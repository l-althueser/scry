import type {
  ComponentInstance,
  FreePoint,
  FreeShape,
  FreeShapeKind,
  ImageLayer,
  Layer,
  LeaderLine,
  LeaderLineEndpoint,
  PipeInstance,
  PortRef,
  Suffix,
  Waypoint,
} from '@svg-editor/shared'
import { isPortRef } from '@svg-editor/shared'
import {
  getLeaderLinePoints,
  leaderLinePathD,
  resolveLeaderLineFromPosition,
} from '../leaderLines/leaderLineGeometry'
import {
  configurePlaceholderRoles,
  getComponentType,
  getComponentTypeVersion,
  resolveLocalBodyCorners,
  resolvePorts,
  rotatePoint,
} from '../library'
import {
  computeHopsForPipe,
  curvedPathD,
  findNearestPipeSegment,
  getDisplayPoints,
  getImageConnectionPointWorldPosition,
  getPipePoints,
  getPortWorldPosition,
  imagePointPortId,
  midpoint,
  pipePointPortId,
  resolveIndicatorTag,
  resolvePipeColor,
  straightPathD,
  straightPathDWithHops,
} from '../pipes/pipeGeometry'
import {
  DEFAULT_FONT_SIZE,
  TEXT_LINE_HEIGHT,
  ellipseAttrs,
  nearestPointOnShapeBorder,
  pointsAttr,
  rectAttrs,
  splitTextLines,
  textAnchorFor,
} from '../shapes/freeShapeGeometry'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export type Tool = 'select' | 'place' | 'draw-pipe' | 'draw-shape' | 'place-connection-point' | 'draw-leader-line'

export interface RoleSelection {
  instanceId: string
  role: Suffix
}

export interface WaypointSelection {
  pipeId: string
  index: number
}

export interface SvgCanvasCallbacks {
  /** keepPlacing is true when Shift was held, so the tool should stay in place mode for placing several in a row. */
  onInstanceAdded: (componentTypeId: string, worldPoint: Point, keepPlacing: boolean) => void
  onInstanceMoved: (instanceId: string, worldPoint: Point) => void
  /** relativeOffset is world-space, relative to the instance origin (not yet rotation-compensated). */
  onRoleMoved: (instanceId: string, role: Suffix, relativeOffset: Point) => void
  /**
   * Called once at the very start of a move-instance/move-role/move-waypoint
   * drag (before the first onInstanceMoved/onRoleMoved/onWaypointMoved call),
   * so the store can push a single undo checkpoint for the whole drag rather
   * than one per pointermove. Group drags checkpoint via onGroupDragStart
   * instead, so this isn't called for those.
   */
  onDragCheckpoint: () => void
  onSelectionChanged: (instanceIds: string[]) => void
  onRoleSelected: (selection: RoleSelection | null) => void
  /** pipePoints are free pipe knots caught in the same box-select as the instances — see companionPipePoints. */
  onGroupDragStart: (instanceIds: string[], pipePoints: { pipeId: string; point: 'from' | 'to' | number }[]) => void
  onGroupDragMove: (delta: Point) => void
  onGroupDragEnd: () => void
  /**
   * keepDrawing is true when Shift was held, so the tool stays active for
   * drawing several pipes in a row. toPort is a bare FreePoint (not a
   * PortRef) when the draw was cut short (e.g. Escape) rather than finished
   * on a real connection point.
   */
  onPipeAdded: (
    fromPort: PortRef | FreePoint,
    toPort: PortRef | FreePoint,
    waypoints: Waypoint[],
    keepDrawing: boolean,
  ) => void
  onPipeSelectionChanged: (pipeIds: string[]) => void
  onWaypointMoved: (pipeId: string, index: number, worldPoint: Point) => void
  onWaypointSelected: (selection: WaypointSelection | null) => void
  /** Double-clicking a pipe's line (not an existing waypoint handle) inserts a new waypoint at `index` (splice position into that pipe's waypoints array). */
  onWaypointAdded: (pipeId: string, index: number, worldPoint: Point) => void
  /**
   * Live update while dragging a pipe's actual from/to endpoint (not an
   * interior waypoint). `ref` is either a snapped PortRef/pipe-point/image
   * connection-point ref (within snap range of a valid target) or a bare
   * FreePoint — dropping in empty space deliberately disconnects that end.
   */
  onPipeEndpointMoved: (pipeId: string, side: PipeEndpointSide, ref: PortRef | FreePoint) => void
  /** Fired once when an endpoint drag ends, so the store can recompute pipe "volumes" (topology may have changed) without doing it on every intermediate move. */
  onPipeEndpointDragEnd: (pipeId: string) => void

  /** keepDrawing is true when Shift was held, so the tool stays active for drawing several shapes in a row. */
  onShapeAdded: (kind: FreeShapeKind, points: Point[], keepDrawing: boolean) => void
  onShapeMoved: (shapeId: string, points: Point[]) => void
  onShapeSelectionChanged: (shapeIds: string[]) => void

  onLayerSelected: (layerId: string | null) => void
  /** Reported as the layer's new x/y — SvgCanvas doesn't know width/height, the store fills those in from its own copy. */
  onLayerMoved: (layerId: string, x: number, y: number) => void
  /** Dragging a corner handle — reports the full new rect (opposite corner stays anchored). */
  onLayerResized: (layerId: string, rect: { x: number; y: number; width: number; height: number }) => void
  /** relX/relY are fractions of the image's current width/height, so the point stays put relative to the image through later drags/resizes. keepPlacing mirrors the other tools' Shift convention. */
  onConnectionPointAdded: (layerId: string, relX: number, relY: number, keepPlacing: boolean) => void

  /** keepDrawing is true when Shift was held, so the tool stays active for drawing several leader lines in a row. */
  onLeaderLineAdded: (from: LeaderLineEndpoint, waypoints: Point[], to: Point, keepDrawing: boolean) => void
  onLeaderLineSelectionChanged: (leaderLineIds: string[]) => void
  /** No grid/align snapping — leader lines are deliberately freeform annotations, unlike pipes/waypoints. */
  onLeaderLinePointMoved: (leaderLineId: string, point: 'to' | number, worldPoint: Point) => void
  /** `from` is a role ref when the drag lands on a label, otherwise a plain point (possibly docked to a shape border). */
  onLeaderLineFromMoved: (leaderLineId: string, from: LeaderLineEndpoint) => void
}

const MIN_SCALE = 0.2
const MAX_SCALE = 8
const MAX_GRID_LINES = 400
const PORT_SNAP_RADIUS = 12
/** Screen-pixel radius for alignment-guide snapping, converted to world units per current zoom. */
const ALIGN_SNAP_PX = 8

type DragMode =
  | 'none'
  | 'pan'
  | 'move-instance'
  | 'move-role'
  | 'move-group'
  | 'box-select'
  | 'move-waypoint'
  | 'move-pipe-endpoint'
  | 'move-shape'
  | 'move-leader-line-point'
  | 'move-layer'
  | 'resize-layer'

type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se'
export type PipeEndpointSide = 'from' | 'to'

/**
 * Imperative SVG scene-graph engine for the editor canvas. Deliberately not
 * rendered through React's virtual DOM: the exported SVG markup this app
 * produces later must be exactly controllable (see .claude/CLAUDE.md), so the
 * canvas manipulates real SVGElement nodes directly instead of going through
 * a framework's own DOM-diffing/id conventions.
 */
export class SvgCanvas {
  readonly svg: SVGSVGElement
  readonly backgroundLayer: SVGGElement
  readonly gridLayer: SVGGElement
  readonly pipesLayer: SVGGElement
  readonly contentLayer: SVGGElement
  readonly shapesLayer: SVGGElement
  readonly leaderLinesLayer: SVGGElement
  readonly overlayLayer: SVGGElement

  private viewBox: ViewBox = { x: 0, y: 0, w: 1000, h: 700 }
  private gridSize: number
  private instanceEls = new Map<string, SVGGElement>()
  private pipeEls = new Map<string, SVGGElement>()
  private shapeEls = new Map<string, SVGGElement>()
  private leaderLineEls = new Map<string, SVGGElement>()
  private imageLayerEls = new Map<string, SVGImageElement>()
  private selectedInstanceIds: string[] = []
  private selectedRole: RoleSelection | null = null
  private selectedPipeIds: string[] = []
  private selectedWaypoint: WaypointSelection | null = null
  private selectedShapeIds: string[] = []
  private selectedLeaderLineIds: string[] = []
  private selectedLayerId: string | null = null

