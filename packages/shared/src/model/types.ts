// Data model shared between the web editor and the server.
// Mirrors the architecture plan (see CLAUDE.md / project plan): a Project is
// composed of ComponentInstances (built from library ComponentDefs), pipes,
// and leader lines. See CLAUDE.md for the Node-RED/ui-svg export contract
// these types must ultimately satisfy (id="{tag}_{suffix}", <text> as a
// direct child, fill only on the indicator <g> itself, etc.).

export type Suffix = 'name' | 'value' | 'indicator' | 'setpoint'

export interface Transform {
  x: number
  y: number
  rotationDeg: number
}

/**
 * One possible role (name/value/indicator/setpoint) attached to a component
 * instance. `enabled` implements the "Baukasten" requirement that the exact
 * combination of roles is configurable per instance, not fixed per type.
 */
export interface RoleInstance {
  role: Suffix
  enabled: boolean
  /** Offset relative to the parent instance's transform. */
  offset: { x: number; y: number }
  /**
   * True once the user has dragged/nudged this role away from its
   * auto-packed slot. Excludes it from the automatic gap-filling that runs
   * when roles are toggled on/off (value/setpoint stack directly under name
   * with no gaps, value above setpoint when both are present) — a manually
   * placed label stays put instead of jumping when a sibling is toggled.
   */
  manuallyPositioned?: boolean
  /** Independent spin around the label's own anchor, applied on top of the parent instance's rotation. */
  rotationDeg?: number
  /** Background color override, or the literal 'transparent'. null resets to the type default (transparent for `name` in most component types, since it renders as bare text by default). */
  fillColor?: string | null
  /** Border color override, or the literal 'transparent'. null resets to the type default. */
  strokeColor?: string | null
  /** Text color override — applies to all three label roles. null resets to the default. */
  textColor?: string | null
  /**
   * Overrides the *visible* text of the `name` role only — the exported
   * `id="{tag}_name"` and every other place the instance's tag is used
   * (pipe/port references, other roles, tag-uniqueness checks, ...) always
   * stay the real tag; this only swaps what's rendered inside the label
   * itself, e.g. showing a friendlier caption than the terse tag. Ignored
   * for value/setpoint/indicator. null/undefined = show the tag as before.
   */
  labelTextOverride?: string | null
}

export interface ComponentInstance {
  instanceId: string
  tag: string
  componentTypeId: string
  libraryPackage: string
  transform: Transform
  propertyValues: Record<string, string | number | boolean | null>
  layerId: string
  roles: RoleInstance[]
  /**
   * Pipes can also connect to these, in addition to the type's own fixed
   * ports — relX/relY fractions of the instance's local (unrotated,
   * unmirrored) body bounding box (see resolveLocalBodyCorners), same
   * convention as FreeShape.connectionPoints (reusing ImageConnectionPoint
   * as-is, same as that field does). Lets a generic type like equipment-box,
   * whose fixed ports don't cover every place a real diagram needs to
   * attach a pipe, get extra attachment points without a per-type schema
   * change. Optional/defaults to [] so existing saved projects load fine.
   */
  connectionPoints?: ImageConnectionPoint[]
}

export type RoutingMode = 'straight' | 'orthogonal' | 'curved' | 'manual'

export interface Waypoint {
  x: number
  y: number
  kind: 'corner' | 'smooth'
}

export interface PortRef {
  instanceId: string
  portId: string
}

/**
 * An unattached pipe end: a bare world-space point, not connected to any
 * component port or other pipe. Only ever produced by leaving the draw-pipe
 * tool (e.g. pressing Escape) mid-draw with at least one waypoint already
 * placed — the pipe is kept up to that last point instead of discarded.
 * Distinguished from PortRef by shape (no instanceId/portId) — see isPortRef.
 */
export interface FreePoint {
  x: number
  y: number
}

export function isPortRef(ref: PortRef | FreePoint): ref is PortRef {
  return 'instanceId' in ref
}

/**
 * A pipe is one continuous run from fromPort to toPort, with waypoints for
 * any bends in between — a bent/multi-corner run is a single PipeInstance,
 * not several. Always tagged (like a ComponentInstance), so every pipe has
 * a stable identity; the optional "_indicator" role is toggled separately
 * (indicatorEnabled), mirroring how ComponentInstance roles are opt-in.
 * A freshly *drawn* pipe always starts with fromPort attached (drawing
 * always starts on a real connection point) and toPort may be a FreePoint if
 * drawing was cut short — but either end of an *existing* pipe can later
 * become a FreePoint too: dragging an endpoint off its component
 * disconnects it deliberately, and deleting a component a pipe was attached
 * to detaches that end automatically (fixed at its last position, a "knot")
 * rather than leaving the pipe referencing a component that no longer
 * exists.
 */
