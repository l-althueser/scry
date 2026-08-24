import {
  isPortRef,
  type ComponentInstance,
  type FreePoint,
  type FreeShape,
  type ImageLayer,
  type Layer,
  type PipeInstance,
  type PortRef,
} from '@svg-editor/shared'
import { fmt, rotatePoint } from '../library/componentUtils'
import { getComponentType, resolvePorts } from '../library/registry'
import { boundsOfPoints } from '../shapes/freeShapeGeometry'

export interface Point {
  x: number
  y: number
}

const HOP_RADIUS = 6

export const PIPE_DEFAULT_COLOR = '#000000'
export const PIPE_NON_CLICKABLE_COLOR = '#b3b3b3'
/** Default size (tip-to-base length, world units) for a newly toggled-on PipeArrow. */
export const DEFAULT_ARROW_SIZE = 12

/**
 * Resolves the line color a pipe should render/export with. An explicit
 * strokeColor always wins; otherwise the color itself communicates
 * clickability — black for pipes with a live "_indicator", light gray for
 * purely decorative ones — so the two are visually distinguishable without
 * relying on the small indicator dot alone.
 */
export function resolvePipeColor(pipe: Pick<PipeInstance, 'strokeColor' | 'indicatorEnabled'>): string {
  if (pipe.strokeColor) return pipe.strokeColor
  return pipe.indicatorEnabled ? PIPE_DEFAULT_COLOR : PIPE_NON_CLICKABLE_COLOR
}

/**
 * The tag used for a pipe's exported "_indicator" id. Every pipe in the same
 * "volume" (see pipes/pipeVolumes.ts) shares this id, so Node-RED coloring
 * the volume's indicator lights up every connected segment at once — gas
 * fills the whole volume, not just one pipe. Falls back to the pipe's own
 * tag if volumeTag hasn't been computed yet (shouldn't normally happen).
 */
export function resolveIndicatorTag(pipe: Pick<PipeInstance, 'tag' | 'volumeTag'>): string {
  return pipe.volumeTag ?? pipe.tag
}

/**
 * A `mirrored: true` instance property (opt-in per type — see
 * IconComponentSpec.mirrorable in iconComponentFactory.ts, e.g. so a gas
 * cylinder's connector can sit on the left or right) flips the body
 * horizontally around `def.mirrorAxisX` (the shape's own visual center, not
 * local x=0 — see iconComponentFactory's bodyTransform for why) alongside
 * the normal rotation. Ports must flip the same way — reflect local x
 * around that same axis *before* rotating, matching the rendered
 * `rotate(...) translate(2*axis,0) scale(-1,1)` transform order exactly —
 * so a pipe still snaps to where the port actually ends up on screen.
 */
export function getPortWorldPosition(instance: ComponentInstance, portId: string): Point | null {
  const def = getComponentType(instance.componentTypeId)
  const port = resolvePorts(def, instance).find((p) => p.portId === portId)
  if (!port) return null
  const mirrored = def.mirrorAxisX !== undefined && instance.propertyValues.mirrored === true
  const localX = mirrored ? 2 * def.mirrorAxisX! - port.x : port.x
  const rotated = rotatePoint({ x: localX, y: port.y }, instance.transform.rotationDeg)
  return { x: instance.transform.x + rotated.x, y: instance.transform.y + rotated.y }
}

function detachEnd(
  ref: PortRef | FreePoint,
  instances: ComponentInstance[],
  removedInstanceIds: ReadonlySet<string>,
): PortRef | FreePoint {
  if (!isPortRef(ref) || !removedInstanceIds.has(ref.instanceId)) return ref
  const inst = instances.find((i) => i.instanceId === ref.instanceId)
  const pos = inst ? getPortWorldPosition(inst, ref.portId) : null
  return pos ?? ref
}

/**
 * Detaches any pipe endpoint referencing one of the given (about-to-be-
 * removed) component instances, replacing that PortRef with a FreePoint
 * fixed at the port's last known world position — the pipe survives with a
 * "knot" where it used to connect, instead of silently becoming
 * unrenderable (getPipePoints would otherwise return null the moment the
 * referenced instance is gone; deleting a component used to make every
 * attached pipe vanish for exactly that reason). `instances` must be the
 * array as it stood *before* removal, since positions are resolved against
 * it — call this before actually filtering the deleted instances out.
 */