  private dragMode: DragMode = 'none'
  private dragStartScreen: Point = { x: 0, y: 0 }
  private dragStartViewBox: ViewBox = { x: 0, y: 0, w: 0, h: 0 }
  private dragInstanceId: string | null = null
  private dragRole: Suffix | null = null
  private dragInstanceOrigin: Point = { x: 0, y: 0 }
  private dragPipeId: string | null = null
  private dragWaypointIndex: number | null = null
  private dragEndpointSide: PipeEndpointSide | null = null
  private groupDragStartWorld: Point = { x: 0, y: 0 }
  /** Drag-start anchors, used for Shift axis-locking (movement constrained relative to these). */
  private dragInstanceStartPos: Point = { x: 0, y: 0 }
  private dragRoleStartWorld: Point = { x: 0, y: 0 }
  private dragWaypointStartWorld: Point = { x: 0, y: 0 }
  private dragShapeId: string | null = null
  private dragShapeStartWorld: Point = { x: 0, y: 0 }
  private dragShapeStartPoints: Point[] = []
  private dragLeaderLineId: string | null = null
  private dragLeaderLinePoint: 'from' | 'to' | number | null = null
  private dragLayerId: string | null = null
  private dragLayerStartWorld: Point = { x: 0, y: 0 }
  private dragLayerStartRect: Point = { x: 0, y: 0 }
  private dragResizeHandle: ResizeHandle | null = null
  private dragResizeStartRect: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 0, height: 0 }
  /** Shared with the width/height properties-panel fields via setAspectLocked; XOR'd with Shift at drag time. */
  private aspectLocked = true
  private boxSelectStartWorld: Point = { x: 0, y: 0 }
  private boxSelectAdditive = false
  /**
   * Free pipe knots (interior waypoints, or a disconnected from/to end) that
   * fell inside the last box-select alongside at least one instance —
   * "marked like elements" per the user's ask, so the very next group-drag
   * of those instances carries these knots along by the same delta instead
   * of leaving them behind. Populated by finalizeBoxSelect, consumed once by
   * the next onGroupDragStart, and cleared by any other (non-box-select)
   * selection change so it never applies to an unrelated later drag.
   */
  private companionPipePoints: { pipeId: string; point: 'from' | 'to' | number }[] = []

  private previewGroup: SVGGElement | null = null
  private boxSelectRectEl: SVGRectElement | null = null
  private connectorsGroup: SVGGElement
  private dragHandlesGroup: SVGGElement
  private portMarkersGroup: SVGGElement
  private waypointHandlesGroup: SVGGElement
  private leaderLineHandlesGroup: SVGGElement
  private companionPointsGroup: SVGGElement
  private layerResizeHandlesGroup: SVGGElement
  private alignGuideGroup: SVGGElement
  private latestInstances: ComponentInstance[] = []
  private latestPipes: PipeInstance[] = []
  private latestShapes: FreeShape[] = []
  private latestLeaderLines: LeaderLine[] = []
  private latestLayers: Layer[] = []

  /** fromPort is a bare FreePoint when the draw started on empty canvas ("start a pipe out in the blue") rather than a real port. */
  private pipeDraft: { fromPort: PortRef | FreePoint; fromPos: Point; waypoints: Point[] } | null = null
  private pipeDraftPathEl: SVGPathElement | null = null

  /** rect/ellipse/line: the fixed first corner while dragging out the second. */
  private shapeDragStart: Point | null = null
  /** polygon: vertices clicked so far. */
  private shapeDraftPoints: Point[] = []
  private shapeDraftPreviewEl: SVGPathElement | null = null

  /** from snaps to a role if the starting click landed on one; every point after that (waypoints, and the final `to`) is a raw, unsnapped click — leader lines are deliberately freeform, unlike pipes. */
  private leaderLineDraft: { from: LeaderLineEndpoint; fromPos: Point; waypoints: Point[] } | null = null
  private leaderLineDraftPathEl: SVGPathElement | null = null

  constructor(
    private readonly container: HTMLElement,
    gridSize: number,
    private readonly callbacks: SvgCanvasCallbacks,
  ) {
    this.gridSize = gridSize

    this.svg = document.createElementNS(SVG_NS, 'svg')
    this.svg.setAttribute('width', '100%')
    this.svg.setAttribute('height', '100%')
    this.svg.style.display = 'block'
    this.svg.style.touchAction = 'none'
    this.svg.style.background = '#f4f4f4'
    // Prevent the browser's own text/drag selection from kicking in while
    // dragging across <text> elements (grid, instances, labels).
    this.svg.style.userSelect = 'none'
    this.svg.style.setProperty('-webkit-user-select', 'none')
    container.appendChild(this.svg)

    this.backgroundLayer = this.createLayer('background-layer')
    this.gridLayer = this.createLayer('grid-layer')
    this.pipesLayer = this.createLayer('pipes-layer')
    this.contentLayer = this.createLayer('content-layer')
    this.shapesLayer = this.createLayer('shapes-layer')
    this.leaderLinesLayer = this.createLayer('leader-lines-layer')
    this.overlayLayer = this.createLayer('overlay-layer')

    this.connectorsGroup = document.createElementNS(SVG_NS, 'g')
    this.connectorsGroup.setAttribute('class', 'gv-selection-connectors')
    this.overlayLayer.appendChild(this.connectorsGroup)

    // A generous, unambiguous "grab here to move it" target per selected
    // instance — the icons themselves are often thin strokes (fill:none) or
    // have a same-shaped "indicator" role overlay competing for the click,
    // both easy to miss/misfire with the mouse. Reuses data-instance-id so
    // onPointerDown's existing instance/group-drag logic picks it up with no
    // extra branch — see refreshDragHandles.
    this.dragHandlesGroup = document.createElementNS(SVG_NS, 'g')
    this.dragHandlesGroup.setAttribute('class', 'gv-drag-handles')
    this.overlayLayer.appendChild(this.dragHandlesGroup)

    this.portMarkersGroup = document.createElementNS(SVG_NS, 'g')
    this.portMarkersGroup.setAttribute('class', 'gv-port-markers')
    this.overlayLayer.appendChild(this.portMarkersGroup)

    this.waypointHandlesGroup = document.createElementNS(SVG_NS, 'g')
    this.waypointHandlesGroup.setAttribute('class', 'gv-waypoint-handles')
    this.overlayLayer.appendChild(this.waypointHandlesGroup)

    this.leaderLineHandlesGroup = document.createElementNS(SVG_NS, 'g')
    this.leaderLineHandlesGroup.setAttribute('class', 'gv-leader-line-handles')
    this.overlayLayer.appendChild(this.leaderLineHandlesGroup)

    this.companionPointsGroup = document.createElementNS(SVG_NS, 'g')
    this.companionPointsGroup.setAttribute('class', 'gv-companion-points')
    this.overlayLayer.appendChild(this.companionPointsGroup)

    this.layerResizeHandlesGroup = document.createElementNS(SVG_NS, 'g')
    this.layerResizeHandlesGroup.setAttribute('class', 'gv-layer-resize-handles')
    this.overlayLayer.appendChild(this.layerResizeHandlesGroup)

    this.alignGuideGroup = document.createElementNS(SVG_NS, 'g')
    this.alignGuideGroup.setAttribute('class', 'gv-align-guides')
    this.alignGuideGroup.style.pointerEvents = 'none'
    this.overlayLayer.appendChild(this.alignGuideGroup)

    this.applyViewBox()
    this.drawGrid()

    this.svg.addEventListener('pointerdown', this.onPointerDown)
    this.svg.addEventListener('pointermove', this.onPointerMove)
    this.svg.addEventListener('pointerup', this.onPointerUp)
    this.svg.addEventListener('pointerleave', this.onPointerLeave)
    this.svg.addEventListener('dblclick', this.onDoubleClick)
    this.svg.addEventListener('wheel', this.onWheel, { passive: false })
  }

  private tool: Tool = 'select'
  private placingType: string | null = null
  private drawingShapeKind: FreeShapeKind | null = null
  private connectionPointTargetLayerId: string | null = null

  setTool(tool: Tool, subKind: string | null = null) {
    this.tool = tool
    this.placingType = tool === 'place' ? subKind : null
    this.drawingShapeKind = tool === 'draw-shape' ? (subKind as FreeShapeKind | null) : null
    this.connectionPointTargetLayerId = tool === 'place-connection-point' ? subKind : null
    this.svg.style.cursor = tool === 'select' ? 'default' : 'crosshair'
    if (tool !== 'place') {
      this.hidePreview()
    } else {
      this.rebuildPreview()
    }
    if (tool !== 'draw-pipe') {
      this.finishOrClearPipeDraft()
    }
    if (tool !== 'draw-shape') {
      this.clearShapeDraft()
    }
    if (tool !== 'draw-leader-line') {
      this.finishOrClearLeaderLineDraft()
    }
    this.refreshPortMarkers()
  }

  setAspectLocked(locked: boolean) {
    this.aspectLocked = locked
  }

  /** Live-updates the grid: redraws the visible lines immediately; snapping (snapToGrid) always reads this.gridSize fresh, so no other state needs touching. */
  setGridSize(size: number) {
    if (this.gridSize === size) return
    this.gridSize = size
    this.drawGrid()
  }

  destroy() {
    this.svg.removeEventListener('pointerdown', this.onPointerDown)
    this.svg.removeEventListener('pointermove', this.onPointerMove)
    this.svg.removeEventListener('pointerup', this.onPointerUp)
    this.svg.removeEventListener('pointerleave', this.onPointerLeave)
    this.svg.removeEventListener('dblclick', this.onDoubleClick)
    this.svg.removeEventListener('wheel', this.onWheel)
    this.container.removeChild(this.svg)
  }

  /** (Re)builds the ghost preview for whichever type is currently being placed, if any. */
  private rebuildPreview() {
    if (this.previewGroup) {
      this.previewGroup.remove()
      this.previewGroup = null
    }
    if (!this.placingType) return

    const g = document.createElementNS(SVG_NS, 'g')
    g.setAttribute('class', 'gv-place-preview')
    g.style.pointerEvents = 'none'
    g.style.opacity = '0.45'
    g.style.display = 'none'
    getComponentType(this.placingType).render(g)
    // Types with a body/icon (e.g. the valve) preview just that, hiding the
    // empty label boxes; types without one (e.g. process-indicator) show
    // their default labels instead, since those *are* the whole preview.
    configurePlaceholderRoles(this.placingType, g)
    this.overlayLayer.appendChild(g)
    this.previewGroup = g
  }

  private hidePreview() {
    if (this.previewGroup) this.previewGroup.style.display = 'none'
  }

  private onPointerLeave = () => {
    this.hidePreview()
  }

  private createLayer(className: string): SVGGElement {
    const g = document.createElementNS(SVG_NS, 'g')
    g.setAttribute('class', className)
    this.svg.appendChild(g)
    return g
  }

  private applyViewBox() {
    const { x, y, w, h } = this.viewBox
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`)
  }

  snapToGrid(pt: Point): Point {
    return {
      x: Math.round(pt.x / this.gridSize) * this.gridSize,
      y: Math.round(pt.y / this.gridSize) * this.gridSize,
    }
  }

  /** Fine-grained snap for role/label dragging — the main grid is much too coarse for precise label placement. */
  private snapFine(pt: Point): Point {
    return { x: Math.round(pt.x), y: Math.round(pt.y) }
  }

  /** Zeroes out whichever axis moved less, so the remaining movement is purely horizontal or vertical. */
  private constrainDeltaToAxis(delta: Point): Point {
    return Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y }
  }

  private worldThreshold(px: number): number {
    return px * (this.viewBox.w / this.svg.clientWidth)
  }

  /**
   * All ports (across every instance) and pipe points (endpoints + waypoints,
   * across every pipe, plus the in-progress draft) that a dragged/drawn pipe
   * point can align to. excludeWaypoint skips the point currently being
   * dragged so it doesn't trivially "align" with itself.
   */
  private collectAlignReferences(excludeWaypoint?: { pipeId: string; index: number }): Point[] {
    const refs: Point[] = []
    for (const inst of this.latestInstances) {
      const def = getComponentType(inst.componentTypeId)
      for (const port of resolvePorts(def, inst)) {
        const pos = getPortWorldPosition(inst, port.portId)
        if (pos) refs.push(pos)
      }
    }
    for (const pipe of this.latestPipes) {
      const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers)
      if (!points) continue
      points.forEach((p, idx) => {
        if (excludeWaypoint && pipe.instanceId === excludeWaypoint.pipeId && idx === excludeWaypoint.index + 1) {
          return
        }
        refs.push(p)
      })
    }
    for (const layer of this.latestLayers) {
      if (layer.kind !== 'image') continue
      for (const cp of layer.connectionPoints) {
        const pos = getImageConnectionPointWorldPosition(layer, cp.pointId)
        if (pos) refs.push(pos)
      }
    }
    if (this.pipeDraft) {
      refs.push(this.pipeDraft.fromPos, ...this.pipeDraft.waypoints)
    }
    return refs
  }

  /**
   * Refines a point onto the nearest reference's x and/or y ("Flucht") if
   * within snap range, independently per axis — so e.g. a waypoint can land
   * exactly level with one port's y while also aligning to another point's x.
   */
  private snapWithAlignment(pt: Point, refs: Point[]): { point: Point; guideX: number | null; guideY: number | null } {
    const threshold = this.worldThreshold(ALIGN_SNAP_PX)
    let bestX: { value: number; dist: number } | null = null
    let bestY: { value: number; dist: number } | null = null
    for (const ref of refs) {
      const dx = Math.abs(ref.x - pt.x)
      if (dx <= threshold && (!bestX || dx < bestX.dist)) bestX = { value: ref.x, dist: dx }
      const dy = Math.abs(ref.y - pt.y)
      if (dy <= threshold && (!bestY || dy < bestY.dist)) bestY = { value: ref.y, dist: dy }
    }
    return {
      point: { x: bestX ? bestX.value : pt.x, y: bestY ? bestY.value : pt.y },
      guideX: bestX ? bestX.value : null,
      guideY: bestY ? bestY.value : null,
    }
  }

  /**
   * Combines alignment-snap with grid-snap: alignment is checked against the
   * raw cursor position (not a pre-rounded one), since a reference point
   * (e.g. a port offset from its instance) rarely sits exactly on a grid
   * multiple itself — grid-snapping first would make most real alignments
   * fall just outside the threshold. Grid-snap only fills in whichever axis
   * didn't get an alignment match.
   */
  private snapWithAlignmentOrGrid(worldPt: Point, refs: Point[]): { point: Point; guideX: number | null; guideY: number | null } {
    const aligned = this.snapWithAlignment(worldPt, refs)
    const gridSnapped = this.snapToGrid(worldPt)
    return {
      point: {
        x: aligned.guideX !== null ? aligned.guideX : gridSnapped.x,
        y: aligned.guideY !== null ? aligned.guideY : gridSnapped.y,
      },
      guideX: aligned.guideX,
      guideY: aligned.guideY,
    }
  }

  private showAlignGuides(guideX: number | null, guideY: number | null) {
    while (this.alignGuideGroup.firstChild) this.alignGuideGroup.removeChild(this.alignGuideGroup.firstChild)
    const { x, y, w, h } = this.viewBox
    if (guideX !== null) {
      const line = document.createElementNS(SVG_NS, 'line')
      line.setAttribute('x1', String(guideX))
      line.setAttribute('y1', String(y))
      line.setAttribute('x2', String(guideX))
      line.setAttribute('y2', String(y + h))
      line.setAttribute('class', 'gv-align-guide')
      this.alignGuideGroup.appendChild(line)
    }
    if (guideY !== null) {
      const line = document.createElementNS(SVG_NS, 'line')
      line.setAttribute('x1', String(x))
      line.setAttribute('y1', String(guideY))
      line.setAttribute('x2', String(x + w))
      line.setAttribute('y2', String(guideY))
      line.setAttribute('class', 'gv-align-guide')
      this.alignGuideGroup.appendChild(line)
    }
  }

  private hideAlignGuides() {
    while (this.alignGuideGroup.firstChild) this.alignGuideGroup.removeChild(this.alignGuideGroup.firstChild)
  }

  /**
   * Resolves where a draw-pipe click/preview point should land: port-snap
   * first, then either Shift axis-lock (relative to the last placed point)
   * or grid+alignment snap. Shared by onPointerDown (committing a waypoint)
   * and onPointerMove (the live dashed preview) so both agree exactly.
   */
  private computeDrawPipeTarget(
    world: Point,
    shiftKey: boolean,
  ): { point: Point; guideX: number | null; guideY: number | null } {
    const hit = this.findPortNear(world)
    if (hit) return { point: hit.pos, guideX: null, guideY: null }
    if (!this.pipeDraft) return { point: this.snapToGrid(world), guideX: null, guideY: null }

    const anchor =
      this.pipeDraft.waypoints.length > 0
        ? this.pipeDraft.waypoints[this.pipeDraft.waypoints.length - 1]
        : this.pipeDraft.fromPos

    if (shiftKey) {
      const delta = this.constrainDeltaToAxis({ x: world.x - anchor.x, y: world.y - anchor.y })
      return {
        point: this.snapToGrid({ x: anchor.x + delta.x, y: anchor.y + delta.y }),
        guideX: null,
        guideY: null,
      }
    }

    return this.snapWithAlignmentOrGrid(world, this.collectAlignReferences())
  }

  screenToWorld(clientX: number, clientY: number): Point {
    const pt = this.svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = this.svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const world = pt.matrixTransform(ctm.inverse())
    return { x: world.x, y: world.y }
  }

  private drawGrid() {
    while (this.gridLayer.firstChild) this.gridLayer.removeChild(this.gridLayer.firstChild)

    const { x, y, w, h } = this.viewBox
    const startX = Math.floor(x / this.gridSize) * this.gridSize
    const startY = Math.floor(y / this.gridSize) * this.gridSize
    const endX = x + w
    const endY = y + h

    const lineCountX = Math.ceil((endX - startX) / this.gridSize)
    const lineCountY = Math.ceil((endY - startY) / this.gridSize)
    if (lineCountX + lineCountY > MAX_GRID_LINES) return // too zoomed out, skip grid to avoid a huge DOM

    const path = document.createElementNS(SVG_NS, 'path')
    let d = ''
    for (let gx = startX; gx <= endX; gx += this.gridSize) {
      d += `M${gx} ${y} L${gx} ${endY} `
    }
    for (let gy = startY; gy <= endY; gy += this.gridSize) {
      d += `M${x} ${gy} L${endX} ${gy} `
    }
    path.setAttribute('d', d.trim())
    path.setAttribute('stroke', '#dddddd')
    path.setAttribute('stroke-width', String(Math.max(this.viewBox.w / 1000, 0.5)))
    path.setAttribute('fill', 'none')
    this.gridLayer.appendChild(path)
  }

  private onWheel = (evt: WheelEvent) => {
    evt.preventDefault()
    const worldBefore = this.screenToWorld(evt.clientX, evt.clientY)
    const factor = evt.deltaY > 0 ? 1.1 : 1 / 1.1
    const newW = clamp(this.viewBox.w * factor, MIN_SCALE * 1000, MAX_SCALE * 1000)
    const scaleChange = newW / this.viewBox.w
    const newH = this.viewBox.h * scaleChange
    this.viewBox = {
      w: newW,
      h: newH,
      x: worldBefore.x - (worldBefore.x - this.viewBox.x) * scaleChange,
      y: worldBefore.y - (worldBefore.y - this.viewBox.y) * scaleChange,
    }
    this.applyViewBox()
    this.drawGrid()
  }

  /**
   * Finds the nearest connectable point within snap range: a component
   * port, or a point (endpoint/waypoint) on another pipe — pipes can branch
   * off each other's connection points, not just component ports.
   * `excludePipeId` skips a given pipe's own points — used while dragging
   * that same pipe's own endpoint, so it can't "snap" onto itself.
   */
  private findPortNear(worldPt: Point, excludePipeId?: string): { ref: PortRef; pos: Point } | null {
    let best: { ref: PortRef; pos: Point; dist: number } | null = null
    for (const inst of this.latestInstances) {
      const def = getComponentType(inst.componentTypeId)
      for (const port of resolvePorts(def, inst)) {
        const pos = getPortWorldPosition(inst, port.portId)
        if (!pos) continue
        const d = Math.hypot(pos.x - worldPt.x, pos.y - worldPt.y)
        if (d <= PORT_SNAP_RADIUS && (!best || d < best.dist)) {
          best = { ref: { instanceId: inst.instanceId, portId: port.portId }, pos, dist: d }
        }
      }
    }
    for (const pipe of this.latestPipes) {
      if (pipe.instanceId === excludePipeId) continue
      const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers)
      if (!points) continue
      points.forEach((pos, idx) => {
        const d = Math.hypot(pos.x - worldPt.x, pos.y - worldPt.y)
        if (d <= PORT_SNAP_RADIUS && (!best || d < best.dist)) {
          best = { ref: { instanceId: pipe.instanceId, portId: pipePointPortId(idx) }, pos, dist: d }
        }
      })
    }
    for (const layer of this.latestLayers) {
      if (layer.kind !== 'image') continue
      for (const cp of layer.connectionPoints) {
        const pos = getImageConnectionPointWorldPosition(layer, cp.pointId)
        if (!pos) continue
        const d = Math.hypot(pos.x - worldPt.x, pos.y - worldPt.y)
        if (d <= PORT_SNAP_RADIUS && (!best || d < best.dist)) {
          best = { ref: { instanceId: layer.layerId, portId: imagePointPortId(cp.pointId) }, pos, dist: d }
        }
      }
    }
    return best
  }

  /**
   * Nearest point on any free-shape's own border/line within snap range —
   * lets a leader-line endpoint "dock" precisely onto a box's edge or a
   * drawn line instead of landing wherever the cursor happened to be a few
   * pixels off. Only rect/line/polygon shapes have a border to dock onto
   * (see nearestPointOnShapeBorder).
   */
  private findShapeAnchorNear(worldPt: Point): Point | null {
    let best: { pos: Point; dist: number } | null = null
    for (const shape of this.latestShapes) {
      const pos = nearestPointOnShapeBorder(shape, worldPt)
      if (!pos) continue
      const d = Math.hypot(pos.x - worldPt.x, pos.y - worldPt.y)
      if (d <= PORT_SNAP_RADIUS && (!best || d < best.dist)) best = { pos, dist: d }
    }
    return best?.pos ?? null
  }

  /**
   * Resolves a raw click/drag point for a leader-line `to`/waypoint/free
   * `from` into where it should actually land: snapped onto a shape's
   * border if the cursor is close enough to one, otherwise the raw point
   * as-is. Never grid-snapped — leader lines stay deliberately freeform.
   */
  private resolveLeaderLineAnchor(worldPt: Point): Point {
    return this.findShapeAnchorNear(worldPt) ?? worldPt
  }

  /**
   * Resolves an element (from a click, or document.elementFromPoint during a
   * drag — see the pointer-capture-retargeting note on onDoubleClick) to the
   * role label it (or an ancestor) represents, if any, plus that role's
   * current world position. Shared by starting a leader line on a label and
   * re-anchoring its `from` end onto a different label while dragging.
   */
  private resolveRoleRefAt(el: Element): { ref: { instanceId: string; role: Suffix }; pos: Point } | null {
    const roleEl = el.closest('[data-role]') as SVGGElement | null
    const instanceEl = el.closest('[data-instance-id]') as SVGGElement | null
    if (!roleEl || !instanceEl) return null
    const instanceId = instanceEl.getAttribute('data-instance-id')!
    const role = roleEl.getAttribute('data-role') as Suffix
    const inst = this.latestInstances.find((i) => i.instanceId === instanceId)
    const roleInst = inst?.roles.find((r) => r.role === role)
    if (!inst || !roleInst) return null
    const rotated = rotatePoint(roleInst.offset, inst.transform.rotationDeg)
    return {
      ref: { instanceId, role },
      pos: { x: inst.transform.x + rotated.x, y: inst.transform.y + rotated.y },
    }
  }

  /**
   * Green snap-target markers, shown while drawing a pipe (component ports +
   * existing pipe points + every image layer's connection points — any of
   * these can be branched off). Separately, the *selected* image layer's own
   * connection points are shown in orange whenever it's selected (in any
   * tool), so its points stay visible/manageable outside of pipe-drawing too.
   */
  private refreshPortMarkers() {
    while (this.portMarkersGroup.firstChild) {
      this.portMarkersGroup.removeChild(this.portMarkersGroup.firstChild)
    }

    const addMarker = (pos: Point, cssClass = 'gv-port-marker') => {
      const c = document.createElementNS(SVG_NS, 'circle')
      c.setAttribute('cx', String(pos.x))
      c.setAttribute('cy', String(pos.y))
      c.setAttribute('r', '4')
      c.setAttribute('class', cssClass)
      c.style.pointerEvents = 'none'
      this.portMarkersGroup.appendChild(c)
    }

    const showSnapTargets =
      this.tool === 'draw-pipe' || this.tool === 'place-connection-point' || this.dragMode === 'move-pipe-endpoint'
    if (showSnapTargets) {
      for (const inst of this.latestInstances) {
        const def = getComponentType(inst.componentTypeId)
        for (const port of resolvePorts(def, inst)) {
          const pos = getPortWorldPosition(inst, port.portId)
          if (pos) addMarker(pos)
        }
      }
      // Existing pipes' points (endpoints + waypoints) are also valid
      // connection points, so a new pipe can branch off a running line.
      for (const pipe of this.latestPipes) {
        const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers)
        points?.forEach((p) => addMarker(p))
      }
      for (const layer of this.latestLayers) {
        if (layer.kind !== 'image') continue
        for (const cp of layer.connectionPoints) {
          const pos = getImageConnectionPointWorldPosition(layer, cp.pointId)
          if (pos) addMarker(pos)
        }
      }
    }

    if (this.selectedLayerId) {
      const layer = this.latestLayers.find((l) => l.layerId === this.selectedLayerId)
      if (layer && layer.kind === 'image') {
        for (const cp of layer.connectionPoints) {
          const pos = getImageConnectionPointWorldPosition(layer, cp.pointId)
          if (pos) addMarker(pos, 'gv-port-marker gv-connection-point-selected')
        }
      }
    }
  }

  private updatePipeDraftPreview(currentPoint: Point) {
    if (!this.pipeDraft) return
    if (!this.pipeDraftPathEl) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('class', 'gv-pipe-draft')
      path.setAttribute('fill', 'none')
      path.style.pointerEvents = 'none'
      this.overlayLayer.appendChild(path)
      this.pipeDraftPathEl = path
    }
    const points = [this.pipeDraft.fromPos, ...this.pipeDraft.waypoints, currentPoint]
    this.pipeDraftPathEl.setAttribute('d', straightPathD(points))
  }

  private clearPipeDraft() {
    this.pipeDraft = null
    if (this.pipeDraftPathEl) {
      this.pipeDraftPathEl.remove()
      this.pipeDraftPathEl = null
    }
    this.hideAlignGuides()
  }

  /**
   * Called whenever draw-pipe is left mid-draft (Escape, switching tools,
   * ...). A draft that's still just its starting port (no waypoints placed
   * yet) is discarded as before. Once at least one waypoint has been
   * placed, the pipe is kept up to that last point instead of losing the
   * work — its far end becomes a bare, unattached FreePoint rather than a
   * real port (draw-pipe from/onto that dangling end later reconnects it;
   * the store merges the two back into one pipe if that stays unambiguous).
   */
  private finishOrClearPipeDraft() {
    const draft = this.pipeDraft
    if (!draft || draft.waypoints.length === 0) {
      this.clearPipeDraft()
      return
    }
    const last = draft.waypoints[draft.waypoints.length - 1]
    const waypoints: Waypoint[] = draft.waypoints.slice(0, -1).map((p) => ({ x: p.x, y: p.y, kind: 'corner' }))
    const fromPort = draft.fromPort
    this.clearPipeDraft()
    this.callbacks.onPipeAdded(fromPort, { x: last.x, y: last.y }, waypoints, false)
  }

  /** Live dashed preview while drawing a shape — same path element reused across kinds, `d` computed per kind. */
  private refreshShapeDraftPreview(points: Point[]) {
    if (!this.drawingShapeKind || points.length < 2) return
    if (!this.shapeDraftPreviewEl) {
      const el = document.createElementNS(SVG_NS, 'path')
      el.setAttribute('class', 'gv-shape-draft')
      el.setAttribute('fill', 'none')
      el.style.pointerEvents = 'none'
      this.overlayLayer.appendChild(el)
      this.shapeDraftPreviewEl = el
    }
    this.shapeDraftPreviewEl.setAttribute('d', shapeOutlinePathD(this.drawingShapeKind, points))
  }

  /**
   * Discards whatever shape is mid-draw. Unlike pipes, there's no "keep the
   * partial result" behavior here — Escape or switching tools always just
   * cancels (rect/ellipse/line need exactly 2 points anyway, and a
   * part-drawn polygon isn't a meaningful shape on its own).
   */
  private clearShapeDraft() {
    this.shapeDragStart = null
    this.shapeDraftPoints = []
    if (this.shapeDraftPreviewEl) {
      this.shapeDraftPreviewEl.remove()
      this.shapeDraftPreviewEl = null
    }
  }

  /** Live dashed preview while drawing a leader line — from's resolved position through waypoints to the current pointer position. */
  private updateLeaderLineDraftPreview(currentPoint: Point) {
    if (!this.leaderLineDraft) return
    if (!this.leaderLineDraftPathEl) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('class', 'gv-leader-line-draft')
      path.setAttribute('fill', 'none')
      path.style.pointerEvents = 'none'
      this.overlayLayer.appendChild(path)
      this.leaderLineDraftPathEl = path
    }
    const points = [this.leaderLineDraft.fromPos, ...this.leaderLineDraft.waypoints, currentPoint]
    this.leaderLineDraftPathEl.setAttribute('d', leaderLinePathD(points))
  }

  private clearLeaderLineDraft() {
    this.leaderLineDraft = null
    if (this.leaderLineDraftPathEl) {
      this.leaderLineDraftPathEl.remove()
      this.leaderLineDraftPathEl = null
    }
  }

  /**
   * Called whenever draw-leader-line is left mid-draft (Escape, switching
   * tools, ...) — mirrors finishOrClearPipeDraft's "end it, don't discard
   * it" behavior (not the shape-draft tools' "always discard" one): a draft
   * that's still just its starting point (no waypoints placed yet) has
   * nothing meaningful to end at, so it's simply discarded; once at least
   * one point has been placed, that most recent point becomes `to` and the
   * line is committed as-is.
   */
  private finishOrClearLeaderLineDraft() {
    const draft = this.leaderLineDraft
    if (!draft || draft.waypoints.length === 0) {
      this.clearLeaderLineDraft()
      return
    }
    const last = draft.waypoints[draft.waypoints.length - 1]
    const waypoints = draft.waypoints.slice(0, -1)
    const from = draft.from
    this.clearLeaderLineDraft()
    this.callbacks.onLeaderLineAdded(from, waypoints, last, false)
  }

  /**
   * Double-clicking a pipe's line inserts a new waypoint there; double-
   * clicking while drawing a leader line finishes it. Deliberately a real
   * "dblclick" listener rather than checking `evt.detail` inside
   * onPointerDown (that was the first attempt for both features —
   * PointerEvent.detail's click-count semantics turned out unreliable
   * enough in practice, confirmed independently for the pipe-waypoint case
   * during development and for the leader-line case by direct user report,
   * that double-click silently never fired): the browser's native dblclick
   * event is the standard, dependable way to detect this gesture.
   */
  private onDoubleClick = (evt: MouseEvent) => {
    if (this.tool === 'draw-leader-line' && this.leaderLineDraft) {
      evt.preventDefault()
      const draft = this.leaderLineDraft
      // The two individual clicks making up this double-click each already
      // ran through onPointerDown's normal add-waypoint path (since it no
      // longer short-circuits on evt.detail) — including shape-border
      // snapping — so the most recently added waypoint is really this same
      // finishing click, already resolved; use it as `to` instead of
      // leaving it as a redundant trailing waypoint or re-resolving it.
      const to = draft.waypoints[draft.waypoints.length - 1]
      const waypoints = draft.waypoints.slice(0, -1)
      const from = draft.from
      this.clearLeaderLineDraft()
      this.callbacks.onLeaderLineAdded(from, waypoints, to, evt.shiftKey)
      return
    }

    if (this.tool !== 'select') return
    // NOT evt.target: onPointerDown calls setPointerCapture on every
    // pointerdown and it's never explicitly released, so by the time the
    // compatibility dblclick event fires, evt.target has been retargeted to
    // the capturing element (this.svg) rather than the actual element under
    // the cursor — evt.target.closest(...) would silently never match
    // anything. elementFromPoint bypasses that retargeting entirely.
    const target = document.elementFromPoint(evt.clientX, evt.clientY) as Element | null
    if (!target) return
    if (target.closest('[data-waypoint-index]')) return
    const pipeEl = target.closest('[data-pipe-id]') as SVGElement | null
    if (!pipeEl) return
    evt.preventDefault()

    const pipeId = pipeEl.getAttribute('data-pipe-id')!
    const pipe = this.latestPipes.find((p) => p.instanceId === pipeId)
    if (!pipe) return
    const rawPoints = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers)
    if (!rawPoints) return

    const world = this.screenToWorld(evt.clientX, evt.clientY)
    const nearest = findNearestPipeSegment(pipe, rawPoints, world)
    if (!nearest) return
    this.callbacks.onWaypointAdded(pipeId, nearest.insertIndex, this.snapToGrid(world))
  }

  private onPointerDown = (evt: PointerEvent) => {
    evt.preventDefault() // stop the browser starting its own text/drag selection
    // preventDefault also suppresses the browser's normal focus-shift on
    // click, so an element focused just before (e.g. a role checkbox in the
    // properties panel) would otherwise keep keyboard focus indefinitely.
    const active = document.activeElement as HTMLElement | null
    if (active && active !== document.body && !this.container.contains(active)) {
      active.blur()
    }
    this.svg.setPointerCapture(evt.pointerId)
    const world = this.screenToWorld(evt.clientX, evt.clientY)

    if (this.tool === 'place' && this.placingType) {
      this.callbacks.onInstanceAdded(this.placingType, this.snapToGrid(world), evt.shiftKey)
      return
    }

    if (this.tool === 'draw-pipe') {
      const hit = this.findPortNear(world)

      if (!this.pipeDraft) {
        // A port/pipe-point/image-point near the click snaps to a real
        // attachment as before; otherwise the draw still starts, just on a
        // bare grid-snapped FreePoint ("start a pipe out in the blue") —
        // the far end can still land on a real port to finish normally, or
        // Escape leaves it as a free-ended stub like any other draft.
        const start = hit ? { ref: hit.ref, pos: hit.pos } : { ref: this.snapToGrid(world), pos: this.snapToGrid(world) }
        this.pipeDraft = {
          fromPort: start.ref,
          fromPos: start.pos,
          waypoints: [],
        }
        return
      }

      const isSameAsStart =
        hit &&
        isPortRef(this.pipeDraft.fromPort) &&
        hit.ref.instanceId === this.pipeDraft.fromPort.instanceId &&
        hit.ref.portId === this.pipeDraft.fromPort.portId

      if (hit && !isSameAsStart) {
        const waypoints: Waypoint[] = this.pipeDraft.waypoints.map((p) => ({
          x: p.x,
          y: p.y,
          kind: 'corner',
        }))
        this.callbacks.onPipeAdded(this.pipeDraft.fromPort, hit.ref, waypoints, evt.shiftKey)
        this.clearPipeDraft()
        return
      }

      const { point } = this.computeDrawPipeTarget(world, evt.shiftKey)
      this.pipeDraft.waypoints.push(point)
      this.updatePipeDraftPreview(point)
      this.hideAlignGuides()
      return
    }

    if (this.tool === 'draw-shape' && this.drawingShapeKind) {
      const kind = this.drawingShapeKind

      if (kind === 'text') {
        this.callbacks.onShapeAdded('text', [this.snapToGrid(world)], evt.shiftKey)
        return
      }

      if (kind === 'polygon') {
        const snapped = this.snapToGrid(world)
        if (this.shapeDraftPoints.length >= 3) {
          const startPt = this.shapeDraftPoints[0]
          const nearStart = Math.hypot(snapped.x - startPt.x, snapped.y - startPt.y) <= this.gridSize / 2
          // Double-click (evt.detail>=2) or clicking back near the start point both finish the polygon
          // with whatever vertices are already accumulated — the click itself isn't added as one more.
          if (evt.detail >= 2 || nearStart) {
            const points = this.shapeDraftPoints
            this.clearShapeDraft()
            this.callbacks.onShapeAdded('polygon', points, evt.shiftKey)
            return
          }
        }
        this.shapeDraftPoints.push(snapped)
        this.refreshShapeDraftPreview(this.shapeDraftPoints)
        return
      }

      // rect / ellipse / line: drag from here, committed on pointerup.
      this.shapeDragStart = this.snapToGrid(world)
      return
    }

    if (this.tool === 'draw-leader-line') {
      // Click to start: snaps to a role label if the click landed on one
      // (the "anchored from a label" case), else docks onto a nearby
      // shape's border/line if there is one, else a raw free point. Every
      // point after that — waypoints and the final `to` — resolves the same
      // way minus the role case (only `from` can live-track a label);
      // leader lines never grid/align-snap.
      if (!this.leaderLineDraft) {
        const roleHit = this.resolveRoleRefAt(evt.target as Element)
        if (roleHit) {
          this.leaderLineDraft = { from: roleHit.ref, fromPos: roleHit.pos, waypoints: [] }
        } else {
          const pos = this.resolveLeaderLineAnchor(world)
          this.leaderLineDraft = { from: pos, fromPos: pos, waypoints: [] }
        }
        return
      }

      // Every subsequent click adds a waypoint — finishing the draft is
      // handled entirely by the dedicated `dblclick` listener (onDoubleClick
      // below), not by checking evt.detail here: PointerEvent.detail's
      // click-count turned out just as unreliable for this as it was for the
      // pipe-waypoint-insert feature (see onDoubleClick's own doc comment).
      const point = this.resolveLeaderLineAnchor(world)
      this.leaderLineDraft.waypoints.push(point)
      this.updateLeaderLineDraftPreview(point)
      return
    }

    if (this.tool === 'place-connection-point' && this.connectionPointTargetLayerId) {
      const layer = this.latestLayers.find((l) => l.layerId === this.connectionPointTargetLayerId)
      if (layer && layer.kind === 'image' && layer.width > 0 && layer.height > 0) {
        const relX = clamp01((world.x - layer.x) / layer.width)
        const relY = clamp01((world.y - layer.y) / layer.height)
        this.callbacks.onConnectionPointAdded(layer.layerId, relX, relY, evt.shiftKey)
      }
      return
    }

    // An *attached* pipe endpoint's handle sits exactly on its component's
    // own port, sharing that one pixel with real content underneath — but a
    // plain click there just grabs the endpoint directly (the explicit,
    // simpler behavior the user asked for, restoring "drag the knot" without
    // a modifier key). Moving the component from that same shared pixel
    // isn't lost: click/drag anywhere else on its body, or use its
    // dedicated drag-handle (refreshDragHandles) — added specifically so a
    // component never *needs* to be grabbed from an exact port pixel.
    const target = evt.target as Element
    const resizeHandleEl = target.closest('[data-resize-handle]') as SVGElement | null
    const endpointEl = target.closest('[data-pipe-endpoint]') as SVGElement | null
    const waypointEl = target.closest('[data-waypoint-index]') as SVGElement | null
    const roleEl = target.closest('[data-role]') as SVGGElement | null
    const instanceEl = target.closest('[data-instance-id]') as SVGGElement | null
    const pipeEl = target.closest('[data-pipe-id]') as SVGElement | null
    const shapeEl = target.closest('[data-shape-id]') as SVGElement | null
    const layerEl = target.closest('[data-layer-id]') as SVGElement | null
    const leaderLinePointEl = target.closest('[data-leader-line-point]') as SVGElement | null
    const companionPointEl = target.closest('[data-companion-pipe-point]') as SVGElement | null
    const leaderLineEl = target.closest('[data-leader-line-id]') as SVGElement | null

    if (resizeHandleEl) {
      const layerId = resizeHandleEl.getAttribute('data-layer-id')!
      const layer = this.latestLayers.find((l) => l.layerId === layerId)
      if (layer && layer.kind === 'image') {
        this.callbacks.onDragCheckpoint()
        this.dragMode = 'resize-layer'
        this.dragLayerId = layerId
        this.dragResizeHandle = resizeHandleEl.getAttribute('data-resize-handle') as ResizeHandle
        this.dragResizeStartRect = { x: layer.x, y: layer.y, width: layer.width, height: layer.height }
      }
      return
    }

    if (endpointEl) {
      const pipeId = endpointEl.getAttribute('data-pipe-id')!
      const side = endpointEl.getAttribute('data-pipe-endpoint') as PipeEndpointSide
      this.setPipeSelectionFromUser([pipeId])
      this.setWaypointSelectionFromUser(null)
      this.callbacks.onDragCheckpoint()
      this.dragMode = 'move-pipe-endpoint'
      this.dragPipeId = pipeId
      this.dragEndpointSide = side
      this.refreshPortMarkers()
      return
    }

    if (waypointEl) {
      const pipeId = waypointEl.getAttribute('data-pipe-id')!
      const index = Number(waypointEl.getAttribute('data-waypoint-index'))
      this.setPipeSelectionFromUser([pipeId])
      this.setWaypointSelectionFromUser({ pipeId, index })
      this.callbacks.onDragCheckpoint()
      this.dragMode = 'move-waypoint'
      this.dragPipeId = pipeId
      this.dragWaypointIndex = index
      const pipe = this.latestPipes.find((p) => p.instanceId === pipeId)
      const wp = pipe?.waypoints[index]
      this.dragWaypointStartWorld = wp ? { x: wp.x, y: wp.y } : world
      return
    }

    if (companionPointEl) {
      // Clicking a marked knot directly starts the exact same group-drag as
      // clicking the instance body or its drag-handle would (beginGroupDrag
      // pushes its own undo checkpoint, same as that path) — it's already
      // part of the group, this is just another way to grab it.
      this.dragMode = 'move-group'
      this.groupDragStartWorld = world
      this.callbacks.onGroupDragStart(this.selectedInstanceIds, this.companionPipePoints)
      return
    }

    if (leaderLinePointEl) {
      const leaderLineId = leaderLinePointEl.getAttribute('data-leader-line-id')!
      const pointAttr = leaderLinePointEl.getAttribute('data-leader-line-point')!
      const point: 'from' | 'to' | number =
        pointAttr === 'from' || pointAttr === 'to' ? pointAttr : Number(pointAttr)
      this.setLeaderLineSelectionFromUser([leaderLineId])
      this.callbacks.onDragCheckpoint()
      this.dragMode = 'move-leader-line-point'
      this.dragLeaderLineId = leaderLineId
      this.dragLeaderLinePoint = point
      return
    }

    if (roleEl && instanceEl) {
      const instanceId = instanceEl.getAttribute('data-instance-id')!
      const role = roleEl.getAttribute('data-role') as Suffix
      this.setSelectionFromUser([instanceId])
      this.setRoleSelectionFromUser({ instanceId, role })
      this.callbacks.onDragCheckpoint()
      this.dragMode = 'move-role'
      this.dragInstanceId = instanceId
      this.dragRole = role
      this.dragInstanceOrigin = readGroupOrigin(instanceEl)
      const inst = this.latestInstances.find((i) => i.instanceId === instanceId)
      const roleInst = inst?.roles.find((r) => r.role === role)
      this.dragRoleStartWorld = roleInst
        ? {
            x: this.dragInstanceOrigin.x + rotatePoint(roleInst.offset, inst!.transform.rotationDeg).x,
            y: this.dragInstanceOrigin.y + rotatePoint(roleInst.offset, inst!.transform.rotationDeg).y,
          }
        : world
      return
    }

    if (instanceEl) {
      const instanceId = instanceEl.getAttribute('data-instance-id')!

      if (isMultiSelectModifier(evt)) {
        // Ctrl/Cmd+click: toggle membership only, never starts a drag (matches
        // the usual "click to add/remove, drag separately to move" convention).
        const next = this.selectedInstanceIds.includes(instanceId)
          ? this.selectedInstanceIds.filter((id) => id !== instanceId)
          : [...this.selectedInstanceIds, instanceId]
        this.setSelectionFromUser(next)
        return
      }

      // Also true for a single already-selected instance that has companion
      // pipe knots from a box-select (see companionPipePoints) — re-running
      // setSelectionFromUser here would wipe them right before they're read
      // below, even though the instance itself doesn't need re-selecting.
      const partOfGroup =
        this.selectedInstanceIds.includes(instanceId) &&
        (this.selectedInstanceIds.length > 1 || this.companionPipePoints.length > 0)

      if (!partOfGroup) {
        this.setSelectionFromUser([instanceId])
      }

      // Also routes a *single* selected instance through the group-drag
      // mechanism whenever it has companion pipe knots (see finalizeBoxSelect)
      // — group-drag is delta-based (origin + delta), which is what lets
      // those knots translate by the same amount the instance does; plain
      // move-instance only ever reports an absolute new position.
      if (this.selectedInstanceIds.length > 1 || this.companionPipePoints.length > 0) {
        this.dragMode = 'move-group'
        this.groupDragStartWorld = world
        this.callbacks.onGroupDragStart(this.selectedInstanceIds, this.companionPipePoints)
      } else {
        this.callbacks.onDragCheckpoint()
        this.dragMode = 'move-instance'
        this.dragInstanceId = instanceId
        this.dragStartScreen = { x: evt.clientX, y: evt.clientY }
        const inst = this.latestInstances.find((i) => i.instanceId === instanceId)
        this.dragInstanceStartPos = inst ? { x: inst.transform.x, y: inst.transform.y } : world
      }
      return
    }

    if (pipeEl) {
      this.setPipeSelectionFromUser([pipeEl.getAttribute('data-pipe-id')!])
      return
    }

    if (shapeEl) {
      const shapeId = shapeEl.getAttribute('data-shape-id')!
      this.setShapeSelectionFromUser([shapeId])
      this.callbacks.onDragCheckpoint()
      this.dragMode = 'move-shape'
      this.dragShapeId = shapeId
      this.dragShapeStartWorld = world
      const shape = this.latestShapes.find((s) => s.instanceId === shapeId)
      this.dragShapeStartPoints = shape ? shape.points.map((p) => ({ ...p })) : []
      return
    }

    if (leaderLineEl) {
      // Selecting the line body itself doesn't start a drag — only the
      // `to`/waypoint handles do (see leaderLinePointEl above); `from` isn't
      // draggable in v1.
      this.setLeaderLineSelectionFromUser([leaderLineEl.getAttribute('data-leader-line-id')!])
      return
    }

    // Locked image layers are pointer-events:none, so this branch can only
    // ever fire for an unlocked one — a locked layer can only be selected
    // via the layers panel (which unlocks it from there, per the design).
    if (layerEl) {
      const layerId = layerEl.getAttribute('data-layer-id')!
      const layer = this.latestLayers.find((l) => l.layerId === layerId)
      this.setLayerSelectionFromUser(layerId)
      this.callbacks.onDragCheckpoint()
      this.dragMode = 'move-layer'
      this.dragLayerId = layerId
      this.dragLayerStartWorld = world
      this.dragLayerStartRect = layer && layer.kind === 'image' ? { x: layer.x, y: layer.y } : { x: 0, y: 0 }
      return
    }

    if (evt.shiftKey) {
      this.dragMode = 'pan'
      this.dragStartScreen = { x: evt.clientX, y: evt.clientY }
      this.dragStartViewBox = { ...this.viewBox }
      return
    }

    this.dragMode = 'box-select'
    this.boxSelectAdditive = isMultiSelectModifier(evt)
    this.boxSelectStartWorld = world
    this.showBoxSelectRect(world, world)
  }

  private onPointerMove = (evt: PointerEvent) => {
    if (this.tool === 'draw-shape' && this.drawingShapeKind === 'polygon' && this.shapeDraftPoints.length > 0) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      this.refreshShapeDraftPreview([...this.shapeDraftPoints, this.snapToGrid(world)])
      return
    }

    if (this.tool === 'draw-shape' && this.shapeDragStart) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      this.refreshShapeDraftPreview([this.shapeDragStart, this.snapToGrid(world)])
      return
    }

    if (this.tool === 'draw-leader-line' && this.leaderLineDraft) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      this.updateLeaderLineDraftPreview(this.resolveLeaderLineAnchor(world))
      return
    }

    if (this.dragMode === 'move-leader-line-point' && this.dragLeaderLineId !== null && this.dragLeaderLinePoint !== null) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      if (this.dragLeaderLinePoint === 'from') {
        // `from` re-anchors onto a different role label if the drag lands on
        // one (elementFromPoint, not evt.target — pointer capture retargets
        // evt.target to the svg root for the duration of this drag, same
        // issue onDoubleClick's own doc comment describes), otherwise docks
        // onto a nearby shape border, otherwise a raw free point.
        const el = document.elementFromPoint(evt.clientX, evt.clientY)
        const roleHit = el ? this.resolveRoleRefAt(el) : null
        const from = roleHit ? roleHit.ref : this.resolveLeaderLineAnchor(world)
        this.callbacks.onLeaderLineFromMoved(this.dragLeaderLineId, from)
        return
      }
      // `to`/waypoint: no grid/align snapping, but does dock onto a nearby shape border.
      this.callbacks.onLeaderLinePointMoved(this.dragLeaderLineId, this.dragLeaderLinePoint, this.resolveLeaderLineAnchor(world))
      return
    }

    if (this.dragMode === 'move-shape' && this.dragShapeId) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      const rawDelta = { x: world.x - this.dragShapeStartWorld.x, y: world.y - this.dragShapeStartWorld.y }
      const delta = evt.shiftKey ? this.constrainDeltaToAxis(rawDelta) : rawDelta
      const snappedDelta = this.snapToGrid(delta)
      const newPoints = this.dragShapeStartPoints.map((p) => ({ x: p.x + snappedDelta.x, y: p.y + snappedDelta.y }))
      this.callbacks.onShapeMoved(this.dragShapeId, newPoints)
      return
    }

    if (this.dragMode === 'move-layer' && this.dragLayerId) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      const rawDelta = { x: world.x - this.dragLayerStartWorld.x, y: world.y - this.dragLayerStartWorld.y }
      const delta = evt.shiftKey ? this.constrainDeltaToAxis(rawDelta) : rawDelta
      const snappedDelta = this.snapToGrid(delta)
      this.callbacks.onLayerMoved(
        this.dragLayerId,
        this.dragLayerStartRect.x + snappedDelta.x,
        this.dragLayerStartRect.y + snappedDelta.y,
      )
      return
    }

    if (this.dragMode === 'resize-layer' && this.dragLayerId && this.dragResizeHandle) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      const snapped = this.snapToGrid(world)
      const start = this.dragResizeStartRect
      // The corner opposite the one being dragged stays fixed in place.
      const anchorX = this.dragResizeHandle.includes('w') ? start.x + start.width : start.x
      const anchorY = this.dragResizeHandle.includes('n') ? start.y + start.height : start.y
      let newWidth = Math.max(this.gridSize, Math.abs(snapped.x - anchorX))
      let newHeight = Math.max(this.gridSize, Math.abs(snapped.y - anchorY))

      // Shift temporarily flips whatever the panel's lock toggle says, same
      // convention as the axis-lock modifier used elsewhere on this canvas.
      const aspectLocked = this.aspectLocked !== evt.shiftKey
      if (aspectLocked && start.width > 0 && start.height > 0) {
        const ratio = start.height / start.width
        if (newWidth * ratio >= newHeight) newHeight = newWidth * ratio
        else newWidth = newHeight / ratio
      }

      const newX = this.dragResizeHandle.includes('w') ? anchorX - newWidth : anchorX
      const newY = this.dragResizeHandle.includes('n') ? anchorY - newHeight : anchorY
      this.callbacks.onLayerResized(this.dragLayerId, { x: newX, y: newY, width: newWidth, height: newHeight })
      return
    }

    if (this.tool === 'draw-pipe' && this.pipeDraft) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      const { point, guideX, guideY } = this.computeDrawPipeTarget(world, evt.shiftKey)
      if (guideX !== null || guideY !== null) this.showAlignGuides(guideX, guideY)
      else this.hideAlignGuides()
      this.updatePipeDraftPreview(point)
      return
    }

    if (this.dragMode === 'move-waypoint' && this.dragPipeId !== null && this.dragWaypointIndex !== null) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      let target: Point
      let guideX: number | null = null
      let guideY: number | null = null
      if (evt.shiftKey) {
        const delta = this.constrainDeltaToAxis({
          x: world.x - this.dragWaypointStartWorld.x,
          y: world.y - this.dragWaypointStartWorld.y,
        })
        target = this.snapToGrid({
          x: this.dragWaypointStartWorld.x + delta.x,
          y: this.dragWaypointStartWorld.y + delta.y,
        })
      } else {
        const refs = this.collectAlignReferences({ pipeId: this.dragPipeId, index: this.dragWaypointIndex })
        const aligned = this.snapWithAlignmentOrGrid(world, refs)
        target = aligned.point
        guideX = aligned.guideX
        guideY = aligned.guideY
      }
      if (guideX !== null || guideY !== null) this.showAlignGuides(guideX, guideY)
      else this.hideAlignGuides()
      this.callbacks.onWaypointMoved(this.dragPipeId, this.dragWaypointIndex, target)
      return
    }

    if (this.dragMode === 'move-pipe-endpoint' && this.dragPipeId !== null && this.dragEndpointSide !== null) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      // Port-snap takes priority (matches draw-pipe's own snap behavior);
      // dropped anywhere else it's a bare grid-snapped free point, which is
      // exactly how disconnecting this end from a component works.
      const hit = this.findPortNear(world, this.dragPipeId)
      const target: PortRef | FreePoint = hit ? hit.ref : this.snapToGrid(world)
      this.callbacks.onPipeEndpointMoved(this.dragPipeId, this.dragEndpointSide, target)
      return
    }

    if (this.dragMode === 'pan') {
      const scale = this.viewBox.w / this.svg.clientWidth
      const dx = (evt.clientX - this.dragStartScreen.x) * scale
      const dy = (evt.clientY - this.dragStartScreen.y) * scale
      this.viewBox = {
        ...this.viewBox,
        x: this.dragStartViewBox.x - dx,
        y: this.dragStartViewBox.y - dy,
      }
      this.applyViewBox()
      this.drawGrid()
      return
    }

    if (this.dragMode === 'move-instance' && this.dragInstanceId) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      let snapped = this.snapToGrid(world)
      if (evt.shiftKey) {
        const delta = this.constrainDeltaToAxis({
          x: snapped.x - this.dragInstanceStartPos.x,
          y: snapped.y - this.dragInstanceStartPos.y,
        })
        snapped = { x: this.dragInstanceStartPos.x + delta.x, y: this.dragInstanceStartPos.y + delta.y }
      }
      this.callbacks.onInstanceMoved(this.dragInstanceId, snapped)
      return
    }

    if (this.dragMode === 'move-role' && this.dragInstanceId && this.dragRole) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      let snapped = this.snapFine(world)
      if (evt.shiftKey) {
        const delta = this.constrainDeltaToAxis({
          x: snapped.x - this.dragRoleStartWorld.x,
          y: snapped.y - this.dragRoleStartWorld.y,
        })
        snapped = { x: this.dragRoleStartWorld.x + delta.x, y: this.dragRoleStartWorld.y + delta.y }
      }
      const relative = {
        x: snapped.x - this.dragInstanceOrigin.x,
        y: snapped.y - this.dragInstanceOrigin.y,
      }
      this.callbacks.onRoleMoved(this.dragInstanceId, this.dragRole, relative)
      return
    }

    if (this.dragMode === 'move-group') {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      const rawDelta = { x: world.x - this.groupDragStartWorld.x, y: world.y - this.groupDragStartWorld.y }
      const delta = evt.shiftKey ? this.constrainDeltaToAxis(rawDelta) : rawDelta
      this.callbacks.onGroupDragMove(this.snapToGrid(delta))
      return
    }

    if (this.dragMode === 'box-select') {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      this.showBoxSelectRect(this.boxSelectStartWorld, world)
      return
    }

    if (this.tool === 'place' && this.previewGroup) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      const snapped = this.snapToGrid(world)
      this.previewGroup.style.display = ''
      this.previewGroup.setAttribute('transform', `translate(${snapped.x},${snapped.y})`)
    }
  }

  private onPointerUp = (evt: PointerEvent) => {
    if (this.tool === 'draw-shape' && this.shapeDragStart && this.drawingShapeKind) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      const snapped = this.snapToGrid(world)
      const points = [this.shapeDragStart, snapped]
      const kind = this.drawingShapeKind
      this.clearShapeDraft()
      if (Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) > 0) {
        this.callbacks.onShapeAdded(kind, points, evt.shiftKey)
      }
    }
    if (this.dragMode === 'box-select') {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      this.finalizeBoxSelect(world)
    }
    if (this.dragMode === 'move-group') {
      this.callbacks.onGroupDragEnd()
    }
    if (this.dragMode === 'move-pipe-endpoint' && this.dragPipeId !== null) {
      this.callbacks.onPipeEndpointDragEnd(this.dragPipeId)
    }
    this.hideAlignGuides()
    const wasEndpointDrag = this.dragMode === 'move-pipe-endpoint'
    this.dragMode = 'none'
    this.dragInstanceId = null
    this.dragRole = null
    this.dragEndpointSide = null
    if (wasEndpointDrag) this.refreshPortMarkers()
    this.dragPipeId = null
    this.dragWaypointIndex = null
    this.dragShapeId = null
    this.dragLeaderLineId = null
    this.dragLeaderLinePoint = null
    this.dragLayerId = null
    this.dragResizeHandle = null
  }

  private showBoxSelectRect(a: Point, b: Point) {
    if (!this.boxSelectRectEl) {
      const rect = document.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('class', 'gv-box-select')
      rect.style.pointerEvents = 'none'
      this.overlayLayer.appendChild(rect)
      this.boxSelectRectEl = rect
    }
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const w = Math.abs(a.x - b.x)
    const h = Math.abs(a.y - b.y)
    this.boxSelectRectEl.setAttribute('x', String(x))
    this.boxSelectRectEl.setAttribute('y', String(y))
    this.boxSelectRectEl.setAttribute('width', String(w))
    this.boxSelectRectEl.setAttribute('height', String(h))
    this.boxSelectRectEl.style.display = ''
  }

  /**
   * Instances take priority (and are the only category additive/Ctrl+drag
   * applies to, same as before) — but a box that catches no instance now
   * also tries pipes, then leader lines, matching on any of their points
   * (endpoints/waypoints/"knots") falling inside the box, so either can be
   * multi-selected by dragging over them instead of one at a time.
   */
  private finalizeBoxSelect(endWorld: Point) {
    const minX = Math.min(this.boxSelectStartWorld.x, endWorld.x)
    const maxX = Math.max(this.boxSelectStartWorld.x, endWorld.x)
    const minY = Math.min(this.boxSelectStartWorld.y, endWorld.y)
    const maxY = Math.max(this.boxSelectStartWorld.y, endWorld.y)
    const within = (p: Point) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY

    const matchedInstances = this.latestInstances.filter((inst) => within(inst.transform)).map((i) => i.instanceId)

    if (matchedInstances.length > 0 || this.boxSelectAdditive) {
      const nextSelection = this.boxSelectAdditive
        ? Array.from(new Set([...this.selectedInstanceIds, ...matchedInstances]))
        : matchedInstances
      this.setSelectionFromUser(nextSelection)
      if (!this.boxSelectAdditive) {
        this.setPipeSelectionFromUser([])
        this.setLeaderLineSelectionFromUser([])
      }
      // "Mark knots like elements": a free pipe knot (interior waypoint, or
      // a disconnected from/to end — an *attached* end already tracks its
      // component live and needs no help) caught in the same box as an
      // instance travels with it on the very next drag. setSelectionFromUser
      // (just above) clears this field first, so it's safe to set it after.
      if (matchedInstances.length > 0) {
        for (const pipe of this.latestPipes) {
          const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers)
          if (!points) continue
          points.forEach((pos, idx) => {
            if (!within(pos)) return
            if (idx === 0) {
              if (!isPortRef(pipe.fromPort)) this.companionPipePoints.push({ pipeId: pipe.instanceId, point: 'from' })
            } else if (idx === points.length - 1) {
              if (!isPortRef(pipe.toPort)) this.companionPipePoints.push({ pipeId: pipe.instanceId, point: 'to' })
            } else {
              this.companionPipePoints.push({ pipeId: pipe.instanceId, point: idx - 1 })
            }
          })
        }
      }
      this.refreshCompanionPipePointHandles()
      if (this.boxSelectRectEl) this.boxSelectRectEl.style.display = 'none'
      return
    }

    const matchedPipes = this.latestPipes
      .filter((pipe) => {
        const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers)
        return points?.some(within) ?? false
      })
      .map((p) => p.instanceId)

    if (matchedPipes.length > 0) {
      this.setPipeSelectionFromUser(matchedPipes)
      this.setLeaderLineSelectionFromUser([])
      if (this.boxSelectRectEl) this.boxSelectRectEl.style.display = 'none'
      return
    }

    const matchedLeaderLines = this.latestLeaderLines
      .filter((line) => {
        const points = getLeaderLinePoints(line, this.latestInstances)
        return points?.some(within) ?? false
      })
      .map((l) => l.instanceId)

    if (matchedLeaderLines.length > 0) {
      this.setLeaderLineSelectionFromUser(matchedLeaderLines)
      this.setPipeSelectionFromUser([])
    } else {
      // Nothing in the box at all — clears every selection category, same as before.
      this.setSelectionFromUser([])
      this.setPipeSelectionFromUser([])
      this.setLeaderLineSelectionFromUser([])
    }
    if (this.boxSelectRectEl) this.boxSelectRectEl.style.display = 'none'
  }

  /**
   * User-driven selection (pointer click / box-select): also notifies the
   * callback. Drops any companion pipe knots from a previous box-select —
   * finalizeBoxSelect re-populates them right after calling this when it
   * has some, so they only ever survive into the very next drag they were
   * computed for, never a later, unrelated one.
   */
  private setSelectionFromUser(instanceIds: string[]) {
    // Any general (re-)selection drops a stale role sub-selection; callers
    // that click a role re-apply it right after via setRoleSelectionFromUser.
    this.setRoleSelectionFromUser(null)
    this.applySelectionHighlight(instanceIds)
    this.companionPipePoints = []
    this.refreshCompanionPipePointHandles()
    this.callbacks.onSelectionChanged(instanceIds)
  }

  /** External sync (e.g. selection changed from a properties panel): highlight only, no callback. */
  setSelection(instanceIds: string[]) {
    this.applySelectionHighlight(instanceIds)
  }

  private setRoleSelectionFromUser(selection: RoleSelection | null) {
    this.applyRoleSelectionHighlight(selection)
    this.callbacks.onRoleSelected(selection)
  }

  /** External sync (e.g. cleared via Escape): highlight only, no callback. */
  setRoleSelection(selection: RoleSelection | null) {
    this.applyRoleSelectionHighlight(selection)
  }

  private applyRoleSelectionHighlight(selection: RoleSelection | null) {
    if (this.selectedRole) {
      this.instanceEls
        .get(this.selectedRole.instanceId)
        ?.querySelector(`[data-role="${this.selectedRole.role}"]`)
        ?.classList.remove('gv-role-selected')
    }
    this.selectedRole = selection
    if (selection) {
      this.instanceEls
        .get(selection.instanceId)
        ?.querySelector(`[data-role="${selection.role}"]`)
        ?.classList.add('gv-role-selected')
    }
  }

  private applySelectionHighlight(instanceIds: string[]) {
    for (const id of this.selectedInstanceIds) {
      if (!instanceIds.includes(id)) this.instanceEls.get(id)?.classList.remove('gv-selected')
    }
    for (const id of instanceIds) {
      this.instanceEls.get(id)?.classList.add('gv-selected')
    }
    this.selectedInstanceIds = instanceIds
    this.drawSelectionConnectors()
    this.refreshDragHandles()
  }

  /**
   * One draggable handle per selected instance, centered on that instance's
   * own body bounding box (same technique as the export viewBox/auto-route
   * obstacle sizing: rotate localBodyCorners, translate by the transform).
   * Deliberately just a plain circle tagged data-instance-id — no new
   * dragMode or pointerdown branch needed, it's picked up by the existing
   * instanceEl handling (single move-instance, or move-group when multiple
   * are selected) exactly like clicking the instance body itself would.
   */
  private refreshDragHandles() {
    while (this.dragHandlesGroup.firstChild) {
      this.dragHandlesGroup.removeChild(this.dragHandlesGroup.firstChild)
    }
    for (const instanceId of this.selectedInstanceIds) {
      const instance = this.latestInstances.find((i) => i.instanceId === instanceId)
      if (!instance) continue
      const def = getComponentType(instance.componentTypeId)
      const { x, y, rotationDeg } = instance.transform

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const corner of resolveLocalBodyCorners(def, instance)) {
        const r = rotatePoint(corner, rotationDeg)
        minX = Math.min(minX, r.x)
        maxX = Math.max(maxX, r.x)
        minY = Math.min(minY, r.y)
        maxY = Math.max(maxY, r.y)
      }
      const cx = x + (Number.isFinite(minX) ? (minX + maxX) / 2 : 0)
      const cy = y + (Number.isFinite(minY) ? (minY + maxY) / 2 : 0)

      const g = document.createElementNS(SVG_NS, 'g')
      g.setAttribute('data-instance-id', instanceId)
      g.setAttribute('class', 'gv-drag-handle')

      const circle = document.createElementNS(SVG_NS, 'circle')
      circle.setAttribute('cx', String(cx))
      circle.setAttribute('cy', String(cy))
      circle.setAttribute('r', '9')
      g.appendChild(circle)

      const glyph = document.createElementNS(SVG_NS, 'path')
      glyph.setAttribute('d', `M${cx - 5} ${cy} L${cx + 5} ${cy} M${cx} ${cy - 5} L${cx} ${cy + 5}`)
      glyph.setAttribute('class', 'gv-drag-handle-glyph')
      g.appendChild(glyph)

      this.dragHandlesGroup.appendChild(g)
    }
  }

  private setPipeSelectionFromUser(pipeIds: string[]) {
    this.setRoleSelectionFromUser(null)
    this.applyPipeSelectionHighlight(pipeIds)
    this.callbacks.onPipeSelectionChanged(pipeIds)
  }

  /** External sync: highlight only, no callback. */
  setPipeSelection(pipeIds: string[]) {
    this.applyPipeSelectionHighlight(pipeIds)
  }

  private applyPipeSelectionHighlight(pipeIds: string[]) {
    for (const id of this.selectedPipeIds) {
      if (!pipeIds.includes(id)) this.pipeEls.get(id)?.classList.remove('gv-selected')
    }
    for (const id of pipeIds) {
      this.pipeEls.get(id)?.classList.add('gv-selected')
    }
    this.selectedPipeIds = pipeIds
    this.refreshWaypointHandles()
  }

  private setShapeSelectionFromUser(shapeIds: string[]) {
    this.setRoleSelectionFromUser(null)
    this.applyShapeSelectionHighlight(shapeIds)
    this.callbacks.onShapeSelectionChanged(shapeIds)
  }

  /** External sync: highlight only, no callback. */
  setShapeSelection(shapeIds: string[]) {
    this.applyShapeSelectionHighlight(shapeIds)
  }

  private applyShapeSelectionHighlight(shapeIds: string[]) {
    for (const id of this.selectedShapeIds) {
      if (!shapeIds.includes(id)) this.shapeEls.get(id)?.classList.remove('gv-selected')
    }
    for (const id of shapeIds) {
      this.shapeEls.get(id)?.classList.add('gv-selected')
    }
    this.selectedShapeIds = shapeIds
  }

  private setLeaderLineSelectionFromUser(leaderLineIds: string[]) {
    this.setRoleSelectionFromUser(null)
    this.applyLeaderLineSelectionHighlight(leaderLineIds)
    this.callbacks.onLeaderLineSelectionChanged(leaderLineIds)
  }

  /** External sync: highlight only, no callback. */
  setLeaderLineSelection(leaderLineIds: string[]) {
    this.applyLeaderLineSelectionHighlight(leaderLineIds)
  }

  private applyLeaderLineSelectionHighlight(leaderLineIds: string[]) {
    for (const id of this.selectedLeaderLineIds) {
      if (!leaderLineIds.includes(id)) this.leaderLineEls.get(id)?.classList.remove('gv-selected')
    }
    for (const id of leaderLineIds) {
      this.leaderLineEls.get(id)?.classList.add('gv-selected')
    }
    this.selectedLeaderLineIds = leaderLineIds
    this.refreshLeaderLineHandles()
  }

  /** One draggable handle per interior waypoint, plus both the `from` and `to` endpoints, of the single selected leader line. */
  private refreshLeaderLineHandles() {
    while (this.leaderLineHandlesGroup.firstChild) {
      this.leaderLineHandlesGroup.removeChild(this.leaderLineHandlesGroup.firstChild)
    }
    if (this.selectedLeaderLineIds.length !== 1) return
    const line = this.latestLeaderLines.find((l) => l.instanceId === this.selectedLeaderLineIds[0])
    if (!line) return

    const addHandle = (pos: Point, pointAttr: string) => {
      const c = document.createElementNS(SVG_NS, 'circle')
      c.setAttribute('cx', String(pos.x))
      c.setAttribute('cy', String(pos.y))
      c.setAttribute('r', '5')
      c.setAttribute('class', 'gv-waypoint-handle')
      c.setAttribute('data-leader-line-id', line.instanceId)
      c.setAttribute('data-leader-line-point', pointAttr)
      this.leaderLineHandlesGroup.appendChild(c)
    }
    const fromPos = resolveLeaderLineFromPosition(line.from, this.latestInstances)
    if (fromPos) addHandle(fromPos, 'from')
    line.waypoints.forEach((wp, index) => addHandle(wp, String(index)))
    addHandle(line.to, 'to')
  }

  private setLayerSelectionFromUser(layerId: string | null) {
    this.setRoleSelectionFromUser(null)
    this.applyLayerSelectionHighlight(layerId)
    this.callbacks.onLayerSelected(layerId)
  }

  /** External sync (e.g. selected via the layers panel): highlight only, no callback. */
  setLayerSelection(layerId: string | null) {
    this.applyLayerSelectionHighlight(layerId)
  }

  private applyLayerSelectionHighlight(layerId: string | null) {
    if (this.selectedLayerId) {
      this.imageLayerEls.get(this.selectedLayerId)?.classList.remove('gv-selected')
    }
    this.selectedLayerId = layerId
    if (layerId) {
      this.imageLayerEls.get(layerId)?.classList.add('gv-selected')
    }
    // The selected layer's own connection points are shown/hidden based on selection.
    this.refreshPortMarkers()
    this.refreshLayerResizeHandles()
  }

  private setWaypointSelectionFromUser(selection: WaypointSelection | null) {
    this.selectedWaypoint = selection
    this.refreshWaypointHandles()
    this.callbacks.onWaypointSelected(selection)
  }

  /** External sync: highlight only, no callback. */
  setWaypointSelection(selection: WaypointSelection | null) {
    this.selectedWaypoint = selection
    this.refreshWaypointHandles()
  }

  private refreshWaypointHandles() {
    while (this.waypointHandlesGroup.firstChild) {
      this.waypointHandlesGroup.removeChild(this.waypointHandlesGroup.firstChild)
    }
    if (this.selectedPipeIds.length !== 1) return
    const pipe = this.latestPipes.find((p) => p.instanceId === this.selectedPipeIds[0])
    if (!pipe) return

    pipe.waypoints.forEach((wp, index) => {
      const c = document.createElementNS(SVG_NS, 'circle')
      c.setAttribute('cx', String(wp.x))
      c.setAttribute('cy', String(wp.y))
      c.setAttribute('r', '5')
      c.setAttribute('class', 'gv-waypoint-handle')
      c.setAttribute('data-pipe-id', pipe.instanceId)
      c.setAttribute('data-waypoint-index', String(index))
      if (
        this.selectedWaypoint &&
        this.selectedWaypoint.pipeId === pipe.instanceId &&
        this.selectedWaypoint.index === index
      ) {
        c.classList.add('gv-waypoint-selected')
      }
      this.waypointHandlesGroup.appendChild(c)
    })

    // The pipe's actual from/to connection points, draggable same as an
    // interior waypoint — dropped near another valid target it reattaches
    // there, dropped in empty space it becomes a fixed free point
    // (deliberately disconnecting that end from whatever it was attached to).
    const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers)
    if (points && points.length >= 2) {
      const ends: Array<{ side: PipeEndpointSide; pos: Point }> = [
        { side: 'from', pos: points[0] },
        { side: 'to', pos: points[points.length - 1] },
      ]
      for (const { side, pos } of ends) {
        const c = document.createElementNS(SVG_NS, 'circle')
        c.setAttribute('cx', String(pos.x))
        c.setAttribute('cy', String(pos.y))
        c.setAttribute('r', '5')
        c.setAttribute('class', 'gv-waypoint-handle gv-pipe-endpoint-handle')
        c.setAttribute('data-pipe-id', pipe.instanceId)
        c.setAttribute('data-pipe-endpoint', side)
        this.waypointHandlesGroup.appendChild(c)
      }
    }
  }

  /**
   * Visible circles (same look as an ordinary waypoint handle, including the
   * "move" cursor) for the free pipe knots currently riding along with a
   * box-selected group — the user asked to actually see which knots are
   * "marked" this way, not just have them silently move on the next drag.
   * Clicking one directly starts the same group-drag as clicking the
   * instance/its drag-handle would (see the pointerdown handling for
   * data-companion-pipe-point).
   */
  private refreshCompanionPipePointHandles() {
    while (this.companionPointsGroup.firstChild) {
      this.companionPointsGroup.removeChild(this.companionPointsGroup.firstChild)
    }
    for (const ref of this.companionPipePoints) {
      const pipe = this.latestPipes.find((p) => p.instanceId === ref.pipeId)
      if (!pipe) continue
      let pos: Point | null = null
      if (ref.point === 'from') {
        pos = isPortRef(pipe.fromPort) ? null : pipe.fromPort
      } else if (ref.point === 'to') {
        pos = isPortRef(pipe.toPort) ? null : pipe.toPort
      } else {
        pos = pipe.waypoints[ref.point] ?? null
      }
      if (!pos) continue

      const c = document.createElementNS(SVG_NS, 'circle')
      c.setAttribute('cx', String(pos.x))
      c.setAttribute('cy', String(pos.y))
      c.setAttribute('r', '5')
      c.setAttribute('class', 'gv-waypoint-handle')
      c.setAttribute('data-companion-pipe-point', 'true')
      c.setAttribute('data-pipe-id', ref.pipeId)
      c.setAttribute('data-companion-point', String(ref.point))
      this.companionPointsGroup.appendChild(c)
    }
  }

  /**
   * Corner drag-handles on the selected image layer, for mouse resizing.
   * Only shown while unlocked (locked layers are canvas-read-only, same rule
   * as move-dragging — resizing while locked still works via the properties
   * panel's width/height fields, just not from the canvas).
   */
  private refreshLayerResizeHandles() {
    while (this.layerResizeHandlesGroup.firstChild) {
      this.layerResizeHandlesGroup.removeChild(this.layerResizeHandlesGroup.firstChild)
    }
    if (!this.selectedLayerId) return
    const layer = this.latestLayers.find((l) => l.layerId === this.selectedLayerId)
    if (!layer || layer.kind !== 'image' || layer.locked) return

    const corners: { handle: ResizeHandle; pos: Point; cursor: string }[] = [
      { handle: 'nw', pos: { x: layer.x, y: layer.y }, cursor: 'nwse-resize' },
      { handle: 'ne', pos: { x: layer.x + layer.width, y: layer.y }, cursor: 'nesw-resize' },
      { handle: 'sw', pos: { x: layer.x, y: layer.y + layer.height }, cursor: 'nesw-resize' },
      { handle: 'se', pos: { x: layer.x + layer.width, y: layer.y + layer.height }, cursor: 'nwse-resize' },
    ]
    const size = this.worldThreshold(10)
    for (const c of corners) {
      const rect = document.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('x', String(c.pos.x - size / 2))
      rect.setAttribute('y', String(c.pos.y - size / 2))
      rect.setAttribute('width', String(size))
      rect.setAttribute('height', String(size))
      rect.setAttribute('class', 'gv-layer-resize-handle')
      rect.setAttribute('data-resize-handle', c.handle)
      rect.setAttribute('data-layer-id', layer.layerId)
      rect.style.cursor = c.cursor
      this.layerResizeHandlesGroup.appendChild(rect)
    }
  }

  /**
   * Thin dashed lines from each selected instance's origin to its enabled
   * name/value/setpoint labels — the link stays visible even after a label
   * has been dragged away from its default position (see onRoleMoved).
   */
  private drawSelectionConnectors() {
    while (this.connectorsGroup.firstChild) {
      this.connectorsGroup.removeChild(this.connectorsGroup.firstChild)
    }
    for (const instanceId of this.selectedInstanceIds) {
      const instance = this.latestInstances.find((i) => i.instanceId === instanceId)
      if (!instance) continue

      const { x, y, rotationDeg } = instance.transform
      for (const role of instance.roles) {
        if (role.role === 'indicator' || !role.enabled) continue
        const rotated = rotatePoint(role.offset, rotationDeg)
        const line = document.createElementNS(SVG_NS, 'line')
        line.setAttribute('x1', String(x))
        line.setAttribute('y1', String(y))
        line.setAttribute('x2', String(x + rotated.x))
        line.setAttribute('y2', String(y + rotated.y))
        line.setAttribute('class', 'gv-connector-line')
        line.style.pointerEvents = 'none'
        this.connectorsGroup.appendChild(line)
      }
    }
  }

  /** Reconciles the DOM with the given instance list (add/update/remove groups). */
  syncInstances(instances: ComponentInstance[]) {
    this.latestInstances = instances
    const seen = new Set<string>()

    for (const instance of instances) {
      seen.add(instance.instanceId)
      const def = getComponentType(instance.componentTypeId)
      const version = String(getComponentTypeVersion(instance.componentTypeId))
      let group = this.instanceEls.get(instance.instanceId)
      // A custom type's geometry may have been edited in the Library Editor
      // (same typeId, bumped version) — rebuild already-placed instances of
      // it instead of leaving their DOM stuck on the old render().
      if (group && group.getAttribute('data-type-version') !== version) {
        group.remove()
        this.instanceEls.delete(instance.instanceId)
        group = undefined
      }
      if (!group) {
        group = document.createElementNS(SVG_NS, 'g')
        group.setAttribute('data-instance-id', instance.instanceId)
        group.setAttribute('data-type-version', version)
        this.contentLayer.appendChild(group)
        this.instanceEls.set(instance.instanceId, group)
        def.render(group)
        group.classList.toggle('gv-selected', this.selectedInstanceIds.includes(instance.instanceId))
      }
      def.update(group, instance)
    }

    for (const [instanceId, el] of this.instanceEls) {
      if (!seen.has(instanceId)) {
        el.remove()
        this.instanceEls.delete(instanceId)
      }
    }

    if (this.selectedInstanceIds.some((id) => !seen.has(id))) {
      this.selectedInstanceIds = this.selectedInstanceIds.filter((id) => seen.has(id))
    }
    if (this.selectedRole && !seen.has(this.selectedRole.instanceId)) {
      this.selectedRole = null
    }
    this.drawSelectionConnectors()
    this.refreshDragHandles()
    this.refreshPortMarkers()
  }

  /**
   * Reconciles pipe DOM. Must be re-run whenever instances change too (not
   * just pipes), since port positions — and therefore pipe geometry — move
   * with their owning instance.
   */
  syncPipes(pipes: PipeInstance[], instances: ComponentInstance[]) {
    this.latestPipes = pipes
    const seen = new Set<string>()
    const pointsByPipe = new Map<string, Point[]>()
    const displayPointsByPipe = new Map<string, Point[]>()
    for (const pipe of pipes) {
      const pts = getPipePoints(pipe, instances, pipes, this.latestLayers)
      if (pts) {
        pointsByPipe.set(pipe.instanceId, pts)
        displayPointsByPipe.set(pipe.instanceId, getDisplayPoints(pipe, pts))
      }
    }

    for (const pipe of pipes) {
      seen.add(pipe.instanceId)
      let group = this.pipeEls.get(pipe.instanceId)
      if (!group) {
        group = document.createElementNS(SVG_NS, 'g')
        group.setAttribute('data-pipe-id', pipe.instanceId)
        this.pipesLayer.appendChild(group)
        this.pipeEls.set(pipe.instanceId, group)

        const linePath = document.createElementNS(SVG_NS, 'path')
        linePath.setAttribute('class', 'gv-pipe-line')
        linePath.setAttribute('fill', 'none')
        group.appendChild(linePath)

        const hitPath = document.createElementNS(SVG_NS, 'path')
        hitPath.setAttribute('class', 'gv-pipe-hit')
        hitPath.setAttribute('fill', 'none')
        group.appendChild(hitPath)

        const indicatorCircle = document.createElementNS(SVG_NS, 'circle')
        indicatorCircle.setAttribute('class', 'gv-pipe-indicator')
        indicatorCircle.setAttribute('r', '5')
        indicatorCircle.setAttribute('fill', 'black')
        group.appendChild(indicatorCircle)
      }

      const points = pointsByPipe.get(pipe.instanceId)
      const displayPoints = displayPointsByPipe.get(pipe.instanceId)
      if (!points || !displayPoints) {
        group.style.display = 'none'
        continue
      }
      group.style.display = ''

      const linePath = group.querySelector<SVGPathElement>('.gv-pipe-line')!
      const hitPath = group.querySelector<SVGPathElement>('.gv-pipe-hit')!
      const indicatorCircle = group.querySelector<SVGCircleElement>('.gv-pipe-indicator')!

      const d =
        pipe.routingMode === 'curved'
          ? curvedPathD(points)
          : straightPathDWithHops(
              displayPoints,
              computeHopsForPipe(pipe.instanceId, pipes, displayPointsByPipe),
            )
      linePath.setAttribute('d', d)
      hitPath.setAttribute('d', d)
      linePath.setAttribute('stroke', resolvePipeColor(pipe))

      indicatorCircle.style.display = pipe.indicatorEnabled ? '' : 'none'
      indicatorCircle.id = `${resolveIndicatorTag(pipe)}_indicator`
      const mid = midpoint(displayPoints)
      indicatorCircle.setAttribute('cx', String(mid.x))
      indicatorCircle.setAttribute('cy', String(mid.y))
    }

    for (const [pipeId, el] of this.pipeEls) {
      if (!seen.has(pipeId)) {
        el.remove()
        this.pipeEls.delete(pipeId)
      }
    }

    if (this.selectedPipeIds.some((id) => !seen.has(id))) {
      this.selectedPipeIds = this.selectedPipeIds.filter((id) => seen.has(id))
    }
    if (this.selectedWaypoint && !seen.has(this.selectedWaypoint.pipeId)) {
      this.selectedWaypoint = null
    }
    this.refreshWaypointHandles()
    this.refreshCompanionPipePointHandles()
  }

  /**
   * Reconciles background image layers (add/update/remove <image> elements,
   * bottom of the z-order) and toggles the vector content's visibility per
   * the "default" layer's own visible flag — hiding it lets the user see
   * just the reference image underneath while tracing over it.
   */
  syncLayers(layers: Layer[]) {
    this.latestLayers = layers
    const seen = new Set<string>()
    for (const layer of layers) {
      if (layer.kind !== 'image') continue
      seen.add(layer.layerId)
      let img = this.imageLayerEls.get(layer.layerId)
      if (!img) {
        img = document.createElementNS(SVG_NS, 'image')
        img.setAttribute('data-layer-id', layer.layerId)
        this.backgroundLayer.appendChild(img)
        this.imageLayerEls.set(layer.layerId, img)
      }
      img.style.display = layer.visible ? '' : 'none'
      img.setAttribute('x', String(layer.x))
      img.setAttribute('y', String(layer.y))
      img.setAttribute('width', String(layer.width))
      img.setAttribute('height', String(layer.height))
      img.setAttribute('opacity', String(layer.opacity))
      img.setAttribute('href', layer.src)
      img.classList.toggle('gv-selected', layer.layerId === this.selectedLayerId)
      // Locked (the default) means non-interactive — a reference image
      // shouldn't intercept clicks meant for the grid/content underneath or
      // on top, and can then only be selected/unlocked via the layers panel.
      img.style.pointerEvents = layer.locked ? 'none' : 'auto'
      img.style.cursor = layer.locked ? 'default' : 'move'
    }
    for (const [id, el] of this.imageLayerEls) {
      if (!seen.has(id)) {
        el.remove()
        this.imageLayerEls.delete(id)
      }
    }
    if (this.selectedLayerId && !seen.has(this.selectedLayerId)) {
      this.selectedLayerId = null
    }

    const vectorLayer = layers.find((l) => l.kind === 'vector')
    const vectorVisible = vectorLayer ? vectorLayer.visible : true
    this.contentLayer.style.display = vectorVisible ? '' : 'none'
    this.pipesLayer.style.display = vectorVisible ? '' : 'none'
    this.shapesLayer.style.display = vectorVisible ? '' : 'none'

    this.refreshPortMarkers()
    this.refreshLayerResizeHandles()
    // A pipe may be anchored to an image connection point — if this layer
    // sync is what just brought those coordinates in (or moved them), pipe
    // geometry needs to be recomputed too, not just wait for its own next
    // unrelated instances/pipes change.
    this.syncPipes(this.latestPipes, this.latestInstances)
  }

  /** Reconciles annotation-shape DOM (add/update/remove groups) — purely decorative, no geometry dependency on instances/pipes. */
  syncFreeShapes(shapes: FreeShape[]) {
    this.latestShapes = shapes
    const seen = new Set<string>()

    for (const shape of shapes) {
      seen.add(shape.instanceId)
      let group = this.shapeEls.get(shape.instanceId)
      if (!group) {
        group = document.createElementNS(SVG_NS, 'g')
        group.setAttribute('data-shape-id', shape.instanceId)
        group.style.cursor = 'move'
        this.shapesLayer.appendChild(group)
        this.shapeEls.set(shape.instanceId, group)
      }
      this.renderShapeInto(group, shape)
    }

    for (const [id, el] of this.shapeEls) {
      if (!seen.has(id)) {
        el.remove()
        this.shapeEls.delete(id)
      }
    }

    if (this.selectedShapeIds.some((id) => !seen.has(id))) {
      this.selectedShapeIds = this.selectedShapeIds.filter((id) => seen.has(id))
    }
  }

  /**
   * Reconciles leader-line DOM. Must be re-run whenever instances change too
   * (not just leader lines), since a role-anchored `from` tracks its owning
   * instance's position — same reason syncPipes needs both.
   */
  syncLeaderLines(leaderLines: LeaderLine[], instances: ComponentInstance[]) {
    this.latestLeaderLines = leaderLines
    const seen = new Set<string>()

    for (const line of leaderLines) {
      seen.add(line.instanceId)
      let group = this.leaderLineEls.get(line.instanceId)
      if (!group) {
        group = document.createElementNS(SVG_NS, 'g')
        group.setAttribute('data-leader-line-id', line.instanceId)
        this.leaderLinesLayer.appendChild(group)
        this.leaderLineEls.set(line.instanceId, group)

        const hitPath = document.createElementNS(SVG_NS, 'path')
        hitPath.setAttribute('class', 'gv-leader-line-hit')
        hitPath.setAttribute('fill', 'none')
        group.appendChild(hitPath)

        const linePath = document.createElementNS(SVG_NS, 'path')
        linePath.setAttribute('class', 'gv-leader-line')
        linePath.setAttribute('fill', 'none')
        linePath.style.pointerEvents = 'none'
        group.appendChild(linePath)

        const dot = document.createElementNS(SVG_NS, 'circle')
        dot.setAttribute('class', 'gv-leader-line-dot')
        dot.setAttribute('r', '3')
        dot.style.pointerEvents = 'none'
        group.appendChild(dot)
      }

      const points = getLeaderLinePoints(line, instances)
      if (!points) {
        group.style.display = 'none'
        continue
      }
      group.style.display = ''

      const d = leaderLinePathD(points)
      group.querySelector<SVGPathElement>('.gv-leader-line-hit')!.setAttribute('d', d)
      group.querySelector<SVGPathElement>('.gv-leader-line')!.setAttribute('d', d)
      const last = points[points.length - 1]
      const dot = group.querySelector<SVGCircleElement>('.gv-leader-line-dot')!
      dot.setAttribute('cx', String(last.x))
      dot.setAttribute('cy', String(last.y))

      group.classList.toggle('gv-selected', this.selectedLeaderLineIds.includes(line.instanceId))
    }

    for (const [id, el] of this.leaderLineEls) {
      if (!seen.has(id)) {
        el.remove()
        this.leaderLineEls.delete(id)
      }
    }

    if (this.selectedLeaderLineIds.some((id) => !seen.has(id))) {
      this.selectedLeaderLineIds = this.selectedLeaderLineIds.filter((id) => seen.has(id))
    }
    this.refreshLeaderLineHandles()
  }

  private renderShapeInto(group: SVGGElement, shape: FreeShape) {
    while (group.firstChild) group.removeChild(group.firstChild)
    const fill = shape.style.fill ?? 'none'

    if (shape.kind === 'rect') {
      const { x, y, width, height } = rectAttrs(shape.points)
      const el = document.createElementNS(SVG_NS, 'rect')
      el.setAttribute('x', String(x))
      el.setAttribute('y', String(y))
      el.setAttribute('width', String(width))
      el.setAttribute('height', String(height))
      el.setAttribute('fill', fill)
      el.setAttribute('stroke', shape.style.stroke)
      el.setAttribute('stroke-width', String(shape.style.strokeWidth))
      // Makes the whole interior clickable even when fill="none" (default
      // SVG hit-testing otherwise only responds to painted pixels).
      el.setAttribute('pointer-events', 'all')
      group.appendChild(el)
    } else if (shape.kind === 'ellipse') {
      const { cx, cy, rx, ry } = ellipseAttrs(shape.points)
      const el = document.createElementNS(SVG_NS, 'ellipse')
      el.setAttribute('cx', String(cx))
      el.setAttribute('cy', String(cy))
      el.setAttribute('rx', String(rx))
      el.setAttribute('ry', String(ry))
      el.setAttribute('fill', fill)
      el.setAttribute('stroke', shape.style.stroke)
      el.setAttribute('stroke-width', String(shape.style.strokeWidth))
      el.setAttribute('pointer-events', 'all')
      group.appendChild(el)
    } else if (shape.kind === 'line') {
      const [a, b] = shape.points
      // Invisible wide-stroke duplicate so a thin line stays easy to click (same trick as pipes' .gv-pipe-hit).
      const hit = document.createElementNS(SVG_NS, 'line')
      hit.setAttribute('x1', String(a.x))
      hit.setAttribute('y1', String(a.y))
      hit.setAttribute('x2', String(b.x))
      hit.setAttribute('y2', String(b.y))
      hit.setAttribute('stroke', 'transparent')
      hit.setAttribute('stroke-width', String(Math.max(shape.style.strokeWidth + 10, 14)))
      group.appendChild(hit)

      const el = document.createElementNS(SVG_NS, 'line')
      el.setAttribute('x1', String(a.x))
      el.setAttribute('y1', String(a.y))
      el.setAttribute('x2', String(b.x))
      el.setAttribute('y2', String(b.y))
      el.setAttribute('stroke', shape.style.stroke)
      el.setAttribute('stroke-width', String(shape.style.strokeWidth))
      el.style.pointerEvents = 'none'
      group.appendChild(el)
    } else if (shape.kind === 'polygon') {
      const el = document.createElementNS(SVG_NS, 'polygon')
      el.setAttribute('points', pointsAttr(shape.points))
      el.setAttribute('fill', fill)
      el.setAttribute('stroke', shape.style.stroke)
      el.setAttribute('stroke-width', String(shape.style.strokeWidth))
      el.setAttribute('pointer-events', 'all')
      group.appendChild(el)
    } else if (shape.kind === 'text') {
      const [a] = shape.points
      const fontSize = shape.fontSize ?? DEFAULT_FONT_SIZE
      const lines = splitTextLines(shape.text)
      const anchor = textAnchorFor(shape.textAlign)
      const lineHeight = fontSize * TEXT_LINE_HEIGHT

      // <text> only hit-tests painted glyphs — add an invisible rect behind
      // it, like component name labels do. Sized/positioned for the widest
      // line and the full multi-line height, anchored per textAlign since a
      // centered/right-aligned block extends to the *left* of `a.x` too.
      const hit = document.createElementNS(SVG_NS, 'rect')
      const longest = Math.max(...lines.map((l) => l.length), 4)
      const approxWidth = longest * fontSize * 0.6
      const hitX = anchor === 'middle' ? a.x - approxWidth / 2 : anchor === 'end' ? a.x - approxWidth : a.x - 2
      hit.setAttribute('x', String(hitX))
      hit.setAttribute('y', String(a.y - fontSize))
      hit.setAttribute('width', String(approxWidth + 2))
      hit.setAttribute('height', String(lineHeight * (lines.length - 1) + fontSize * 1.3))
      hit.setAttribute('fill', 'transparent')
      group.appendChild(hit)

      const el = document.createElementNS(SVG_NS, 'text')
      el.setAttribute('font-family', 'Arial')
      el.setAttribute('font-size', String(fontSize))
      el.setAttribute('text-anchor', anchor)
      el.setAttribute('fill', shape.style.stroke)
      el.style.pointerEvents = 'none'
      lines.forEach((line, i) => {
        const tspan = document.createElementNS(SVG_NS, 'tspan')
        tspan.setAttribute('x', String(a.x))
        tspan.setAttribute('y', String(a.y + i * lineHeight))
        tspan.textContent = line
        el.appendChild(tspan)
      })
      group.appendChild(el)
    }

    group.classList.toggle('gv-selected', this.selectedShapeIds.includes(shape.instanceId))
  }
}

/** Live-preview outline for a shape being drawn — same idea as the real shapes but always unfilled/dashed. */
function shapeOutlinePathD(kind: FreeShapeKind, points: Point[]): string {
  if (points.length < 2) return ''
  if (kind === 'rect') {
    const { x, y, width, height } = rectAttrs(points)
    return `M${x} ${y} L${x + width} ${y} L${x + width} ${y + height} L${x} ${y + height} Z`
  }
  if (kind === 'ellipse') {
    const { cx, cy, rx, ry } = ellipseAttrs(points)
    if (rx === 0 || ry === 0) return ''
    return `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}`
  }
  // line, and an in-progress (still-open) polygon.
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
}

function isMultiSelectModifier(evt: PointerEvent): boolean {
  return evt.ctrlKey || evt.metaKey
}

function readGroupOrigin(el: SVGGElement): Point {
  const matrix = el.transform.baseVal.consolidate()?.matrix
  return matrix ? { x: matrix.e, y: matrix.f } : { x: 0, y: 0 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}