export interface PipeInstance {
  instanceId: string
  tag: string
  fromPort: PortRef | FreePoint
  toPort: PortRef | FreePoint
  routingMode: RoutingMode
  waypoints: Waypoint[]
  /** Whether this pipe exports a clickable/colorable "{tag}_indicator" element. */
  indicatorEnabled: boolean
  /**
   * Whether this pipe exports a static "{tag}_name" label at its midpoint —
   * bare text, same style as a component instance's `name` role. The text
   * itself is always the pipe's *volume* tag (resolveIndicatorTag), same as
   * "_indicator" — labels the connected run, not just this one segment,
   * consistent with indicatorEnabled potentially being on for several pipes
   * in one volume at once.
   */
  nameEnabled: boolean
  /** Explicit line color override. When unset, the line falls back to plain black regardless of indicatorEnabled. */
  strokeColor?: string | null
  /**
   * Tag of the "pipe volume" this pipe belongs to — the maximal set of
   * pipes connected to each other (directly or via branching) without a
   * component (e.g. a valve) in between. Gas fills a whole volume at once,
   * so every pipe in one shares the same "{volumeTag}_indicator" id in the
   * export, letting Node-RED color the entire connected run in one command.
   * Computed automatically (see pipes/pipeVolumes.ts) and kept stable
   * across edits; not user-authored directly except via renameVolumeTag.
   */
  volumeTag?: string | null
  /** crossingId -> which of the two pipes renders the hop arc at that crossing. */
  hopOverrides: Record<string, 'self' | 'other'>
  /**
   * Per-corner override for orthogonal routing: forces the bend inserted at
   * raw segment index `i` (between raw points i and i+1 — see
   * getPipePoints) to go horizontal-first or vertical-first, instead of the
   * default "larger delta wins" heuristic in pipeGeometry's
   * expandWithOwners. Keyed by segment index as a string, same convention
   * as hopOverrides' crossingId keys. Absent/empty means every corner uses
   * the default heuristic — only touched once a corner's flip handle is
   * clicked.
   */
  cornerOverrides?: Record<string, 'h-first' | 'v-first'>
  /** Arrow markers toggled on individually at specific points along this pipe — see PipeArrow. */
  arrows: PipeArrow[]
}

/**
 * One arrow marker sitting at a specific point along a pipe's own point
 * list — `pointIndex` uses the same full-point-list convention
 * pipePointPortId already does elsewhere (0 = fromPort, the last index =
 * toPort, anything in between an interior waypoint), so an arrow always
 * names a physical point on the pipe rather than a raw coordinate: dragging
 * that point moves its arrow along with it, and inserting/deleting a
 * waypoint elsewhere on the pipe renumbers pointIndex the same way
 * PortRef/LeaderLineBorderRef references into this pipe already do (see
 * insertPipeWaypoint/deletePipeWaypoint in projectStore.ts). Purely
 * decorative, like the indicator dot — no id, never read by Node-RED.
 * rotationDeg is fully free (not tied to the pipe's own flow direction) —
 * only given a sensible default (pointing along the pipe's local tangent
 * there) at the moment it's first toggled on.
 */
export interface PipeArrow {
  pointIndex: number
  size: number
  rotationDeg: number
}

export interface LeaderLineEndpointRef {
  instanceId: string
  role: Suffix
}

export type LeaderLineBorderTargetKind = 'shape' | 'pipe' | 'roleBox'

/**
 * Anchors to a live point on a target's current perimeter/polyline — a
 * shape's border (rect/polygon/line's own outline; ellipse approximated by
 * its bounding box; text is never a target here), a pipe's
 * from->waypoints->to polyline, or a role's label box (name/value/setpoint —
 * always a fixed-size rect in the role's local space, rotated by the
 * instance+role rotation, even for `name`, which usually renders as bare
 * text with no visible box: the box still exists as an invisible snap
 * target at the same footprint. `indicator` has no generic box — it's a
 * status overlay shaped like the component's own icon — so it's never a
 * 'roleBox' target; see LeaderLineEndpointRef instead, which anchors to a
 * role's plain center point). `segmentIndex` is which edge of the target's
 * current point list, `t` in [0,1] is how far along that edge — resolved
 * against the target's live geometry every render (see
 * resolveLeaderLineEndpoint in leaderLineGeometry.ts), so the anchor moves,
 * resizes, and rotates with its target instead of freezing at the position
 * it was dropped.
 */