export function detachPipesFromInstances(
  pipes: PipeInstance[],
  instances: ComponentInstance[],
  removedInstanceIds: ReadonlySet<string>,
): PipeInstance[] {
  return pipes.map((pipe) => {
    const fromPort = detachEnd(pipe.fromPort, instances, removedInstanceIds)
    const toPort = detachEnd(pipe.toPort, instances, removedInstanceIds)
    return fromPort === pipe.fromPort && toPort === pipe.toPort ? pipe : { ...pipe, fromPort, toPort }
  })
}

/**
 * Detaches any pipe endpoint branched onto one of the given (about-to-be-
 * removed) *other pipes* — a "pt:{index}" PortRef whose target pipe is
 * being deleted — replacing it with a FreePoint fixed at its last known
 * world position, same "leave a knot instead of dangling" contract as
 * detachPipesFromInstances (that one only ever checked component instances,
 * never another pipe being the thing that disappeared, so deleting a pipe a
 * branch was attached to silently made that branch unresolvable —
 * getPipePoints returns null the moment the referenced pipe is gone —
 * which reads as "the branch got deleted too" even though its PipeInstance
 * technically still exists). `pipes`/`instances`/`layers` must be the
 * arrays as they stood *before* removal, since positions are resolved
 * against them — call this before actually filtering the deleted pipes out.
 */
export function detachPipesFromPipes(
  pipes: PipeInstance[],
  instances: ComponentInstance[],
  layers: Layer[],
  removedPipeIds: ReadonlySet<string>,
  freeShapes: FreeShape[] = [],
): PipeInstance[] {
  const detach = (ref: PortRef | FreePoint): PortRef | FreePoint => {
    if (!isPortRef(ref) || !ref.portId.startsWith(PIPE_POINT_PREFIX) || !removedPipeIds.has(ref.instanceId)) return ref
    return resolvePortRefWorldPosition(ref, instances, pipes, layers, freeShapes) ?? ref
  }
  return pipes.map((pipe) => {
    if (removedPipeIds.has(pipe.instanceId)) return pipe
    const fromPort = detach(pipe.fromPort)
    const toPort = detach(pipe.toPort)
    return fromPort === pipe.fromPort && toPort === pipe.toPort ? pipe : { ...pipe, fromPort, toPort }
  })
}

/**
 * Detaches any pipe endpoint referencing a connection point on one of the
 * given (about-to-be-removed) image layers or shapes, replacing that PortRef
 * with a FreePoint fixed at its last known world position — same "leave a
 * knot instead of dangling" contract as detachPipesFromInstances, just for
 * connection-point owners instead of component instances (image/shape
 * deletion previously skipped this entirely, silently leaving any attached
 * pipe end referencing a layer/shape that no longer exists). `instances`/
 * `pipes`/`layers`/`freeShapes` must be the arrays as they stood *before*
 * removal, since positions are resolved against them.
 */
export function detachPipesFromConnectionPointOwners(
  pipes: PipeInstance[],
  instances: ComponentInstance[],
  layers: Layer[],
  freeShapes: FreeShape[],
  removedLayerIds: ReadonlySet<string>,
  removedShapeIds: ReadonlySet<string>,
): PipeInstance[] {
  if (removedLayerIds.size === 0 && removedShapeIds.size === 0) return pipes
  const detach = (ref: PortRef | FreePoint): PortRef | FreePoint => {
    if (!isPortRef(ref)) return ref
    const isRemovedOwner =
      (ref.portId.startsWith(IMAGE_POINT_PREFIX) && removedLayerIds.has(ref.instanceId)) ||
      (ref.portId.startsWith(SHAPE_POINT_PREFIX) && removedShapeIds.has(ref.instanceId))
    if (!isRemovedOwner) return ref
    return resolvePortRefWorldPosition(ref, instances, pipes, layers, freeShapes) ?? ref
  }
  return pipes.map((pipe) => {
    const fromPort = detach(pipe.fromPort)
    const toPort = detach(pipe.toPort)
    return fromPort === pipe.fromPort && toPort === pipe.toPort ? pipe : { ...pipe, fromPort, toPort }
  })
}

/** portId convention for a PortRef that points at another pipe's point (endpoint or waypoint) instead of a component port. */
export const PIPE_POINT_PREFIX = 'pt:'

export function pipePointPortId(index: number): string {
  return `${PIPE_POINT_PREFIX}${index}`
}

