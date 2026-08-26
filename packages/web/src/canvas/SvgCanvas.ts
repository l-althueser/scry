import type {
  ComponentInstance,
  FreePoint,
  FreeShape,
  FreeShapeKind,
  Group,
  GroupMemberKind,
  GroupMemberRef,
  ImageLayer,
  Layer,
  LeaderLine,
  LeaderLineBorderRef,
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
  resolveLeaderLineEndpoint,
} from '../leaderLines/leaderLineGeometry'
import {
  configurePlaceholderRoles,
  fmt,
  getComponentType,
  getComponentTypeVersion,
  resolveLocalBodyCorners,
  resolvePorts,
  roleBoxCorners,
  rotatePoint,
} from '../library'
import { nearestPointOnPolylineIndexed } from '../geometry/polyline'
import { computeNameLabelPipeIds } from '../pipes/pipeVolumes'
import {
  computeHopsForPipe,
  curvedPathD,
  findNearestPipeSegment,
  getDisplayPoints,
  getImageConnectionPointWorldPosition,
  getOrthogonalCorners,
  getPipePoints,
  getPortWorldPosition,
  getShapeConnectionPointWorldPosition,
  imagePointPortId,
  midpoint,
  pipePointPortId,
  resolveIndicatorTag,
  resolvePipeArrows,
  resolvePipeColor,
  shapePointPortId,
  straightPathD,
  straightPathDWithHops,
} from '../pipes/pipeGeometry'
import {
  DEFAULT_FONT_SIZE,
  TEXT_LINE_HEIGHT,
  boundsOfPoints,
  ellipseAttrs,
  nearestPointOnShapeBorder,
  nearestPointOnShapeBorderIndexed,
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

export type Tool =
  | 'select'
  | 'place'
  | 'draw-pipe'
  | 'draw-shape'
  | 'place-connection-point'
  | 'place-connection-point-shape'
  | 'draw-leader-line'
  | 'pick-transparent-color'

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
  /** Continuous drag from a resize-instance handle — see onLayerResized for the analogous image-layer callback. Checkpointed once via onDragCheckpoint at drag-start, same as onInstanceMoved. */
  onInstanceResized: (instanceId: string, rect: { x: number; y: number; width: number; height: number }) => void
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
  /**
   * A box-select that catches a mix of instances/pipes/shapes/leader lines
   * together — sets all four selection-category arrays at once (see the
   * store's selectMixed) instead of going through onSelectionChanged/
   * onPipeSelectionChanged/etc. individually, each of which clears the
   * OTHER three categories (correct for their own single-category click use
   * case, wrong here — it would just make whichever call runs last win).
   */
  onMixedSelectionChanged: (selection: {
    instanceIds: string[]
    pipeIds: string[]
    shapeIds: string[]
    leaderLineIds: string[]
    layerIds: string[]
  }) => void
  /** Clicking (or box-selecting into) any member of a persisted Group selects the whole group as a unit — see the grouping plan's PowerPoint-style click behavior. */
  onGroupSelected: (groupId: string) => void
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
  /** Endpoint counterpart to onWaypointSelected — lets the properties panel show per-point arrow controls for a selected 'from'/'to' end, not just an interior waypoint (see PipeArrow). */
  onEndpointSelected: (selection: { pipeId: string; side: PipeEndpointSide } | null) => void
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
  /** Clicking an orthogonal pipe's corner-flip handle — forces that bend (raw segment `segmentIndex`, see cornerOverrides) to the other side. */
  onCornerFlip: (pipeId: string, segmentIndex: number, mode: 'h-first' | 'v-first') => void

  /** keepDrawing is true when Shift was held, so the tool stays active for drawing several shapes in a row. */
  onShapeAdded: (kind: FreeShapeKind, points: Point[], keepDrawing: boolean) => void
  onShapeMoved: (shapeId: string, points: Point[]) => void
  onShapeSelectionChanged: (shapeIds: string[]) => void

  onLayerSelectionChanged: (layerIds: string[]) => void
  /** Reported as the layer's new x/y — SvgCanvas doesn't know width/height, the store fills those in from its own copy. */
  onLayerMoved: (layerId: string, x: number, y: number) => void
  /** Dragging a corner handle — reports the full new rect (opposite corner stays anchored). */
  onLayerResized: (layerId: string, rect: { x: number; y: number; width: number; height: number }) => void
  /** relX/relY are fractions of the image's current width/height, so the point stays put relative to the image through later drags/resizes. keepPlacing mirrors the other tools' Shift convention. */
  onConnectionPointAdded: (layerId: string, relX: number, relY: number, keepPlacing: boolean) => void
  /** Parallel to onConnectionPointAdded, but relX/relY are fractions of the shape's own bounding box. */
  onShapeConnectionPointAdded: (shapeId: string, relX: number, relY: number, keepPlacing: boolean) => void
  /** Clicking (or starting a drag on) a connection-point handle selects it — see connectionPointHandlesGroup. */
  onConnectionPointSelected: (selection: { ownerKind: 'layer' | 'shape'; ownerId: string; pointId: string } | null) => void
  /** Live update while dragging a connection-point handle — relX/relY already resolved against the owner's current bbox. No history push per frame, checkpointed via onDragCheckpoint at drag-start like every other continuous drag. */
  onConnectionPointMoved: (ownerKind: 'layer' | 'shape', ownerId: string, pointId: string, relX: number, relY: number) => void
  /** relX/relY are fractions of the image's current width/height, same convention as onConnectionPointAdded — the store resolves the actual pixel color and reprocesses the image. */
  onTransparentColorPicked: (layerId: string, relX: number, relY: number) => void

  /** keepDrawing is true when Shift was held, so the tool stays active for drawing several leader lines in a row. */
  onLeaderLineAdded: (from: LeaderLineEndpoint, waypoints: Point[], to: LeaderLineEndpoint, keepDrawing: boolean) => void
  onLeaderLineSelectionChanged: (leaderLineIds: string[]) => void
  /** No grid/align snapping — leader lines are deliberately freeform annotations, unlike pipes/waypoints. */
  onLeaderLinePointMoved: (leaderLineId: string, point: 'to' | number, worldPoint: LeaderLineEndpoint) => void
  /** `from` is a role ref when the drag lands on a label, otherwise a plain point (possibly docked to a shape border). */
  onLeaderLineFromMoved: (leaderLineId: string, from: LeaderLineEndpoint) => void
}

/** Ensures each SvgCanvas instance's <mask id> is unique in the document (see gridMaskId in the constructor) — matters if the app ever mounts more than one canvas at once. */
let nextCanvasInstanceId = 0

