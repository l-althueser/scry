import { isPortRef, type FreePoint, type PipeInstance, type PortRef } from '@svg-editor/shared'
import { pipePointPortId } from './pipeGeometry'

/**
 * Key for a pipe end's connection-point identity. A FreePoint (unattached
 * end) has no instanceId/portId to key on, but it also never needs to match
 * anything else — nothing can reference "this specific free point" from
 * elsewhere — so a key scoped to this exact pipe+side is unique and safe.
 */
function endKey(pipe: PipeInstance, ref: PortRef | FreePoint, side: 'from' | 'to'): string {
  return isPortRef(ref) ? `${ref.instanceId}::${ref.portId}` : `free::${pipe.instanceId}::${side}`
}

/** Minimal union-find over connection-point identities (component ports / pipe points). */
class UnionFind {
  private parent = new Map<string, string>()

  private ensure(key: string): string {
    if (!this.parent.has(key)) this.parent.set(key, key)
    return key
  }

  find(key: string): string {
    this.ensure(key)
    let root = key
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    let cur = key
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/**
 * Groups pipes into "volumes": maximal sets of pipes connected to each
 * other — directly, or transitively via branching off one another's points
 * — without a component (e.g. a valve) in between. Every component port is
 * a hard boundary: connectivity never passes through a component, matching
 * the physical reality that gas only fills up to the nearest valve. A lone,
 * unbranched pipe between two components is still its own (size-1) volume.
 *
 * This only looks at fromPort/toPort (topology), never at waypoints/routing
 * (pure geometry) — so it only needs recomputing when pipes are added,
 * removed, or an instance they attach to is removed, not on every drag.
 */
export function computePipeVolumeGroups(pipes: PipeInstance[]): PipeInstance[][] {
  const uf = new UnionFind()
  for (const pipe of pipes) {
    const fromKey = endKey(pipe, pipe.fromPort, 'from')
    uf.union(fromKey, endKey(pipe, pipe.toPort, 'to'))
    // Every point along this pipe (both ends plus any waypoints) is
    // reachable from the pipe's own network — so a branch pipe attached via
    // pipePointPortId(N) must be unioned with the anchor pipe's own keys,
    // otherwise "a point on pipe A" stays a disconnected island from "pipe
    // A's fromPort/toPort" and the branch never actually joins the volume.
    const pointCount = pipe.waypoints.length + 2
    for (let i = 0; i < pointCount; i++) {
      uf.union(fromKey, `${pipe.instanceId}::${pipePointPortId(i)}`)
    }
  }
  const groups = new Map<string, PipeInstance[]>()
  for (const pipe of pipes) {
    const root = uf.find(endKey(pipe, pipe.fromPort, 'from'))
    const arr = groups.get(root)
    if (arr) arr.push(pipe)
    else groups.set(root, [pipe])
  }
  return [...groups.values()]
}

/**
 * Expands `ids` to include every pipe sharing a volumeTag with any pipe
 * already in `ids` — a connected run's indicator/name/color are really one
 * shared thing (see PipeInstance.indicatorEnabled/nameEnabled/strokeColor
 * and recomputeVolumeTags in projectStore.ts), so any setter touching one
 * of those fields on one pipe needs to apply to its whole run, not just the
 * pipe that happened to be clicked/selected.
 */
export function expandToVolumeSiblings(pipes: PipeInstance[], ids: ReadonlySet<string>): Set<string> {
  const volumeTags = new Set(pipes.filter((p) => ids.has(p.instanceId) && p.volumeTag).map((p) => p.volumeTag!))
  return new Set(
    pipes.filter((p) => ids.has(p.instanceId) || (p.volumeTag && volumeTags.has(p.volumeTag))).map((p) => p.instanceId),
  )
}

/**
 * For every volume with `nameEnabled` on for at least one member, the
 * single pipe that should actually render the shared "_name" label — the
 * one with the most waypoints (a proxy for "the main trunk" of a branching
 * run), tie-broken by instanceId for determinism. Every other pipe in that
 * volume still carries `nameEnabled: true` (kept in sync across the whole
 * volume — see recomputeVolumeTags) but must not render its own duplicate
 * label; unlike the indicator dot, which deliberately stays one-per-pipe
 * (multiple status dots along a long run aid visibility — a repeated name
 * label is just clutter).
 */
export function computeNameLabelPipeIds(pipes: PipeInstance[]): Set<string> {
  const groups = computePipeVolumeGroups(pipes)
  const result = new Set<string>()
  for (const group of groups) {
    if (!group.some((p) => p.nameEnabled)) continue
    const primary = group.reduce((best, p) =>
      p.waypoints.length > best.waypoints.length ||
      (p.waypoints.length === best.waypoints.length && p.instanceId < best.instanceId)
        ? p
        : best,
    )
    result.add(primary.instanceId)
  }
  return result
}