/** portId convention for a PortRef that points at a user-placed connection point on an image layer. */
export const IMAGE_POINT_PREFIX = 'cp:'

export function imagePointPortId(pointId: string): string {
  return `${IMAGE_POINT_PREFIX}${pointId}`
}

/** World position of one image layer's connection point, computed from the layer's *current* rect — this is what makes it track a drag/resize. */
export function getImageConnectionPointWorldPosition(layer: ImageLayer, pointId: string): Point | null {
  const cp = layer.connectionPoints.find((p) => p.pointId === pointId)
  if (!cp) return null
  return { x: layer.x + cp.relX * layer.width, y: layer.y + cp.relY * layer.height }
}

/** portId convention for a PortRef that points at a user-placed connection point on a free shape — parallel to IMAGE_POINT_PREFIX. */
export const SHAPE_POINT_PREFIX = 'scp:'

export function shapePointPortId(pointId: string): string {
  return `${SHAPE_POINT_PREFIX}${pointId}`
}

/** World position of one shape's connection point, computed from the shape's *current* bounding box — same tracking-through-edits behavior as getImageConnectionPointWorldPosition. */
export function getShapeConnectionPointWorldPosition(shape: FreeShape, pointId: string): Point | null {
  const cp = (shape.connectionPoints ?? []).find((p) => p.pointId === pointId)
  if (!cp) return null
  const { minX, minY, maxX, maxY } = boundsOfPoints(shape.points)
  return { x: minX + cp.relX * (maxX - minX), y: minY + cp.relY * (maxY - minY) }
}

/**
 * Resolves any connection point a pipe end can attach to: a fixed
 * world-space point (an unattached end left by cutting a draw short), a
 * component instance's port, a user-placed point on an image layer, or a
 * point (endpoint/waypoint) on another pipe — so pipes can branch off each
 * other's existing connection points, not just component ports. Live: if
 * the referenced pipe's waypoints move (or the image is dragged/resized),
 * anything attached to it moves too. `visiting` guards against reference
 * cycles (structurally shouldn't happen, since a pipe's ports are only ever
 * set once at creation time, but resolution stays safe either way).
 */
export function resolvePortRefWorldPosition(
  ref: PortRef | FreePoint,
  instances: ComponentInstance[],
  pipes: PipeInstance[],
  layers: Layer[] = [],
  freeShapes: FreeShape[] = [],
  visiting: ReadonlySet<string> = new Set(),
): Point | null {
  if (!isPortRef(ref)) return { x: ref.x, y: ref.y }

  const inst = instances.find((i) => i.instanceId === ref.instanceId)
  if (inst) return getPortWorldPosition(inst, ref.portId)

  if (ref.portId.startsWith(IMAGE_POINT_PREFIX)) {
    const layer = layers.find((l) => l.layerId === ref.instanceId)
    if (!layer || layer.kind !== 'image') return null
    return getImageConnectionPointWorldPosition(layer, ref.portId.slice(IMAGE_POINT_PREFIX.length))
  }

  if (ref.portId.startsWith(SHAPE_POINT_PREFIX)) {
    const shape = freeShapes.find((s) => s.instanceId === ref.instanceId)
    if (!shape) return null
    return getShapeConnectionPointWorldPosition(shape, ref.portId.slice(SHAPE_POINT_PREFIX.length))
  }

  if (!ref.portId.startsWith(PIPE_POINT_PREFIX) || visiting.has(ref.instanceId)) return null
  const pipe = pipes.find((p) => p.instanceId === ref.instanceId)
  if (!pipe) return null

  const index = Number(ref.portId.slice(PIPE_POINT_PREFIX.length))
  if (!Number.isInteger(index)) return null

  const points = getPipePoints(pipe, instances, pipes, layers, freeShapes, new Set(visiting).add(ref.instanceId))
  if (!points || index < 0 || index >= points.length) return null
  return points[index]
}

/**
 * Full world-space point list for a pipe (port -> waypoints -> port), or
 * null if either end can't be resolved. `pipes`/`layers`/`freeShapes` are
 * needed to resolve ends that branch off another pipe's point, an image
 * layer's connection point, or a shape's connection point, rather than a
 * component port.
 */
