import type { ComponentInstance, LeaderLine, LeaderLineEndpoint, LeaderLineEndpointRef } from '@svg-editor/shared'
import { fmt, rotatePoint } from '../library/componentUtils'

export interface Point {
  x: number
  y: number
}

export function isRoleRef(ref: LeaderLineEndpoint): ref is LeaderLineEndpointRef {
  return 'instanceId' in ref
}

/**
 * World position of a leader line's `from` endpoint — either a fixed free
 * point, or (the common case) a live reference to one of a component
 * instance's role labels, tracking it automatically as the instance moves,
 * rotates, or the role gets individually nudged. Same anchor point
 * `drawSelectionConnectors` (SvgCanvas.ts) already uses for its own
 * role-connector highlight line, so a leader line drawn from a role lines
 * up with that highlight exactly.
 */
export function resolveLeaderLineFromPosition(
  from: LeaderLineEndpoint,
  instances: ComponentInstance[],
): Point | null {
  if (!isRoleRef(from)) return { x: from.x, y: from.y }
  const inst = instances.find((i) => i.instanceId === from.instanceId)
  if (!inst) return null
  const role = inst.roles.find((r) => r.role === from.role)
  if (!role) return null
  const rotated = rotatePoint(role.offset, inst.transform.rotationDeg)
  return { x: inst.transform.x + rotated.x, y: inst.transform.y + rotated.y }
}

/**
 * Detaches any leader line's `from` that references one of the given
 * about-to-be-removed instances, freezing it as a fixed free point at its
 * last resolved position — mirrors detachPipesFromInstances (pipeGeometry.ts):
 * deleting a labeled component shouldn't silently make lines pointing from
 * it disappear, it should leave a "knot" where the label used to be.
 * `instances` must be the array as it stood *before* removal.
 */
export function detachLeaderLinesFromInstances(
  lines: LeaderLine[],
  instances: ComponentInstance[],
  removedInstanceIds: ReadonlySet<string>,
): LeaderLine[] {
  return lines.map((line) => {
    if (!isRoleRef(line.from) || !removedInstanceIds.has(line.from.instanceId)) return line
    const pos = resolveLeaderLineFromPosition(line.from, instances)
    return pos ? { ...line, from: pos } : line
  })
}

/** Full point list (from -> waypoints -> to) for a leader line, or null if a role-anchored `from` no longer resolves (e.g. the instance/role was deleted). */
export function getLeaderLinePoints(line: LeaderLine, instances: ComponentInstance[]): Point[] | null {
  const fromPos = resolveLeaderLineFromPosition(line.from, instances)
  if (!fromPos) return null
  return [fromPos, ...line.waypoints, line.to]
}

export function leaderLinePathD(points: Point[]): string {
  if (points.length === 0) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`).join(' ')
}