export interface LeaderLineBorderRef {
  targetKind: LeaderLineBorderTargetKind
  targetId: string
  /** Only set when targetKind === 'roleBox'. */
  role?: Suffix
  segmentIndex: number
  t: number
}

export type LeaderLineEndpoint = LeaderLineEndpointRef | LeaderLineBorderRef | { x: number; y: number }

/**
 * Freeform annotation line (e.g. pointing from a _value label to a precise
 * spot on a background image). Deliberately separate from PipeInstance:
 * no grid/port snapping. Both `from` and `to` share the same
 * LeaderLineEndpoint union — either can be a bare point, a role-center
 * anchor, or a live border anchor.
 */
export interface LeaderLine {
  instanceId: string
  from: LeaderLineEndpoint
  to: LeaderLineEndpoint
  waypoints: { x: number; y: number }[]
}

export type FreeShapeKind = 'rect' | 'ellipse' | 'line' | 'polygon' | 'text'

export interface FreeShapeStyle {
  stroke: string
  strokeWidth: number
  /** null = no fill. Meaningless for 'line' and 'text', ignored there. */
  fill: string | null
}

/**
 * A hand-drawn annotation shape — purely decorative, never tagged, so it
 * never participates in the Node-RED tag contract (no "{tag}_suffix" id).
 * Deliberately separate from ComponentInstance/PipeInstance for that reason,
 * same rationale as LeaderLine. Geometry is just a point list, interpreted
 * per `kind`: rect/ellipse take two opposite corners; line takes its two
 * endpoints; polygon takes 3+ vertices (implicitly closed); text takes a
 * single anchor point plus `text`.
 */
export type TextAlign = 'left' | 'center' | 'right'

export interface FreeShape {
  instanceId: string
  kind: FreeShapeKind
  layerId: string
  points: { x: number; y: number }[]
  /** Only meaningful for kind: 'text'. `\n` splits into multiple rendered lines (see freeShapeExport.ts / SvgCanvas's renderShapeInto). */
  text?: string
  fontSize?: number
  /** Only meaningful for kind: 'text'. Undefined = 'left' (the original, only-ever behavior — kept optional so existing saved projects still load with their prior appearance). */
  textAlign?: TextAlign
  style: FreeShapeStyle
  /** Pipes can connect to these — relX/relY fractions of the shape's own bounding box, same convention as ImageConnectionPoint (reused as-is despite the name; it's generic). Optional/defaults to [] so existing saved projects without any still load. */
  connectionPoints?: ImageConnectionPoint[]
}

interface LayerBase {
  layerId: string
  name: string
  visible: boolean
  locked: boolean
}

export interface VectorLayer extends LayerBase {
  kind: 'vector'
}

/**
 * A point pipes can connect to, defined relative to its image layer's own
 * (x, y, width, height) rect — relX/relY are fractions in [0,1], not world
 * coordinates, so the point automatically tracks the image when it's
 * dragged or resized instead of needing to be re-placed.
 */
export interface ImageConnectionPoint {
  pointId: string
  relX: number
  relY: number
  label?: string
}

export interface ImageLayer extends LayerBase {
  kind: 'image'
  /** Data URI — images are embedded directly in the project JSON, no separate asset pipeline. */
  src: string
  /** The pre-"Set Transparent Color" data URI, saved the first time that edit is applied (never overwritten by a later re-application, so it always holds the true original) — lets "Restore original image" undo the edit outside of undo history. Unset when no transparent-color edit has been applied (or after restoring). */
  originalSrc?: string
  /** The color last picked via the eyedropper — remembered so changing the color-offset tolerance can re-derive `src` from `originalSrc` with the new tolerance, without re-picking. Unset alongside originalSrc. */
  transparentColorHex?: string
  opacity: number
  /** Whether this background image is embedded in the exported live SVG or stays editor-only. */
  includeInExport: boolean
  /** Placement/size in canvas world units — draggable/resizable via the properties panel; dragging on the canvas only works while unlocked. */
  x: number
  y: number
  width: number
  height: number
  connectionPoints: ImageConnectionPoint[]
  /** Grid lines are hidden under this image's footprint by default (so the image reads cleanly); set true to show the grid over it anyway. Undefined behaves as false — older saved projects keep the same (hidden) look they always had. */
  showGridOverImage?: boolean
}