export function getPipePoints(
  pipe: PipeInstance,
  instances: ComponentInstance[],
  pipes: PipeInstance[] = [],
  layers: Layer[] = [],
  freeShapes: FreeShape[] = [],
  visiting: ReadonlySet<string> = new Set([pipe.instanceId]),
): Point[] | null {
  const fromPos = resolvePortRefWorldPosition(pipe.fromPort, instances, pipes, layers, freeShapes, visiting)
  const toPos = resolvePortRefWorldPosition(pipe.toPort, instances, pipes, layers, freeShapes, visiting)
  if (!fromPos || !toPos) return null
  return [fromPos, ...pipe.waypoints.map((w) => ({ x: w.x, y: w.y })), toPos]
}

/**
 * Renumbers every OTHER pipe's `fromPort`/`toPort` that branches off one of
 * `pipeId`'s own points (a "pt:{index}" PortRef) after a new waypoint is
 * spliced into `pipeId`'s point list at `insertedPointIndex` (a full-point-
 * list index — see getPipePoints: index 0 is fromPos, the last is toPos, so
 * a waypoint-array insertion at position `i` lands at point-list index
 * `i + 1`). Every existing point at or after that index shifts up by one,
 * so a ref naming it must shift too, or it silently ends up naming whatever
 * new point happens to have that old index — the exact bug this fixes.
 * Exact/lossless: unlike a leader line's segmentIndex/t (see
 * shiftLeaderLinePipeAnchorsForPipeChange in leaderLineGeometry.ts), a
 * PortRef names one discrete existing point, so renumbering it is all
 * that's needed — no position math, no ambiguity.
 */
export function shiftPipePointRefsForInsert(
  pipes: PipeInstance[],
  pipeId: string,
  insertedPointIndex: number,
): PipeInstance[] {
  const shiftEnd = (ref: PortRef | FreePoint): PortRef | FreePoint => {
    if (!isPortRef(ref) || ref.instanceId !== pipeId || !ref.portId.startsWith(PIPE_POINT_PREFIX)) return ref
    const idx = Number(ref.portId.slice(PIPE_POINT_PREFIX.length))
    if (!Number.isInteger(idx) || idx < insertedPointIndex) return ref
    return { ...ref, portId: pipePointPortId(idx + 1) }
  }
  return pipes.map((p) => {
    const fromPort = shiftEnd(p.fromPort)
    const toPort = shiftEnd(p.toPort)
    return fromPort === p.fromPort && toPort === p.toPort ? p : { ...p, fromPort, toPort }
  })
}

/**
 * Inverse of shiftPipePointRefsForInsert, for a point being removed from
 * `pipeId` at `removedPointIndex` (again a full-point-list index): every ref
 * naming a later point shifts down by one to keep naming the same physical
 * point, and a ref naming *exactly* the removed point is detached — resolved
 * to its last known world position (via the pre-removal `pipes`/`instances`/
 * `layers`) and frozen as a FreePoint, the same "leave a knot instead of
 * dangling" contract detachPipesFromInstances already uses when a component
 * a pipe was attached to gets deleted. Call with the pipe/instance/layer
 * arrays as they stood *before* the removal.
 */
export function shiftPipePointRefsForDelete(
  pipes: PipeInstance[],
  instances: ComponentInstance[],
  layers: Layer[],
  pipeId: string,
  removedPointIndex: number,
): PipeInstance[] {
  const adjustEnd = (ref: PortRef | FreePoint): PortRef | FreePoint => {
    if (!isPortRef(ref) || ref.instanceId !== pipeId || !ref.portId.startsWith(PIPE_POINT_PREFIX)) return ref
    const idx = Number(ref.portId.slice(PIPE_POINT_PREFIX.length))
    if (!Number.isInteger(idx)) return ref
    if (idx === removedPointIndex) {
      return resolvePortRefWorldPosition(ref, instances, pipes, layers) ?? ref
    }
    if (idx < removedPointIndex) return ref
    return { ...ref, portId: pipePointPortId(idx - 1) }
  }
  return pipes.map((p) => {
    const fromPort = adjustEnd(p.fromPort)
    const toPort = adjustEnd(p.toPort)
    return fromPort === p.fromPort && toPort === p.toPort ? p : { ...p, fromPort, toPort }
  })
}

export interface ResolvedPipeArrow {
  pos: Point
  rotationDeg: number
  size: number
}

