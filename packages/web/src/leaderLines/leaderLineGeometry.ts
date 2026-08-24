import type {
  ComponentInstance,
  FreeShape,
  Layer,
  LeaderLine,
  LeaderLineBorderRef,
  LeaderLineEndpoint,
  LeaderLineEndpointRef,
  PipeInstance,
} from '@svg-editor/shared'
import { nearestPointOnPolylineIndexed, pointAlongPolyline } from '../geometry/polyline'
import { fmt, roleBoxCorners, rotatePoint } from '../library/componentUtils'
import { getPipePoints } from '../pipes/pipeGeometry'
import { resolveShapeBorderPoint } from '../shapes/freeShapeGeometry'

export interface Point {
  x: number
  y: number
}

export function isRoleRef(ref: LeaderLineEndpoint): ref is LeaderLineEndpointRef {
  return 'instanceId' in ref
}

export function isBorderRef(ref: LeaderLineEndpoint): ref is LeaderLineBorderRef {
  return 'targetKind' in ref
}

/**
 * World position of any leader-line endpoint: a fixed free point, a live
 * reference to a component instance's role center (LeaderLineEndpointRef),
 * or a live border anchor (LeaderLineBorderRef) on a shape's outline, a
 * pipe's polyline, or a name/value/setpoint role's label box (an invisible
 * but real footprint for `name`, which usually renders as bare text with no
 * visible box — see roleBoxCorners). All three border-target kinds are
 * resolved against the target's CURRENT geometry, which is what makes the
 * anchor track it through drags, resizes, rotation, or re-routing instead of
 * freezing at the position it was dropped. The role-center anchor
 * (LeaderLineEndpointRef) is the same point drawSelectionConnectors
 * (SvgCanvas.ts) uses for its own role-connector highlight line, so a leader
 * line drawn from a role lines up with that highlight exactly. Returns null
 * if the referenced instance/pipe/shape/role no longer exists.
 */
export function resolveLeaderLineEndpoint(
  endpoint: LeaderLineEndpoint,
  instances: ComponentInstance[],
  pipes: PipeInstance[],
  freeShapes: FreeShape[],
  layers: Layer[] = [],
): Point | null {
  if (isRoleRef(endpoint)) {
    const inst = instances.find((i) => i.instanceId === endpoint.instanceId)
    if (!inst) return null
    const role = inst.roles.find((r) => r.role === endpoint.role)
    if (!role) return null
    const rotated = rotatePoint(role.offset, inst.transform.rotationDeg)
    return { x: inst.transform.x + rotated.x, y: inst.transform.y + rotated.y }
  }

  if (isBorderRef(endpoint)) {
    if (endpoint.targetKind === 'shape') {
      const shape = freeShapes.find((s) => s.instanceId === endpoint.targetId)
      return shape ? resolveShapeBorderPoint(shape, endpoint.segmentIndex, endpoint.t) : null
    }
    if (endpoint.targetKind === 'pipe') {
      const pipe = pipes.find((p) => p.instanceId === endpoint.targetId)
      if (!pipe) return null
      const points = getPipePoints(pipe, instances, pipes, layers, freeShapes)
      return points ? pointAlongPolyline(points, endpoint.segmentIndex, endpoint.t) : null
    }
    // roleBox
    const inst = instances.find((i) => i.instanceId === endpoint.targetId)
    const role = inst?.roles.find((r) => r.role === endpoint.role)
    if (!inst || !role) return null
    const corners = roleBoxCorners(inst, role)
    return corners ? pointAlongPolyline(corners, endpoint.segmentIndex, endpoint.t) : null
  }

  return { x: endpoint.x, y: endpoint.y }
}

/**
 * Detaches any leader-line endpoint (from or to) that references one of the
 * given about-to-be-removed instances/pipes/shapes, freezing it as a fixed
 * free point at its last resolved position — mirrors detachPipesFromInstances
 * (pipeGeometry.ts): deleting something a line points at shouldn't silently
 * make the line disappear or dangle, it should leave a "knot" where it used
 * to attach. `instances`/`pipes`/`freeShapes` must be the arrays as they
 * stood *before* removal, since positions are resolved against them — call
 * this before actually filtering the deleted entities out.
 */