const MIN_SCALE = 0.2
const MAX_SCALE = 8
// High enough that the grid still renders at the default zoom with the
// finest (1/8x) grid-size option — a single <path> covering the whole
// viewBox, not one DOM element per line, so a few thousand segments cost
// nothing extra in DOM size; this cap only exists to bound how much `d`
// string gets built/rasterized at extreme zoom-out.
const MAX_GRID_LINES = 6000
const PORT_SNAP_RADIUS = 12
/** Screen-pixel radius for alignment-guide snapping, converted to world units per current zoom. */
const ALIGN_SNAP_PX = 8
/** Screen-pixel movement below which a pointerdown+pointerup on a pipe endpoint/waypoint counts as a click (triggering coincident-point cycling) rather than a drag — see pipePointCycleCandidate. */
const CLICK_MOVE_THRESHOLD_PX = 4

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
  | 'resize-instance'
  | 'resize-shape-point'
  | 'move-connection-point'

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
  readonly gridLayer: SVGGElement
  /**
   * Dynamic z-order container: one <g data-layer-id> child per Layer
   * (image or vector), re-appended in `layers` array order on every
   * syncLayers call — appendChild on an already-parented node just moves
   * it, so this is the entire "make DOM paint order match the array" step.
   * Replaces the old fixed background/pipes/content/shapes groups, which
   * could never interleave vector content with images. See
   * getOrCreateImageLayerGroup / getOrCreateVectorLayerSubGroups.
   */
  readonly layersContainer: SVGGElement
  readonly leaderLinesLayer: SVGGElement
  readonly overlayLayer: SVGGElement

  private viewBox: ViewBox = { x: 0, y: 0, w: 1000, h: 700 }
  private gridSize: number
  /** Unique per instance — see nextCanvasInstanceId. */
  private readonly gridMaskId = `gv-grid-mask-${nextCanvasInstanceId++}`
  private gridMaskEl!: SVGMaskElement
  /** Keeps the viewBox's aspect ratio matching the container's actual (resizable) aspect ratio — see syncViewBoxAspect. Without this, a container whose aspect ratio doesn't match the viewBox's fixed 1000:700 gets letterboxed by the SVG's default preserveAspectRatio, and the grid (which only fills the viewBox rectangle) visibly stops short of the letterboxed edges. */
  private readonly resizeObserver: ResizeObserver
  private instanceEls = new Map<string, SVGGElement>()
  private pipeEls = new Map<string, SVGGElement>()
  private shapeEls = new Map<string, SVGGElement>()
  private leaderLineEls = new Map<string, SVGGElement>()
  private imageLayerEls = new Map<string, SVGImageElement>()
  /** layerId -> that layer's outer <g data-layer-id> inside layersContainer (image or vector). */
  private layerGroupEls = new Map<string, SVGGElement>()
  /** layerId -> a vector layer's three fixed-relative-order inner sub-groups (pipes under instances under shapes) — only 'default' ever has pipes/instances; every vector layer can have shapes. */
  private vectorPipesSubEls = new Map<string, SVGGElement>()
  private vectorContentSubEls = new Map<string, SVGGElement>()
  private vectorShapesSubEls = new Map<string, SVGGElement>()
  private selectedInstanceIds: string[] = []
  private selectedRole: RoleSelection | null = null
  private selectedPipeIds: string[] = []
  private selectedWaypoint: WaypointSelection | null = null
  /**
   * Which pipe endpoint ('from'/'to') is currently selected — the endpoint
   * counterpart to selectedWaypoint, purely internal to this class (no
   * store/React state, no callback) since it exists only to detect "the
   * user clicked the already-selected point again" for coincident-point
   * cycling (see cyclePipePointSelection). Cleared by
   * applyPipeSelectionHighlight, the single choke point every pipe
   * selection change (user-driven or external sync) already runs through.
   */
  private selectedEndpoint: { pipeId: string; side: PipeEndpointSide } | null = null
  private selectedShapeIds: string[] = []
  private selectedLeaderLineIds: string[] = []
  private selectedLayerIds: string[] = []

  /**
   * Set on pointerdown when an endpointEl/waypointEl click lands on the
   * already-selected point, cleared on every pointerup — a genuine drag
   * still needs to start immediately on pointerdown (so the point can be
   * grabbed and moved in one motion, same as a first-time click), but
   * coincident-point cycling (see cyclePipePointSelection) should only
   * actually fire if the pointer never really moved, i.e. this turned out
   * to be a click, not a drag. Checked against dragStartScreen on
   * pointerup: below the small pixel threshold there = a click, cycle now;
   * beyond it = a real drag already happened live, don't also cycle.
   */
  private pipePointCycleCandidate: { pipeId: string; point: 'from' | 'to' | number; pos: Point } | null = null

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
  /** World-space offset between the pointer and the instance's own origin at drag start — subtracted from the pointer's position on every move so the origin keeps its place under the grabbed point instead of jumping to the cursor. */
  private dragInstanceGrabOffset: Point = { x: 0, y: 0 }
  private dragRoleStartWorld: Point = { x: 0, y: 0 }
  private dragWaypointStartWorld: Point = { x: 0, y: 0 }
  private dragShapeId: string | null = null
  private dragShapeStartWorld: Point = { x: 0, y: 0 }
  private dragShapeStartPoints: Point[] = []
  private dragShapePointIndex: number | null = null
  private dragConnectionPointOwnerKind: 'layer' | 'shape' | null = null
  private dragConnectionPointOwnerId: string | null = null
  private dragConnectionPointId: string | null = null
  private selectedConnectionPoint: { ownerKind: 'layer' | 'shape'; ownerId: string; pointId: string } | null = null
  private dragLeaderLineId: string | null = null
  private dragLeaderLinePoint: 'from' | 'to' | number | null = null
  private dragLayerId: string | null = null
  private dragLayerStartWorld: Point = { x: 0, y: 0 }
  private dragLayerStartRect: Point = { x: 0, y: 0 }
  private dragResizeHandle: ResizeHandle | null = null
  private dragResizeStartRect: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 0, height: 0 }
  private dragResizeInstanceId: string | null = null
  private dragResizeStartSize: { width: number; height: number } = { width: 0, height: 0 }
  /** Fixed for the whole resize-instance drag — a rotated box's opposite corner is anchored in its own local frame, not world axes, see onPointerMove's 'resize-instance' branch. */
  private dragResizeStartTransform: { x: number; y: number; rotationDeg: number } = { x: 0, y: 0, rotationDeg: 0 }
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
  private cornerFlipHandlesGroup: SVGGElement
  private leaderLineHandlesGroup: SVGGElement
  private companionPointsGroup: SVGGElement
  private layerResizeHandlesGroup: SVGGElement
  private instanceResizeHandlesGroup: SVGGElement
  private shapeResizeHandlesGroup: SVGGElement
  private connectionPointHandlesGroup: SVGGElement
  private alignGuideGroup: SVGGElement
  private latestInstances: ComponentInstance[] = []
  private latestPipes: PipeInstance[] = []
  private latestShapes: FreeShape[] = []
  private latestLeaderLines: LeaderLine[] = []
  private latestLayers: Layer[] = []
  private latestGroups: Group[] = []
  /** Set on double-click of a member of the currently selected group; while entered, clicking a member of THIS group bypasses the group-redirect and selects that one member instead (PowerPoint-style "enter the group"). Cleared on empty-canvas click or Escape (see App.tsx). */
  private enteredGroupId: string | null = null

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

    this.gridLayer = this.createLayer('grid-layer')

    // Punches out the grid under each image layer's footprint by default
    // (see updateGridMask) so the image reads cleanly instead of the grid
    // showing through on top of it — an image layer's own showGridOverImage
    // flag opts back in. userSpaceOnUse so the mask's own rects are plain
    // world coordinates, same as everything else drawn in this SVG.
    const defs = document.createElementNS(SVG_NS, 'defs')
    this.gridMaskEl = document.createElementNS(SVG_NS, 'mask')
    this.gridMaskEl.id = this.gridMaskId
    this.gridMaskEl.setAttribute('maskUnits', 'userSpaceOnUse')
    defs.appendChild(this.gridMaskEl)
    this.svg.appendChild(defs)
    this.gridLayer.setAttribute('mask', `url(#${this.gridMaskId})`)

    this.layersContainer = this.createLayer('layers-container')
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

    this.cornerFlipHandlesGroup = document.createElementNS(SVG_NS, 'g')
    this.cornerFlipHandlesGroup.setAttribute('class', 'gv-corner-flip-handles')
    this.overlayLayer.appendChild(this.cornerFlipHandlesGroup)

    this.leaderLineHandlesGroup = document.createElementNS(SVG_NS, 'g')
    this.leaderLineHandlesGroup.setAttribute('class', 'gv-leader-line-handles')
    this.overlayLayer.appendChild(this.leaderLineHandlesGroup)

    this.companionPointsGroup = document.createElementNS(SVG_NS, 'g')
    this.companionPointsGroup.setAttribute('class', 'gv-companion-points')
    this.overlayLayer.appendChild(this.companionPointsGroup)

    this.layerResizeHandlesGroup = document.createElementNS(SVG_NS, 'g')
    this.layerResizeHandlesGroup.setAttribute('class', 'gv-layer-resize-handles')
    this.overlayLayer.appendChild(this.layerResizeHandlesGroup)

    this.instanceResizeHandlesGroup = document.createElementNS(SVG_NS, 'g')
    this.instanceResizeHandlesGroup.setAttribute('class', 'gv-instance-resize-handles')
    this.overlayLayer.appendChild(this.instanceResizeHandlesGroup)

    this.shapeResizeHandlesGroup = document.createElementNS(SVG_NS, 'g')
    this.shapeResizeHandlesGroup.setAttribute('class', 'gv-shape-resize-handles')
    this.overlayLayer.appendChild(this.shapeResizeHandlesGroup)

    this.connectionPointHandlesGroup = document.createElementNS(SVG_NS, 'g')
    this.connectionPointHandlesGroup.setAttribute('class', 'gv-connection-point-handles')
    this.overlayLayer.appendChild(this.connectionPointHandlesGroup)

    this.alignGuideGroup = document.createElementNS(SVG_NS, 'g')
    this.alignGuideGroup.setAttribute('class', 'gv-align-guides')
    this.alignGuideGroup.style.pointerEvents = 'none'
    this.overlayLayer.appendChild(this.alignGuideGroup)

    this.applyViewBox()
    this.drawGrid()
    // Hidden by default (matches the store's own gridVisible default) —
    // avoids a flash of visible grid before CanvasView's own effect runs.
    this.gridLayer.style.display = 'none'
    // Seeds the mask's white base rect before any real syncLayers call — an
    // empty <mask> would otherwise mean "fully hidden" and the grid would
    // vanish entirely until the first layers sync.
    this.updateGridMask([])

    this.resizeObserver = new ResizeObserver(() => this.syncViewBoxAspect())
    this.resizeObserver.observe(this.svg)

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
  private connectionPointTargetShapeId: string | null = null
  private pickTransparentColorTargetLayerId: string | null = null

  setTool(tool: Tool, subKind: string | null = null) {
    this.tool = tool
    this.placingType = tool === 'place' ? subKind : null
    this.drawingShapeKind = tool === 'draw-shape' ? (subKind as FreeShapeKind | null) : null
    this.connectionPointTargetLayerId = tool === 'place-connection-point' ? subKind : null
    this.connectionPointTargetShapeId = tool === 'place-connection-point-shape' ? subKind : null
    this.pickTransparentColorTargetLayerId = tool === 'pick-transparent-color' ? subKind : null
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

  /** Purely visual — snapToGrid keeps using gridSize regardless, so hiding the grid never changes placement/snap behavior, only whether the lines are drawn. */
  setGridVisible(visible: boolean) {
    this.gridLayer.style.display = visible ? '' : 'none'
  }

  destroy() {
    this.resizeObserver.disconnect()
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

  /**
   * Returns (creating if needed) an image layer's outer <g data-layer-id>
   * inside layersContainer, holding its single <image> directly. Does NOT
   * reorder anything or set the <image>'s own attributes — see syncLayers,
   * the only place layer order/content actually changes.
   */
  private getOrCreateImageLayerGroup(layerId: string): SVGGElement {
    let outer = this.layerGroupEls.get(layerId)
    if (!outer) {
      outer = document.createElementNS(SVG_NS, 'g')
      outer.setAttribute('data-layer-id', layerId)
      this.layersContainer.appendChild(outer)
      this.layerGroupEls.set(layerId, outer)
    }
    return outer
  }

  /**
   * Returns (creating if needed) a vector layer's outer <g data-layer-id>
   * plus its three fixed-relative-order inner sub-groups (pipes, then
   * instances, then shapes — the same relative order the old fixed
   * pipesLayer/contentLayer/shapesLayer anchors always had). Every sync*
   * method that used to append into one of those fixed groups now routes
   * through here instead, keyed by the owning layer's id ('default' for
   * pipes/instances, always; a shape's own layerId for shapes).
   */
  private getOrCreateVectorLayerSubGroups(layerId: string): {
    outer: SVGGElement
    pipesSub: SVGGElement
    contentSub: SVGGElement
    shapesSub: SVGGElement
  } {
    let outer = this.layerGroupEls.get(layerId)
    if (!outer) {
      outer = document.createElementNS(SVG_NS, 'g')
      outer.setAttribute('data-layer-id', layerId)
      this.layersContainer.appendChild(outer)
      this.layerGroupEls.set(layerId, outer)
    }
    let pipesSub = this.vectorPipesSubEls.get(layerId)
    if (!pipesSub) {
      pipesSub = document.createElementNS(SVG_NS, 'g')
      outer.appendChild(pipesSub)
      this.vectorPipesSubEls.set(layerId, pipesSub)
    }
    let contentSub = this.vectorContentSubEls.get(layerId)
    if (!contentSub) {
      contentSub = document.createElementNS(SVG_NS, 'g')
      outer.appendChild(contentSub)
      this.vectorContentSubEls.set(layerId, contentSub)
    }
    let shapesSub = this.vectorShapesSubEls.get(layerId)
    if (!shapesSub) {
      shapesSub = document.createElementNS(SVG_NS, 'g')
      outer.appendChild(shapesSub)
      this.vectorShapesSubEls.set(layerId, shapesSub)
    }
    return { outer, pipesSub, contentSub, shapesSub }
  }

  /**
   * Rebuilds the grid mask's contents: a huge always-white base rect (so the
   * grid is fully visible with no image layers, or images that opted back
   * in), then one black rect per image layer whose showGridOverImage flag
   * isn't set — black punches the grid out there. World-space rects, not
   * tied to the current viewBox, so this only needs recomputing when the
   * layers themselves change (see syncLayers), not on every pan/zoom.
   */
  private updateGridMask(layers: readonly Layer[]) {
    while (this.gridMaskEl.firstChild) this.gridMaskEl.removeChild(this.gridMaskEl.firstChild)

    const base = document.createElementNS(SVG_NS, 'rect')
    base.setAttribute('x', '-100000')
    base.setAttribute('y', '-100000')
    base.setAttribute('width', '200000')
    base.setAttribute('height', '200000')
    base.setAttribute('fill', 'white')
    this.gridMaskEl.appendChild(base)

    for (const layer of layers) {
      if (layer.kind !== 'image' || layer.showGridOverImage) continue
      const rect = document.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('x', String(layer.x))
      rect.setAttribute('y', String(layer.y))
      rect.setAttribute('width', String(layer.width))
      rect.setAttribute('height', String(layer.height))
      rect.setAttribute('fill', 'black')
      this.gridMaskEl.appendChild(rect)
    }
  }

  private applyViewBox() {
    const { x, y, w, h } = this.viewBox
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`)
  }

  /** Recenters the canvas on a world-space point at the current zoom level (no auto-zoom) — used by tag search's "jump to result". */
  focusOnWorldPoint(point: Point) {
    this.viewBox = { ...this.viewBox, x: point.x - this.viewBox.w / 2, y: point.y - this.viewBox.h / 2 }
    this.applyViewBox()
    this.drawGrid()
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
   * point — or a dragged instance's own ports, see instancePortWorldPositions
   * — can align to. excludeWaypoint skips the point currently being dragged;
   * excludeInstanceIds skips a dragged instance's (stale, pre-drag) own ports,
   * so neither trivially "aligns" with itself.
   */
  private collectAlignReferences(opts?: {
    excludeWaypoint?: { pipeId: string; index: number }
    excludeInstanceIds?: ReadonlySet<string>
  }): Point[] {
    const refs: Point[] = []
    for (const inst of this.latestInstances) {
      if (opts?.excludeInstanceIds?.has(inst.instanceId)) continue
      const def = getComponentType(inst.componentTypeId)
      for (const port of resolvePorts(def, inst)) {
        const pos = getPortWorldPosition(inst, port.portId)
        if (pos) refs.push(pos)
      }
    }
    const excludeWaypoint = opts?.excludeWaypoint
    for (const pipe of this.latestPipes) {
      const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
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

  /**
   * Same nearest-match-per-axis rule as snapWithAlignment, generalized from a
   * single dragged point to a set of candidate points (e.g. every port of a
   * dragged instance) — used so a whole component aligns via whichever of its
   * own ports lands nearest a reference, not just its raw origin. Returns a
   * correction (ref value minus candidate value) per axis rather than an
   * absolute position, since the caller applies it to different things
   * (an instance origin vs. a shared group-drag delta).
   */
  private bestAxisAlignment(
    candidates: Point[],
    refs: Point[],
  ): { correctionX: number | null; correctionY: number | null; guideX: number | null; guideY: number | null } {
    const threshold = this.worldThreshold(ALIGN_SNAP_PX)
    let bestX: { value: number; dist: number; candidate: number } | null = null
    let bestY: { value: number; dist: number; candidate: number } | null = null
    for (const c of candidates) {
      for (const ref of refs) {
        const dx = Math.abs(ref.x - c.x)
        if (dx <= threshold && (!bestX || dx < bestX.dist)) bestX = { value: ref.x, dist: dx, candidate: c.x }
        const dy = Math.abs(ref.y - c.y)
        if (dy <= threshold && (!bestY || dy < bestY.dist)) bestY = { value: ref.y, dist: dy, candidate: c.y }
      }
    }
    return {
      correctionX: bestX ? bestX.value - bestX.candidate : null,
      correctionY: bestY ? bestY.value - bestY.candidate : null,
      guideX: bestX ? bestX.value : null,
      guideY: bestY ? bestY.value : null,
    }
  }

  /** World positions of every port `instance` would have if its origin were `atOrigin` — lets alignment be evaluated at a not-yet-committed drag position without touching the real instance/store. */
  private instancePortWorldPositions(instance: ComponentInstance, atOrigin: Point): Point[] {
    const def = getComponentType(instance.componentTypeId)
    const tentative: ComponentInstance = { ...instance, transform: { ...instance.transform, x: atOrigin.x, y: atOrigin.y } }
    const positions: Point[] = []
    for (const port of resolvePorts(def, instance)) {
      const pos = getPortWorldPosition(tentative, port.portId)
      if (pos) positions.push(pos)
    }
    return positions
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

  /**
   * Recomputes viewBox.h from the container's *current* pixel aspect ratio
   * against the existing viewBox.w (treated as the authoritative "world
   * units per container width" — i.e. the current zoom level), keeping the
   * vertical center fixed. Runs on every ResizeObserver tick (container
   * resize, side panel toggling, window resize, ...) so the viewBox always
   * exactly matches what's visibly on screen — no default-preserveAspectRatio
   * letterboxing where the grid (and background) would fall short of the
   * container's actual edges.
   */
  private syncViewBoxAspect() {
    const width = this.svg.clientWidth
    const height = this.svg.clientHeight
    if (width === 0 || height === 0) return
    const targetH = this.viewBox.w * (height / width)
    if (Math.abs(targetH - this.viewBox.h) < 0.5) return
    const centerY = this.viewBox.y + this.viewBox.h / 2
    this.viewBox = { ...this.viewBox, h: targetH, y: centerY - targetH / 2 }
    this.applyViewBox()
    this.drawGrid()
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
    path.setAttribute('stroke-width', String(Math.max(this.viewBox.w / 1500, 0.35)))
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
      const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
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
    for (const shape of this.latestShapes) {
      for (const cp of shape.connectionPoints ?? []) {
        const pos = getShapeConnectionPointWorldPosition(shape, cp.pointId)
        if (!pos) continue
        const d = Math.hypot(pos.x - worldPt.x, pos.y - worldPt.y)
        if (d <= PORT_SNAP_RADIUS && (!best || d < best.dist)) {
          best = { ref: { instanceId: shape.instanceId, portId: shapePointPortId(cp.pointId) }, pos, dist: d }
        }
      }
    }
    return best
  }

  /** Stable sort key for a pipe's own point ('from'/'to'/interior waypoint index) — used only to make coincident-point cycling order deterministic across renders. */
  private pipePointSortKey(point: 'from' | 'to' | number): string {
    if (point === 'from') return '0'
    if (point === 'to') return 'z'
    return String(point + 1).padStart(6, '0')
  }

  /**
   * Every (pipeId, point) in the project whose resolved world position is
   * within snap range of `pos` — i.e. every pipe endpoint/waypoint
   * physically sitting at the same junction. A real PortRef branch (see
   * PIPE_POINT_PREFIX) always resolves to an exact match (distance 0), but
   * a dead-end pipe whose near end is just a plain FreePoint dragged
   * visually next to the junction — never actually snapped onto it — can
   * sit a few units off, so this uses the same PORT_SNAP_RADIUS the rest of
   * the app already treats as "close enough to count as connected" (the
   * radius findPortNear itself uses while drawing/dragging), rather than a
   * near-zero tolerance that would only ever catch the exact-ref case. Used
   * by cyclePipePointSelection to find what a re-click on an
   * already-selected point should switch to.
   */
  private findCoincidentPipePoints(pos: Point): { pipeId: string; point: 'from' | 'to' | number }[] {
    const EPS = PORT_SNAP_RADIUS
    const result: { pipeId: string; point: 'from' | 'to' | number }[] = []
    for (const pipe of this.latestPipes) {
      const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
      if (!points) continue
      points.forEach((p, idx) => {
        if (Math.hypot(p.x - pos.x, p.y - pos.y) > EPS) return
        if (idx === 0) result.push({ pipeId: pipe.instanceId, point: 'from' })
        else if (idx === points.length - 1) result.push({ pipeId: pipe.instanceId, point: 'to' })
        else result.push({ pipeId: pipe.instanceId, point: idx - 1 })
      })
    }
    return result
  }

  /**
   * Re-clicking a pipe endpoint/waypoint that's already selected cycles to
   * the next pipe sharing that same physical junction (round-robin,
   * wrapping back to the first) instead of just re-confirming the same
   * selection — the user's ask: several pipes meeting at one knot should be
   * switchable between via repeated clicks, each switch also selecting that
   * other pipe. Returns false (no-op) when nothing else shares the point,
   * so the caller falls through to its normal select+start-drag behavior.
   */
  private cyclePipePointSelection(pipeId: string, point: 'from' | 'to' | number, pos: Point): boolean {
    const all = this.findCoincidentPipePoints(pos)
    if (all.length <= 1) return false
    all.sort((a, b) =>
      a.pipeId === b.pipeId
        ? this.pipePointSortKey(a.point).localeCompare(this.pipePointSortKey(b.point))
        : a.pipeId.localeCompare(b.pipeId),
    )
    const selfIdx = all.findIndex((c) => c.pipeId === pipeId && c.point === point)
    if (selfIdx === -1) return false
    const next = all[(selfIdx + 1) % all.length]
    this.setPipeSelectionFromUser([next.pipeId])
    if (next.point === 'from' || next.point === 'to') {
      this.setWaypointSelectionFromUser(null)
      this.selectedEndpoint = { pipeId: next.pipeId, side: next.point }
    } else {
      this.setWaypointSelectionFromUser({ pipeId: next.pipeId, index: next.point })
    }
    return true
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
   * Resolves a raw click/drag point for a leader-line waypoint into where it
   * should actually land: snapped onto a shape's border if the cursor is
   * close enough to one, otherwise the raw point as-is. Never grid-snapped —
   * leader lines stay deliberately freeform. Waypoints only ever get this
   * simpler shape-only snap; see findLeaderLineEndpointAnchor for the wider
   * search (shapes + pipes + role boxes) used by `from`/`to`.
   */
  private resolveLeaderLineAnchor(worldPt: Point): Point {
    return this.findShapeAnchorNear(worldPt) ?? worldPt
  }

  /**
   * Nearest "stickable" border within snap range across every target a
   * leader-line endpoint can anchor to live: a shape's outline (rect/
   * polygon/line/ellipse-as-bbox; text has none), a pipe's polyline, or a
   * value/setpoint role's label box (name/indicator have no box — see
   * roleBoxCorners). Closest candidate wins across all three categories,
   * same "closest wins" rule findPortNear already uses for pipe-port
   * snapping. Returns a LeaderLineBorderRef (not yet a resolved position —
   * the caller already has worldPt for live preview) or null if nothing is
   * within PORT_SNAP_RADIUS.
   */
  private findLeaderLineBorderAnchorNear(worldPt: Point): LeaderLineBorderRef | null {
    let best: { ref: LeaderLineBorderRef; dist: number } | null = null

    for (const shape of this.latestShapes) {
      const hit = nearestPointOnShapeBorderIndexed(shape, worldPt)
      if (hit && hit.dist <= PORT_SNAP_RADIUS && (!best || hit.dist < best.dist)) {
        best = {
          ref: { targetKind: 'shape', targetId: shape.instanceId, segmentIndex: hit.segmentIndex, t: hit.t },
          dist: hit.dist,
        }
      }
    }

    for (const pipe of this.latestPipes) {
      const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
      if (!points) continue
      const hit = nearestPointOnPolylineIndexed(points, worldPt)
      if (hit && hit.dist <= PORT_SNAP_RADIUS && (!best || hit.dist < best.dist)) {
        best = {
          ref: { targetKind: 'pipe', targetId: pipe.instanceId, segmentIndex: hit.segmentIndex, t: hit.t },
          dist: hit.dist,
        }
      }
    }

    for (const inst of this.latestInstances) {
      for (const role of inst.roles) {
        if (!role.enabled) continue
        const corners = roleBoxCorners(inst, role)
        if (!corners) continue
        const hit = nearestPointOnPolylineIndexed(corners, worldPt)
        if (hit && hit.dist <= PORT_SNAP_RADIUS && (!best || hit.dist < best.dist)) {
          best = {
            ref: {
              targetKind: 'roleBox',
              targetId: inst.instanceId,
              role: role.role,
              segmentIndex: hit.segmentIndex,
              t: hit.t,
            },
            dist: hit.dist,
          }
        }
      }
    }

    return best?.ref ?? null
  }

  /**
   * Resolves a raw click/drag point for a leader-line `from`/`to` endpoint
   * into the richer LeaderLineEndpoint it should actually become: a live
   * border anchor if the cursor is close enough to one (see
   * findLeaderLineBorderAnchorNear), otherwise the raw point as-is. Never
   * grid-snapped, same as resolveLeaderLineAnchor.
   */
  private resolveLeaderLineEndpointAnchor(worldPt: Point): LeaderLineEndpoint {
    return this.findLeaderLineBorderAnchorNear(worldPt) ?? worldPt
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
      this.tool === 'draw-pipe' ||
      this.tool === 'place-connection-point' ||
      this.tool === 'place-connection-point-shape' ||
      this.dragMode === 'move-pipe-endpoint'
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
        const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
        points?.forEach((p) => addMarker(p))
      }
      for (const layer of this.latestLayers) {
        if (layer.kind !== 'image') continue
        for (const cp of layer.connectionPoints) {
          const pos = getImageConnectionPointWorldPosition(layer, cp.pointId)
          if (pos) addMarker(pos)
        }
      }
      for (const shape of this.latestShapes) {
        for (const cp of shape.connectionPoints ?? []) {
          const pos = getShapeConnectionPointWorldPosition(shape, cp.pointId)
          if (pos) addMarker(pos)
        }
      }
    }
    // The selected owner's own connection points get real interactive
    // handles instead (connectionPointHandlesGroup, see
    // refreshConnectionPointHandles) — no separate static preview needed here.
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
    // The last waypoint was only ever shape-border-snapped as it was placed
    // (see resolveLeaderLineAnchor); re-resolving that same world position
    // through the wider endpoint search picks up a pipe/role-box anchor too
    // if one's there, now that it's becoming `to` rather than an interior bend.
    const to = this.resolveLeaderLineEndpointAnchor(draft.waypoints[draft.waypoints.length - 1])
    const waypoints = draft.waypoints.slice(0, -1)
    const from = draft.from
    this.clearLeaderLineDraft()
    this.callbacks.onLeaderLineAdded(from, waypoints, to, false)
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
      // finishing click, already at the right world position; re-resolve it
      // through the wider endpoint search (same reasoning as
      // finishOrClearLeaderLineDraft) so it can pick up a pipe/role-box
      // anchor now that it's becoming `to`, not just the shape-border point
      // it was snapped to as an interior waypoint.
      const to = this.resolveLeaderLineEndpointAnchor(draft.waypoints[draft.waypoints.length - 1])
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

    // Double-click on a member of the CURRENTLY selected group enters it:
    // selects just that one member instead of the whole group, and remembers
    // enteredGroupId so the very next plain click on this same group's
    // members bypasses the group-redirect in onPointerDown (see
    // groupRedirectFor) — there's no separate "exit" step, since
    // groupRedirectFor itself clears enteredGroupId the moment a click lands
    // on a different group or an ungrouped element.
    if (!target.closest('[data-waypoint-index]')) {
      const memberHit = this.resolveGroupMemberAt(target)
      const group = memberHit && this.groupContaining(memberHit.kind, memberHit.id)
      if (memberHit && group && this.isCurrentGroupSelection(group)) {
        evt.preventDefault()
        this.enteredGroupId = group.groupId
        this.selectSingleGroupMember(memberHit.kind, memberHit.id)
        return
      }
    }

    if (target.closest('[data-waypoint-index]')) return
    const pipeEl = target.closest('[data-pipe-id]') as SVGElement | null
    if (!pipeEl) return
    evt.preventDefault()

    const pipeId = pipeEl.getAttribute('data-pipe-id')!
    const pipe = this.latestPipes.find((p) => p.instanceId === pipeId)
    if (!pipe) return
    const rawPoints = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
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

    // Middle-mouse-button drag pans, exactly like Shift+drag — regardless of
    // tool or what's under the cursor, matching the common app convention
    // (browsers, design tools) of the wheel button always panning.
    if (evt.button === 1) {
      this.dragMode = 'pan'
      this.dragStartScreen = { x: evt.clientX, y: evt.clientY }
      this.dragStartViewBox = { ...this.viewBox }
      return
    }

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
        // Always stays in the tool after finishing a connection (unlike
        // instance/shape/connection-point placement, which only does this
        // when Shift is held) — a diagram is usually a whole connected
        // network of pipes, not one segment. Escape (the Escape-driven
        // stub-finish just below hardcodes `false`) or re-clicking the pipe
        // tool button are the only ways out.
        this.callbacks.onPipeAdded(this.pipeDraft.fromPort, hit.ref, waypoints, true)
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
      // Click to start: snaps to a role label if the click landed exactly on
      // one (the "anchored from a label" case), else docks onto the nearest
      // shape/pipe/label-box border within range (see
      // findLeaderLineBorderAnchorNear), else a raw free point. Interior
      // waypoints resolve more simply (shape-border snap only, see
      // resolveLeaderLineAnchor) — only the endpoints (`from`/the eventual
      // `to`) get the wider anchor search; leader lines never grid/
      // align-snap either way.
      if (!this.leaderLineDraft) {
        const roleHit = this.resolveRoleRefAt(evt.target as Element)
        if (roleHit) {
          this.leaderLineDraft = { from: roleHit.ref, fromPos: roleHit.pos, waypoints: [] }
        } else {
          const anchor = this.resolveLeaderLineEndpointAnchor(world)
          const pos = resolveLeaderLineEndpoint(anchor, this.latestInstances, this.latestPipes, this.latestShapes, this.latestLayers) ?? world
          this.leaderLineDraft = { from: anchor, fromPos: pos, waypoints: [] }
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

    if (this.tool === 'place-connection-point-shape' && this.connectionPointTargetShapeId) {
      const shape = this.latestShapes.find((s) => s.instanceId === this.connectionPointTargetShapeId)
      if (shape) {
        const { minX, minY, maxX, maxY } = boundsOfPoints(shape.points)
        const width = maxX - minX
        const height = maxY - minY
        if (width > 0 && height > 0) {
          const relX = clamp01((world.x - minX) / width)
          const relY = clamp01((world.y - minY) / height)
          this.callbacks.onShapeConnectionPointAdded(shape.instanceId, relX, relY, evt.shiftKey)
        }
      }
      return
    }

    if (this.tool === 'pick-transparent-color' && this.pickTransparentColorTargetLayerId) {
      const layer = this.latestLayers.find((l) => l.layerId === this.pickTransparentColorTargetLayerId)
      if (layer && layer.kind === 'image' && layer.width > 0 && layer.height > 0) {
        const relX = clamp01((world.x - layer.x) / layer.width)
        const relY = clamp01((world.y - layer.y) / layer.height)
        this.callbacks.onTransparentColorPicked(layer.layerId, relX, relY)
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
    const shapePointHandleEl = target.closest('[data-shape-point-index]') as SVGElement | null
    const connectionPointHandleEl = target.closest('[data-cp-point-id]') as SVGElement | null
    const cornerFlipHandleEl = target.closest('[data-corner-segment-index]') as SVGElement | null
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
      const resizeInstanceId = resizeHandleEl.getAttribute('data-resize-instance-id')
      if (resizeInstanceId) {
        const instance = this.latestInstances.find((i) => i.instanceId === resizeInstanceId)
        const def = instance ? getComponentType(instance.componentTypeId) : null
        if (instance && def?.resizable) {
          this.callbacks.onDragCheckpoint()
          this.dragMode = 'resize-instance'
          this.dragResizeInstanceId = resizeInstanceId
          this.dragResizeHandle = resizeHandleEl.getAttribute('data-resize-handle') as ResizeHandle
          this.dragResizeStartTransform = { ...instance.transform }
          let minX = Infinity
          let minY = Infinity
          let maxX = -Infinity
          let maxY = -Infinity
          for (const corner of resolveLocalBodyCorners(def, instance)) {
            minX = Math.min(minX, corner.x)
            maxX = Math.max(maxX, corner.x)
            minY = Math.min(minY, corner.y)
            maxY = Math.max(maxY, corner.y)
          }
          this.dragResizeStartSize = { width: maxX - minX, height: maxY - minY }
        }
        return
      }
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

    if (shapePointHandleEl) {
      const shapeId = shapePointHandleEl.getAttribute('data-shape-id')!
      const pointIndex = Number(shapePointHandleEl.getAttribute('data-shape-point-index'))
      const shape = this.latestShapes.find((s) => s.instanceId === shapeId)
      if (shape) {
        this.callbacks.onDragCheckpoint()
        this.dragMode = 'resize-shape-point'
        this.dragShapeId = shapeId
        this.dragShapePointIndex = pointIndex
        this.dragShapeStartPoints = shape.points.map((p) => ({ ...p }))
      }
      return
    }

    if (connectionPointHandleEl) {
      const ownerKind = connectionPointHandleEl.getAttribute('data-cp-owner-kind') as 'layer' | 'shape'
      const ownerId = connectionPointHandleEl.getAttribute('data-cp-owner-id')!
      const pointId = connectionPointHandleEl.getAttribute('data-cp-point-id')!
      this.callbacks.onDragCheckpoint()
      this.selectedConnectionPoint = { ownerKind, ownerId, pointId }
      this.callbacks.onConnectionPointSelected(this.selectedConnectionPoint)
      this.refreshConnectionPointHandles()
      this.dragMode = 'move-connection-point'
      this.dragConnectionPointOwnerKind = ownerKind
      this.dragConnectionPointOwnerId = ownerId
      this.dragConnectionPointId = pointId
      return
    }

    if (cornerFlipHandleEl) {
      // A plain click, not a drag — flipping a corner is binary, so there's
      // nothing to track between pointerdown and pointerup.
      const pipeId = cornerFlipHandleEl.getAttribute('data-pipe-id')!
      const segmentIndex = Number(cornerFlipHandleEl.getAttribute('data-corner-segment-index'))
      const pipe = this.latestPipes.find((p) => p.instanceId === pipeId)
      const points =
        pipe && getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
      const corner =
        pipe && points && getOrthogonalCorners(points, pipe.cornerOverrides).find((c) => c.segmentIndex === segmentIndex)
      if (corner) {
        this.callbacks.onCornerFlip(pipeId, segmentIndex, corner.hFirst ? 'v-first' : 'h-first')
      }
      return
    }

    if (endpointEl) {
      const pipeId = endpointEl.getAttribute('data-pipe-id')!
      const side = endpointEl.getAttribute('data-pipe-endpoint') as PipeEndpointSide

      // Re-clicking the already-selected endpoint cycles to another pipe
      // sharing this exact junction (see cyclePipePointSelection) — but a
      // drag still needs to start right away too, in case this press turns
      // into an actual drag rather than a click; onPointerUp decides which
      // one it was (via pipePointCycleCandidate + a small movement
      // threshold) and only performs the cycle if the pointer never
      // actually moved.
      const pipe = this.latestPipes.find((p) => p.instanceId === pipeId)
      const points = pipe && getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
      const pos = points ? (side === 'from' ? points[0] : points[points.length - 1]) : null
      this.pipePointCycleCandidate =
        pos && this.selectedEndpoint?.pipeId === pipeId && this.selectedEndpoint.side === side
          ? { pipeId, point: side, pos }
          : null

      this.setPipeSelectionFromUser([pipeId])
      this.setWaypointSelectionFromUser(null)
      this.setEndpointSelectionFromUser({ pipeId, side })
      this.callbacks.onDragCheckpoint()
      this.dragMode = 'move-pipe-endpoint'
      this.dragPipeId = pipeId
      this.dragEndpointSide = side
      this.dragStartScreen = { x: evt.clientX, y: evt.clientY }
      this.refreshPortMarkers()
      return
    }

    if (waypointEl) {
      const pipeId = waypointEl.getAttribute('data-pipe-id')!
      const index = Number(waypointEl.getAttribute('data-waypoint-index'))

      // Same "start the drag either way, decide on release" pattern as the
      // endpoint branch above.
      const pipe = this.latestPipes.find((p) => p.instanceId === pipeId)
      const wp = pipe?.waypoints[index]
      this.pipePointCycleCandidate =
        wp && this.selectedWaypoint?.pipeId === pipeId && this.selectedWaypoint.index === index
          ? { pipeId, point: index, pos: wp }
          : null

      this.setPipeSelectionFromUser([pipeId])
      this.setWaypointSelectionFromUser({ pipeId, index })
      this.setEndpointSelectionFromUser(null)
      this.callbacks.onDragCheckpoint()
      this.dragMode = 'move-waypoint'
      this.dragPipeId = pipeId
      this.dragWaypointIndex = index
      this.dragStartScreen = { x: evt.clientX, y: evt.clientY }
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

      if (isMultiSelectModifier(evt)) {
        // Ctrl/Cmd+click on a role-covered click just toggles the instance,
        // same as a plain instanceEl Ctrl/Cmd+click — no point starting a
        // role-drag under a multi-select gesture.
        this.toggleMemberInSelection('instance', instanceId)
        return
      }

      // Same group-redirect as the plain instanceEl branch below: a click
      // that happens to land on a role element (most commonly the Indicator
      // overlay, which visually IS the component body for many types, per
      // CLAUDE.md's "colored overlay on top of an untagged base outline
      // group with an identical transform") must still select the whole
      // group first — otherwise grouping felt inconsistent across component
      // types purely because of which of their parts a click happened to
      // land on (e.g. valves vs. gas bottles vs. pipes). Always called for
      // its enteredGroupId side effect, but its result is only ACTED on
      // below when this instance isn't already part of a larger selection —
      // see partOfGroup's doc comment just below for why order matters here.
      const redirectGroup = this.groupRedirectFor('instance', instanceId)

      // Checked BEFORE acting on redirectGroup: if this instance is already
      // part of a larger selection (a loose mixed multi-select, OR a
      // persisted Group that's the current selection, OR either of those
      // plus extra elements added alongside it), a plain click+drag here
      // must carry that ENTIRE current selection along — redirecting to
      // "just this instance's own persisted group" would silently drop any
      // extra elements selected alongside it. Only a click on something NOT
      // already selected should redirect into a fresh group selection.
      const partOfGroup =
        this.selectedInstanceIds.includes(instanceId) &&
        (this.totalSelectedCount() > 1 || this.companionPipePoints.length > 0)

      if (partOfGroup) {
        this.dragMode = 'move-group'
        this.groupDragStartWorld = world
        this.callbacks.onGroupDragStart(this.selectedInstanceIds, this.companionPipePoints)
        return
      }

      if (redirectGroup) {
        this.callbacks.onGroupSelected(redirectGroup.groupId)
        this.dragMode = 'move-group'
        this.groupDragStartWorld = world
        const memberInstanceIds = redirectGroup.members.filter((m) => m.kind === 'instance').map((m) => m.id)
        this.callbacks.onGroupDragStart(memberInstanceIds, [])
        return
      }

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
        this.toggleMemberInSelection('instance', instanceId)
        return
      }

      // Clicking a member of a persisted Group (that we're not already
      // "entered" into, see enteredGroupId) normally selects the whole group
      // and starts a group-drag of it instead of this one instance —
      // PowerPoint-style. Always called for its enteredGroupId side effect,
      // but its result is only acted on below (after the partOfGroup check)
      // — see that check's own doc comment for why order matters.
      const redirectGroup = this.groupRedirectFor('instance', instanceId)

      // Checked BEFORE acting on redirectGroup: also true for a single
      // already-selected instance that's part of a larger mixed selection
      // (any combination of instances/pipes/shapes/leader lines/layers — not
      // just 2+ instances, and regardless of whether that selection happens
      // to exactly match a persisted Group or include extra elements
      // alongside one) or has companion pipe knots from a box-select (see
      // companionPipePoints). Redirecting to "just this instance's own
      // persisted group" here would silently drop any extra elements
      // selected alongside it — a plain click+drag on something already
      // selected must carry the ENTIRE current selection, never narrow it.
      const partOfGroup =
        this.selectedInstanceIds.includes(instanceId) &&
        (this.totalSelectedCount() > 1 || this.companionPipePoints.length > 0)

      if (partOfGroup) {
        this.dragMode = 'move-group'
        this.groupDragStartWorld = world
        this.callbacks.onGroupDragStart(this.selectedInstanceIds, this.companionPipePoints)
        return
      }

      if (redirectGroup) {
        this.callbacks.onGroupSelected(redirectGroup.groupId)
        this.dragMode = 'move-group'
        this.groupDragStartWorld = world
        const memberInstanceIds = redirectGroup.members.filter((m) => m.kind === 'instance').map((m) => m.id)
        this.callbacks.onGroupDragStart(memberInstanceIds, [])
        return
      }

      this.setSelectionFromUser([instanceId])
      this.callbacks.onDragCheckpoint()
      this.dragMode = 'move-instance'
      this.dragInstanceId = instanceId
      this.dragStartScreen = { x: evt.clientX, y: evt.clientY }
      const inst = this.latestInstances.find((i) => i.instanceId === instanceId)
      this.dragInstanceStartPos = inst ? { x: inst.transform.x, y: inst.transform.y } : world
      this.dragInstanceGrabOffset = { x: world.x - this.dragInstanceStartPos.x, y: world.y - this.dragInstanceStartPos.y }
      return
    }

    if (pipeEl) {
      const pipeId = pipeEl.getAttribute('data-pipe-id')!
      if (isMultiSelectModifier(evt)) {
        this.toggleMemberInSelection('pipe', pipeId)
        return
      }
      const redirectGroup = this.groupRedirectFor('pipe', pipeId)
      if (redirectGroup) {
        this.callbacks.onGroupSelected(redirectGroup.groupId)
        return
      }
      this.setPipeSelectionFromUser([pipeId])
      return
    }

    if (shapeEl) {
      const shapeId = shapeEl.getAttribute('data-shape-id')!
      if (isMultiSelectModifier(evt)) {
        this.toggleMemberInSelection('shape', shapeId)
        return
      }
      // Always called for its enteredGroupId side effect, but only acted on
      // below (after the partOfGroup check) — see instanceEl's own doc
      // comment for why: redirecting to "just this shape's own persisted
      // group" would drop any extra elements already selected alongside it.
      const redirectGroup = this.groupRedirectFor('shape', shapeId)
      // Same "already part of a larger mixed selection" carry-along as the
      // instanceEl branch above — a selected shape being dragged alongside a
      // selected leader line (or pipe) must not collapse down to just this
      // shape.
      const partOfGroup = this.selectedShapeIds.includes(shapeId) && this.totalSelectedCount() > 1
      if (partOfGroup) {
        this.dragMode = 'move-group'
        this.groupDragStartWorld = world
        this.callbacks.onGroupDragStart(this.selectedInstanceIds, this.companionPipePoints)
        return
      }
      if (redirectGroup) {
        this.callbacks.onGroupSelected(redirectGroup.groupId)
        this.dragMode = 'move-group'
        this.groupDragStartWorld = world
        const memberInstanceIds = redirectGroup.members.filter((m) => m.kind === 'instance').map((m) => m.id)
        this.callbacks.onGroupDragStart(memberInstanceIds, [])
        return
      }
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
      const leaderLineId = leaderLineEl.getAttribute('data-leader-line-id')!
      if (isMultiSelectModifier(evt)) {
        this.toggleMemberInSelection('leaderLine', leaderLineId)
        return
      }
      const redirectGroup = this.groupRedirectFor('leaderLine', leaderLineId)
      if (redirectGroup) {
        this.callbacks.onGroupSelected(redirectGroup.groupId)
        return
      }
      // Selecting the line body itself doesn't start a drag — only the
      // `to`/waypoint handles do (see leaderLinePointEl above); `from` isn't
      // draggable in v1.
      this.setLeaderLineSelectionFromUser([leaderLineId])
      return
    }

    // Locked image layers are pointer-events:none, so this branch can only
    // ever fire for an unlocked one — a locked layer can only be selected
    // via the layers panel (which unlocks it from there, per the design).
    if (layerEl) {
      const layerId = layerEl.getAttribute('data-layer-id')!
      const layer = this.latestLayers.find((l) => l.layerId === layerId)
      if (isMultiSelectModifier(evt)) {
        this.toggleMemberInSelection('layer', layerId)
        return
      }
      // Always called for its enteredGroupId side effect, but only acted on
      // below (after the partOfGroup check) — see instanceEl's own doc
      // comment for why: redirecting to "just this layer's own persisted
      // group" would drop any extra elements already selected alongside it.
      const redirectGroup = this.groupRedirectFor('layer', layerId)
      const partOfGroup = this.selectedLayerIds.includes(layerId) && this.totalSelectedCount() > 1
      if (partOfGroup) {
        this.dragMode = 'move-group'
        this.groupDragStartWorld = world
        this.callbacks.onGroupDragStart(this.selectedInstanceIds, this.companionPipePoints)
        return
      }
      if (redirectGroup) {
        this.callbacks.onGroupSelected(redirectGroup.groupId)
        this.dragMode = 'move-group'
        this.groupDragStartWorld = world
        const memberInstanceIds = redirectGroup.members.filter((m) => m.kind === 'instance').map((m) => m.id)
        this.callbacks.onGroupDragStart(memberInstanceIds, [])
        return
      }
      this.setLayerSelectionFromUser([layerId])
      this.enteredGroupId = null
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

    // Empty canvas: starts a box-select and exits any "entered" group (see
    // enteredGroupId) — clicking away from a group's members always leaves
    // whole-group-selection mode for the next click on them.
    this.enteredGroupId = null
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
      const anchor = this.resolveLeaderLineEndpointAnchor(world)
      const previewPos =
        resolveLeaderLineEndpoint(anchor, this.latestInstances, this.latestPipes, this.latestShapes, this.latestLayers) ?? world
      this.updateLeaderLineDraftPreview(previewPos)
      return
    }

    if (this.dragMode === 'move-leader-line-point' && this.dragLeaderLineId !== null && this.dragLeaderLinePoint !== null) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      if (this.dragLeaderLinePoint === 'from') {
        // `from` re-anchors onto a different role label if the drag lands
        // exactly on one (elementFromPoint, not evt.target — pointer capture
        // retargets evt.target to the svg root for the duration of this
        // drag, same issue onDoubleClick's own doc comment describes),
        // otherwise the wider proximity search (shape/pipe/role-box border),
        // otherwise a raw free point.
        const el = document.elementFromPoint(evt.clientX, evt.clientY)
        const roleHit = el ? this.resolveRoleRefAt(el) : null
        const from = roleHit ? roleHit.ref : this.resolveLeaderLineEndpointAnchor(world)
        this.callbacks.onLeaderLineFromMoved(this.dragLeaderLineId, from)
        return
      }
      if (this.dragLeaderLinePoint === 'to') {
        // No grid/align snapping, but does dock onto a nearby shape/pipe/role-box border.
        this.callbacks.onLeaderLinePointMoved(this.dragLeaderLineId, 'to', this.resolveLeaderLineEndpointAnchor(world))
        return
      }
      // Interior waypoint: shape-border snap only, same as before.
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

    if (this.dragMode === 'resize-shape-point' && this.dragShapeId && this.dragShapePointIndex !== null) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      const snapped = this.snapToGrid(world)
      const newPoints = this.dragShapeStartPoints.map((p, i) => (i === this.dragShapePointIndex ? snapped : p))
      this.callbacks.onShapeMoved(this.dragShapeId, newPoints)
      return
    }

    if (
      this.dragMode === 'move-connection-point' &&
      this.dragConnectionPointOwnerKind &&
      this.dragConnectionPointOwnerId &&
      this.dragConnectionPointId
    ) {
      const world = this.screenToWorld(evt.clientX, evt.clientY)
      if (this.dragConnectionPointOwnerKind === 'layer') {
        const layer = this.latestLayers.find((l) => l.layerId === this.dragConnectionPointOwnerId)
        if (layer && layer.kind === 'image' && layer.width > 0 && layer.height > 0) {
          const relX = clamp01((world.x - layer.x) / layer.width)
          const relY = clamp01((world.y - layer.y) / layer.height)
          this.callbacks.onConnectionPointMoved('layer', layer.layerId, this.dragConnectionPointId, relX, relY)
        }
      } else {
        const shape = this.latestShapes.find((s) => s.instanceId === this.dragConnectionPointOwnerId)
        if (shape) {
          const { minX, minY, maxX, maxY } = boundsOfPoints(shape.points)
          const width = maxX - minX
          const height = maxY - minY
          if (width > 0 && height > 0) {
            const relX = clamp01((world.x - minX) / width)
            const relY = clamp01((world.y - minY) / height)
            this.callbacks.onConnectionPointMoved('shape', shape.instanceId, this.dragConnectionPointId, relX, relY)
          }
        }
      }
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

    if (this.dragMode === 'resize-instance' && this.dragResizeInstanceId && this.dragResizeHandle) {
      const instance = this.latestInstances.find((i) => i.instanceId === this.dragResizeInstanceId)
      const def = instance ? getComponentType(instance.componentTypeId) : null
      if (instance && def?.resizable) {
        const world = this.screenToWorld(evt.clientX, evt.clientY)
        const snapped = this.snapToGrid(world)
        const { x: startX, y: startY, rotationDeg } = this.dragResizeStartTransform
        const startSize = this.dragResizeStartSize
        const handle = this.dragResizeHandle

        // Un-rotate the cursor into the box's own local frame — the corner
        // opposite the one being dragged is anchored in that local frame,
        // not world axes, so a rotated box resizes without skewing.
        const localCursor = rotatePoint({ x: snapped.x - startX, y: snapped.y - startY }, -rotationDeg)
        const anchorLocal = {
          x: handle.includes('w') ? startSize.width : 0,
          y: handle.includes('n') ? startSize.height : 0,
        }
        const minSize = def.resizable.minSize(instance)
        const newWidth = Math.max(minSize.width, Math.abs(localCursor.x - anchorLocal.x))
        const newHeight = Math.max(minSize.height, Math.abs(localCursor.y - anchorLocal.y))

        // The origin (the box's own local (0,0)/nw corner) only moves when
        // the anchor isn't already local (0,0) — for the 'se' handle both
        // offsets below are zero, so the origin stays put with no special case.
        const originOffsetLocal = {
          x: handle.includes('w') ? -newWidth : 0,
          y: handle.includes('n') ? -newHeight : 0,
        }
        const anchorWorld = {
          x: startX + rotatePoint(anchorLocal, rotationDeg).x,
          y: startY + rotatePoint(anchorLocal, rotationDeg).y,
        }
        const rotatedOffset = rotatePoint(originOffsetLocal, rotationDeg)
        this.callbacks.onInstanceResized(instance.instanceId, {
          x: anchorWorld.x + rotatedOffset.x,
          y: anchorWorld.y + rotatedOffset.y,
          width: newWidth,
          height: newHeight,
        })
      }
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
        const refs = this.collectAlignReferences({
          excludeWaypoint: { pipeId: this.dragPipeId, index: this.dragWaypointIndex },
        })
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
      // Port-snap takes priority (matches draw-pipe's own snap behavior).
      // Dropped anywhere else it becomes a bare free point — exactly how
      // disconnecting this end from a component works — so that case gets
      // the same alignment-guide ("orange line") snap-to-other-elements
      // behavior draw-pipe and move-waypoint already have, instead of a
      // plain grid-only snap.
      const hit = this.findPortNear(world, this.dragPipeId)
      let target: PortRef | FreePoint
      if (hit) {
        target = hit.ref
        this.hideAlignGuides()
      } else {
        const aligned = this.snapWithAlignmentOrGrid(world, this.collectAlignReferences())
        target = aligned.point
        if (aligned.guideX !== null || aligned.guideY !== null) this.showAlignGuides(aligned.guideX, aligned.guideY)
        else this.hideAlignGuides()
      }
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
      // The instance's origin, not the raw pointer, is what gets snapped/
      // positioned — keeps the point the user actually grabbed fixed under
      // the cursor instead of the origin jumping to the cursor on the first
      // move frame (the bug when grabbing a box anywhere but its corner).
      const target = { x: world.x - this.dragInstanceGrabOffset.x, y: world.y - this.dragInstanceGrabOffset.y }
      let snapped: Point
      if (evt.shiftKey) {
        const gridSnapped = this.snapToGrid(target)
        const delta = this.constrainDeltaToAxis({
          x: gridSnapped.x - this.dragInstanceStartPos.x,
          y: gridSnapped.y - this.dragInstanceStartPos.y,
        })
        snapped = { x: this.dragInstanceStartPos.x + delta.x, y: this.dragInstanceStartPos.y + delta.y }
        this.hideAlignGuides()
      } else {
        const instance = this.latestInstances.find((i) => i.instanceId === this.dragInstanceId)
        const refs = this.collectAlignReferences({ excludeInstanceIds: new Set([this.dragInstanceId]) })
        const candidates = instance ? this.instancePortWorldPositions(instance, target) : []
        const { correctionX, correctionY, guideX, guideY } = this.bestAxisAlignment(candidates, refs)
        const gridSnapped = this.snapToGrid(target)
        snapped = {
          x: correctionX !== null ? target.x + correctionX : gridSnapped.x,
          y: correctionY !== null ? target.y + correctionY : gridSnapped.y,
        }
        if (guideX !== null || guideY !== null) this.showAlignGuides(guideX, guideY)
        else this.hideAlignGuides()
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
      let snappedDelta: Point
      if (evt.shiftKey) {
        snappedDelta = this.snapToGrid(delta)
        this.hideAlignGuides()
      } else {
        const selected = new Set(this.selectedInstanceIds)
        const groupInstances = this.latestInstances.filter((i) => selected.has(i.instanceId))
        const excludeIds = new Set(groupInstances.map((i) => i.instanceId))
        const refs = this.collectAlignReferences({ excludeInstanceIds: excludeIds })
        const candidates = groupInstances.flatMap((inst) =>
          this.instancePortWorldPositions(inst, { x: inst.transform.x + delta.x, y: inst.transform.y + delta.y }),
        )
        const { correctionX, correctionY, guideX, guideY } = this.bestAxisAlignment(candidates, refs)
        const gridDelta = this.snapToGrid(delta)
        snappedDelta = {
          x: correctionX !== null ? delta.x + correctionX : gridDelta.x,
          y: correctionY !== null ? delta.y + correctionY : gridDelta.y,
        }
        if (guideX !== null || guideY !== null) this.showAlignGuides(guideX, guideY)
        else this.hideAlignGuides()
      }
      this.callbacks.onGroupDragMove(snappedDelta)
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
    // A pipe endpoint/waypoint pointerdown always starts a drag immediately
    // (see endpointEl/waypointEl above), but if it turns out the pointer
    // never actually moved — a click, not a drag — and it landed on the
    // already-selected point, cycle to the next pipe sharing that junction
    // instead (see cyclePipePointSelection/pipePointCycleCandidate).
    if (
      (this.dragMode === 'move-pipe-endpoint' || this.dragMode === 'move-waypoint') &&
      this.pipePointCycleCandidate
    ) {
      const dx = evt.clientX - this.dragStartScreen.x
      const dy = evt.clientY - this.dragStartScreen.y
      if (Math.hypot(dx, dy) <= CLICK_MOVE_THRESHOLD_PX) {
        const { pipeId, point, pos } = this.pipePointCycleCandidate
        this.cyclePipePointSelection(pipeId, point, pos)
      }
    }
    this.pipePointCycleCandidate = null
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
    this.dragShapePointIndex = null
    this.dragConnectionPointOwnerKind = null
    this.dragConnectionPointOwnerId = null
    this.dragConnectionPointId = null
    this.dragLeaderLineId = null
    this.dragLeaderLinePoint = null
    this.dragLayerId = null
    this.dragResizeHandle = null
    this.dragResizeInstanceId = null
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
   * Computes matches for all four categories (instances/pipes/shapes/leader
   * lines) unconditionally in one pass and unions them into the selection —
   * the previous version checked instances first and only looked at pipes
   * (then leader lines) as a fallback when zero instances matched, so a box
   * overlapping both a component and a pipe silently dropped the pipe. That
   * tiering was a real pre-existing bug affecting every box-select, not
   * just this grouping feature; fixed here for all of them at once.
   */
  private finalizeBoxSelect(endWorld: Point) {
    const minX = Math.min(this.boxSelectStartWorld.x, endWorld.x)
    const maxX = Math.max(this.boxSelectStartWorld.x, endWorld.x)
    const minY = Math.min(this.boxSelectStartWorld.y, endWorld.y)
    const maxY = Math.max(this.boxSelectStartWorld.y, endWorld.y)
    const within = (p: Point) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY

    const matchedInstances = this.latestInstances.filter((inst) => within(inst.transform)).map((i) => i.instanceId)
    const matchedPipes = this.latestPipes
      .filter((pipe) => {
        const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
        return points?.some(within) ?? false
      })
      .map((p) => p.instanceId)
    const matchedShapes = this.latestShapes
      .filter((shape) => {
        const shapeLayer = this.latestLayers.find((l) => l.layerId === (shape.layerId || 'default'))
        if (shapeLayer?.locked) return false
        return shape.points.some(within)
      })
      .map((s) => s.instanceId)
    const matchedLeaderLines = this.latestLeaderLines
      .filter((line) => {
        const points = getLeaderLinePoints(line, this.latestInstances, this.latestPipes, this.latestShapes, this.latestLayers)
        return points?.some(within) ?? false
      })
      .map((l) => l.instanceId)
    const matchedLayers = this.latestLayers
      .filter((l) => {
        if (l.kind !== 'image' || l.locked) return false
        const corners = [
          { x: l.x, y: l.y },
          { x: l.x + l.width, y: l.y },
          { x: l.x, y: l.y + l.height },
          { x: l.x + l.width, y: l.y + l.height },
        ]
        return corners.some(within)
      })
      .map((l) => l.layerId)

    const nothingMatched =
      matchedInstances.length === 0 &&
      matchedPipes.length === 0 &&
      matchedShapes.length === 0 &&
      matchedLeaderLines.length === 0 &&
      matchedLayers.length === 0

    if (nothingMatched && !this.boxSelectAdditive) {
      // Nothing in the box at all — clears every selection category, same as before.
      this.setMixedSelectionFromUser({ instanceIds: [], pipeIds: [], shapeIds: [], leaderLineIds: [], layerIds: [] })
      if (this.boxSelectRectEl) this.boxSelectRectEl.style.display = 'none'
      return
    }

    // Group expansion: a (non-additive) box that touches part of an existing
    // group pulls in that group's full membership, not just whichever
    // members happened to physically fall inside the box — and keeps
    // whatever else the box also caught (free-standing elements, or another
    // group) alongside it, rather than replacing the whole selection with
    // just the touched group. Only collapses to a persisted selectedGroupId
    // when the expanded result exactly equals one group's full membership
    // (via membersMatchSelection, the same exact-match check
    // toggleMemberInSelection uses for Ctrl/Cmd+click) — otherwise it's a
    // loose multi-select spanning the expanded group(s) plus any extras.
    let instancesForSelection = matchedInstances
    let pipesForSelection = matchedPipes
    let shapesForSelection = matchedShapes
    let leaderLinesForSelection = matchedLeaderLines
    let layersForSelection = matchedLayers

    if (!this.boxSelectAdditive) {
      const touchedGroups = this.latestGroups.filter((g) =>
        g.members.some(
          (m) =>
            (m.kind === 'instance' && matchedInstances.includes(m.id)) ||
            (m.kind === 'pipe' && matchedPipes.includes(m.id)) ||
            (m.kind === 'shape' && matchedShapes.includes(m.id)) ||
            (m.kind === 'leaderLine' && matchedLeaderLines.includes(m.id)) ||
            (m.kind === 'layer' && matchedLayers.includes(m.id)),
        ),
      )
      if (touchedGroups.length > 0) {
        const expandedInstances = new Set(matchedInstances)
        const expandedPipes = new Set(matchedPipes)
        const expandedShapes = new Set(matchedShapes)
        const expandedLeaderLines = new Set(matchedLeaderLines)
        const expandedLayers = new Set(matchedLayers)
        for (const group of touchedGroups) {
          for (const m of group.members) {
            if (m.kind === 'instance') expandedInstances.add(m.id)
            else if (m.kind === 'pipe') expandedPipes.add(m.id)
            else if (m.kind === 'shape') expandedShapes.add(m.id)
            else if (m.kind === 'layer') expandedLayers.add(m.id)
            else expandedLeaderLines.add(m.id)
          }
        }
        instancesForSelection = Array.from(expandedInstances)
        pipesForSelection = Array.from(expandedPipes)
        shapesForSelection = Array.from(expandedShapes)
        leaderLinesForSelection = Array.from(expandedLeaderLines)
        layersForSelection = Array.from(expandedLayers)

        const exactGroup = this.latestGroups.find((g) =>
          this.membersMatchSelection(g, {
            instanceIds: instancesForSelection,
            pipeIds: pipesForSelection,
            shapeIds: shapesForSelection,
            leaderLineIds: leaderLinesForSelection,
            layerIds: layersForSelection,
          }),
        )
        if (exactGroup) {
          this.companionPipePoints = []
          this.refreshCompanionPipePointHandles()
          this.callbacks.onGroupSelected(exactGroup.groupId)
          if (this.boxSelectRectEl) this.boxSelectRectEl.style.display = 'none'
          return
        }
      }
    }

    const nextInstances = this.boxSelectAdditive
      ? Array.from(new Set([...this.selectedInstanceIds, ...instancesForSelection]))
      : instancesForSelection
    const nextPipes = this.boxSelectAdditive
      ? Array.from(new Set([...this.selectedPipeIds, ...pipesForSelection]))
      : pipesForSelection
    const nextShapes = this.boxSelectAdditive
      ? Array.from(new Set([...this.selectedShapeIds, ...shapesForSelection]))
      : shapesForSelection
    const nextLeaderLines = this.boxSelectAdditive
      ? Array.from(new Set([...this.selectedLeaderLineIds, ...leaderLinesForSelection]))
      : leaderLinesForSelection
    const nextLayers = this.boxSelectAdditive
      ? Array.from(new Set([...this.selectedLayerIds, ...layersForSelection]))
      : layersForSelection

    this.setMixedSelectionFromUser({
      instanceIds: nextInstances,
      pipeIds: nextPipes,
      shapeIds: nextShapes,
      leaderLineIds: nextLeaderLines,
      layerIds: nextLayers,
    })

    // "Mark knots like elements": a free pipe knot (interior waypoint, or a
    // disconnected from/to end — an *attached* end already tracks its
    // component live and needs no help) caught in the same box as an
    // instance travels with it on the very next drag. setMixedSelectionFromUser
    // (just above) clears this field first, so it's safe to set it after.
    if (matchedInstances.length > 0) {
      for (const pipe of this.latestPipes) {
        const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
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
  }

  /**
   * User-driven selection (pointer click / box-select): also notifies the
   * callback. Drops any companion pipe knots from a previous box-select —
   * finalizeBoxSelect re-populates them right after calling this when it
   * has some, so they only ever survive into the very next drag they were
   * computed for, never a later, unrelated one.
   */
  /**
   * Sets all four selection-category highlight/state at once and notifies
   * onMixedSelectionChanged — used by finalizeBoxSelect's unified match pass
   * so a box catching a genuine mix (e.g. a component and a pipe together)
   * keeps all of them selected together, instead of going through the four
   * individual setXSelectionFromUser methods, each of which (via its own
   * store action) clears the OTHER three categories for its own single-
   * category click use case.
   */
  /**
   * Ctrl/Cmd+click toggle-membership, generalized to any of the four kinds
   * and routed through setMixedSelectionFromUser instead of a single-kind
   * setXSelectionFromUser — so Ctrl/Cmd+clicking across different kinds
   * (an instance, then a pipe, then a shape) accumulates a real mixed
   * selection instead of each click's own store action wiping the other
   * three categories.
   *
   * Respects group boundaries: if the clicked element belongs to a
   * persisted Group, the WHOLE group toggles as one unit (added if any of
   * its members are missing from the current selection, removed only if
   * every one of them is already present) — so Ctrl/Cmd+clicking a member
   * of a different group while one group is already selected adds that
   * entire second group, not just the one element clicked. An ungrouped
   * element still toggles on its own, same as before.
   */
  private toggleMemberInSelection(kind: GroupMemberKind, id: string) {
    this.enteredGroupId = null
    const group = this.groupContaining(kind, id)
    const targets: GroupMemberRef[] = group ? group.members : [{ kind, id }]

    const sets: Record<GroupMemberKind, Set<string>> = {
      instance: new Set(this.selectedInstanceIds),
      pipe: new Set(this.selectedPipeIds),
      shape: new Set(this.selectedShapeIds),
      leaderLine: new Set(this.selectedLeaderLineIds),
      layer: new Set(this.selectedLayerIds),
    }
    const allPresent = targets.every((m) => sets[m.kind].has(m.id))
    for (const m of targets) {
      if (allPresent) sets[m.kind].delete(m.id)
      else sets[m.kind].add(m.id)
    }
    const next = {
      instanceIds: Array.from(sets.instance),
      pipeIds: Array.from(sets.pipe),
      shapeIds: Array.from(sets.shape),
      leaderLineIds: Array.from(sets.leaderLine),
      layerIds: Array.from(sets.layer),
    }

    // If the resulting selection happens to exactly equal some persisted
    // group's full membership (e.g. Ctrl/Cmd+clicking a second group off
    // again leaves exactly the first one), reselect it as that group so the
    // properties panel shows "Group selected" rather than a generic loose
    // multi-select.
    const exactGroup = this.latestGroups.find((g) => this.membersMatchSelection(g, next))
    if (exactGroup) {
      this.callbacks.onGroupSelected(exactGroup.groupId)
      return
    }
    this.setMixedSelectionFromUser(next)
  }

  /** True when `group`'s full membership exactly equals the given four-array selection — shared by isCurrentGroupSelection (against the live canvas selection) and toggleMemberInSelection (against a not-yet-applied candidate selection). */
  private membersMatchSelection(
    group: Group,
    selection: { instanceIds: string[]; pipeIds: string[]; shapeIds: string[]; leaderLineIds: string[]; layerIds: string[] },
  ): boolean {
    const total =
      selection.instanceIds.length +
      selection.pipeIds.length +
      selection.shapeIds.length +
      selection.leaderLineIds.length +
      selection.layerIds.length
    if (group.members.length !== total) return false
    const sets: Record<GroupMemberKind, Set<string>> = {
      instance: new Set(selection.instanceIds),
      pipe: new Set(selection.pipeIds),
      shape: new Set(selection.shapeIds),
      leaderLine: new Set(selection.leaderLineIds),
      layer: new Set(selection.layerIds),
    }
    return group.members.every((m) => sets[m.kind].has(m.id))
  }

  private setMixedSelectionFromUser(selection: {
    instanceIds: string[]
    pipeIds: string[]
    shapeIds: string[]
    leaderLineIds: string[]
    layerIds: string[]
  }) {
    this.setRoleSelectionFromUser(null)
    this.applySelectionHighlight(selection.instanceIds)
    this.applyPipeSelectionHighlight(selection.pipeIds)
    this.applyShapeSelectionHighlight(selection.shapeIds)
    this.applyLeaderLineSelectionHighlight(selection.leaderLineIds)
    this.applyLayerSelectionHighlight(selection.layerIds)
    this.companionPipePoints = []
    this.refreshCompanionPipePointHandles()
    this.callbacks.onMixedSelectionChanged(selection)
  }

  /** Combined size of the current selection across all five kinds — used to decide whether dragging an already-selected instance/shape/layer should carry the rest of a mixed selection along (group-drag) instead of collapsing to just the clicked item. */
  private totalSelectedCount(): number {
    return (
      this.selectedInstanceIds.length +
      this.selectedPipeIds.length +
      this.selectedShapeIds.length +
      this.selectedLeaderLineIds.length +
      this.selectedLayerIds.length
    )
  }

  /** Finds the group (if any) a given member kind/id belongs to — flat lookup, no recursion (Group.members is always leaf-kind, see the model). */
  private groupContaining(kind: GroupMemberKind, id: string): Group | null {
    return this.latestGroups.find((g) => g.members.some((m) => m.kind === kind && m.id === id)) ?? null
  }

  /** True when `group`'s full membership exactly equals the canvas's current live selection — used to recognize "the currently selected group" without SvgCanvas needing its own copy of selectedGroupId. */
  private isCurrentGroupSelection(group: Group): boolean {
    return this.membersMatchSelection(group, {
      instanceIds: this.selectedInstanceIds,
      pipeIds: this.selectedPipeIds,
      shapeIds: this.selectedShapeIds,
      leaderLineIds: this.selectedLeaderLineIds,
      layerIds: this.selectedLayerIds,
    })
  }

  /**
   * Decides whether a plain click on this member should redirect into
   * whole-group selection (PowerPoint-style), and maintains enteredGroupId
   * along the way: exits it the moment a different group (or an ungrouped
   * element) is clicked, so a stale "entered" flag can never linger onto an
   * unrelated later click. Returns the group to redirect to, or null if
   * there's no group here or we're already entered into this exact one (see
   * onDoubleClick, which is the only place that sets enteredGroupId).
   */
  private groupRedirectFor(kind: GroupMemberKind, id: string): Group | null {
    const group = this.groupContaining(kind, id)
    const staysEntered = group != null && this.enteredGroupId === group.groupId
    if (!staysEntered) this.enteredGroupId = null
    return staysEntered ? null : group
  }

  /** Selects just one member on its own — used when double-clicking into a group (see onDoubleClick) to bypass the group-redirect for that one click. */
  private selectSingleGroupMember(kind: GroupMemberKind, id: string) {
    if (kind === 'instance') this.setSelectionFromUser([id])
    else if (kind === 'pipe') this.setPipeSelectionFromUser([id])
    else if (kind === 'shape') this.setShapeSelectionFromUser([id])
    else if (kind === 'layer') this.setLayerSelectionFromUser([id])
    else this.setLeaderLineSelectionFromUser([id])
  }

  /** Resolves the nearest group-member-bearing element (instance/pipe/shape/leader-line) at a point, if any — used by onDoubleClick's group-enter check. */
  private resolveGroupMemberAt(target: Element): { kind: GroupMemberKind; id: string } | null {
    const instanceEl = target.closest('[data-instance-id]') as SVGElement | null
    if (instanceEl) return { kind: 'instance', id: instanceEl.getAttribute('data-instance-id')! }
    const shapeEl = target.closest('[data-shape-id]') as SVGElement | null
    if (shapeEl) return { kind: 'shape', id: shapeEl.getAttribute('data-shape-id')! }
    const pipeEl = target.closest('[data-pipe-id]') as SVGElement | null
    if (pipeEl) return { kind: 'pipe', id: pipeEl.getAttribute('data-pipe-id')! }
    const leaderLineEl = target.closest('[data-leader-line-id]') as SVGElement | null
    if (leaderLineEl) return { kind: 'leaderLine', id: leaderLineEl.getAttribute('data-leader-line-id')! }
    const layerEl = target.closest('[data-layer-id]') as SVGElement | null
    if (layerEl) return { kind: 'layer', id: layerEl.getAttribute('data-layer-id')! }
    return null
  }

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

  /** Called from App.tsx's Escape handler — exits "entered" group-editing mode (see enteredGroupId) the same way clicking empty canvas does. */
  clearEnteredGroup() {
    this.enteredGroupId = null
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
    this.refreshInstanceResizeHandles()
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
    // Only invalidated when the endpoint's own pipe actually drops out of
    // the selection, not on every call — this function also runs as an
    // external sync (setPipeSelection) every time the *store's*
    // selectedPipeIds changes, which includes the redundant round-trip
    // right after the endpointEl click branch's own setPipeSelectionFromUser
    // call. Resetting unconditionally here wiped selectedEndpoint before the
    // user's next click could ever see it "already selected", silently
    // breaking coincident-point cycling one step in (see
    // cyclePipePointSelection) — cycle *into* an endpoint worked, cycling
    // *out of* one didn't, since a real selection change (a different pipe)
    // still correctly clears it below.
    if (this.selectedEndpoint && !pipeIds.includes(this.selectedEndpoint.pipeId)) {
      this.selectedEndpoint = null
    }
    this.refreshWaypointHandles()
    this.refreshCornerFlipHandles()
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
    this.refreshShapeResizeHandles()
    this.refreshConnectionPointHandles()
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
    const fromPos = resolveLeaderLineEndpoint(line.from, this.latestInstances, this.latestPipes, this.latestShapes, this.latestLayers)
    if (fromPos) addHandle(fromPos, 'from')
    line.waypoints.forEach((wp, index) => addHandle(wp, String(index)))
    const toPos = resolveLeaderLineEndpoint(line.to, this.latestInstances, this.latestPipes, this.latestShapes, this.latestLayers)
    if (toPos) addHandle(toPos, 'to')
  }

  private setLayerSelectionFromUser(layerIds: string[]) {
    this.setRoleSelectionFromUser(null)
    this.applyLayerSelectionHighlight(layerIds)
    this.callbacks.onLayerSelectionChanged(layerIds)
  }

  /** External sync (e.g. selected via the layers panel): highlight only, no callback. */
  setLayerSelection(layerIds: string[]) {
    this.applyLayerSelectionHighlight(layerIds)
  }

  /** External sync (e.g. cleared by Escape, or selected via a connection-point list row in the panel): highlight only, no callback. */
  setConnectionPointSelection(selection: { ownerKind: 'layer' | 'shape'; ownerId: string; pointId: string } | null) {
    this.selectedConnectionPoint = selection
    this.refreshConnectionPointHandles()
  }

  private applyLayerSelectionHighlight(layerIds: string[]) {
    for (const id of this.selectedLayerIds) {
      if (!layerIds.includes(id)) this.imageLayerEls.get(id)?.classList.remove('gv-selected')
    }
    for (const id of layerIds) {
      this.imageLayerEls.get(id)?.classList.add('gv-selected')
    }
    this.selectedLayerIds = layerIds
    // The selected layer's own connection points are shown/hidden based on selection.
    this.refreshPortMarkers()
    this.refreshLayerResizeHandles()
    this.refreshConnectionPointHandles()
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

  private setEndpointSelectionFromUser(selection: { pipeId: string; side: PipeEndpointSide } | null) {
    this.selectedEndpoint = selection
    this.callbacks.onEndpointSelected(selection)
  }

  /** External sync: internal state only, no callback. */
  setEndpointSelection(selection: { pipeId: string; side: PipeEndpointSide } | null) {
    this.selectedEndpoint = selection
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
    const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
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
   * One small diamond marker per inserted orthogonal bend on the selected
   * pipe — clicking it flips that corner to the other side (see
   * setPipeCornerOverride). Only shown for a single selected pipe actually
   * in orthogonal mode; a straight/curved/manual pipe has no bends to flip.
   */
  private refreshCornerFlipHandles() {
    while (this.cornerFlipHandlesGroup.firstChild) {
      this.cornerFlipHandlesGroup.removeChild(this.cornerFlipHandlesGroup.firstChild)
    }
    if (this.selectedPipeIds.length !== 1) return
    const pipe = this.latestPipes.find((p) => p.instanceId === this.selectedPipeIds[0])
    if (!pipe || pipe.routingMode !== 'orthogonal') return

    const points = getPipePoints(pipe, this.latestInstances, this.latestPipes, this.latestLayers, this.latestShapes)
    if (!points) return
    const corners = getOrthogonalCorners(points, pipe.cornerOverrides)
    const r = 5
    for (const corner of corners) {
      const d = document.createElementNS(SVG_NS, 'path')
      d.setAttribute(
        'd',
        `M${corner.pos.x} ${corner.pos.y - r} L${corner.pos.x + r} ${corner.pos.y} L${corner.pos.x} ${corner.pos.y + r} L${corner.pos.x - r} ${corner.pos.y} Z`,
      )
      d.setAttribute('class', 'gv-corner-flip-handle')
      d.setAttribute('data-pipe-id', pipe.instanceId)
      d.setAttribute('data-corner-segment-index', String(corner.segmentIndex))
      this.cornerFlipHandlesGroup.appendChild(d)
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
    // See refreshInstanceResizeHandles's doc comment — same "part of a
    // larger mixed selection" guard, not just "exactly one image selected".
    if (this.totalSelectedCount() !== 1 || this.selectedLayerIds.length !== 1) return
    const layer = this.latestLayers.find((l) => l.layerId === this.selectedLayerIds[0])
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
   * Corner drag-handles on the selected instance, only when exactly one is
   * selected and its type opted into manual resizing (def.resizable — see
   * registry.ts). Unlike the axis-aligned image-layer handles above, these
   * sit at the box's actual *rotated* corners (rotate each local corner by
   * rotationDeg, translate by transform.x/y — same technique refreshDragHandles
   * uses for its bbox-center handle) since a resizable instance can rotate.
   */
  private refreshInstanceResizeHandles() {
    while (this.instanceResizeHandlesGroup.firstChild) {
      this.instanceResizeHandlesGroup.removeChild(this.instanceResizeHandlesGroup.firstChild)
    }
    // totalSelectedCount, not just selectedInstanceIds.length — a resizable
    // instance that's merely one member of a larger mixed selection (e.g.
    // grouped with a pipe/shape/image) must NOT show corner handles, or
    // clicking one hijacks what should be a whole-group drag into a lone
    // resize-instance drag on just this instance (see the pointerdown
    // priority: resizeHandleEl is checked before the group-drag logic).
    if (this.totalSelectedCount() !== 1 || this.selectedInstanceIds.length !== 1) return
    const instance = this.latestInstances.find((i) => i.instanceId === this.selectedInstanceIds[0])
    if (!instance) return
    const def = getComponentType(instance.componentTypeId)
    if (!def.resizable) return

    const { x, y, rotationDeg } = instance.transform
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const corner of resolveLocalBodyCorners(def, instance)) {
      minX = Math.min(minX, corner.x)
      maxX = Math.max(maxX, corner.x)
      minY = Math.min(minY, corner.y)
      maxY = Math.max(maxY, corner.y)
    }
    if (!Number.isFinite(minX)) return

    const localCorners: { handle: ResizeHandle; local: Point; cursor: string }[] = [
      { handle: 'nw', local: { x: minX, y: minY }, cursor: 'nwse-resize' },
      { handle: 'ne', local: { x: maxX, y: minY }, cursor: 'nesw-resize' },
      { handle: 'sw', local: { x: minX, y: maxY }, cursor: 'nesw-resize' },
      { handle: 'se', local: { x: maxX, y: maxY }, cursor: 'nwse-resize' },
    ]
    const size = this.worldThreshold(10)
    for (const c of localCorners) {
      const rotated = rotatePoint(c.local, rotationDeg)
      const worldX = x + rotated.x
      const worldY = y + rotated.y
      const rect = document.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('x', String(worldX - size / 2))
      rect.setAttribute('y', String(worldY - size / 2))
      rect.setAttribute('width', String(size))
      rect.setAttribute('height', String(size))
      rect.setAttribute('class', 'gv-instance-resize-handle')
      rect.setAttribute('data-resize-instance-id', instance.instanceId)
      rect.setAttribute('data-resize-handle', c.handle)
      rect.style.cursor = c.cursor
      this.instanceResizeHandlesGroup.appendChild(rect)
    }
  }

  /**
   * One draggable handle per point of the single selected free shape — since
   * FreeShape.points already *is* its editable geometry (rect/ellipse: 2
   * opposite corners; line: 2 endpoints; polygon: 3+ vertices), dragging any
   * handle just moves that one point via the existing onShapeMoved callback,
   * no separate resize math needed. Text is excluded — its single point is
   * an anchor, not a corner, already covered by the ordinary move drag.
   */
  private refreshShapeResizeHandles() {
    while (this.shapeResizeHandlesGroup.firstChild) {
      this.shapeResizeHandlesGroup.removeChild(this.shapeResizeHandlesGroup.firstChild)
    }
    // See refreshInstanceResizeHandles's doc comment — same "part of a
    // larger mixed selection" guard, not just "exactly one shape selected".
    if (this.totalSelectedCount() !== 1 || this.selectedShapeIds.length !== 1) return
    const shape = this.latestShapes.find((s) => s.instanceId === this.selectedShapeIds[0])
    if (!shape || shape.kind === 'text') return
    const shapeLayer = this.latestLayers.find((l) => l.layerId === (shape.layerId || 'default'))
    if (shapeLayer?.locked) return

    const size = this.worldThreshold(10)
    shape.points.forEach((p, index) => {
      const rect = document.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('x', String(p.x - size / 2))
      rect.setAttribute('y', String(p.y - size / 2))
      rect.setAttribute('width', String(size))
      rect.setAttribute('height', String(size))
      rect.setAttribute('class', 'gv-shape-resize-handle')
      rect.setAttribute('data-shape-id', shape.instanceId)
      rect.setAttribute('data-shape-point-index', String(index))
      rect.style.cursor = 'move'
      this.shapeResizeHandlesGroup.appendChild(rect)
    })
  }

  /**
   * Real interactive (click-to-select, drag-to-reposition) handles for the
   * connection points of the single selected image layer or shape — distinct
   * from portMarkersGroup's non-interactive snap-target previews. Same
   * "part of a larger mixed selection" single-target guard as the resize
   * handles.
   */
  private refreshConnectionPointHandles() {
    while (this.connectionPointHandlesGroup.firstChild) {
      this.connectionPointHandlesGroup.removeChild(this.connectionPointHandlesGroup.firstChild)
    }
    if (this.totalSelectedCount() !== 1) return

    let ownerKind: 'layer' | 'shape'
    let ownerId: string
    let points: { pointId: string; pos: Point }[]

    if (this.selectedLayerIds.length === 1) {
      const layer = this.latestLayers.find((l) => l.layerId === this.selectedLayerIds[0])
      if (!layer || layer.kind !== 'image' || layer.locked) return
      ownerKind = 'layer'
      ownerId = layer.layerId
      points = layer.connectionPoints
        .map((cp) => ({ pointId: cp.pointId, pos: getImageConnectionPointWorldPosition(layer, cp.pointId) }))
        .filter((p): p is { pointId: string; pos: Point } => p.pos !== null)
    } else if (this.selectedShapeIds.length === 1) {
      const shape = this.latestShapes.find((s) => s.instanceId === this.selectedShapeIds[0])
      if (!shape) return
      const shapeLayer = this.latestLayers.find((l) => l.layerId === (shape.layerId || 'default'))
      if (shapeLayer?.locked) return
      ownerKind = 'shape'
      ownerId = shape.instanceId
      points = (shape.connectionPoints ?? [])
        .map((cp) => ({ pointId: cp.pointId, pos: getShapeConnectionPointWorldPosition(shape, cp.pointId) }))
        .filter((p): p is { pointId: string; pos: Point } => p.pos !== null)
    } else {
      return
    }

    const radius = this.worldThreshold(5)
    for (const { pointId, pos } of points) {
      const isSelected =
        this.selectedConnectionPoint?.ownerKind === ownerKind &&
        this.selectedConnectionPoint?.ownerId === ownerId &&
        this.selectedConnectionPoint?.pointId === pointId
      const c = document.createElementNS(SVG_NS, 'circle')
      c.setAttribute('cx', String(pos.x))
      c.setAttribute('cy', String(pos.y))
      c.setAttribute('r', String(radius))
      c.setAttribute('class', isSelected ? 'gv-connection-point-handle gv-selected' : 'gv-connection-point-handle')
      c.setAttribute('data-cp-owner-kind', ownerKind)
      c.setAttribute('data-cp-owner-id', ownerId)
      c.setAttribute('data-cp-point-id', pointId)
      c.style.cursor = 'move'
      this.connectionPointHandlesGroup.appendChild(c)
    }
  }

  /**
   * Thin dashed lines from each selected instance's own body center to its
   * enabled name/value/setpoint labels — the link stays visible even after a
   * label has been dragged away from its default position (see
   * onRoleMoved). Anchored at the body's visual center rather than the
   * instance's transform origin: for most types that origin sits on an edge
   * or corner of the body (e.g. a valve's is on its left edge, an equipment
   * box's is its top-left corner), which made every connector look like it
   * was pointing at a corner instead of "the component this label belongs
   * to" — the center reads correctly regardless of a type's own local
   * coordinate-origin convention.
   */
  private drawSelectionConnectors() {
    while (this.connectorsGroup.firstChild) {
      this.connectorsGroup.removeChild(this.connectorsGroup.firstChild)
    }
    for (const instanceId of this.selectedInstanceIds) {
      const instance = this.latestInstances.find((i) => i.instanceId === instanceId)
      if (!instance) continue

      const { x, y, rotationDeg } = instance.transform
      const def = getComponentType(instance.componentTypeId)
      const corners = resolveLocalBodyCorners(def, instance)
      const localCenter =
        corners.length > 0
          ? {
              x: (Math.min(...corners.map((c) => c.x)) + Math.max(...corners.map((c) => c.x))) / 2,
              y: (Math.min(...corners.map((c) => c.y)) + Math.max(...corners.map((c) => c.y))) / 2,
            }
          : { x: 0, y: 0 }
      const rotatedCenter = rotatePoint(localCenter, rotationDeg)
      const originX = x + rotatedCenter.x
      const originY = y + rotatedCenter.y

      for (const role of instance.roles) {
        if (role.role === 'indicator' || !role.enabled) continue
        const rotated = rotatePoint(role.offset, rotationDeg)
        const line = document.createElementNS(SVG_NS, 'line')
        line.setAttribute('x1', String(originX))
        line.setAttribute('y1', String(originY))
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
        this.getOrCreateVectorLayerSubGroups('default').contentSub.appendChild(group)
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
    this.refreshInstanceResizeHandles()
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
      const pts = getPipePoints(pipe, instances, pipes, this.latestLayers, this.latestShapes)
      if (pts) {
        pointsByPipe.set(pipe.instanceId, pts)
        displayPointsByPipe.set(pipe.instanceId, getDisplayPoints(pipe, pts))
      }
    }
    const nameLabelPipeIds = computeNameLabelPipeIds(pipes)

    for (const pipe of pipes) {
      seen.add(pipe.instanceId)
      let group = this.pipeEls.get(pipe.instanceId)
      if (!group) {
        group = document.createElementNS(SVG_NS, 'g')
        group.setAttribute('data-pipe-id', pipe.instanceId)
        this.getOrCreateVectorLayerSubGroups('default').pipesSub.appendChild(group)
        this.pipeEls.set(pipe.instanceId, group)

        const linePath = document.createElementNS(SVG_NS, 'path')
        linePath.setAttribute('class', 'gv-pipe-line')
        linePath.setAttribute('fill', 'none')
        group.appendChild(linePath)

        const hitPath = document.createElementNS(SVG_NS, 'path')
        hitPath.setAttribute('class', 'gv-pipe-hit')
        hitPath.setAttribute('fill', 'none')
        group.appendChild(hitPath)

        // Bare-text label, same style as a component instance's `name` role
        // — see syncPipes below for why its content is the pipe's volume tag.
        const nameText = document.createElementNS(SVG_NS, 'text')
        nameText.setAttribute('class', 'gv-pipe-name')
        nameText.setAttribute('text-anchor', 'middle')
        nameText.setAttribute('dominant-baseline', 'central')
        nameText.setAttribute('font-family', 'Arial')
        nameText.setAttribute('font-size', '10')
        nameText.style.pointerEvents = 'none'
        group.appendChild(nameText)

        // Per-point arrow markers (see PipeArrow) — rebuilt wholesale below
        // each sync, same as refreshWaypointHandles, since the count varies.
        const arrowsGroup = document.createElementNS(SVG_NS, 'g')
        arrowsGroup.setAttribute('class', 'gv-pipe-arrows')
        arrowsGroup.style.pointerEvents = 'none'
        group.appendChild(arrowsGroup)
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
      const nameText = group.querySelector<SVGTextElement>('.gv-pipe-name')!
      const arrowsGroup = group.querySelector<SVGGElement>('.gv-pipe-arrows')!

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

      // No separate dot marker — when enabled, the pipe's own visible line
      // carries the "_pipe" id directly, same as the exported SVG (see
      // pipeExport.ts), so the entire connected run is what's interactive.
      if (pipe.indicatorEnabled) {
        linePath.id = `${resolveIndicatorTag(pipe)}_pipe`
      } else if (linePath.id) {
        linePath.removeAttribute('id')
      }
      const mid = midpoint(displayPoints)

      // Text is the pipe's *volume* tag, same as "_pipe" above — labels
      // the connected run, not just this one segment (see PipeInstance.nameEnabled).
      // Only the one pipe computeNameLabelPipeIds picked for this volume
      // actually shows it, even though every pipe in the volume has
      // nameEnabled kept in sync — one label per run, not one per segment.
      nameText.style.display = pipe.nameEnabled && nameLabelPipeIds.has(pipe.instanceId) ? '' : 'none'
      nameText.id = `${resolveIndicatorTag(pipe)}_name`
      nameText.textContent = resolveIndicatorTag(pipe)
      nameText.setAttribute('x', String(mid.x))
      nameText.setAttribute('y', String(mid.y - 10))

      // Arrow markers resolve against the RAW point list (points), not
      // displayPoints — pointIndex is defined the same way pipePointPortId
      // is (see resolvePipeArrows's own doc comment), and displayPoints can
      // insert extra orthogonal-mode corners that would shift indices.
      while (arrowsGroup.firstChild) arrowsGroup.removeChild(arrowsGroup.firstChild)
      const color = resolvePipeColor(pipe)
      for (const arrow of resolvePipeArrows(pipe, points)) {
        // An open chevron (two strokes meeting at the tip), not a filled
        // triangle — tip at local (size,0), pointing along +X before rotation.
        const half = arrow.size * 0.5
        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', `M0,${fmt(-half)} L${fmt(arrow.size)},0 L0,${fmt(half)}`)
        path.setAttribute('fill', 'none')
        path.setAttribute('stroke', color)
        path.setAttribute('stroke-width', '2')
        path.setAttribute('stroke-linecap', 'round')
        path.setAttribute('stroke-linejoin', 'round')
        path.setAttribute('transform', `translate(${fmt(arrow.pos.x)},${fmt(arrow.pos.y)}) rotate(${fmt(arrow.rotationDeg)})`)
        arrowsGroup.appendChild(path)
      }
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
    this.refreshCornerFlipHandles()
    this.refreshCompanionPipePointHandles()
  }

  /**
   * Reconciles every layer's DOM group (image <image> elements; vector
   * layers' sub-groups, created on demand) AND reorders them to match
   * `layers` array order — this is the one place layer paint order actually
   * changes, since it's the only sync* method CanvasView re-runs on a pure
   * `layers` change (see its own useEffect wiring). 'default' always holds
   * pipes/instances; every vector layer (including 'default') independently
   * toggles its own visibility now — previously there was only ever one
   * vector layer so a single shared visible flag was enough, but with
   * multiple vector (shape) layers each needs its own.
   */
  syncLayers(layers: Layer[]) {
    this.latestLayers = layers
    this.updateGridMask(layers)
    const seen = new Set<string>()

    for (const layer of layers) {
      seen.add(layer.layerId)
      if (layer.kind === 'image') {
        const outer = this.getOrCreateImageLayerGroup(layer.layerId)
        let img = this.imageLayerEls.get(layer.layerId)
        if (!img) {
          img = document.createElementNS(SVG_NS, 'image')
          img.setAttribute('data-layer-id', layer.layerId)
          outer.appendChild(img)
          this.imageLayerEls.set(layer.layerId, img)
        }
        img.style.display = layer.visible ? '' : 'none'
        img.setAttribute('x', String(layer.x))
        img.setAttribute('y', String(layer.y))
        img.setAttribute('width', String(layer.width))
        img.setAttribute('height', String(layer.height))
        img.setAttribute('opacity', String(layer.opacity))
        img.setAttribute('href', layer.src)
        img.classList.toggle('gv-selected', this.selectedLayerIds.includes(layer.layerId))
        // Locked (the default) means non-interactive — a reference image
        // shouldn't intercept clicks meant for the grid/content underneath
        // or on top, and can then only be selected/unlocked via the layers
        // panel.
        img.style.pointerEvents = layer.locked ? 'none' : 'auto'
        img.style.cursor = layer.locked ? 'default' : 'move'
      } else {
        const { outer } = this.getOrCreateVectorLayerSubGroups(layer.layerId)
        outer.style.display = layer.visible ? '' : 'none'
      }
    }

    // Remove groups for deleted layers (image els + vector sub-group maps + the outer group itself).
    for (const [id, outer] of this.layerGroupEls) {
      if (!seen.has(id)) {
        outer.remove()
        this.layerGroupEls.delete(id)
        this.imageLayerEls.delete(id)
        this.vectorPipesSubEls.delete(id)
        this.vectorContentSubEls.delete(id)
        this.vectorShapesSubEls.delete(id)
      }
    }
    if (this.selectedLayerIds.some((id) => !seen.has(id))) {
      this.selectedLayerIds = this.selectedLayerIds.filter((id) => seen.has(id))
    }

    // Reorder: re-append every layer's outer group in array order
    // (bottom-first, matching how `layers` is already stored elsewhere) —
    // appendChild on an already-parented node just moves it, so this is
    // the entire "make DOM paint order match the array" step.
    for (const layer of layers) {
      const outer = this.layerGroupEls.get(layer.layerId)
      if (outer) this.layersContainer.appendChild(outer)
    }

    this.refreshPortMarkers()
    this.refreshLayerResizeHandles()
    this.refreshConnectionPointHandles()
    // A pipe may be anchored to an image connection point — if this layer
    // sync is what just brought those coordinates in (or moved them), pipe
    // geometry needs to be recomputed too, not just wait for its own next
    // unrelated instances/pipes change.
    this.syncPipes(this.latestPipes, this.latestInstances)
  }

  /** Groups have no DOM presence of their own (unlike shapes/leader lines) — just a plain field sync, kept for finalizeBoxSelect's/onPointerDown's group-expansion lookups. */
  syncGroups(groups: Group[]) {
    this.latestGroups = groups
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
        this.shapeEls.set(shape.instanceId, group)
      }
      // Always re-parent (not just on creation) — appendChild on an
      // already-correctly-parented node is a no-op move, but this is what
      // makes reassigning a shape to a different layer (setShapeLayer)
      // actually relocate its DOM on the next sync.
      const { shapesSub } = this.getOrCreateVectorLayerSubGroups(shape.layerId || 'default')
      shapesSub.appendChild(group)
      const layer = this.latestLayers.find((l) => l.layerId === (shape.layerId || 'default'))
      const locked = layer?.locked ?? false
      group.style.cursor = locked ? 'default' : 'move'
      this.renderShapeInto(group, shape, locked)
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
    this.refreshShapeResizeHandles()
    this.refreshConnectionPointHandles()
  }

  /**
   * Reconciles leader-line DOM. Must be re-run whenever instances/pipes/
   * freeShapes change too (not just leader lines themselves), since a
   * role-, pipe-, or shape-anchored endpoint tracks its target's live
   * position — same reason syncPipes needs instances. `layers` is read from
   * `this.latestLayers` (kept fresh by syncLayers) rather than threaded
   * through here, since only a pipe end anchored to an image connection
   * point needs it, and that's an existing edge case, not new to this.
   */
  syncLeaderLines(leaderLines: LeaderLine[], instances: ComponentInstance[], pipes: PipeInstance[], freeShapes: FreeShape[]) {
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

      const points = getLeaderLinePoints(line, instances, pipes, freeShapes, this.latestLayers)
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

  private renderShapeInto(group: SVGGElement, shape: FreeShape, locked = false) {
    while (group.firstChild) group.removeChild(group.firstChild)
    const fill = shape.style.fill ?? 'none'
    const hitPointerEvents = locked ? 'none' : 'all'

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
      // SVG hit-testing otherwise only responds to painted pixels) — unless
      // the shape's own layer is locked, in which case it shouldn't
      // intercept clicks at all (same rule as a locked image layer).
      el.setAttribute('pointer-events', hitPointerEvents)
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
      el.setAttribute('pointer-events', hitPointerEvents)
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
      hit.style.pointerEvents = hitPointerEvents
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
      el.setAttribute('pointer-events', hitPointerEvents)
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
      hit.style.pointerEvents = hitPointerEvents
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