/**
 * Resolves each of a pipe's PipeArrow entries against its current RAW point
 * list (getPipePoints's [fromPos, ...waypoints, toPos] — the same list
 * pointIndex is defined against, NOT getDisplayPoints's reshaped orthogonal
 * copy, whose indices don't correspond 1:1 to the raw list — see
 * getDisplayPoints's own doc comment on why the two must stay separate). An
 * out-of-range pointIndex (shouldn't normally happen — see
 * insertPipeWaypoint/deletePipeWaypoint's renumbering) is simply skipped
 * rather than thrown. `pipe.arrows` is defensively defaulted to `[]` —
 * a project saved before this field existed has pipes with no `arrows` at
 * all (no schema migration in this codebase; optional new fields are
 * handled with a fallback at each read site instead, same as elsewhere).
 */
export function resolvePipeArrows(pipe: Pick<PipeInstance, 'arrows'>, points: Point[]): ResolvedPipeArrow[] {
  return (pipe.arrows ?? [])
    .filter((a) => a.pointIndex >= 0 && a.pointIndex < points.length)
    .map((a) => ({ pos: points[a.pointIndex], rotationDeg: a.rotationDeg, size: a.size }))
}

/**
 * A sensible default rotation for a newly-toggled-on arrow at `pointIndex`
 * — the direction of the pipe's local tangent there (average of the
 * incoming/outgoing segment directions at an interior point; whichever
 * single segment exists at an end). Purely a starting point — the arrow's
 * rotationDeg is freely editable afterward, this just avoids a bare 0°
 * arrow pointing right regardless of the pipe's actual orientation.
 */
export function computeDefaultArrowRotation(points: Point[], pointIndex: number): number {
  if (points.length < 2) return 0
  const prev = points[pointIndex - 1]
  const cur = points[pointIndex]
  const next = points[pointIndex + 1]
  const dirs: Point[] = []
  if (prev) dirs.push({ x: cur.x - prev.x, y: cur.y - prev.y })
  if (next) dirs.push({ x: next.x - cur.x, y: next.y - cur.y })
  const sum = dirs.reduce((acc, d) => ({ x: acc.x + d.x, y: acc.y + d.y }), { x: 0, y: 0 })
  if (sum.x === 0 && sum.y === 0) return 0
  return (Math.atan2(sum.y, sum.x) * 180) / Math.PI
}

export function midpoint(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return points[0]
  // Midpoint by cumulative length, not just the middle index, so it stays centered on bent runs too.
  const lengths: number[] = []
  let total = 0
  for (let i = 0; i < points.length - 1; i++) {
    const d = dist(points[i], points[i + 1])
    lengths.push(d)
    total += d
  }
  let target = total / 2
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] === 0 ? 0 : target / lengths[i]
      const a = points[i]
      const b = points[i + 1]
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    target -= lengths[i]
  }
  return points[Math.floor(points.length / 2)]
}