export function detachLeaderLineEndpoints(
  lines: LeaderLine[],
  instances: ComponentInstance[],
  pipes: PipeInstance[],
  freeShapes: FreeShape[],
  layers: Layer[],
  removed: { instanceIds?: ReadonlySet<string>; pipeIds?: ReadonlySet<string>; shapeIds?: ReadonlySet<string> },
): LeaderLine[] {
  const isRemoved = (ep: LeaderLineEndpoint): boolean => {
    if (isRoleRef(ep)) return removed.instanceIds?.has(ep.instanceId) ?? false
    if (isBorderRef(ep)) {
      if (ep.targetKind === 'roleBox') return removed.instanceIds?.has(ep.targetId) ?? false
      if (ep.targetKind === 'pipe') return removed.pipeIds?.has(ep.targetId) ?? false
      if (ep.targetKind === 'shape') return removed.shapeIds?.has(ep.targetId) ?? false
    }
    return false
  }
  const detach = (ep: LeaderLineEndpoint): LeaderLineEndpoint => {
    if (!isRemoved(ep)) return ep
    return resolveLeaderLineEndpoint(ep, instances, pipes, freeShapes, layers) ?? ep
  }
  return lines.map((line) => {
    const from = detach(line.from)
    const to = detach(line.to)
    return from === line.from && to === line.to ? line : { ...line, from, to }
  })
}

/**
 * Re-anchors every `from`/`to` that's a LeaderLineBorderRef on `pipeId`
 * after that pipe's own point list changed shape (a waypoint inserted or
 * removed) — `oldPoints`/`newPoints` are its point list immediately before
 * and after that edit. Unlike a PortRef's exact "pt:{index}" identity (see
 * shiftPipePointRefsForInsert/Delete in pipeGeometry.ts, which just
 * renumber), a border anchor's segmentIndex/t names a *continuous* position
 * that can end up split across two segments by an insertion in the middle
 * of it — there's no index arithmetic that represents that exactly. Instead
 * this resolves the anchor's world position against `oldPoints`, then
 * re-projects that same position onto `newPoints` (nearestPointOnPolylineIndexed)
 * to get a fresh segmentIndex/t at the same physical spot, however the
 * segment boundaries moved.
 */
export function shiftLeaderLinePipeAnchorsForPipeChange(
  lines: LeaderLine[],
  pipeId: string,
  oldPoints: Point[],
  newPoints: Point[],
): LeaderLine[] {
  const reanchor = (ep: LeaderLineEndpoint): LeaderLineEndpoint => {
    if (!isBorderRef(ep) || ep.targetKind !== 'pipe' || ep.targetId !== pipeId) return ep
    const worldPos = pointAlongPolyline(oldPoints, ep.segmentIndex, ep.t)
    if (!worldPos) return ep
    const hit = nearestPointOnPolylineIndexed(newPoints, worldPos)
    if (!hit) return ep
    return { ...ep, segmentIndex: hit.segmentIndex, t: hit.t }
  }
  return lines.map((line) => {
    const from = reanchor(line.from)
    const to = reanchor(line.to)
    return from === line.from && to === line.to ? line : { ...line, from, to }
  })
}

/** Full world-space point list (from -> waypoints -> to) for a leader line, or null if either end can't be resolved (e.g. its target was deleted). */
export function getLeaderLinePoints(
  line: LeaderLine,
  instances: ComponentInstance[],
  pipes: PipeInstance[] = [],
  freeShapes: FreeShape[] = [],
  layers: Layer[] = [],
): Point[] | null {
  const fromPos = resolveLeaderLineEndpoint(line.from, instances, pipes, freeShapes, layers)
  const toPos = resolveLeaderLineEndpoint(line.to, instances, pipes, freeShapes, layers)
  if (!fromPos || !toPos) return null
  return [fromPos, ...line.waypoints, toPos]
}

export function leaderLinePathD(points: Point[]): string {
  if (points.length === 0) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`).join(' ')
}
