import type { ComponentInstance, Port, RoleInstance } from '@svg-editor/shared'

/**
 * Declarative description of a per-instance customization a component type
 * offers beyond the standard tag/roles/transform — backed by
 * `ComponentInstance.propertyValues[key]`, generically rendered by
 * PropertiesPanel (a checkbox for 'boolean', a color input for 'color') with
 * no per-type UI code needed. Currently produced only by
 * iconComponentFactory's mirrorable/colorable/optionalExtras spec fields
 * (see gasCylinderComponent.ts for the first real use), but it's a
 * `ComponentTypeDef`-level concept so a hand-written type could add its own.
 */
export interface InstanceOptionDescriptor {
  /** Key into ComponentInstance.propertyValues. */
  key: string
  kind: 'boolean' | 'color' | 'text' | 'select'
  label: string
  default: boolean | string
  /** Only used when kind === 'select'. */
  options?: { value: string; label: string }[]
}

/**
 * The "Baukasten": every placeable component type registers itself here
 * (see valveComponent.ts / indicatorComponent.ts). The canvas, store, and
 * exporter all dispatch through this registry instead of hard-coding a
 * single component type, so adding a new type only means adding a new
 * module + registerComponentType() call.
 */
export interface ComponentTypeDef {
  typeId: string
  displayName: string
  /** Prefix used for auto-generated tags, e.g. "V" -> V1, V2, ... */
  tagPrefix: string
  /** Grouping label for the toolbar palette (e.g. "Valves", "Instruments"). */
  category: string
  /** Builds the static, one-time DOM structure for a new instance. */
  render: (group: SVGGElement) => void
  /** Applies an instance's current transform/roles/tag to its DOM structure. */
  update: (group: SVGGElement, instance: ComponentInstance) => void
  defaultRoles: () => RoleInstance[]
  /** Recomputes offsets so *every* enabled label role stacks neatly with no gaps — including ones the user had manually dragged (an explicit "tidy up" action). */
  centerRoles: (roles: RoleInstance[]) => RoleInstance[]
  /** Same gap-filling stack, but skips roles the user has manually positioned — used automatically whenever a role gets toggled on/off. */
  autoPackRoles: (roles: RoleInstance[]) => RoleInstance[]
  /** Lines of exported SVG markup for one instance (decorative body + tagged <g id="tag_role"> groups). */
  exportInstance: (instance: ComponentInstance) => string[]
  /** Local (unrotated) corner points of the type's own body/icon shape, if any — used to size the export viewBox. */
  localBodyCorners: { x: number; y: number }[]
  /** Connection points pipes can snap to, in local (unrotated) coordinates. Empty for non-piping types. */
  ports: Port[]
  /**
   * Overrides localBodyCorners with a per-instance computation, for the rare
   * type whose body size itself depends on instance data (e.g. equipment-box
   * growing to fit its text) rather than being fixed per type. Everything
   * that sizes/positions against a type's body (bounds, drag handles,
   * auto-route obstacles) goes through resolveLocalBodyCorners, which prefers
   * this when present — see registry.ts.
   */
  getLocalBodyCorners?: (instance: ComponentInstance) => { x: number; y: number }[]
  /** Same idea as getLocalBodyCorners, but for ports — see resolvePorts. */
  getPorts?: (instance: ComponentInstance) => Port[]
  /** Per-instance customizations this type exposes (mirror, fill color, optional decorative extras, ...) — see InstanceOptionDescriptor. Absent/empty for types that don't offer any (the common case). */
  instanceOptions?: InstanceOptionDescriptor[]
  /**
   * Opts a type into manual corner-drag resizing on the canvas (SvgCanvas's
   * resize-instance handles). minSize is the type's own floor — e.g.
   * equipment-box's text-driven minimum — that a manual override (read from/
   * written to propertyValues[widthKey]/[heightKey]) is clamped to, never
   * shrunk below.
   */
  resizable?: {
    minSize: (instance: ComponentInstance) => { width: number; height: number }
    widthKey: string
    heightKey: string
  }
  /**
   * The local x a `mirrored: true` instance flips its body (and ports)
   * around — the shape's own visual center, NOT necessarily 0/the
   * transform anchor (a body whose local geometry isn't centered on its own
   * anchor point would otherwise jump sideways when mirrored around 0
   * instead of flipping in place). Only set for mirrorable types.
   */
  mirrorAxisX?: number
}

const registry = new Map<string, ComponentTypeDef>()

/**
 * Bumped every time a typeId is (re-)registered — lets SvgCanvas notice that
 * an already-placed instance's type was edited in the Library Editor (same
 * typeId, new render()) and rebuild that instance's DOM instead of silently
 * keeping the stale one (render() otherwise only ever runs once, the first
 * time an instance's group is created).
 */
const typeVersions = new Map<string, number>()

export function registerComponentType(def: ComponentTypeDef) {
  registry.set(def.typeId, def)
  typeVersions.set(def.typeId, (typeVersions.get(def.typeId) ?? 0) + 1)
}

/** For the Library Editor's "delete custom type" action — built-in types are never unregistered. */
export function unregisterComponentType(typeId: string) {
  registry.delete(typeId)
  typeVersions.delete(typeId)
}

export function getComponentType(typeId: string): ComponentTypeDef {
  const def = registry.get(typeId)
  if (!def) throw new Error(`Unknown component type: ${typeId}`)
  return def
}

export function getComponentTypeVersion(typeId: string): number {
  return typeVersions.get(typeId) ?? 0
}

export function listComponentTypes(): ComponentTypeDef[] {
  return Array.from(registry.values())
}

/** Resolves a type's local body corners for a specific instance — dynamic (getLocalBodyCorners) if the type declares it, otherwise the static per-type list. */
export function resolveLocalBodyCorners(
  def: ComponentTypeDef,
  instance: ComponentInstance,
): { x: number; y: number }[] {
  return def.getLocalBodyCorners ? def.getLocalBodyCorners(instance) : def.localBodyCorners
}

/** Resolves a type's ports for a specific instance — dynamic (getPorts) if the type declares it, otherwise the static per-type list. */
export function resolvePorts(def: ComponentTypeDef, instance: ComponentInstance): Port[] {
  return def.getPorts ? def.getPorts(instance) : def.ports
}