export function straightPathD(points: Point[]): string {
  if (points.length === 0) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`).join(' ')
}

/**
 * Points actually used for rendering + crossing/hop detection. Orthogonal
 * mode inserts right-angle corners between consecutive points that aren't
 * already axis-aligned; every other mode renders straight through the raw
 * port/waypoint list unchanged (curved pipes build their own spline
 * separately and never call this). Kept distinct from the raw port/waypoint
 * list itself (getPipePoints) because that list's indices are load-bearing —
 * PIPE_POINT_PREFIX port refs address into it by index, so it must never be
 * reshaped, only the display copy used for drawing.
 */
export function getDisplayPoints(pipe: Pick<PipeInstance, 'routingMode'>, points: Point[]): Point[] {
  return pipe.routingMode === 'orthogonal' ? expandOrthogonal(points) : points
}

/**
 * Shared by expandOrthogonal and findNearestPipeSegment: expands the raw
 * point list into display points, and for each display *segment* records
 * which raw segment (index into the conceptual [from, ...waypoints, to]
 * list) it came from — a raw segment that got a corner inserted owns two
 * display segments. Non-orthogonal mode is the identity map (one display
 * segment per raw segment).
 */
function expandWithOwners(points: Point[], orthogonal: boolean): { points: Point[]; owners: number[] } {
  if (points.length < 2) return { points, owners: [] }
  if (!orthogonal) {
    return { points, owners: points.slice(0, -1).map((_, i) => i) }
  }
  const result: Point[] = [points[0]]
  const owners: number[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) {
      // Bend along whichever axis has the larger delta, so a short stub near
      // a port reads as a natural first turn rather than a long detour.
      const corner = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y }
      result.push(corner)
      owners.push(i)
    }
    result.push(b)
    owners.push(i)
  }
  return { points: result, owners }
}

/** Inserts one right-angle corner between each pair of consecutive points that isn't already axis-aligned, so the rendered line only ever moves horizontally/vertically. */
export function expandOrthogonal(points: Point[]): Point[] {
  return expandWithOwners(points, true).points
}

function distSqToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lenSq = abx * abx + aby * aby
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq))
  const cx = a.x + t * abx
  const cy = a.y + t * aby
  return (p.x - cx) ** 2 + (p.y - cy) ** 2
}

/**
 * Which raw segment of a pipe's [fromPort, ...waypoints, toPort] list is
 * closest to a world point — used to turn a double-click on a pipe's line
 * into "insert a new waypoint here". Hit-tests against the pipe's *display*
 * points (so orthogonal mode matches the actual bent line drawn, not the
 * invisible diagonal shortcut through raw points), then maps back to a raw
 * segment via expandWithOwners. The returned `insertIndex` is both the raw
 * segment index and the correct splice position into the `waypoints` array
 * (waypoints[0..n-1] sit at raw points[1..n], so splitting raw segment i
 * always means `waypoints.splice(i, 0, newPoint)`).
 */
export function findNearestPipeSegment(
  pipe: Pick<PipeInstance, 'routingMode'>,
  rawPoints: Point[],
  point: Point,
): { insertIndex: number; distanceSq: number } | null {
  if (rawPoints.length < 2) return null
  const { points: displayPoints, owners } = expandWithOwners(rawPoints, pipe.routingMode === 'orthogonal')
  let best: { insertIndex: number; distanceSq: number } | null = null
  for (let i = 0; i < displayPoints.length - 1; i++) {
    const distanceSq = distSqToSegment(point, displayPoints[i], displayPoints[i + 1])
    if (!best || distanceSq < best.distanceSq) {
      best = { insertIndex: owners[i], distanceSq }
    }
  }
  return best
}

/** Smooth spline through the points (Catmull-Rom converted to cubic beziers). */
export function curvedPathD(points: Point[]): string {
  if (points.length < 3) return straightPathD(points)
  let d = `M${fmt(points[0].x)} ${fmt(points[0].y)}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    d += ` C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(p2.x)} ${fmt(p2.y)}`
  }
  return d
}

export interface HopPoint {
  point: Point
  segmentIndex: number
}

/**
 * Straight polyline with a small arc "bump" inserted at each hop point, so a
 * pipe crossing another (unconnected) one visually reads as not-joined —
 * like the crossing jumps in an electrical schematic. Used for both
 * 'straight' and 'orthogonal' routing (against that mode's display points,
 * see getDisplayPoints); curved pipes don't hop.
 */
export function straightPathDWithHops(points: Point[], hops: HopPoint[]): string {
  if (points.length === 0) return ''
  const bySegment = new Map<number, Point[]>()
  for (const h of hops) {
    const arr = bySegment.get(h.segmentIndex) ?? []
    arr.push(h.point)
    bySegment.set(h.segmentIndex, arr)
  }

  let d = `M${fmt(points[0].x)} ${fmt(points[0].y)}`
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const segHops = (bySegment.get(i) ?? []).sort((h1, h2) => dist(a, h1) - dist(a, h2))

    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len

    for (const hop of segHops) {
      const before = { x: hop.x - ux * HOP_RADIUS, y: hop.y - uy * HOP_RADIUS }
      const after = { x: hop.x + ux * HOP_RADIUS, y: hop.y + uy * HOP_RADIUS }
      d += ` L${fmt(before.x)} ${fmt(before.y)}`
      d += ` A${HOP_RADIUS} ${HOP_RADIUS} 0 0 1 ${fmt(after.x)} ${fmt(after.y)}`
    }
    d += ` L${fmt(b.x)} ${fmt(b.y)}`
  }
  return d
}

/**
 * Stable-ish id for one crossing between two pipes' segments, symmetric in
 * the two pipes (order doesn't matter). Built from instance ids + segment
 * indices into each pipe's current display-point list, so it shifts if
 * waypoints are added/removed/re-routed — an existing manual hopOverride
 * silently reverts to the default rule when that happens, which is an
 * accepted tradeoff (no stable geometry-independent identity exists for a
 * crossing that survives edits).
 */