export type Layer = VectorLayer | ImageLayer

export interface ProjectMeta {
  id: string
  name: string
  canvasWidth: number
  canvasHeight: number
  gridSize: number
  schemaVersion: number
  createdAt: string
  modifiedAt: string
}

export interface LibraryRef {
  package: string
  version: string
}

export type GroupMemberKind = 'instance' | 'pipe' | 'shape' | 'leaderLine' | 'layer'

export interface GroupMemberRef {
  kind: GroupMemberKind
  id: string
}

/**
 * A user-created, persisted grouping of elements across kinds (instances,
 * pipes, shapes, leader lines, image layers). Editor-only concept — has no
 * bearing on the exported live SVG's Node-RED tag contract. Deliberately
 * flat: a member's kind is always one of the five leaves above, never
 * 'group' itself, so nothing that consumes Group.members needs to recurse.
 * Grouping a selection that includes an existing whole group flattens/merges
 * it into the new group instead of nesting.
 */
export interface Group {
  groupId: string
  members: GroupMemberRef[]
}

export interface Project {
  meta: ProjectMeta
  libraryRefs: LibraryRef[]
  layers: Layer[]
  instances: ComponentInstance[]
  pipes: PipeInstance[]
  leaderLines: LeaderLine[]
  freeShapes: FreeShape[]
  groups: Group[]
}

// --- Clipboard (copy/paste/duplicate) ---

/**
 * Ephemeral snapshot of "whatever was selected" at copy time — never
 * persisted as part of a Project. Original ids are kept as-is; remapping to
 * fresh ids only happens at paste/duplicate time (see cloneEntitySet in
 * projectStore.ts), so the same copy can be pasted repeatedly into
 * independent clones.
 */
export interface ScryClipboardPayload {
  instances: ComponentInstance[]
  pipes: PipeInstance[]
  freeShapes: FreeShape[]
  leaderLines: LeaderLine[]
  /** Image layers only — vector/shape layers are containers, not selected "content" the same way. */
  layers: ImageLayer[]
  /** 0 or 1 in practice — the selected group, if any. */
  groups: Group[]
}

export interface ScryClipboardEnvelope {
  scryClipboard: true
  version: 1
  payload: ScryClipboardPayload
}

/** Cheap shape check (marker + version + array fields present) so paste can silently no-op on foreign clipboard content (or content from an incompatible future version) instead of erroring. */
export function isScryClipboardEnvelope(x: unknown): x is ScryClipboardEnvelope {
  if (!x || typeof x !== 'object') return false
  const env = x as Record<string, unknown>
  if (env.scryClipboard !== true || env.version !== 1) return false
  const payload = env.payload as Record<string, unknown> | null | undefined
  if (!payload || typeof payload !== 'object') return false
  return (
    Array.isArray(payload.instances) &&
    Array.isArray(payload.pipes) &&
    Array.isArray(payload.freeShapes) &&
    Array.isArray(payload.leaderLines) &&
    Array.isArray(payload.layers) &&
    Array.isArray(payload.groups)
  )
}

// --- Component library ("Baukasten") ---

export interface Port {
  portId: string
  x: number
  y: number
  exitAngleDeg: number
}

export interface PropertySchemaField {
  key: string
  label: string
  type: 'string' | 'enum' | 'number' | 'boolean'
  enumOptions?: string[]
  default?: string | number | boolean | null
}

/** Raw SVG node tree (rect/path/text/tspan/...) authored in the Library Editor. */
export type SvgNodeTree = Record<string, unknown>

export interface ComponentPart {
  partId: string
  role: 'static' | Suffix
  geometry: SvgNodeTree
  offsetTransform?: { x: number; y: number }
  clickable?: boolean
}

export interface AvailableRole {
  role: Suffix
  defaultEnabled: boolean
}

export interface ComponentDef {
  componentTypeId: string
  displayName: string
  category: string
  parts: ComponentPart[]
  /** Which roles this type offers at all, and whether they're on by default (see RoleInstance.enabled). */
  availableRoles: AvailableRole[]
  ports: Port[]
  propertySchema: PropertySchemaField[]
  defsRequirements: string[]
}

export interface LibraryManifest {
  package: string
  version: string
  components: string[]
}
