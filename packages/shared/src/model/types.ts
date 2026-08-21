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
   * Explicit line color override. When unset, the line falls back to a
   * default that itself communicates clickability: black for pipes with
   * indicatorEnabled, light gray for purely decorative ones.
   */
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
}

export interface LeaderLineEndpointRef {
  instanceId: string
  role: Suffix
}

export type LeaderLineEndpoint = LeaderLineEndpointRef | { x: number; y: number }

/**
 * Freeform annotation line (e.g. pointing from a _value label to a precise
 * spot on a background image). Deliberately separate from PipeInstance:
 * no grid/port snapping.
 */
export interface LeaderLine {
  instanceId: string
  from: LeaderLineEndpoint
  to: { x: number; y: number }
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
  opacity: number
  /** Whether this background image is embedded in the exported live SVG or stays editor-only. */
  includeInExport: boolean
  /** Placement/size in canvas world units — draggable/resizable via the properties panel; dragging on the canvas only works while unlocked. */
  x: number
  y: number
  width: number
  height: number
  connectionPoints: ImageConnectionPoint[]
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

export interface Project {
  meta: ProjectMeta
  libraryRefs: LibraryRef[]
  layers: Layer[]
  instances: ComponentInstance[]
  pipes: PipeInstance[]
  leaderLines: LeaderLine[]
  freeShapes: FreeShape[]
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