export function crossingId(pipeAId: string, segA: number, pipeBId: string, segB: number): string {
  return pipeAId < pipeBId ? `${pipeAId}#${segA}:${pipeBId}#${segB}` : `${pipeBId}#${segB}:${pipeAId}#${segA}`
}

interface RawCrossing {
  id: string
  otherPipeId: string
  point: Point
  segmentIndex: number
}

function findCrossingsForPipe(
  pipeId: string,
  allPipes: PipeInstance[],
  pointsByPipe: Map<string, Point[]>,
): RawCrossing[] {
  const myPoints = pointsByPipe.get(pipeId)
  if (!myPoints) return []
  const crossings: RawCrossing[] = []

  for (let segIdx = 0; segIdx < myPoints.length - 1; segIdx++) {
    const a = myPoints[segIdx]
    const b = myPoints[segIdx + 1]

    for (const other of allPipes) {
      if (other.instanceId === pipeId) continue
      const otherPoints = pointsByPipe.get(other.instanceId)
      if (!otherPoints) continue

      for (let oIdx = 0; oIdx < otherPoints.length - 1; oIdx++) {
        const hit = segmentIntersection(a, b, otherPoints[oIdx], otherPoints[oIdx + 1])
        if (!hit) continue
        crossings.push({
          id: crossingId(pipeId, segIdx, other.instanceId, oIdx),
          otherPipeId: other.instanceId,
          point: hit,
          segmentIndex: segIdx,
        })
      }
    }
  }
  return crossings
}

/**
 * Which pipe "hops" at a crossing: an explicit hopOverride (checked on
 * either pipe's map, so setting it on just one side is enough) wins;
 * otherwise falls back to the deterministic default (larger instanceId
 * hops), so both pipes agree without needing to coordinate.
 */
function resolveHop(
  pipeId: string,
  otherPipeId: string,
  crossing: string,
  pipesById: Map<string, PipeInstance>,
): { hops: boolean; overridden: boolean } {
  const mine = pipesById.get(pipeId)?.hopOverrides[crossing]
  if (mine === 'self') return { hops: true, overridden: true }
  if (mine === 'other') return { hops: false, overridden: true }
  const theirs = pipesById.get(otherPipeId)?.hopOverrides[crossing]
  if (theirs === 'self') return { hops: false, overridden: true }
  if (theirs === 'other') return { hops: true, overridden: true }
  return { hops: pipeId > otherPipeId, overridden: false }
}

export function computeHopsForPipe(
  pipeId: string,
  allPipes: PipeInstance[],
  pointsByPipe: Map<string, Point[]>,
): HopPoint[] {
  const pipesById = new Map(allPipes.map((p) => [p.instanceId, p]))
  return findCrossingsForPipe(pipeId, allPipes, pointsByPipe)
    .filter((c) => resolveHop(pipeId, c.otherPipeId, c.id, pipesById).hops)
    .map((c) => ({ point: c.point, segmentIndex: c.segmentIndex }))
}

export interface PipeCrossing {
  id: string
  otherPipeId: string
  point: Point
  /** Does *this* pipe (the one passed to computeCrossingsForPipe) render the hop arc here? */
  hopsHere: boolean
  /** True if a manual hopOverride (on either side) decided this, false if it's just the default rule. */
  overridden: boolean
}

/** All crossings a pipe participates in, with the resolved (override-aware) winner — backs the "Crossings" list in the properties panel. */
export function computeCrossingsForPipe(
  pipeId: string,
  allPipes: PipeInstance[],
  pointsByPipe: Map<string, Point[]>,
): PipeCrossing[] {
  const pipesById = new Map(allPipes.map((p) => [p.instanceId, p]))
  return findCrossingsForPipe(pipeId, allPipes, pointsByPipe).map((c) => {
    const r = resolveHop(pipeId, c.otherPipeId, c.id, pipesById)
    return { id: c.id, otherPipeId: c.otherPipeId, point: c.point, hopsHere: r.hops, overridden: r.overridden }
  })
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Proper interior crossing only — near-endpoint "intersections" (shared ports etc.) are ignored. */
function segmentIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1x = p2.x - p1.x
  const d1y = p2.y - p1.y
  const d2x = p4.x - p3.x
  const d2y = p4.y - p3.y
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) < 1e-9) return null

  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom
  if (t <= 0.02 || t >= 0.98 || u <= 0.02 || u >= 0.98) return null

  return { x: p1.x + t * d1x, y: p1.y + t * d1y }
}
