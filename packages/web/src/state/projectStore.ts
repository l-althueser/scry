import { create } from 'zustand'
import {
  isPortRef,
  isScryClipboardEnvelope,
  type ComponentInstance,
  type FreePoint,
  type FreeShape,
  type FreeShapeKind,
  type FreeShapeStyle,
  type Group,
  type GroupMemberRef,
  type ImageConnectionPoint,
  type ImageLayer,
  type Layer,
  type LeaderLine,
  type LeaderLineBorderRef,
  type LeaderLineEndpoint,
  type LeaderLineEndpointRef,
  type PipeInstance,
  type PortRef,
  type Project,
  type ProjectMeta,
  type RoutingMode,
  type ScryClipboardEnvelope,
  type ScryClipboardPayload,
  type Suffix,
  type TextAlign,
  type VectorLayer,
  type Waypoint,
} from '@svg-editor/shared'
import { componentHasPipeColorOption, getComponentType, resolveLocalBodyCorners, rotatePoint } from '../library'
import type { ConnectionPointOwnerKind, Tool, Point } from '../canvas/SvgCanvas'
import * as api from '../api/client'
import { exportProjectToSvg } from '../export/svgExport'
import { downloadTextFile } from '../export/downloadFile'
import { applyTransparentColor, samplePixelColor } from '../import/imageTransparency'
import { resizeImage } from '../import/imageResize'
import { computePipeVolumeGroups, expandToVolumeSiblings } from '../pipes/pipeVolumes'
import {
  detachPipesFromConnectionPointOwners,
  detachPipesFromInstances,
  detachPipesFromPipes,
  getPipePoints,
  getShapeConnectionPointWorldPosition,
  IMAGE_POINT_PREFIX,
  PIPE_POINT_PREFIX,
  pipePointPortId,
  resolvePortRefWorldPosition,
  SHAPE_POINT_PREFIX,
  shapePointPortId,
  shiftCornerOverridesForDelete,
  shiftCornerOverridesForInsert,
  shiftPipePointRefsForDelete,
  shiftPipePointRefsForInsert,
} from '../pipes/pipeGeometry'
import {
  detachLeaderLineEndpoints,
  resolveLeaderLineEndpoint,
  shiftLeaderLinePipeAnchorsForPipeChange,
} from '../leaderLines/leaderLineGeometry'
import { computeAutoRoute } from '../routing/autoRoute'
import { DEFAULT_FONT_SIZE, DEFAULT_SHAPE_STYLE, boundsOfPoints } from '../shapes/freeShapeGeometry'

/** The one always-present vector content layer — instances/pipes/shapes all implicitly live here (no per-instance layer assignment UI yet). */
const DEFAULT_VECTOR_LAYER: Layer = { layerId: 'default', name: 'Default', visible: true, locked: false, kind: 'vector' }

/** The "1x"/standard grid size — the toolbar's grid toggle offers this plus 1/2x and 1/4x, derived from it rather than hardcoded separately. */
export const BASE_GRID_SIZE = 20

/**
 * Remembers whichever project name was last open in *this browser*, so a
 * page reload reopens that project instead of always falling back to the
 * hardcoded 'my-project' default (see loadInitialProject, which still does
 * the real work of actually fetching it from the server and only trusts
 * this as a starting guess). Read once at module load for the store's
 * initial state; written by the subscriber right after it, on every actual
 * change. localStorage is per-browser, not synced across machines/tabs —
 * consistent with this being a local UX convenience, not project data.
 */
const LAST_PROJECT_STORAGE_KEY = 'gv-last-project-name'

function readLastProjectName(): string {
  try {
    return localStorage.getItem(LAST_PROJECT_STORAGE_KEY) || 'my-project'
  } catch {
    return 'my-project'
  }
}

const instanceCounters: Record<string, number> = {}
const PIPE_COUNTER_KEY = 'pipe'
const PIPE_TAG_PREFIX = 'L'
const VOLUME_COUNTER_KEY = 'volume'
const VOLUME_TAG_PREFIX = 'LV'

function nextTag(componentTypeId: string): string {
  const def = getComponentType(componentTypeId)
  const n = (instanceCounters[componentTypeId] ?? 0) + 1
  instanceCounters[componentTypeId] = n
  return `${def.tagPrefix}${n}`
}

function nextPipeTag(): string {
  const n = (instanceCounters[PIPE_COUNTER_KEY] ?? 0) + 1
  instanceCounters[PIPE_COUNTER_KEY] = n
  return `${PIPE_TAG_PREFIX}${n}`
}

function nextVolumeTag(): string {
  const n = (instanceCounters[VOLUME_COUNTER_KEY] ?? 0) + 1
  instanceCounters[VOLUME_COUNTER_KEY] = n
  return `${VOLUME_TAG_PREFIX}${n}`
}

/**
 * Auto-generated tags only ever count up — deleting an instance/pipe never
 * frees its number back up for re-use. When a project is loaded from the
 * server, the counters must be resynced to the highest tag already present
 * for each prefix, otherwise a freshly generated tag could collide with (or
 * "reuse") one that was already used in that project before the reload.
 * Manually retagging something to an old value is still always possible via
 * renameInstance/renamePipeTag — this only governs the *automatic* choice.
 */
function resyncCounters(instances: ComponentInstance[], pipes: PipeInstance[]) {
  for (const inst of instances) {
    const def = getComponentType(inst.componentTypeId)
    bumpCounter(inst.componentTypeId, def.tagPrefix, inst.tag)
  }
  for (const pipe of pipes) {
    bumpCounter(PIPE_COUNTER_KEY, PIPE_TAG_PREFIX, pipe.tag)
    if (pipe.volumeTag) bumpCounter(VOLUME_COUNTER_KEY, VOLUME_TAG_PREFIX, pipe.volumeTag)
  }
}

function bumpCounter(key: string, prefix: string, tag: string) {
  if (!tag.startsWith(prefix)) return
  const n = Number(tag.slice(prefix.length))
  if (Number.isInteger(n) && n > (instanceCounters[key] ?? 0)) {
    instanceCounters[key] = n
  }
}

/**
 * Recomputes which pipes belong to the same "volume" (see pipes/pipeVolumes)
 * and (re-)assigns each group a stable tag: a group that already has a tag
 * among its members keeps it (the lowest one, by tag number, if a merge
 * brought two previously-separate tagged groups together — the other tag is
 * simply retired, matching the "never reuse" policy above); a brand-new
 * group gets a freshly generated one. Must run after anything that can
 * change pipe topology (add/delete a pipe, delete an instance a pipe was
 * attached to) — NOT after purely geometric changes (dragging a waypoint,
 * moving an instance), since those don't change which pipes are connected.
 */
function recomputeVolumeTags(pipes: PipeInstance[]): PipeInstance[] {
  const groups = computePipeVolumeGroups(pipes)
  const tagByPipeId = new Map<string, string>()
  const usedTags = new Set<string>()
  // A merge (via a new branch) can leave two later-split-apart groups both
  // "remembering" the same old tag. Assign larger groups first — the
  // biggest remaining fragment is the best guess for "still the same
  // volume" — so on a collision only the smaller fragment gets a fresh tag.
  const bySizeDesc = [...groups].sort((a, b) => b.length - a.length)
  // Reconciled alongside the tag itself: a volume's indicator/name/color are
  // one shared thing (see expandToVolumeSiblings), so whenever topology
  // changes bring pipes together into (or apart from) a group, their flags
  // need to end up consistent too — same OR/first-non-null merge rule
  // mergeFreeEndChains already uses for the simpler 2-pipe "continuing a
  // draw" case, generalized here to an arbitrary-size group.
  const indicatorByPipeId = new Map<string, boolean>()
  const nameByPipeId = new Map<string, boolean>()
  const colorByPipeId = new Map<string, string | null>()
  for (const group of bySizeDesc) {
    const existingTags = Array.from(new Set(group.map((p) => p.volumeTag).filter((t): t is string => !!t))).sort(
      compareTagNumbers,
    )
    const tag = existingTags.find((t) => !usedTags.has(t)) ?? nextVolumeTag()
    usedTags.add(tag)
    const indicatorEnabled = group.some((p) => p.indicatorEnabled)
    const nameEnabled = group.some((p) => p.nameEnabled)
    const strokeColor = group.find((p) => p.strokeColor)?.strokeColor ?? null
    for (const p of group) {
      tagByPipeId.set(p.instanceId, tag)
      indicatorByPipeId.set(p.instanceId, indicatorEnabled)
      nameByPipeId.set(p.instanceId, nameEnabled)
      colorByPipeId.set(p.instanceId, strokeColor)
    }
  }
  return pipes.map((p) => {
    const tag = tagByPipeId.get(p.instanceId)
    const indicatorEnabled = indicatorByPipeId.get(p.instanceId) ?? p.indicatorEnabled
    const nameEnabled = nameByPipeId.get(p.instanceId) ?? p.nameEnabled
    const strokeColor = colorByPipeId.has(p.instanceId) ? colorByPipeId.get(p.instanceId)! : p.strokeColor
    const nextTag = tag && tag !== p.volumeTag ? tag : p.volumeTag
    return nextTag === p.volumeTag && indicatorEnabled === p.indicatorEnabled && nameEnabled === p.nameEnabled && strokeColor === p.strokeColor
      ? p
      : { ...p, volumeTag: nextTag, indicatorEnabled, nameEnabled, strokeColor }
  })
}

function compareTagNumbers(a: string, b: string): number {
  const na = Number(a.replace(/^\D+/, ''))
  const nb = Number(b.replace(/^\D+/, ''))
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return a.localeCompare(b)
}

function refsEqual(a: PortRef | FreePoint, b: PortRef | FreePoint): boolean {
  return isPortRef(a) && isPortRef(b) && a.instanceId === b.instanceId && a.portId === b.portId
}

/**
 * Finds one pipe whose fromPort or toPort references another pipe's
 * unattached (FreePoint) end — i.e. someone continued drawing from/onto a
 * dangling stub — where that end isn't ALSO referenced by anything else (a
 * real branch). In that case the two pipes together have exactly one start
 * and one end, so they're merged into a single continuous pipe instead of
 * staying as two tagged pieces joined by a coincidental shared point. The
 * anchor pipe (the one whose free end gets continued) keeps its identity;
 * the continuing pipe is absorbed. Returns null if no such pair exists.
 */
function tryMergeOneFreeEndChain(
  pipes: PipeInstance[],
): { pipes: PipeInstance[]; absorbedId: string; survivorId: string } | null {
  for (const continuing of pipes) {
    for (const side of ['from', 'to'] as const) {
      const ref = side === 'from' ? continuing.fromPort : continuing.toPort
      if (!isPortRef(ref) || !ref.portId.startsWith(PIPE_POINT_PREFIX)) continue

      const anchor = pipes.find((p) => p.instanceId === ref.instanceId)
      if (!anchor || anchor.instanceId === continuing.instanceId) continue
      // This merge convenience only recognizes a free end at anchor.toPort
      // — the natural shape for a stub left by Escape-ing a draw mid-pipe.
      // A pipe can also end up with a free *fromPort* now (disconnected via
      // drag, or a deleted component), but continuing from/onto that spot
      // just stays a normal pt:-referenced branch rather than auto-merging
      // — a minor missed convenience, not a correctness issue.
      if (isPortRef(anchor.toPort)) continue
      const anchorPointCount = anchor.waypoints.length + 2
      if (ref.portId !== pipePointPortId(anchorPointCount - 1)) continue

      // Ambiguous (a real branch) if any OTHER pipe also references this exact free end.
      const otherReferences = pipes.some(
        (p) => p.instanceId !== continuing.instanceId && (refsEqual(p.fromPort, ref) || refsEqual(p.toPort, ref)),
      )
      if (otherReferences) continue

      const junction: Waypoint = { x: (anchor.toPort as FreePoint).x, y: (anchor.toPort as FreePoint).y, kind: 'corner' }
      const waypoints =
        side === 'from'
          ? [...anchor.waypoints, junction, ...continuing.waypoints]
          : [...anchor.waypoints, junction, ...[...continuing.waypoints].reverse()]
      const toPort: PortRef | FreePoint = side === 'from' ? continuing.toPort : continuing.fromPort

      const merged: PipeInstance = {
        ...anchor,
        waypoints,
        toPort,
        indicatorEnabled: anchor.indicatorEnabled || continuing.indicatorEnabled,
        nameEnabled: anchor.nameEnabled || continuing.nameEnabled,
        strokeColor: anchor.strokeColor ?? continuing.strokeColor ?? null,
        // Concatenating (and possibly reversing) two point lists into one
        // would require remapping both sides' arrow pointIndex values
        // through that reshuffle — a rare edge case (both segments already
        // having arrows right as they're auto-merged mid-draw) not worth
        // the complexity; simplest correct behavior is to drop them.
        arrows: [],
      }
      const nextPipes = pipes
        .filter((p) => p.instanceId !== anchor.instanceId && p.instanceId !== continuing.instanceId)
        .concat(merged)
      return { pipes: nextPipes, absorbedId: continuing.instanceId, survivorId: anchor.instanceId }
    }
  }
  return null
}

/**
 * Repeatedly collapses any eligible free-end continuations (see
 * tryMergeOneFreeEndChain) until none remain — a chain of several
 * stub-continuations collapses fully in one call. Returns the resulting
 * pipes plus a resolver from any absorbed pipe's old id to whichever id
 * ultimately survived, so callers can keep e.g. a selection pointed at the
 * right pipe even if the one they just created got absorbed into another.
 */
function mergeFreeEndChains(pipes: PipeInstance[]): { pipes: PipeInstance[]; resolveId: (id: string) => string } {
  let current = pipes
  const redirect = new Map<string, string>()
  for (let i = 0; i < pipes.length; i++) {
    const result = tryMergeOneFreeEndChain(current)
    if (!result) break
    current = result.pipes
    redirect.set(result.absorbedId, result.survivorId)
  }
  const resolveId = (id: string): string => {
    let cur = id
    const seen = new Set<string>()
    while (redirect.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      cur = redirect.get(cur)!
    }
    return cur
  }
  return { pipes: current, resolveId }
}

/**
 * Strips references to just-deleted instances/pipes/shapes/leader lines out
 * of every group's member list, and drops any group left with fewer than 2
 * members afterward (a "group" of 0 or 1 is meaningless). Used by every
 * per-category delete action so a group never accumulates stale ids when one
 * of its members is deleted outside the whole-group `deleteGroup` path —
 * one shared helper instead of four near-identical filter blocks.
 */
function stripDeletedGroupMembers(
  groups: Group[],
  removedByKind: Partial<Record<GroupMemberRef['kind'], Set<string>>>,
): Group[] {
  return groups
    .map((g) => ({
      ...g,
      members: g.members.filter((m) => !removedByKind[m.kind]?.has(m.id)),
    }))
    .filter((g) => g.members.length >= 2)
}

/** If `selectedGroupId` no longer names a group in `groups` (deleted or dissolved by stripDeletedGroupMembers), clears it — a stale group selection would otherwise silently keep pointing at nothing. */
function clearSelectedGroupIfGone(groups: Group[], selectedGroupId: string | null): string | null {
  if (!selectedGroupId) return null
  return groups.some((g) => g.groupId === selectedGroupId) ? selectedGroupId : null
}

function isLeaderLineEndpointRef(ref: LeaderLineEndpoint): ref is LeaderLineEndpointRef {
  return 'instanceId' in ref
}

function isLeaderLineBorderRef(ref: LeaderLineEndpoint): ref is LeaderLineBorderRef {
  return 'targetKind' in ref
}

/** Shifts a bare-point leader-line endpoint by `offset`; a role or border ref is left untouched (it tracks its target live, no coordinate of its own to shift) — used by cloneEntitySet's pass 1. */
function offsetLeaderLineEndpoint(ep: LeaderLineEndpoint, offset: Point): LeaderLineEndpoint {
  if (isLeaderLineEndpointRef(ep) || isLeaderLineBorderRef(ep)) return ep
  return { x: ep.x + offset.x, y: ep.y + offset.y }
}

/** Rewrites a role/border ref's target id through idMap (falling back to the original id if absent — see cloneEntitySet pass 2's doc comment); a bare point is left untouched. */
function remapLeaderLineEndpoint(ep: LeaderLineEndpoint, idMap: Map<string, string>): LeaderLineEndpoint {
  if (isLeaderLineEndpointRef(ep)) return { ...ep, instanceId: idMap.get(ep.instanceId) ?? ep.instanceId }
  if (isLeaderLineBorderRef(ep)) return { ...ep, targetId: idMap.get(ep.targetId) ?? ep.targetId }
  return ep
}

/**
 * Mirrors createGroup's existing selection-reading pattern: filters the
 * project's four entity arrays down to the four selected-id arrays, plus
 * `groups` filtered to `selectedGroupId` (0 or 1 entries). This is the
 * single place "what counts as the current selection" is defined — reused
 * by duplicate, copy, and (implicitly, via the same ScryClipboardPayload
 * shape) paste.
 *
 * Any pipe port or leader-line anchor that references a component instance
 * or another pipe NOT included in this gathered set is frozen into an open
 * (FreePoint) end at its current world position — a clone/paste must never
 * keep pointing at something the user didn't actually select, mirroring how
 * detachPipesFromInstances/detachLeaderLineEndpoints already freeze an
 * end at its last known position when the instance it pointed at is
 * deleted. A reference to an image layer's connection point is left alone:
 * layers aren't duplicated by this feature, so the same shared background
 * image is still there in the clone/paste target either way. Doing this
 * here (not later in cloneEntitySet) is what makes it work for copy/paste
 * too, not just duplicate — cloneEntitySet only ever sees the entities it's
 * asked to clone, with no way to resolve a position for something outside
 * that set, whereas gather time still has the full live project to resolve
 * against.
 */
function gatherSelectionAsEntitySet(
  state: Pick<
    ProjectState,
    | 'instances'
    | 'pipes'
    | 'freeShapes'
    | 'leaderLines'
    | 'layers'
    | 'groups'
    | 'selectedInstanceIds'
    | 'selectedPipeIds'
    | 'selectedShapeIds'
    | 'selectedLeaderLineIds'
    | 'selectedLayerIds'
    | 'selectedGroupId'
  >,
): ScryClipboardPayload {
  const instanceIds = new Set(state.selectedInstanceIds)
  const pipeIds = new Set(state.selectedPipeIds)
  const shapeIds = new Set(state.selectedShapeIds)
  const leaderLineIds = new Set(state.selectedLeaderLineIds)
  const layerIds = new Set(state.selectedLayerIds)

  const openEndIfExternal = (ref: PortRef | FreePoint): PortRef | FreePoint => {
    if (!isPortRef(ref)) return ref
    const referencesUngatheredPipe = ref.portId.startsWith(PIPE_POINT_PREFIX) && !pipeIds.has(ref.instanceId)
    const referencesUngatheredImage = ref.portId.startsWith(IMAGE_POINT_PREFIX) && !layerIds.has(ref.instanceId)
    const referencesUngatheredShape = ref.portId.startsWith(SHAPE_POINT_PREFIX) && !shapeIds.has(ref.instanceId)
    const referencesUngatheredInstance =
      !ref.portId.startsWith(PIPE_POINT_PREFIX) &&
      !ref.portId.startsWith(IMAGE_POINT_PREFIX) &&
      !ref.portId.startsWith(SHAPE_POINT_PREFIX) &&
      !instanceIds.has(ref.instanceId)
    if (!referencesUngatheredPipe && !referencesUngatheredImage && !referencesUngatheredShape && !referencesUngatheredInstance)
      return ref
    return resolvePortRefWorldPosition(ref, state.instances, state.pipes, state.layers, state.freeShapes) ?? ref
  }

  const pipes = state.pipes
    .filter((p) => pipeIds.has(p.instanceId))
    .map((p) => {
      const fromPort = openEndIfExternal(p.fromPort)
      const toPort = openEndIfExternal(p.toPort)
      return fromPort === p.fromPort && toPort === p.toPort ? p : { ...p, fromPort, toPort }
    })

  const openLeaderLineEndIfExternal = (ep: LeaderLineEndpoint): LeaderLineEndpoint => {
    const referencesUngathered = isLeaderLineEndpointRef(ep)
      ? !instanceIds.has(ep.instanceId)
      : isLeaderLineBorderRef(ep)
        ? (ep.targetKind === 'roleBox' && !instanceIds.has(ep.targetId)) ||
          (ep.targetKind === 'pipe' && !pipeIds.has(ep.targetId)) ||
          (ep.targetKind === 'shape' && !shapeIds.has(ep.targetId))
        : false
    if (!referencesUngathered) return ep
    return resolveLeaderLineEndpoint(ep, state.instances, state.pipes, state.freeShapes, state.layers) ?? ep
  }

  const leaderLines = state.leaderLines
    .filter((l) => leaderLineIds.has(l.instanceId))
    .map((l) => {
      const from = openLeaderLineEndIfExternal(l.from)
      const to = openLeaderLineEndIfExternal(l.to)
      return from === l.from && to === l.to ? l : { ...l, from, to }
    })

  return {
    instances: state.instances.filter((i) => instanceIds.has(i.instanceId)),
    pipes,
    freeShapes: state.freeShapes.filter((s) => shapeIds.has(s.instanceId)),
    leaderLines,
    layers: state.layers.filter((l): l is ImageLayer => l.kind === 'image' && layerIds.has(l.layerId)),
    groups: state.groups.filter((g) => g.groupId === state.selectedGroupId),
  }
}

/**
 * Two-pass clone of a gathered selection (or clipboard payload): pass 1
 * gives every entity a fresh id/tag and shifts its geometry by `offset`,
 * building an `idMap: Map<oldId, newId>` that spans instances/pipes/shapes/
 * leaderLines (all UUIDs, safe to share one map across kinds). Pass 2
 * rewrites cross-references through that map — pipe `fromPort`/`toPort`
 * when `isPortRef`, leader-line `from` when it's a ref, and group members.
 * Every ref reaching this point should already resolve in `idMap`:
 * gatherSelectionAsEntitySet (the only place that builds a `source` for this
 * function) already freezes any reference to something outside the gathered
 * set into an open FreePoint end before this ever runs. The `?? ` fallback
 * to the original id below is just a defensive no-op for that case, not the
 * normal path — kept in case a payload from an older clipboard format (or
 * anything else assembled by hand) somehow still contains one.
 */
function cloneEntitySet(source: ScryClipboardPayload, offset: Point): ScryClipboardPayload {
  const idMap = new Map<string, string>()

  const instances = source.instances.map((inst) => {
    const instanceId = crypto.randomUUID()
    idMap.set(inst.instanceId, instanceId)
    return {
      ...inst,
      instanceId,
      tag: nextTag(inst.componentTypeId),
      transform: { ...inst.transform, x: inst.transform.x + offset.x, y: inst.transform.y + offset.y },
    }
  })

  const pipes = source.pipes.map((pipe) => {
    const instanceId = crypto.randomUUID()
    idMap.set(pipe.instanceId, instanceId)
    return {
      ...pipe,
      instanceId,
      tag: nextPipeTag(),
      fromPort: isPortRef(pipe.fromPort)
        ? pipe.fromPort
        : { x: pipe.fromPort.x + offset.x, y: pipe.fromPort.y + offset.y },
      toPort: isPortRef(pipe.toPort) ? pipe.toPort : { x: pipe.toPort.x + offset.x, y: pipe.toPort.y + offset.y },
      waypoints: pipe.waypoints.map((wp) => ({ ...wp, x: wp.x + offset.x, y: wp.y + offset.y })),
      // Neither is stable across edits anyway (see pipeGeometry.ts's own
      // documented caveat) — volumeTag gets recomputed by
      // recomputeVolumeTags, which every caller of cloneEntitySet runs on
      // the resulting pipes array.
      hopOverrides: {},
      volumeTag: null,
    }
  })

  const freeShapes = source.freeShapes.map((shape) => {
    const instanceId = crypto.randomUUID()
    idMap.set(shape.instanceId, instanceId)
    return { ...shape, instanceId, points: shape.points.map((pt) => ({ x: pt.x + offset.x, y: pt.y + offset.y })) }
  })

  const leaderLines = source.leaderLines.map((line) => {
    const instanceId = crypto.randomUUID()
    idMap.set(line.instanceId, instanceId)
    return {
      ...line,
      instanceId,
      from: offsetLeaderLineEndpoint(line.from, offset),
      to: offsetLeaderLineEndpoint(line.to, offset),
      waypoints: line.waypoints.map((wp) => ({ x: wp.x + offset.x, y: wp.y + offset.y })),
    }
  })

  const layers = source.layers.map((layer) => {
    const layerId = crypto.randomUUID()
    idMap.set(layer.layerId, layerId)
    return { ...layer, layerId, x: layer.x + offset.x, y: layer.y + offset.y }
  })

  // Pass 2 — every kind's clone id now exists in idMap, so refs can be
  // resolved (or, for a ref outside the clone, deliberately left pointing
  // at the original).
  const remappedPipes = pipes.map((pipe) => ({
    ...pipe,
    fromPort: isPortRef(pipe.fromPort)
      ? { ...pipe.fromPort, instanceId: idMap.get(pipe.fromPort.instanceId) ?? pipe.fromPort.instanceId }
      : pipe.fromPort,
    toPort: isPortRef(pipe.toPort)
      ? { ...pipe.toPort, instanceId: idMap.get(pipe.toPort.instanceId) ?? pipe.toPort.instanceId }
      : pipe.toPort,
  }))
  const remappedLeaderLines = leaderLines.map((line) => ({
    ...line,
    from: remapLeaderLineEndpoint(line.from, idMap),
    to: remapLeaderLineEndpoint(line.to, idMap),
  }))
  const remappedGroups = source.groups
    .map((g) => ({
      groupId: crypto.randomUUID(),
      members: g.members
        .map((m) => (idMap.has(m.id) ? { ...m, id: idMap.get(m.id)! } : null))
        .filter((m): m is GroupMemberRef => m !== null),
    }))
    // Reuses stripDeletedGroupMembers's "<2 members drops the group"
    // invariant — a group cloned alongside only some of its members can end
    // up too small to remain meaningful.
    .filter((g) => g.members.length >= 2)

  return { instances, pipes: remappedPipes, freeShapes, leaderLines: remappedLeaderLines, layers, groups: remappedGroups }
}

/**
 * Core of setGroupStyle/setSelectionStyle: applies a color-field change to
 * ONE kind only (instances' role labels, pipes' line color, or shapes' own
 * fill/stroke) — `kind` comes from which per-kind fieldset (Labels/Pipes/
 * Shapes) the panel's swatch was clicked in (see SelectionStylePanel), so
 * e.g. recoloring pipes' lines never bleeds into instance label borders just
 * because both happen to use the same 'stroke' field name. Leader lines have
 * no style fields at all so they're never a valid `kind` here. Shared
 * between the persisted-group and loose-multi-select editors so both
 * broadcast identically.
 *
 * `pipeStubInstanceIds` (kind === 'pipe' only) is the selection's instances
 * that have their own "pipe color" option (see componentHasPipeColorOption)
 * — a component's small pipe-connector stub is visually part of "the pipe",
 * so the shared Pipes swatch recolors those alongside any real selected
 * pipes rather than requiring a separate control.
 */
function applyStyleFieldToIds(
  state: Pick<ProjectState, 'instances' | 'pipes' | 'freeShapes'>,
  kind: 'instance' | 'pipe' | 'shape',
  ids: Set<string>,
  field: 'fill' | 'stroke' | 'text',
  value: string | null,
  pipeStubInstanceIds: Set<string> = new Set(),
): Pick<ProjectState, 'instances' | 'pipes' | 'freeShapes'> {
  if (kind === 'instance') {
    const roleKey = field === 'fill' ? 'fillColor' : field === 'stroke' ? 'strokeColor' : 'textColor'
    return {
      instances: state.instances.map((inst) =>
        ids.has(inst.instanceId) ? { ...inst, roles: inst.roles.map((r) => ({ ...r, [roleKey]: value })) } : inst,
      ),
      pipes: state.pipes,
      freeShapes: state.freeShapes,
    }
  }
  if (kind === 'pipe') {
    // Expanded to volume siblings, same as setPipeColor — a connected run's
    // color is one shared thing, not per-segment. Pipes only ever have a
    // stroke (their line color) — fill/text are meaningless and no-op.
    if (field !== 'stroke') return { instances: state.instances, pipes: state.pipes, freeShapes: state.freeShapes }
    const expanded = expandToVolumeSiblings(state.pipes, ids)
    return {
      instances: state.instances.map((inst) =>
        pipeStubInstanceIds.has(inst.instanceId)
          ? { ...inst, propertyValues: { ...inst.propertyValues, pipeColor: value } }
          : inst,
      ),
      pipes: state.pipes.map((p) => (expanded.has(p.instanceId) ? { ...p, strokeColor: value } : p)),
      freeShapes: state.freeShapes,
    }
  }
  // kind === 'shape': fill and stroke apply, text is meaningless (no per-shape text color) and no-ops.
  if (field !== 'fill' && field !== 'stroke') {
    return { instances: state.instances, pipes: state.pipes, freeShapes: state.freeShapes }
  }
  return {
    instances: state.instances,
    pipes: state.pipes,
    freeShapes: state.freeShapes.map((s) => (ids.has(s.instanceId) ? { ...s, style: { ...s.style, [field]: value } } : s)),
  }
}

/**
 * Core of setGroupPipeFlag/setSelectionPipeFlag: applies a shared on/off
 * toggle across every selected pipe at once — the bulk counterpart to
 * setPipeIndicatorEnabled/setPipeNameEnabled for a multi-pipe selection.
 * Non-pipe ids in the selection are silently unaffected (only pipes have
 * these two flags), same "ignore kinds that don't have this field" pattern
 * as applyStyleFieldToIds.
 */
function applyPipeFlagToIds(
  pipes: PipeInstance[],
  pipeIds: Set<string>,
  field: 'indicatorEnabled' | 'nameEnabled',
  value: boolean,
): PipeInstance[] {
  // Expanded to volume siblings, same as setPipeIndicatorEnabled/
  // setPipeNameEnabled — a bulk action on part of a selection shouldn't
  // leave an unselected sibling pipe out of sync with the rest of its run.
  const expanded = expandToVolumeSiblings(pipes, pipeIds)
  return pipes.map((p) => (expanded.has(p.instanceId) ? { ...p, [field]: value } : p))
}

/**
 * Core of deleteGroup/deleteSelection: removes the given ids from every
 * project array in one pass and strips them out of any Group.members list
 * that referenced them, so a group never accumulates stale ids when one of
 * its members is deleted via a path other than deleteGroup itself.
 */
function computeMixedDeletion(
  state: Pick<ProjectState, 'instances' | 'pipes' | 'leaderLines' | 'freeShapes' | 'layers' | 'groups'>,
  ids: {
    instanceIds: Set<string>
    pipeIds: Set<string>
    shapeIds: Set<string>
    leaderLineIds: Set<string>
    layerIds?: Set<string>
  },
): Pick<ProjectState, 'instances' | 'pipes' | 'leaderLines' | 'freeShapes' | 'layers' | 'groups'> {
  const layerIds = ids.layerIds ?? new Set<string>()
  return {
    instances: state.instances.filter((inst) => !ids.instanceIds.has(inst.instanceId)),
    pipes: recomputeVolumeTags(
      detachPipesFromConnectionPointOwners(
        detachPipesFromPipes(
          detachPipesFromInstances(state.pipes, state.instances, ids.instanceIds),
          state.instances,
          state.layers,
          ids.pipeIds,
          state.freeShapes,
        ),
        state.instances,
        state.layers,
        state.freeShapes,
        layerIds,
        ids.shapeIds,
      ).filter((p) => !ids.pipeIds.has(p.instanceId)),
    ),
    leaderLines: detachLeaderLineEndpoints(state.leaderLines, state.instances, state.pipes, state.freeShapes, state.layers, {
      instanceIds: ids.instanceIds,
      pipeIds: ids.pipeIds,
      shapeIds: ids.shapeIds,
    }).filter((l) => !ids.leaderLineIds.has(l.instanceId)),
    freeShapes: state.freeShapes.filter((s) => !ids.shapeIds.has(s.instanceId)),
    layers: state.layers.filter((l) => !layerIds.has(l.layerId)),
    groups: stripDeletedGroupMembers(state.groups, {
      instance: ids.instanceIds,
      pipe: ids.pipeIds,
      shape: ids.shapeIds,
      leaderLine: ids.leaderLineIds,
      layer: layerIds,
    }),
  }
}

interface HistorySnapshot {
  instances: ComponentInstance[]
  pipes: PipeInstance[]
  freeShapes: FreeShape[]
  layers: Layer[]
  leaderLines: LeaderLine[]
  groups: Group[]
}

const MAX_HISTORY = 100

/**
 * Captures the current instances/pipes/freeShapes/layers as one undo step
 * and clears the redo stack (a new edit invalidates whatever redo history
 * existed). Selection, tool, and other UI-only state are deliberately NOT
 * part of history — undo only ever rewinds the actual project content.
 *
 * Call once per discrete action, or once at the START of a multi-step drag
 * (see the `checkpointHistory` action) — never on every intermediate drag
 * update, or a single visual drag would take many Ctrl+Z presses to undo.
 */
function pushHistory(
  state: Pick<ProjectState, 'instances' | 'pipes' | 'freeShapes' | 'layers' | 'leaderLines' | 'groups' | 'past'>,
): Pick<ProjectState, 'past' | 'future'> {
  const snapshot = snapshotOf(state)
  const past = [...state.past, snapshot]
  if (past.length > MAX_HISTORY) past.shift()
  return { past, future: [] }
}

function snapshotOf(
  state: Pick<ProjectState, 'instances' | 'pipes' | 'freeShapes' | 'layers' | 'leaderLines' | 'groups'>,
): HistorySnapshot {
  return {
    instances: state.instances,
    pipes: state.pipes,
    freeShapes: state.freeShapes,
    layers: state.layers,
    leaderLines: state.leaderLines,
    groups: state.groups,
  }
}


/** Letters, then optional digits — a practical subset of the tag pattern documented in .claude/CLAUDE.md. */
export const TAG_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/

export interface RoleSelection {
  instanceId: string
  role: Suffix
}

/**
 * Arrow-key nudge steps. Default is a small, fine-grained step for precise
 * placement; Shift+arrow jumps by a full grid cell for fast repositioning.
 * A selected role always moves in even finer, sub-grid steps.
 */
const INSTANCE_NUDGE_STEP = 0.5
const INSTANCE_NUDGE_STEP_FAST = 20
const ROLE_NUDGE_STEP = 0.5
const ROLE_NUDGE_STEP_FAST = 5
const WAYPOINT_NUDGE_STEP = 0.5
const WAYPOINT_NUDGE_STEP_FAST = 5
const CONNECTION_POINT_NUDGE_STEP = 0.5
const CONNECTION_POINT_NUDGE_STEP_FAST = 5

interface ProjectState {
  instances: ComponentInstance[]
  selectedInstanceIds: string[]
  selectedRole: RoleSelection | null
  pipes: PipeInstance[]
  selectedPipeIds: string[]
  selectedWaypoint: { pipeId: string; index: number } | null
  /** Which pipe endpoint ('from'/'to') is selected — the endpoint counterpart to selectedWaypoint, needed so the properties panel can show per-point arrow controls (see PipeArrow) for an end, not just an interior waypoint. */
  selectedEndpoint: { pipeId: string; side: 'from' | 'to' } | null
  freeShapes: FreeShape[]
  selectedShapeIds: string[]
  leaderLines: LeaderLine[]
  selectedLeaderLineIds: string[]
  /** Which point of the selected leader line is being edited — mirrors selectedWaypoint's shape, 'from'/'to' or a waypoint index. */
  selectedLeaderLinePoint: { leaderLineId: string; point: 'from' | 'to' | number } | null
  layers: Layer[]
  selectedLayerIds: string[]
  /** Which connection point (on the currently selected image layer, shape, or component instance) is being edited — coexists with, doesn't clear, selectedLayerIds/selectedShapeIds/selectedInstanceIds, same as selectedWaypoint coexisting with selectedPipeIds. */
  selectedConnectionPoint: { ownerKind: ConnectionPointOwnerKind; ownerId: string; pointId: string } | null
  groups: Group[]
  /** Non-null means the five selection arrays above currently equal exactly one group's membership, selected as a unit (see selectGroup). */
  selectedGroupId: string | null
  /** Drives the layers list view in the (right) properties panel — toggled from a toolbar button, since there's no dedicated left-hand layers panel anymore. */
  layersPanelOpen: boolean
  /** Drives the tag-search view in the (right) properties panel, same convention as layersPanelOpen. */
  searchPanelOpen: boolean
  /** Persisted (not the result list itself — that's derived live from this + current instances/pipes) so reopening the panel shows the same search. */
  searchQuery: string
  searchRegexPattern: string
  searchRegexReplacement: string
  /** Shared by the width/height panel fields and the canvas corner-drag handles, so both respect the same lock. */
  imageAspectLocked: boolean
  tool: Tool
  placingType: string | null
  drawingShapeKind: FreeShapeKind | null
  connectionPointTargetLayerId: string | null
  /** Parallel to connectionPointTargetLayerId, but for the 'place-connection-point-shape' tool. */
  connectionPointTargetShapeId: string | null
  /** Parallel to connectionPointTargetLayerId, but for the 'place-connection-point-instance' tool. */
  connectionPointTargetInstanceId: string | null
  /** Non-null while the "pick transparent color" eyedropper tool is armed for an image layer — see pickTransparentColorAt. */
  pickTransparentColorTargetLayerId: string | null
  /** Max per-channel color difference (0-255) still counted as a match — see applyTransparentColor. 0 = exact match only. A UI setting, not per-image, so it carries over between picks like the regex-search fields do. */
  transparentColorTolerance: number
  gridSize: number
  /** Whether the grid is drawn at all — independent of gridSize, which stays the snap spacing even while the grid is hidden. Defaults to hidden (the "0x" toolbar option). */
  gridVisible: boolean
  tagRenameError: string | null
  /** Set when autoRoutePipe fails to find an obstacle-free path (e.g. fully boxed in); cleared on the next successful route or pipe (re)selection. */
  routeError: string | null
  groupDragOrigins: Record<string, Point> | null
  /** Free pipe knots riding along with the current group drag — see beginGroupDrag's doc comment. */
  groupDragPipePoints: { pipeId: string; point: 'from' | 'to' | number; origin: Point }[] | null
  /** Full points-array origin per selected shape riding along with the current group drag. */
  groupDragShapeOrigins: Record<string, Point[]> | null
  /** Free (non-role-anchored) leader-line points — 'from' when it's a plain point, 'to', and every waypoint — riding along with the current group drag, same shape as groupDragPipePoints. */
  groupDragLeaderLinePoints: { leaderLineId: string; point: 'from' | 'to' | number; origin: Point }[] | null
  /** Origin x/y per selected (unlocked) image layer riding along with the current group drag — same convention as groupDragOrigins for instances. */
  groupDragLayerOrigins: Record<string, Point> | null
  /**
   * The clipboard text (JSON-stringified ScryClipboardEnvelope) behind the
   * most recent paste, paired with the live ids it produced. Duplicate needs
   * no equivalent: its "source" is always whatever's currently selected,
   * which already IS the previous duplicate's own output by construction, so
   * repeated Ctrl+D naturally chains without separately tracked state. Paste
   * has no such loop — its source is a frozen clipboard snapshot that
   * doesn't move on its own — so chaining "paste again, offset from wherever
   * I dragged the last one" requires remembering that last paste's live ids
   * explicitly.
   */
  lastPasteText: string | null
  lastPastedIds: {
    instanceIds: string[]
    pipeIds: string[]
    shapeIds: string[]
    leaderLineIds: string[]
    layerIds: string[]
    groupId: string | null
  } | null
  past: HistorySnapshot[]
  future: HistorySnapshot[]

  projectName: string
  availableProjects: string[]
  serverStatus: string | null
  /** 'error' when serverStatus is a failure message — drives the toast in App.tsx. Success messages are kept in serverStatus for debugging but aren't shown anywhere. */
  serverStatusKind: 'error' | null
  serverBusy: boolean

  /**
   * Continuous autosave/sync status, distinct from the one-off serverStatus
   * toast text above (which is for discrete actions like rename/duplicate).
   * 'unsaved': never saved/loaded on this server (brand new or imported from
   * a local file) — nothing to autosave against yet. 'dirty': local edits
   * pending, debounce running. 'saving'/'synced'/'error' are what they say.
   * 'conflict': the periodic poll found the server copy's meta.modifiedAt no
   * longer matches what we last saved/loaded — see autosavePaused.
   */
  syncStatus: 'unsaved' | 'dirty' | 'saving' | 'synced' | 'conflict' | 'error'
  /** The meta of the version we last successfully saved to or loaded from the server — the poll's comparison baseline. */
  projectMeta: ProjectMeta | null
  /** True while a conflict is unresolved — the autosave subscriber checks this and skips, so local edits never silently overwrite someone else's save mid-conflict. */
  autosavePaused: boolean
  syncErrorMessage: string | null

  addInstance: (componentTypeId: string, pos: Point, keepPlacing?: boolean) => void
  moveInstance: (instanceId: string, pos: Point) => void
  /** One-shot X/Y edit (e.g. a typed properties-panel field) — unlike moveInstance, this pushes its own history entry since it isn't part of a checkpointed drag. */
  setInstancePosition: (instanceId: string, pos: Point) => void
  /** Continuous drag from a canvas resize-instance handle — see moveInstance/resizeImageLayer for the analogous no-history-per-frame pattern. */
  resizeInstance: (instanceId: string, rect: { x: number; y: number; width: number; height: number }) => void
  deleteInstance: (instanceId: string) => void
  deleteInstances: (instanceIds: string[]) => void
  rotateInstance: (instanceId: string, deltaDeg: number) => void
  renameInstance: (instanceId: string, newTag: string) => void
  /** Generic per-instance customization (mirror/fill-color/optional-extras — see InstanceOptionDescriptor) — not every type offers any. */
  setInstancePropertyValue: (instanceId: string, key: string, value: string | number | boolean | null) => void
  setRoleEnabled: (instanceId: string, role: Suffix, enabled: boolean) => void
  /** worldRelativeOffset is relative to the instance origin, not yet compensated for rotation. */
  moveRole: (instanceId: string, role: Suffix, worldRelativeOffset: Point) => void
  /** One-shot X/Y edit (typed field) — worldPos is an absolute canvas position, converted to the role's own local offset internally (same math moveRole/nudgeSelection use). Pushes its own history entry. */
  setRolePosition: (instanceId: string, role: Suffix, worldPos: Point) => void
  /** Independent spin of one label around its own anchor, on top of the parent instance's rotation. */
  setRoleRotation: (instanceId: string, role: Suffix, rotationDeg: number) => void
  /** null resets that color to the type default. */
  setRoleColor: (
    instanceId: string,
    role: Suffix,
    key: 'fillColor' | 'strokeColor' | 'textColor',
    value: string | null,
  ) => void
  /** Overrides only the `name` role's *displayed* text — the real tag (and the exported "{tag}_name" id) is untouched. null/'' resets to showing the tag. */
  setRoleLabelTextOverride: (instanceId: string, value: string | null) => void
  centerRoles: (instanceId: string) => void
  /** pipePoints: free pipe knots caught in the same box-select as instanceIds ("mark knots like elements") — they translate by the same delta as the group for the duration of this drag. */
  beginGroupDrag: (
    instanceIds: string[],
    pipePoints?: { pipeId: string; point: 'from' | 'to' | number }[],
  ) => void
  applyGroupDrag: (delta: Point) => void
  endGroupDrag: () => void
  selectInstances: (instanceIds: string[]) => void
  selectAll: () => void
  selectRole: (selection: RoleSelection | null) => void
  nudgeSelection: (direction: Point, fine: boolean) => void
  setTool: (tool: Tool, componentTypeId?: string | null) => void
  cancelTool: () => void
  /** Not part of undo history (a view/editor setting, like imageAspectLocked) even though it's also saved into the project's meta on export. */
  setGridSize: (size: number) => void
  setGridVisible: (visible: boolean) => void

  /** Pushes one undo checkpoint without changing any state — call once at the start of a multi-step drag. */
  checkpointHistory: () => void
  undo: () => void
  redo: () => void

  addPipe: (fromPort: PortRef | FreePoint, toPort: PortRef | FreePoint, waypoints: Waypoint[], keepDrawing?: boolean) => void
  deletePipes: (pipeIds: string[]) => void
  renamePipeTag: (pipeId: string, newTag: string) => void
  renameVolumeTag: (pipeId: string, newTag: string) => void
  setPipeIndicatorEnabled: (pipeId: string, enabled: boolean) => void
  setPipeNameEnabled: (pipeId: string, enabled: boolean) => void
  setPipeColor: (pipeId: string, color: string | null) => void
  setPipeRoutingMode: (pipeId: string, mode: RoutingMode) => void
  movePipeWaypoint: (pipeId: string, waypointIndex: number, pt: Point) => void
  /** Splits raw segment `index` by inserting a new waypoint there (see findNearestPipeSegment) and selects it. */
  insertPipeWaypoint: (pipeId: string, index: number, pt: Point) => void
  deletePipeWaypoint: (pipeId: string, index: number) => void
  /** Live update while dragging a pipe's actual from/to connection point (not an interior waypoint) — ref may be a snapped PortRef or a bare FreePoint (disconnects that end). No history push per call, mirrors movePipeWaypoint; see finalizePipeEndpointDrag. */
  movePipeEndpoint: (pipeId: string, side: 'from' | 'to', ref: PortRef | FreePoint) => void
  /** Called once when an endpoint drag ends, to recompute pipe "volumes" (topology may have changed) without doing it on every intermediate move. */
  finalizePipeEndpointDrag: (pipeId: string) => void
  /** winner is relative to pipeId: 'self' = pipeId hops at this crossing, 'other' = the crossing pipe does, null = clear the override (back to the default larger-id-hops rule). */
  setHopOverride: (pipeId: string, otherPipeId: string, crossingId: string, winner: 'self' | 'other' | null) => void
  setPipeCornerOverride: (pipeId: string, segmentIndex: number, mode: 'h-first' | 'v-first') => void
  /** Grid A* re-route around other components' bounding boxes; replaces the pipe's waypoints and switches it to 'orthogonal' mode. Sets routeError if no path is found. */
  autoRoutePipe: (pipeId: string) => void
  selectPipes: (pipeIds: string[]) => void
  selectWaypoint: (selection: { pipeId: string; index: number } | null) => void
  selectEndpoint: (selection: { pipeId: string; side: 'from' | 'to' } | null) => void
  /** Adds, updates, or (when arrow is null) removes the arrow marker at a specific point along a pipe (see PipeArrow) — one undo step. */
  setPipeArrow: (pipeId: string, pointIndex: number, arrow: { size: number; rotationDeg: number } | null) => void

  /** keepDrawing is true when Shift was held, so the tool stays active for drawing several shapes in a row. */
  addFreeShape: (
    kind: FreeShapeKind,
    points: Point[],
    keepDrawing?: boolean,
  ) => void
  deleteShapes: (shapeIds: string[]) => void
  moveShape: (shapeId: string, points: Point[]) => void
  /** Panel-driven numeric resize (unlike moveShape, pushes its own history step) — rescales every point relative to the shape's current bbox top-left corner by newWidth/oldWidth and newHeight/oldHeight, so it works uniformly for rect/ellipse (2 corners), line (2 endpoints), and polygon (any vertex count). */
  resizeShape: (shapeId: string, width: number, height: number) => void
  setShapeStyle: (shapeId: string, style: Partial<FreeShapeStyle>) => void
  setShapeText: (shapeId: string, text: string) => void
  setShapeFontSize: (shapeId: string, fontSize: number) => void
  setShapeTextAlign: (shapeId: string, textAlign: TextAlign) => void
  setShapeRotation: (shapeId: string, rotationDeg: number) => void
  selectShapes: (shapeIds: string[]) => void

  /** Adds a finished leader line from a completed draw-tool interaction (from/waypoints/to already resolved by the canvas). */
  addLeaderLine: (from: LeaderLineEndpoint, waypoints: Point[], to: LeaderLineEndpoint) => void
  deleteLeaderLines: (leaderLineIds: string[]) => void
  /** Continuous drag, like moveShape/moveInstance — checkpointed once at drag-start via onDragCheckpoint. Moves the 'to' endpoint (which may snap onto a role/border anchor, not just a bare point) or a waypoint by index (always a bare point). */
  moveLeaderLinePoint: (leaderLineId: string, point: 'to' | number, pos: LeaderLineEndpoint) => void
  /** Same drag pattern as moveLeaderLinePoint, but for 'from' — its value is a full LeaderLineEndpoint (a role ref when the drag re-anchors onto a different label, otherwise a plain point). */
  moveLeaderLineFrom: (leaderLineId: string, from: LeaderLineEndpoint) => void
  selectLeaderLines: (leaderLineIds: string[]) => void
  selectLeaderLinePoint: (selection: { leaderLineId: string; point: 'from' | 'to' | number } | null) => void

  /**
   * Sets all four selection-category arrays at once, without the mutual
   * clearing that selectInstances/selectPipes/selectShapes/selectLeaderLines
   * each do for their own single-category click use case — needed so a
   * marquee box that catches a genuine mix (e.g. a component and a pipe
   * together) can keep all of them selected together (see SvgCanvas's
   * finalizeBoxSelect), instead of whichever category's own select action
   * happens to run last wiping out the others.
   */
  selectMixed: (selection: {
    instanceIds: string[]
    pipeIds: string[]
    shapeIds: string[]
    leaderLineIds: string[]
    layerIds: string[]
  }) => void
  /** Selects an existing group as a unit: partitions its members into the four selection arrays and sets selectedGroupId. */
  selectGroup: (groupId: string) => void
  /** Groups the current contents of the four selection arrays (2+ members required). Flattens/merges in any already-selected whole group(s) instead of nesting. Selects the new group. */
  createGroup: () => void
  /** Removes the Group record; the four selection arrays are left as a loose multi-select (selectedGroupId cleared). */
  ungroup: (groupId: string) => void
  /** Deletes every member of the group plus the Group record itself, atomically (one undo step). */
  deleteGroup: (groupId: string) => void
  /** Fans a shared color-field change out to every member of a matching kind, one undo step for the whole group. */
  /** kind selects which member kind's ids the field/value applies to (instance/pipe/shape) — see applyStyleFieldToIds. */
  setGroupStyle: (
    groupId: string,
    kind: 'instance' | 'pipe' | 'shape',
    field: 'fill' | 'stroke' | 'text',
    value: string | null,
  ) => void
  /** Same broadcast as setGroupStyle, but for whatever is currently selected across the five arrays — no persisted Group required. */
  setSelectionStyle: (kind: 'instance' | 'pipe' | 'shape', field: 'fill' | 'stroke' | 'text', value: string | null) => void
  /** Bulk-sets indicatorEnabled/nameEnabled across every pipe in a persisted Group at once, one undo step. */
  setGroupPipeFlag: (groupId: string, field: 'indicatorEnabled' | 'nameEnabled', value: boolean) => void
  /** Same bulk toggle as setGroupPipeFlag, but for every currently-selected pipe (loose multi-select). */
  setSelectionPipeFlag: (field: 'indicatorEnabled' | 'nameEnabled', value: boolean) => void
  /** Deletes everything currently selected across all four categories at once, one undo step. */
  deleteSelection: () => void
  /** Clones whatever is currently selected (instances/pipes/shapes/leaderLines/group), offset one grid cell right and down, and selects the clone — repeated Ctrl+D naturally stacks further each time since it always clones "current selection" and re-selects its own output. */
  duplicateSelection: () => void
  /** Snapshots the current selection to the real OS clipboard as a ScryClipboardEnvelope (no mutation, no history entry). No-ops on an empty selection. */
  copySelectionToClipboard: () => void
  /** Parses `text` as a ScryClipboardEnvelope and clones its payload into the project, offset one grid cell from its recorded position; silently no-ops on anything that isn't a valid envelope. Repeated Ctrl+V with the same clipboard text chains off the previous paste's own (possibly since-moved) clones instead of the frozen envelope payload — see lastPasteText/lastPastedIds. */
  pasteFromClipboardText: (text: string) => void

  addImageLayer: (name: string, src: string, width: number, height: number) => void
  /** Creates a new, initially empty vector layer a free shape can be moved onto (see setShapeLayer) — returned synchronously so the caller can immediately assign a shape to it. */
  addShapeLayer: (name?: string) => string
  /** Moves one free shape onto a different (or newly created) vector layer. */
  setShapeLayer: (shapeId: string, layerId: string) => void
  deleteLayer: (layerId: string) => void
  renameLayer: (layerId: string, name: string) => void
  setLayerVisible: (layerId: string, visible: boolean) => void
  setLayerLocked: (layerId: string, locked: boolean) => void
  setLayerOpacity: (layerId: string, opacity: number) => void
  setLayerIncludeInExport: (layerId: string, included: boolean) => void
  setLayerShowGridOverImage: (layerId: string, show: boolean) => void
  setLayerRect: (layerId: string, rect: { x: number; y: number; width: number; height: number }) => void
  moveLayer: (layerId: string, direction: 'up' | 'down') => void
  moveImageLayer: (layerId: string, x: number, y: number) => void
  /** Continuous drag, like moveImageLayer — checkpointed once at drag-start via onDragCheckpoint. */
  resizeImageLayer: (layerId: string, rect: { x: number; y: number; width: number; height: number }) => void
  selectLayers: (layerIds: string[]) => void
  /** Opens the layers list view (clearing any other selection) — e.g. from the toolbar button. */
  openLayersPanel: () => void
  /** Closes the layers list view and deselects any layer whose settings were showing. */
  closeLayersPanel: () => void
  toggleLayersPanel: () => void
  /** Opens the tag-search view (clearing any other selection) — e.g. from the toolbar button. */
  openSearchPanel: () => void
  closeSearchPanel: () => void
  toggleSearchPanel: () => void
  setSearchQuery: (query: string) => void
  setSearchRegexPattern: (pattern: string) => void
  setSearchRegexReplacement: (replacement: string) => void
  /** Applies an already-validated batch of tag renames (see previewRegexRename in search/tagSearch.ts) as one undo step. */
  bulkRenameTagsByRegex: (matches: { kind: 'instance' | 'pipe'; id: string; newTag: string }[]) => void
  setImageAspectLocked: (locked: boolean) => void
  /** keepPlacing is true when Shift was held, so the tool stays active for placing several points in a row. */
  addConnectionPoint: (layerId: string, relX: number, relY: number, keepPlacing?: boolean) => void
  deleteConnectionPoint: (layerId: string, pointId: string) => void
  /** Parallel to addConnectionPoint, but for a free shape's own connection points (relX/relY fractions of the shape's bounding box). */
  addShapeConnectionPoint: (shapeId: string, relX: number, relY: number, keepPlacing?: boolean) => void
  deleteShapeConnectionPoint: (shapeId: string, pointId: string) => void
  /** Parallel to addShapeConnectionPoint, but for a component instance's own connection points (relX/relY fractions of the instance's local unrotated body bounding box) — in addition to that type's own fixed ports. */
  addInstanceConnectionPoint: (instanceId: string, relX: number, relY: number, keepPlacing?: boolean) => void
  deleteInstanceConnectionPoint: (instanceId: string, pointId: string) => void
  selectConnectionPoint: (selection: { ownerKind: ConnectionPointOwnerKind; ownerId: string; pointId: string } | null) => void
  /** Live update while dragging a connection-point handle — no history push per call, checkpointed via onDragCheckpoint at drag-start like every other continuous drag. */
  moveConnectionPoint: (ownerKind: ConnectionPointOwnerKind, ownerId: string, pointId: string, relX: number, relY: number) => void
  /** The "pick transparent color" eyedropper: samples the pixel at relX/relY (fractions of the image's footprint) and re-encodes the image with every pixel within transparentColorTolerance made transparent — one-shot, exits the tool on completion. */
  pickTransparentColorAt: (layerId: string, relX: number, relY: number) => Promise<void>
  /** Updates the tolerance; if layerId is given and that layer has a remembered pick (originalSrc + transparentColorHex), immediately re-derives src from originalSrc at the new tolerance. */
  setTransparentColorTolerance: (tolerance: number, layerId?: string) => void
  /** Reverts to the pre-edit image saved in ImageLayer.originalSrc (see pickTransparentColorAt) — a no-op if no transparent-color edit has been applied. */
  restoreOriginalImage: (layerId: string) => void
  /** Re-encodes the image's native pixel size to shrink file size (independent of its on-canvas display width/height, see resizeImageLayer). Snapshots the pre-resize image into originalSrc the same way pickTransparentColorAt does, so restoreOriginalImage also undoes a resize. */
  resizeImagePixels: (layerId: string, targetWidth: number, targetHeight: number) => Promise<void>
  /** Permanently drops ImageLayer.originalSrc (and the now-meaningless transparentColorHex), making the current src the new floor with nothing left to restore — a no-op if originalSrc isn't set. */
  discardOriginalImage: (layerId: string) => void

  setProjectName: (name: string) => void
  refreshProjectList: () => Promise<void>
  /** Once, on app mount: loads the current projectName's content from the server if it already exists there — see the action's own doc comment. */
  loadInitialProject: () => Promise<void>
  saveProjectToServer: () => Promise<void>
  loadProjectFromServer: (name: string) => Promise<void>
  exportToServer: () => Promise<void>

  renameProjectOnServer: (oldName: string, newName: string) => Promise<void>
  duplicateProjectOnServer: (name: string, newName: string) => Promise<void>
  /** Soft-delete (server moves the file to a hidden trash dir, nothing is unlinked). If the trashed project is the one currently open, detaches it from autosave/sync (the in-memory content is untouched, just no longer tied to a server file). */
  trashProjectOnServer: (name: string) => Promise<void>

  /** Downloads the current in-memory project (including unsaved edits) as a local .json file. */
  exportProjectToFile: () => void
  /**
   * Loads an already-parsed local file's content into the current editing
   * session. mode 'new' (default): treated as a fresh, not-yet-saved
   * project (detaches from whatever was open — no server round-trip, no
   * assumption this content corresponds to any saved server project). mode
   * 'overwrite-current': keeps the *currently open* project's name/meta
   * association, so the imported content becomes this project's content and
   * the next autosave overwrites that same server file with it.
   */
  importProjectFromFile: (project: Project, mode?: 'new' | 'overwrite-current') => void

  /** Force-saves the local copy over the server's, resolving a conflict by discarding the other side's changes. */
  resolveConflictKeepMine: () => Promise<void>
  /** Discards local edits and reloads the server's copy, resolving a conflict by discarding this side's changes. */
  resolveConflictReloadTheirs: () => Promise<void>

  versions: api.ProjectVersionInfo[]
  versionsLoading: boolean
  loadProjectVersions: (name: string) => Promise<void>
  /** Restores a past version as the project's live server content, then reloads it into the editor (mirrors loadProjectFromServer's local-state reset). */
  restoreProjectVersion: (name: string, timestamp: number) => Promise<void>
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  instances: [],
  selectedInstanceIds: [],
  selectedRole: null,
  pipes: [],
  selectedPipeIds: [],
  selectedWaypoint: null,
  selectedEndpoint: null,
  freeShapes: [],
  selectedShapeIds: [],
  leaderLines: [],
  selectedLeaderLineIds: [],
  selectedLeaderLinePoint: null,
  selectedConnectionPoint: null,
  layers: [DEFAULT_VECTOR_LAYER],
  selectedLayerIds: [],
  groups: [],
  selectedGroupId: null,
  layersPanelOpen: false,
  searchPanelOpen: false,
  searchQuery: '',
  searchRegexPattern: '',
  searchRegexReplacement: '',
  imageAspectLocked: true,
  tool: 'select',
  placingType: null,
  drawingShapeKind: null,
  connectionPointTargetLayerId: null,
  connectionPointTargetShapeId: null,
  connectionPointTargetInstanceId: null,
  pickTransparentColorTargetLayerId: null,
  transparentColorTolerance: 0,
  gridSize: BASE_GRID_SIZE / 8,
  gridVisible: false,
  tagRenameError: null,
  routeError: null,
  groupDragOrigins: null,
  groupDragPipePoints: null,
  groupDragShapeOrigins: null,
  groupDragLeaderLinePoints: null,
  groupDragLayerOrigins: null,
  lastPasteText: null,
  lastPastedIds: null,
  past: [],
  future: [],

  projectName: readLastProjectName(),
  availableProjects: [],
  serverStatus: null,
  serverStatusKind: null,
  serverBusy: false,
  syncStatus: 'unsaved',
  projectMeta: null,
  autosavePaused: false,
  syncErrorMessage: null,
  versions: [],
  versionsLoading: false,

  addInstance: (componentTypeId, pos, keepPlacing = false) =>
    set((state) => {
      const def = getComponentType(componentTypeId)
      const instance: ComponentInstance = {
        instanceId: crypto.randomUUID(),
        tag: nextTag(componentTypeId),
        componentTypeId,
        libraryPackage: 'prototype',
        transform: { x: pos.x, y: pos.y, rotationDeg: 0 },
        propertyValues: {},
        layerId: 'default',
        roles: def.defaultRoles(),
      }
      return {
        ...pushHistory(state),
        instances: [...state.instances, instance],
        selectedInstanceIds: [instance.instanceId],
        selectedPipeIds: [],
        tagRenameError: null,
        // Placement is single-shot by default: back to the select tool once
        // placed (Escape cancels early, see cancelTool). Holding Shift while
        // placing keeps the tool (and type) active so several can be placed in a row.
        tool: keepPlacing ? state.tool : 'select',
        placingType: keepPlacing ? state.placingType : null,
      }
    }),

  moveInstance: (instanceId, pos) =>
    set((state) => ({
      instances: state.instances.map((inst) =>
        inst.instanceId === instanceId
          ? { ...inst, transform: { ...inst.transform, x: pos.x, y: pos.y } }
          : inst,
      ),
    })),

  setInstancePosition: (instanceId, pos) =>
    set((state) => ({
      ...pushHistory(state),
      instances: state.instances.map((inst) =>
        inst.instanceId === instanceId
          ? { ...inst, transform: { ...inst.transform, x: pos.x, y: pos.y } }
          : inst,
      ),
    })),

  resizeInstance: (instanceId, rect) =>
    set((state) => ({
      instances: state.instances.map((inst) => {
        if (inst.instanceId !== instanceId) return inst
        const resizable = getComponentType(inst.componentTypeId).resizable
        if (!resizable) return inst
        return {
          ...inst,
          transform: { ...inst.transform, x: rect.x, y: rect.y },
          propertyValues: {
            ...inst.propertyValues,
            [resizable.widthKey]: rect.width,
            [resizable.heightKey]: rect.height,
          },
        }
      }),
    })),

  deleteInstance: (instanceId) =>
    set((state) => {
      const removed = new Set([instanceId])
      const groups = stripDeletedGroupMembers(state.groups, { instance: removed })
      return {
        ...pushHistory(state),
        instances: state.instances.filter((inst) => inst.instanceId !== instanceId),
        // Pipes attached to the deleted instance are kept, not removed — the
        // detached end becomes a fixed FreePoint ("knot") at the port's last
        // position instead of a dangling reference that would otherwise
        // silently stop rendering.
        pipes: recomputeVolumeTags(detachPipesFromInstances(state.pipes, state.instances, removed)),
        leaderLines: detachLeaderLineEndpoints(state.leaderLines, state.instances, state.pipes, state.freeShapes, state.layers, {
          instanceIds: removed,
        }),
        selectedInstanceIds: state.selectedInstanceIds.filter((id) => id !== instanceId),
        selectedRole: state.selectedRole?.instanceId === instanceId ? null : state.selectedRole,
        groups,
        selectedGroupId: clearSelectedGroupIfGone(groups, state.selectedGroupId),
        tagRenameError: null,
      }
    }),

  deleteInstances: (instanceIds) =>
    set((state) => {
      const removed = new Set(instanceIds)
      const groups = stripDeletedGroupMembers(state.groups, { instance: removed })
      return {
        ...pushHistory(state),
        instances: state.instances.filter((inst) => !removed.has(inst.instanceId)),
        pipes: recomputeVolumeTags(detachPipesFromInstances(state.pipes, state.instances, removed)),
        leaderLines: detachLeaderLineEndpoints(state.leaderLines, state.instances, state.pipes, state.freeShapes, state.layers, {
          instanceIds: removed,
        }),
        selectedInstanceIds: state.selectedInstanceIds.filter((id) => !removed.has(id)),
        selectedRole:
          state.selectedRole && removed.has(state.selectedRole.instanceId) ? null : state.selectedRole,
        groups,
        selectedGroupId: clearSelectedGroupIfGone(groups, state.selectedGroupId),
        tagRenameError: null,
      }
    }),

  rotateInstance: (instanceId, deltaDeg) =>
    set((state) => ({
      ...pushHistory(state),
      instances: state.instances.map((inst) =>
        inst.instanceId === instanceId
          ? {
              ...inst,
              transform: {
                ...inst.transform,
                rotationDeg: (inst.transform.rotationDeg + deltaDeg + 360) % 360,
              },
            }
          : inst,
      ),
    })),

  renameInstance: (instanceId, newTag) =>
    set((state) => {
      const trimmed = newTag.trim()
      if (!TAG_PATTERN.test(trimmed)) {
        return { tagRenameError: 'Tag must start with a letter (e.g. V1, HV208).' }
      }
      // Duplicates are allowed (e.g. deliberately sharing a tag across a
      // couple of instances) — the properties panel warns about it instead
      // of blocking it, see duplicateInstanceTagCount in PropertiesPanel.tsx.
      return {
        ...pushHistory(state),
        tagRenameError: null,
        instances: state.instances.map((inst) =>
          inst.instanceId === instanceId ? { ...inst, tag: trimmed } : inst,
        ),
      }
    }),

  setInstancePropertyValue: (instanceId, key, value) =>
    set((state) => ({
      ...pushHistory(state),
      instances: state.instances.map((inst) =>
        inst.instanceId === instanceId
          ? { ...inst, propertyValues: { ...inst.propertyValues, [key]: value } }
          : inst,
      ),
    })),

  setRoleEnabled: (instanceId, role, enabled) =>
    set((state) => ({
      ...pushHistory(state),
      instances: state.instances.map((inst) => {
        if (inst.instanceId !== instanceId) return inst
        const toggled = inst.roles.map((r) => (r.role === role ? { ...r, enabled } : r))
        // Toggling a role changes which slots are occupied, so re-pack the
        // gap-free stack immediately — but only for roles still at their
        // auto-positioned spot; anything the user has manually dragged stays put.
        return { ...inst, roles: getComponentType(inst.componentTypeId).autoPackRoles(toggled) }
      }),
    })),

  moveRole: (instanceId, role, worldRelativeOffset) =>
    set((state) => ({
      instances: state.instances.map((inst) => {
        if (inst.instanceId !== instanceId) return inst
        // The role's offset is stored in the valve's own (unrotated) frame,
        // so a drag captured in world space must be rotated back first —
        // otherwise the label would jump when the valve isn't at 0deg.
        const offset = rotatePoint(worldRelativeOffset, -inst.transform.rotationDeg)
        return {
          ...inst,
          roles: inst.roles.map((r) => (r.role === role ? { ...r, offset, manuallyPositioned: true } : r)),
        }
      }),
    })),

  setRolePosition: (instanceId, role, worldPos) =>
    set((state) => ({
      ...pushHistory(state),
      instances: state.instances.map((inst) => {
        if (inst.instanceId !== instanceId) return inst
        const worldRelativeOffset = { x: worldPos.x - inst.transform.x, y: worldPos.y - inst.transform.y }
        const offset = rotatePoint(worldRelativeOffset, -inst.transform.rotationDeg)
        return {
          ...inst,
          roles: inst.roles.map((r) => (r.role === role ? { ...r, offset, manuallyPositioned: true } : r)),
        }
      }),
    })),

  setRoleRotation: (instanceId, role, rotationDeg) =>
    set((state) => ({
      ...pushHistory(state),
      instances: state.instances.map((inst) =>
        inst.instanceId === instanceId
          ? { ...inst, roles: inst.roles.map((r) => (r.role === role ? { ...r, rotationDeg } : r)) }
          : inst,
      ),
    })),

  setRoleColor: (instanceId, role, key, value) =>
    set((state) => ({
      ...pushHistory(state),
      instances: state.instances.map((inst) =>
        inst.instanceId === instanceId
          ? { ...inst, roles: inst.roles.map((r) => (r.role === role ? { ...r, [key]: value } : r)) }
          : inst,
      ),
    })),

  setRoleLabelTextOverride: (instanceId, value) =>
    set((state) => ({
      ...pushHistory(state),
      instances: state.instances.map((inst) =>
        inst.instanceId === instanceId
          ? {
              ...inst,
              roles: inst.roles.map((r) =>
                r.role === 'name' ? { ...r, labelTextOverride: value || null } : r,
              ),
            }
          : inst,
      ),
    })),

  centerRoles: (instanceId) =>
    set((state) => ({
      ...pushHistory(state),
      instances: state.instances.map((inst) =>
        inst.instanceId === instanceId
          ? { ...inst, roles: getComponentType(inst.componentTypeId).centerRoles(inst.roles) }
          : inst,
      ),
    })),

  beginGroupDrag: (instanceIds, pipePoints = []) =>
    set((state) => {
      const origins: Record<string, Point> = {}
      for (const inst of state.instances) {
        if (instanceIds.includes(inst.instanceId)) {
          origins[inst.instanceId] = { x: inst.transform.x, y: inst.transform.y }
        }
      }

      // Free (unattached) pipe points to carry along: the explicit
      // `pipePoints` list (knots caught alongside instances in a box-select
      // — "marked like elements", see companionPipePoints in SvgCanvas) plus
      // every free end/waypoint of any pipe that is ITSELF part of the
      // current selection (a pipe can now be a group member in its own
      // right, not just an instance's companion knot) — a selected pipe's
      // attached ends already track their component live and need no help,
      // only its free ones do. Deduped so a knot named in both sources is
      // only captured once.
      const pipePointOrigins: { pipeId: string; point: 'from' | 'to' | number; origin: Point }[] = []
      const capturedPipeRefs = new Set<string>()
      const capturePipeRef = (pipeId: string, point: 'from' | 'to' | number) => {
        const key = `${pipeId}:${point}`
        if (capturedPipeRefs.has(key)) return
        capturedPipeRefs.add(key)
        const pipe = state.pipes.find((p) => p.instanceId === pipeId)
        if (!pipe) return
        const origin =
          point === 'from'
            ? (!isPortRef(pipe.fromPort) ? pipe.fromPort : null)
            : point === 'to'
              ? (!isPortRef(pipe.toPort) ? pipe.toPort : null)
              : (pipe.waypoints[point] ?? null)
        if (origin) pipePointOrigins.push({ pipeId, point, origin: { x: origin.x, y: origin.y } })
      }
      for (const ref of pipePoints) capturePipeRef(ref.pipeId, ref.point)
      for (const pipeId of state.selectedPipeIds) {
        const pipe = state.pipes.find((p) => p.instanceId === pipeId)
        if (!pipe) continue
        if (!isPortRef(pipe.fromPort)) capturePipeRef(pipeId, 'from')
        if (!isPortRef(pipe.toPort)) capturePipeRef(pipeId, 'to')
        pipe.waypoints.forEach((_, idx) => capturePipeRef(pipeId, idx))
      }

      // Selected shapes move as a rigid translation of their whole points
      // array — skipping any on a locked layer, same rule as everywhere
      // else a locked layer's shapes are immovable.
      const shapeOrigins: Record<string, Point[]> = {}
      for (const shape of state.freeShapes) {
        if (!state.selectedShapeIds.includes(shape.instanceId)) continue
        const shapeLayer = state.layers.find((l) => l.layerId === (shape.layerId || 'default'))
        if (shapeLayer?.locked) continue
        shapeOrigins[shape.instanceId] = shape.points.map((p) => ({ x: p.x, y: p.y }))
      }

      // Selected leader lines: every waypoint, plus `from`/`to` only when
      // each is a bare point — a role- or border-anchored endpoint already
      // tracks its target live (label, shape, or pipe), same reasoning as an
      // attached pipe port above, so it's never delta-moved here.
      const leaderLinePointOrigins: { leaderLineId: string; point: 'from' | 'to' | number; origin: Point }[] = []
      for (const line of state.leaderLines) {
        if (!state.selectedLeaderLineIds.includes(line.instanceId)) continue
        if (!isLeaderLineEndpointRef(line.from) && !isLeaderLineBorderRef(line.from)) {
          leaderLinePointOrigins.push({ leaderLineId: line.instanceId, point: 'from', origin: { x: line.from.x, y: line.from.y } })
        }
        if (!isLeaderLineEndpointRef(line.to) && !isLeaderLineBorderRef(line.to)) {
          leaderLinePointOrigins.push({ leaderLineId: line.instanceId, point: 'to', origin: { x: line.to.x, y: line.to.y } })
        }
        line.waypoints.forEach((wp, idx) => {
          leaderLinePointOrigins.push({ leaderLineId: line.instanceId, point: idx, origin: { x: wp.x, y: wp.y } })
        })
      }

      // Selected (unlocked) image layers move as a rigid x/y translation —
      // same "immovable while locked" rule as everywhere else images are dragged.
      const layerOrigins: Record<string, Point> = {}
      for (const layer of state.layers) {
        if (layer.kind === 'image' && !layer.locked && state.selectedLayerIds.includes(layer.layerId)) {
          layerOrigins[layer.layerId] = { x: layer.x, y: layer.y }
        }
      }

      return {
        ...pushHistory(state),
        groupDragOrigins: origins,
        groupDragPipePoints: pipePointOrigins,
        groupDragShapeOrigins: Object.keys(shapeOrigins).length > 0 ? shapeOrigins : null,
        groupDragLeaderLinePoints: leaderLinePointOrigins,
        groupDragLayerOrigins: Object.keys(layerOrigins).length > 0 ? layerOrigins : null,
      }
    }),

  applyGroupDrag: (delta) =>
    set((state) => {
      if (!state.groupDragOrigins) return {}
      const origins = state.groupDragOrigins
      const pipePointOrigins = state.groupDragPipePoints
      const pipes =
        pipePointOrigins && pipePointOrigins.length > 0
          ? state.pipes.map((pipe) => {
              const refs = pipePointOrigins.filter((r) => r.pipeId === pipe.instanceId)
              if (refs.length === 0) return pipe
              let next = pipe
              for (const ref of refs) {
                const pos = { x: ref.origin.x + delta.x, y: ref.origin.y + delta.y }
                if (ref.point === 'from') {
                  if (!isPortRef(next.fromPort)) next = { ...next, fromPort: pos }
                } else if (ref.point === 'to') {
                  if (!isPortRef(next.toPort)) next = { ...next, toPort: pos }
                } else {
                  next = {
                    ...next,
                    waypoints: next.waypoints.map((wp, i) => (i === ref.point ? { ...wp, x: pos.x, y: pos.y } : wp)),
                  }
                }
              }
              return next
            })
          : state.pipes

      const shapeOrigins = state.groupDragShapeOrigins
      const freeShapes = shapeOrigins
        ? state.freeShapes.map((shape) => {
            const shapeOrigin = shapeOrigins[shape.instanceId]
            if (!shapeOrigin) return shape
            return { ...shape, points: shapeOrigin.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y })) }
          })
        : state.freeShapes

      const leaderLinePointOrigins = state.groupDragLeaderLinePoints
      const leaderLines =
        leaderLinePointOrigins && leaderLinePointOrigins.length > 0
          ? state.leaderLines.map((line) => {
              const refs = leaderLinePointOrigins.filter((r) => r.leaderLineId === line.instanceId)
              if (refs.length === 0) return line
              let next = line
              for (const ref of refs) {
                const pos = { x: ref.origin.x + delta.x, y: ref.origin.y + delta.y }
                if (ref.point === 'from') next = { ...next, from: pos }
                else if (ref.point === 'to') next = { ...next, to: pos }
                else next = { ...next, waypoints: next.waypoints.map((wp, i) => (i === ref.point ? pos : wp)) }
              }
              return next
            })
          : state.leaderLines

      const layerOrigins = state.groupDragLayerOrigins
      const layers = layerOrigins
        ? state.layers.map((l) => {
            const origin = layerOrigins[l.layerId]
            if (!origin || l.kind !== 'image') return l
            return { ...l, x: origin.x + delta.x, y: origin.y + delta.y }
          })
        : state.layers

      return {
        pipes,
        freeShapes,
        leaderLines,
        layers,
        instances: state.instances.map((inst) => {
          const origin = origins[inst.instanceId]
          if (!origin) return inst
          return { ...inst, transform: { ...inst.transform, x: origin.x + delta.x, y: origin.y + delta.y } }
        }),
      }
    }),

  endGroupDrag: () =>
    set({
      groupDragOrigins: null,
      groupDragPipePoints: null,
      groupDragShapeOrigins: null,
      groupDragLeaderLinePoints: null,
      groupDragLayerOrigins: null,
    }),

  selectInstances: (instanceIds) =>
    set({
      selectedInstanceIds: instanceIds,
      selectedRole: null,
      selectedPipeIds: instanceIds.length > 0 ? [] : get().selectedPipeIds,
      selectedWaypoint: null,
      selectedEndpoint: null,
      selectedShapeIds: instanceIds.length > 0 ? [] : get().selectedShapeIds,
      selectedLayerIds: instanceIds.length > 0 ? [] : get().selectedLayerIds,
      selectedLeaderLineIds: instanceIds.length > 0 ? [] : get().selectedLeaderLineIds,
      selectedLeaderLinePoint: instanceIds.length > 0 ? null : get().selectedLeaderLinePoint,
      selectedGroupId: null,
      tagRenameError: null,
    }),

  selectAll: () =>
    set((state) => ({
      selectedInstanceIds: state.instances.map((inst) => inst.instanceId),
      selectedRole: null,
      selectedPipeIds: state.pipes.map((p) => p.instanceId),
      selectedWaypoint: null,
      selectedEndpoint: null,
      selectedShapeIds: state.freeShapes.map((s) => s.instanceId),
      selectedLayerIds: state.layers.filter((l) => l.kind === 'image' && !l.locked).map((l) => l.layerId),
      selectedLeaderLineIds: state.leaderLines.map((l) => l.instanceId),
      selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
      selectedGroupId: null,
      tagRenameError: null,
    })),

  selectRole: (selection) => set({ selectedRole: selection }),

  nudgeSelection: (direction, fine) =>
    set((state) => {
      if (state.selectedConnectionPoint) {
        const { ownerKind, ownerId, pointId } = state.selectedConnectionPoint
        const step = fine ? CONNECTION_POINT_NUDGE_STEP_FAST : CONNECTION_POINT_NUDGE_STEP
        const worldDelta = { x: direction.x * step, y: direction.y * step }
        if (ownerKind === 'layer') {
          const layer = state.layers.find((l) => l.layerId === ownerId)
          if (!layer || layer.kind !== 'image' || layer.width <= 0 || layer.height <= 0) return {}
          const cp = layer.connectionPoints.find((p) => p.pointId === pointId)
          if (!cp) return {}
          const relX = Math.max(0, Math.min(1, cp.relX + worldDelta.x / layer.width))
          const relY = Math.max(0, Math.min(1, cp.relY + worldDelta.y / layer.height))
          return {
            ...pushHistory(state),
            layers: state.layers.map((l) =>
              l.layerId === ownerId && l.kind === 'image'
                ? { ...l, connectionPoints: l.connectionPoints.map((p) => (p.pointId === pointId ? { ...p, relX, relY } : p)) }
                : l,
            ),
          }
        }
        if (ownerKind === 'shape') {
          const shape = state.freeShapes.find((s) => s.instanceId === ownerId)
          if (!shape) return {}
          const { minX, minY, maxX, maxY } = boundsOfPoints(shape.points)
          const width = maxX - minX
          const height = maxY - minY
          if (width <= 0 || height <= 0) return {}
          const cp = (shape.connectionPoints ?? []).find((p) => p.pointId === pointId)
          if (!cp) return {}
          const relX = Math.max(0, Math.min(1, cp.relX + worldDelta.x / width))
          const relY = Math.max(0, Math.min(1, cp.relY + worldDelta.y / height))
          return {
            ...pushHistory(state),
            freeShapes: state.freeShapes.map((s) =>
              s.instanceId === ownerId
                ? {
                    ...s,
                    connectionPoints: (s.connectionPoints ?? []).map((p) => (p.pointId === pointId ? { ...p, relX, relY } : p)),
                  }
                : s,
            ),
          }
        }
        const instance = state.instances.find((i) => i.instanceId === ownerId)
        if (!instance) return {}
        const def = getComponentType(instance.componentTypeId)
        const corners = resolveLocalBodyCorners(def, instance)
        if (corners.length === 0) return {}
        const iMinX = Math.min(...corners.map((c) => c.x))
        const iMaxX = Math.max(...corners.map((c) => c.x))
        const iMinY = Math.min(...corners.map((c) => c.y))
        const iMaxY = Math.max(...corners.map((c) => c.y))
        const width = iMaxX - iMinX
        const height = iMaxY - iMinY
        if (width <= 0 || height <= 0) return {}
        const cp = (instance.connectionPoints ?? []).find((p) => p.pointId === pointId)
        if (!cp) return {}
        // The instance's own body can be rotated, unlike a shape's/layer's —
        // rotate the world nudge delta into the instance's local space first
        // (same technique as the role nudge below) so arrow keys still move
        // the point in the screen direction pressed, not the instance's own
        // unrotated axes.
        const localDelta = rotatePoint(worldDelta, -instance.transform.rotationDeg)
        const relX = Math.max(0, Math.min(1, cp.relX + localDelta.x / width))
        const relY = Math.max(0, Math.min(1, cp.relY + localDelta.y / height))
        return {
          ...pushHistory(state),
          instances: state.instances.map((i) =>
            i.instanceId === ownerId
              ? {
                  ...i,
                  connectionPoints: (i.connectionPoints ?? []).map((p) => (p.pointId === pointId ? { ...p, relX, relY } : p)),
                }
              : i,
          ),
        }
      }

      if (state.selectedWaypoint) {
        const { pipeId, index } = state.selectedWaypoint
        const step = fine ? WAYPOINT_NUDGE_STEP_FAST : WAYPOINT_NUDGE_STEP
        const delta = { x: direction.x * step, y: direction.y * step }
        return {
          ...pushHistory(state),
          pipes: state.pipes.map((pipe) => {
            if (pipe.instanceId !== pipeId) return pipe
            return {
              ...pipe,
              waypoints: pipe.waypoints.map((w, i) =>
                i === index ? { ...w, x: w.x + delta.x, y: w.y + delta.y } : w,
              ),
            }
          }),
        }
      }

      if (state.selectedRole) {
        const { instanceId, role } = state.selectedRole
        const step = fine ? ROLE_NUDGE_STEP_FAST : ROLE_NUDGE_STEP
        const worldDelta = { x: direction.x * step, y: direction.y * step }
        return {
          ...pushHistory(state),
          instances: state.instances.map((inst) => {
            if (inst.instanceId !== instanceId) return inst
            const localDelta = rotatePoint(worldDelta, -inst.transform.rotationDeg)
            return {
              ...inst,
              roles: inst.roles.map((r) =>
                r.role === role
                  ? {
                      ...r,
                      offset: { x: r.offset.x + localDelta.x, y: r.offset.y + localDelta.y },
                      manuallyPositioned: true,
                    }
                  : r,
              ),
            }
          }),
        }
      }

      // Everything currently selected across all five kinds moves together
      // by the same delta — mirrors beginGroupDrag/applyGroupDrag (the mouse
      // group-drag path) exactly, so arrow-key nudging never leaves part of
      // a mixed selection (e.g. pipes/images alongside instances) behind.
      const totalSelected =
        state.selectedInstanceIds.length +
        state.selectedPipeIds.length +
        state.selectedShapeIds.length +
        state.selectedLeaderLineIds.length +
        state.selectedLayerIds.length
      if (totalSelected > 0) {
        const step = fine ? INSTANCE_NUDGE_STEP_FAST : INSTANCE_NUDGE_STEP
        const delta = { x: direction.x * step, y: direction.y * step }
        const shiftFreePoint = <T extends Point>(p: T) => ({ ...p, x: p.x + delta.x, y: p.y + delta.y })

        return {
          ...pushHistory(state),
          instances: state.instances.map((inst) =>
            state.selectedInstanceIds.includes(inst.instanceId)
              ? { ...inst, transform: { ...inst.transform, x: inst.transform.x + delta.x, y: inst.transform.y + delta.y } }
              : inst,
          ),
          pipes: state.pipes.map((pipe) =>
            state.selectedPipeIds.includes(pipe.instanceId)
              ? {
                  ...pipe,
                  fromPort: isPortRef(pipe.fromPort) ? pipe.fromPort : shiftFreePoint(pipe.fromPort),
                  toPort: isPortRef(pipe.toPort) ? pipe.toPort : shiftFreePoint(pipe.toPort),
                  waypoints: pipe.waypoints.map(shiftFreePoint),
                }
              : pipe,
          ),
          freeShapes: state.freeShapes.map((shape) => {
            if (!state.selectedShapeIds.includes(shape.instanceId)) return shape
            const shapeLayer = state.layers.find((l) => l.layerId === (shape.layerId || 'default'))
            if (shapeLayer?.locked) return shape
            return { ...shape, points: shape.points.map(shiftFreePoint) }
          }),
          leaderLines: state.leaderLines.map((line) =>
            state.selectedLeaderLineIds.includes(line.instanceId)
              ? {
                  ...line,
                  from:
                    isLeaderLineEndpointRef(line.from) || isLeaderLineBorderRef(line.from)
                      ? line.from
                      : shiftFreePoint(line.from),
                  to:
                    isLeaderLineEndpointRef(line.to) || isLeaderLineBorderRef(line.to)
                      ? line.to
                      : shiftFreePoint(line.to),
                  waypoints: line.waypoints.map(shiftFreePoint),
                }
              : line,
          ),
          layers: state.layers.map((l) =>
            l.kind === 'image' && !l.locked && state.selectedLayerIds.includes(l.layerId)
              ? { ...l, x: l.x + delta.x, y: l.y + delta.y }
              : l,
          ),
        }
      }

      return {}
    }),

  setTool: (tool, componentTypeId = null) =>
    set((state) => ({
      tool,
      placingType: tool === 'place' ? componentTypeId : null,
      drawingShapeKind: tool === 'draw-shape' ? (componentTypeId as FreeShapeKind | null) : null,
      connectionPointTargetLayerId: tool === 'place-connection-point' ? componentTypeId : null,
      connectionPointTargetShapeId: tool === 'place-connection-point-shape' ? componentTypeId : null,
      connectionPointTargetInstanceId: tool === 'place-connection-point-instance' ? componentTypeId : null,
      pickTransparentColorTargetLayerId: tool === 'pick-transparent-color' ? componentTypeId : null,
      // Switching tools deselects any selected image layers — except arming
      // the connection-point/transparent-color-pick tool from that same
      // (single) selected layer's own panel button, which isn't "another
      // tool" from the user's perspective, just a mode of editing it.
      selectedLayerIds:
        (tool === 'place-connection-point' || tool === 'pick-transparent-color') &&
        state.selectedLayerIds.length === 1 &&
        componentTypeId === state.selectedLayerIds[0]
          ? state.selectedLayerIds
          : [],
    })),

  cancelTool: () =>
    set({
      tool: 'select',
      placingType: null,
      drawingShapeKind: null,
      connectionPointTargetLayerId: null,
      connectionPointTargetShapeId: null,
      connectionPointTargetInstanceId: null,
      pickTransparentColorTargetLayerId: null,
    }),

  // Picking a concrete size implies wanting to see it — also turns the grid
  // back on if "0x" (hidden) was active.
  setGridSize: (size) => set({ gridSize: size, gridVisible: true }),
  setGridVisible: (visible) => set({ gridVisible: visible }),

  checkpointHistory: () => set((state) => pushHistory(state)),

  undo: () =>
    set((state) => {
      if (state.past.length === 0) return {}
      const previous = state.past[state.past.length - 1]
      return {
        past: state.past.slice(0, -1),
        future: [snapshotOf(state), ...state.future],
        instances: previous.instances,
        pipes: previous.pipes,
        freeShapes: previous.freeShapes,
        layers: previous.layers,
        leaderLines: previous.leaderLines,
        groups: previous.groups,
        // Old selections may point at instances/pipes/shapes that no longer
        // exist (or exist again) after rewinding — simplest correct behavior
        // is to just clear them rather than try to reconcile. Same reasoning
        // for selectedGroupId: a rewound group's membership may no longer
        // match what the four arrays would need to be.
        selectedInstanceIds: [],
        selectedRole: null,
        selectedPipeIds: [],
        selectedWaypoint: null,
        selectedShapeIds: [],
        selectedLayerIds: [],
        selectedLeaderLineIds: [],
        selectedGroupId: null,
        tagRenameError: null,
      }
    }),

  redo: () =>
    set((state) => {
      if (state.future.length === 0) return {}
      const next = state.future[0]
      return {
        future: state.future.slice(1),
        past: [...state.past, snapshotOf(state)],
        instances: next.instances,
        pipes: next.pipes,
        freeShapes: next.freeShapes,
        layers: next.layers,
        leaderLines: next.leaderLines,
        groups: next.groups,
        selectedInstanceIds: [],
        selectedRole: null,
        selectedPipeIds: [],
        selectedWaypoint: null,
        selectedShapeIds: [],
        selectedLayerIds: [],
        selectedLeaderLineIds: [],
        selectedGroupId: null,
        tagRenameError: null,
      }
    }),

  addPipe: (fromPort, toPort, waypoints, keepDrawing = false) =>
    set((state) => {
      const pipe: PipeInstance = {
        instanceId: crypto.randomUUID(),
        tag: nextPipeTag(),
        fromPort,
        toPort,
        routingMode: 'straight',
        waypoints,
        indicatorEnabled: true,
        nameEnabled: false,
        strokeColor: null,
        volumeTag: null,
        hopOverrides: {},
        arrows: [],
      }
      const { pipes: mergedPipes, resolveId } = mergeFreeEndChains([...state.pipes, pipe])
      return {
        ...pushHistory(state),
        pipes: recomputeVolumeTags(mergedPipes),
        selectedPipeIds: [resolveId(pipe.instanceId)],
        selectedInstanceIds: [],
        selectedRole: null,
        selectedWaypoint: null,
        tagRenameError: null,
        tool: keepDrawing ? state.tool : 'select',
        placingType: keepDrawing ? state.placingType : null,
      }
    }),

  deletePipes: (pipeIds) =>
    set((state) => {
      const removed = new Set(pipeIds)
      const groups = stripDeletedGroupMembers(state.groups, { pipe: removed })
      return {
        ...pushHistory(state),
        // A surviving pipe branched onto one of these via a "pt:{index}"
        // PortRef would otherwise silently stop resolving (getPipePoints
        // returns null the moment its target pipe is gone) — freeze it at
        // its last position first, same "leave a knot" contract as deleting
        // a component a pipe was attached to.
        pipes: recomputeVolumeTags(
          detachPipesFromPipes(state.pipes, state.instances, state.layers, removed, state.freeShapes).filter(
            (p) => !pipeIds.includes(p.instanceId),
          ),
        ),
        // A leader line anchored to one of these pipes' borders (see
        // LeaderLineBorderRef) would otherwise silently stop resolving —
        // freeze it at its last position instead, same "leave a knot"
        // contract used everywhere else an anchor's target disappears.
        leaderLines: detachLeaderLineEndpoints(state.leaderLines, state.instances, state.pipes, state.freeShapes, state.layers, {
          pipeIds: removed,
        }),
        selectedPipeIds: state.selectedPipeIds.filter((id) => !pipeIds.includes(id)),
        selectedWaypoint:
          state.selectedWaypoint && pipeIds.includes(state.selectedWaypoint.pipeId)
            ? null
            : state.selectedWaypoint,
        groups,
        selectedGroupId: clearSelectedGroupIfGone(groups, state.selectedGroupId),
      }
    }),

  renamePipeTag: (pipeId, newTag) =>
    set((state) => {
      const trimmed = newTag.trim()
      if (!TAG_PATTERN.test(trimmed)) {
        return { tagRenameError: 'Tag must start with a letter (e.g. L1).' }
      }
      const conflict =
        state.pipes.some((p) => p.tag === trimmed && p.instanceId !== pipeId) ||
        state.instances.some((inst) => inst.tag === trimmed)
      if (conflict) {
        return { tagRenameError: `Tag "${trimmed}" is already in use.` }
      }
      return {
        ...pushHistory(state),
        tagRenameError: null,
        pipes: state.pipes.map((p) => (p.instanceId === pipeId ? { ...p, tag: trimmed } : p)),
      }
    }),

  /** Renames the *volume* tag shared by every pipe currently grouped with pipeId's — not that one pipe's own tag. */
  renameVolumeTag: (pipeId, newTag) =>
    set((state) => {
      const trimmed = newTag.trim()
      if (!TAG_PATTERN.test(trimmed)) {
        return { tagRenameError: 'Tag must start with a letter (e.g. LV1).' }
      }
      const pipe = state.pipes.find((p) => p.instanceId === pipeId)
      if (!pipe) return {}
      const oldTag = pipe.volumeTag
      if (trimmed === oldTag) return { tagRenameError: null }
      const conflict =
        state.instances.some((inst) => inst.tag === trimmed) ||
        state.pipes.some((p) => p.tag === trimmed) ||
        state.pipes.some((p) => p.volumeTag === trimmed && p.volumeTag !== oldTag)
      if (conflict) {
        return { tagRenameError: `Tag "${trimmed}" is already in use.` }
      }
      return {
        ...pushHistory(state),
        tagRenameError: null,
        pipes: state.pipes.map((p) => (p.volumeTag === oldTag ? { ...p, volumeTag: trimmed } : p)),
      }
    }),

  // These three fan out to every pipe sharing this one's volumeTag — a
  // connected run's indicator/name/color are one shared thing (see
  // expandToVolumeSiblings), not a per-segment setting.
  setPipeIndicatorEnabled: (pipeId, enabled) =>
    set((state) => {
      const ids = expandToVolumeSiblings(state.pipes, new Set([pipeId]))
      return {
        ...pushHistory(state),
        pipes: state.pipes.map((p) => (ids.has(p.instanceId) ? { ...p, indicatorEnabled: enabled } : p)),
      }
    }),

  setPipeNameEnabled: (pipeId, enabled) =>
    set((state) => {
      const ids = expandToVolumeSiblings(state.pipes, new Set([pipeId]))
      return {
        ...pushHistory(state),
        pipes: state.pipes.map((p) => (ids.has(p.instanceId) ? { ...p, nameEnabled: enabled } : p)),
      }
    }),

  setPipeColor: (pipeId, color) =>
    set((state) => {
      const ids = expandToVolumeSiblings(state.pipes, new Set([pipeId]))
      return {
        ...pushHistory(state),
        pipes: state.pipes.map((p) => (ids.has(p.instanceId) ? { ...p, strokeColor: color } : p)),
      }
    }),

  setPipeRoutingMode: (pipeId, mode) =>
    set((state) => ({
      ...pushHistory(state),
      pipes: state.pipes.map((p) => (p.instanceId === pipeId ? { ...p, routingMode: mode } : p)),
    })),

  movePipeWaypoint: (pipeId, waypointIndex, pt) =>
    set((state) => ({
      pipes: state.pipes.map((p) =>
        p.instanceId === pipeId
          ? {
              ...p,
              waypoints: p.waypoints.map((w, i) => (i === waypointIndex ? { ...w, x: pt.x, y: pt.y } : w)),
            }
          : p,
      ),
    })),

  // Inserting/deleting a waypoint shifts the index of every later point in
  // this pipe's own point list (getPipePoints: [fromPos, ...waypoints,
  // toPos]) — any other pipe branched onto one of those points via a
  // "pt:{index}" PortRef, or any leader line anchored onto this pipe's
  // border, must be renumbered/re-anchored in the same action or it ends up
  // silently naming a different physical point (see shiftPipePointRefsFor*
  // / shiftLeaderLinePipeAnchorsForPipeChange for why each uses a different
  // fix-up strategy).
  insertPipeWaypoint: (pipeId, index, pt) =>
    set((state) => {
      const pipe = state.pipes.find((p) => p.instanceId === pipeId)
      if (!pipe) return {}
      const insertedPointIndex = index + 1 // waypoint-array index -> full-point-list index (fromPos is always point 0)
      const oldPoints = getPipePoints(pipe, state.instances, state.pipes, state.layers, state.freeShapes)
      const pipes = shiftPipePointRefsForInsert(state.pipes, pipeId, insertedPointIndex).map((p) =>
        p.instanceId === pipeId
          ? {
              ...p,
              waypoints: [
                ...p.waypoints.slice(0, index),
                { x: pt.x, y: pt.y, kind: 'corner' as const },
                ...p.waypoints.slice(index),
              ],
              // Same renumbering as shiftPipePointRefsForInsert, just applied
              // to this pipe's own arrow markers instead of scanning other
              // pipes' PortRefs.
              arrows: (p.arrows ?? []).map((a) =>
                a.pointIndex >= insertedPointIndex ? { ...a, pointIndex: a.pointIndex + 1 } : a,
              ),
              cornerOverrides: shiftCornerOverridesForInsert(p.cornerOverrides, insertedPointIndex),
            }
          : p,
      )
      const newPipe = pipes.find((p) => p.instanceId === pipeId)!
      const newPoints = getPipePoints(newPipe, state.instances, pipes, state.layers, state.freeShapes)
      const leaderLines =
        oldPoints && newPoints
          ? shiftLeaderLinePipeAnchorsForPipeChange(state.leaderLines, pipeId, oldPoints, newPoints)
          : state.leaderLines
      return {
        ...pushHistory(state),
        pipes,
        leaderLines,
        selectedPipeIds: [pipeId],
        selectedInstanceIds: [],
        selectedRole: null,
        selectedShapeIds: [],
        selectedLayerIds: [],
        selectedWaypoint: { pipeId, index },
        selectedEndpoint: null,
        tagRenameError: null,
        routeError: null,
      }
    }),

  deletePipeWaypoint: (pipeId, index) =>
    set((state) => {
      const pipe = state.pipes.find((p) => p.instanceId === pipeId)
      if (!pipe) return {}
      const removedPointIndex = index + 1
      const oldPoints = getPipePoints(pipe, state.instances, state.pipes, state.layers, state.freeShapes)
      const pipes = shiftPipePointRefsForDelete(state.pipes, state.instances, state.layers, pipeId, removedPointIndex).map(
        (p) =>
          p.instanceId === pipeId
            ? {
                ...p,
                waypoints: p.waypoints.filter((_, i) => i !== index),
                // Same reasoning as insertPipeWaypoint above: an arrow
                // exactly on the removed point is dropped, later ones
                // shift down to keep naming the same physical point.
                arrows: (p.arrows ?? [])
                  .filter((a) => a.pointIndex !== removedPointIndex)
                  .map((a) => (a.pointIndex > removedPointIndex ? { ...a, pointIndex: a.pointIndex - 1 } : a)),
                cornerOverrides: shiftCornerOverridesForDelete(p.cornerOverrides, removedPointIndex),
              }
            : p,
      )
      const newPipe = pipes.find((p) => p.instanceId === pipeId)!
      const newPoints = getPipePoints(newPipe, state.instances, pipes, state.layers, state.freeShapes)
      const leaderLines =
        oldPoints && newPoints
          ? shiftLeaderLinePipeAnchorsForPipeChange(state.leaderLines, pipeId, oldPoints, newPoints)
          : state.leaderLines
      return {
        ...pushHistory(state),
        pipes,
        leaderLines,
        selectedWaypoint: null,
        selectedEndpoint: null,
      }
    }),

  movePipeEndpoint: (pipeId, side, ref) =>
    set((state) => ({
      pipes: state.pipes.map((p) =>
        p.instanceId === pipeId ? { ...p, [side === 'from' ? 'fromPort' : 'toPort']: ref } : p,
      ),
    })),

  finalizePipeEndpointDrag: (pipeId) =>
    set((state) => {
      if (!state.pipes.some((p) => p.instanceId === pipeId)) return {}
      return { pipes: recomputeVolumeTags(state.pipes) }
    }),

  setHopOverride: (pipeId, otherPipeId, crossingIdValue, winner) =>
    set((state) => ({
      ...pushHistory(state),
      pipes: state.pipes.map((p) => {
        if (p.instanceId === pipeId) {
          const hopOverrides = { ...p.hopOverrides }
          if (winner === null) delete hopOverrides[crossingIdValue]
          else hopOverrides[crossingIdValue] = winner
          return { ...p, hopOverrides }
        }
        if (p.instanceId === otherPipeId) {
          const hopOverrides = { ...p.hopOverrides }
          if (winner === null) delete hopOverrides[crossingIdValue]
          else hopOverrides[crossingIdValue] = winner === 'self' ? 'other' : 'self'
          return { ...p, hopOverrides }
        }
        return p
      }),
    })),

  setPipeCornerOverride: (pipeId, segmentIndex, mode) =>
    set((state) => ({
      ...pushHistory(state),
      pipes: state.pipes.map((p) =>
        p.instanceId === pipeId
          ? { ...p, cornerOverrides: { ...(p.cornerOverrides ?? {}), [String(segmentIndex)]: mode } }
          : p,
      ),
    })),

  autoRoutePipe: (pipeId) =>
    set((state) => {
      const pipe = state.pipes.find((p) => p.instanceId === pipeId)
      if (!pipe) return {}
      const ignoreInstanceIds = new Set<string>()
      if (isPortRef(pipe.fromPort)) ignoreInstanceIds.add(pipe.fromPort.instanceId)
      if (isPortRef(pipe.toPort)) ignoreInstanceIds.add(pipe.toPort.instanceId)

      const waypoints = computeAutoRoute(pipe, state.instances, state.pipes, state.layers, state.freeShapes, {
        cellSize: state.gridSize,
        ignoreInstanceIds,
      })
      if (!waypoints) {
        return { routeError: 'No obstacle-free path found — try moving components apart or route manually.' }
      }
      return {
        ...pushHistory(state),
        routeError: null,
        pipes: state.pipes.map((p) => (p.instanceId === pipeId ? { ...p, waypoints, routingMode: 'orthogonal' } : p)),
      }
    }),

  selectPipes: (pipeIds) =>
    set({
      selectedPipeIds: pipeIds,
      selectedInstanceIds: pipeIds.length > 0 ? [] : get().selectedInstanceIds,
      selectedRole: null,
      selectedWaypoint: null,
      selectedEndpoint: null,
      selectedShapeIds: pipeIds.length > 0 ? [] : get().selectedShapeIds,
      selectedLayerIds: pipeIds.length > 0 ? [] : get().selectedLayerIds,
      selectedLeaderLineIds: pipeIds.length > 0 ? [] : get().selectedLeaderLineIds,
      selectedLeaderLinePoint: pipeIds.length > 0 ? null : get().selectedLeaderLinePoint,
      selectedGroupId: null,
      tagRenameError: null,
      routeError: null,
    }),

  selectWaypoint: (selection) => set({ selectedWaypoint: selection }),

  selectEndpoint: (selection) => set({ selectedEndpoint: selection }),

  setPipeArrow: (pipeId, pointIndex, arrow) =>
    set((state) => ({
      ...pushHistory(state),
      pipes: state.pipes.map((p) => {
        if (p.instanceId !== pipeId) return p
        const arrows = (p.arrows ?? []).filter((a) => a.pointIndex !== pointIndex)
        if (arrow) arrows.push({ pointIndex, size: arrow.size, rotationDeg: arrow.rotationDeg })
        return { ...p, arrows }
      }),
    })),

  addFreeShape: (kind, points, keepDrawing = false) =>
    set((state) => {
      const shape: FreeShape = {
        instanceId: crypto.randomUUID(),
        kind,
        layerId: 'default',
        points,
        style: { ...DEFAULT_SHAPE_STYLE },
        ...(kind === 'text' ? { text: 'Text', fontSize: DEFAULT_FONT_SIZE } : {}),
      }
      return {
        ...pushHistory(state),
        freeShapes: [...state.freeShapes, shape],
        selectedShapeIds: [shape.instanceId],
        selectedInstanceIds: [],
        selectedPipeIds: [],
        selectedRole: null,
        selectedWaypoint: null,
        tagRenameError: null,
        tool: keepDrawing ? state.tool : 'select',
        drawingShapeKind: keepDrawing ? state.drawingShapeKind : null,
      }
    }),

  deleteShapes: (shapeIds) =>
    set((state) => {
      const removed = new Set(shapeIds)
      const groups = stripDeletedGroupMembers(state.groups, { shape: removed })
      return {
        ...pushHistory(state),
        freeShapes: state.freeShapes.filter((s) => !shapeIds.includes(s.instanceId)),
        // Same "leave a knot instead of dangling" contract as deletePipes above — now also for any pipe attached to one of these shapes' connection points.
        pipes: recomputeVolumeTags(
          detachPipesFromConnectionPointOwners(
            state.pipes,
            state.instances,
            state.layers,
            state.freeShapes,
            new Set(),
            removed,
          ),
        ),
        leaderLines: detachLeaderLineEndpoints(state.leaderLines, state.instances, state.pipes, state.freeShapes, state.layers, {
          shapeIds: removed,
        }),
        selectedShapeIds: state.selectedShapeIds.filter((id) => !shapeIds.includes(id)),
        groups,
        selectedGroupId: clearSelectedGroupIfGone(groups, state.selectedGroupId),
      }
    }),

  moveShape: (shapeId, points) =>
    set((state) => ({
      freeShapes: state.freeShapes.map((s) => (s.instanceId === shapeId ? { ...s, points } : s)),
    })),

  resizeShape: (shapeId, width, height) =>
    set((state) => {
      const shape = state.freeShapes.find((s) => s.instanceId === shapeId)
      if (!shape) return {}
      const { minX, minY, maxX, maxY } = boundsOfPoints(shape.points)
      const oldWidth = maxX - minX
      const oldHeight = maxY - minY
      if (oldWidth <= 0 || oldHeight <= 0) return {}
      const scaleX = Math.max(1, width) / oldWidth
      const scaleY = Math.max(1, height) / oldHeight
      return {
        ...pushHistory(state),
        freeShapes: state.freeShapes.map((s) =>
          s.instanceId === shapeId
            ? { ...s, points: s.points.map((p) => ({ x: minX + (p.x - minX) * scaleX, y: minY + (p.y - minY) * scaleY })) }
            : s,
        ),
      }
    }),

  setShapeStyle: (shapeId, style) =>
    set((state) => ({
      ...pushHistory(state),
      freeShapes: state.freeShapes.map((s) =>
        s.instanceId === shapeId ? { ...s, style: { ...s.style, ...style } } : s,
      ),
    })),

  setShapeText: (shapeId, text) =>
    set((state) => ({
      ...pushHistory(state),
      freeShapes: state.freeShapes.map((s) => (s.instanceId === shapeId ? { ...s, text } : s)),
    })),

  setShapeFontSize: (shapeId, fontSize) =>
    set((state) => ({
      ...pushHistory(state),
      freeShapes: state.freeShapes.map((s) => (s.instanceId === shapeId ? { ...s, fontSize } : s)),
    })),

  setShapeTextAlign: (shapeId, textAlign) =>
    set((state) => ({
      ...pushHistory(state),
      freeShapes: state.freeShapes.map((s) => (s.instanceId === shapeId ? { ...s, textAlign } : s)),
    })),

  setShapeRotation: (shapeId, rotationDeg) =>
    set((state) => ({
      ...pushHistory(state),
      freeShapes: state.freeShapes.map((s) => (s.instanceId === shapeId ? { ...s, rotationDeg } : s)),
    })),

  selectShapes: (shapeIds) =>
    set({
      selectedShapeIds: shapeIds,
      selectedInstanceIds: shapeIds.length > 0 ? [] : get().selectedInstanceIds,
      selectedPipeIds: shapeIds.length > 0 ? [] : get().selectedPipeIds,
      selectedRole: null,
      selectedWaypoint: null,
      selectedEndpoint: null,
      selectedLayerIds: shapeIds.length > 0 ? [] : get().selectedLayerIds,
      selectedLeaderLineIds: shapeIds.length > 0 ? [] : get().selectedLeaderLineIds,
      selectedGroupId: null,
      tagRenameError: null,
    }),

  addLeaderLine: (from, waypoints, to) =>
    set((state) => {
      const line: LeaderLine = {
        instanceId: crypto.randomUUID(),
        from,
        waypoints,
        to,
      }
      return {
        ...pushHistory(state),
        leaderLines: [...state.leaderLines, line],
        selectedLeaderLineIds: [line.instanceId],
        selectedInstanceIds: [],
        selectedPipeIds: [],
        selectedShapeIds: [],
        selectedRole: null,
        selectedWaypoint: null,
        selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
        tagRenameError: null,
        tool: 'select',
      }
    }),

  deleteLeaderLines: (leaderLineIds) =>
    set((state) => {
      const groups = stripDeletedGroupMembers(state.groups, { leaderLine: new Set(leaderLineIds) })
      return {
        ...pushHistory(state),
        leaderLines: state.leaderLines.filter((l) => !leaderLineIds.includes(l.instanceId)),
        selectedLeaderLineIds: state.selectedLeaderLineIds.filter((id) => !leaderLineIds.includes(id)),
        selectedLeaderLinePoint:
          state.selectedLeaderLinePoint && leaderLineIds.includes(state.selectedLeaderLinePoint.leaderLineId)
            ? null
            : state.selectedLeaderLinePoint,
        groups,
        selectedGroupId: clearSelectedGroupIfGone(groups, state.selectedGroupId),
      }
    }),

  // Continuous drag, like moveShape/moveInstance — checkpointed once at
  // drag-start via onDragCheckpoint, not on every pointermove.
  moveLeaderLinePoint: (leaderLineId, point, pos) =>
    set((state) => ({
      leaderLines: state.leaderLines.map((l) => {
        if (l.instanceId !== leaderLineId) return l
        if (point === 'to') return { ...l, to: pos }
        // Waypoints are always bare points — SvgCanvas only ever drags a
        // waypoint to a raw world position, never onto a role/border anchor
        // (only `from`/`to` can snap onto those), so this cast is safe.
        const wpPos = pos as Point
        return { ...l, waypoints: l.waypoints.map((wp, i) => (i === point ? wpPos : wp)) }
      }),
    })),

  moveLeaderLineFrom: (leaderLineId, from) =>
    set((state) => ({
      leaderLines: state.leaderLines.map((l) => (l.instanceId === leaderLineId ? { ...l, from } : l)),
    })),

  selectLeaderLines: (leaderLineIds) =>
    set({
      selectedLeaderLineIds: leaderLineIds,
      selectedInstanceIds: leaderLineIds.length > 0 ? [] : get().selectedInstanceIds,
      selectedPipeIds: leaderLineIds.length > 0 ? [] : get().selectedPipeIds,
      selectedShapeIds: leaderLineIds.length > 0 ? [] : get().selectedShapeIds,
      selectedRole: null,
      selectedWaypoint: null,
      selectedEndpoint: null,
      selectedLayerIds: leaderLineIds.length > 0 ? [] : get().selectedLayerIds,
      selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
      selectedGroupId: null,
      tagRenameError: null,
    }),

  selectLeaderLinePoint: (selection) => set({ selectedLeaderLinePoint: selection }),

  selectMixed: (selection) =>
    set({
      selectedInstanceIds: selection.instanceIds,
      selectedPipeIds: selection.pipeIds,
      selectedShapeIds: selection.shapeIds,
      selectedLeaderLineIds: selection.leaderLineIds,
      selectedLayerIds: selection.layerIds,
      selectedRole: null,
      selectedWaypoint: null,
      selectedEndpoint: null,
      selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
      selectedGroupId: null,
      tagRenameError: null,
    }),

  selectGroup: (groupId) =>
    set((state) => {
      const group = state.groups.find((g) => g.groupId === groupId)
      if (!group) return {}
      const byKind = (kind: GroupMemberRef['kind']) => group.members.filter((m) => m.kind === kind).map((m) => m.id)
      return {
        selectedInstanceIds: byKind('instance'),
        selectedPipeIds: byKind('pipe'),
        selectedShapeIds: byKind('shape'),
        selectedLeaderLineIds: byKind('leaderLine'),
        selectedLayerIds: byKind('layer'),
        selectedGroupId: groupId,
        selectedRole: null,
        selectedWaypoint: null,
        selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
        tagRenameError: null,
      }
    }),

  createGroup: () =>
    set((state) => {
      const total =
        state.selectedInstanceIds.length +
        state.selectedPipeIds.length +
        state.selectedShapeIds.length +
        state.selectedLeaderLineIds.length +
        state.selectedLayerIds.length
      if (total < 2) return {}

      const selectedIds: Record<GroupMemberRef['kind'], Set<string>> = {
        instance: new Set(state.selectedInstanceIds),
        pipe: new Set(state.selectedPipeIds),
        shape: new Set(state.selectedShapeIds),
        leaderLine: new Set(state.selectedLeaderLineIds),
        layer: new Set(state.selectedLayerIds),
      }
      // No real nested groups in v1: grouping a selection that already
      // covers an existing whole group merges/flattens that group into the
      // new one instead of nesting — any existing group whose every member
      // is part of the current selection is absorbed (its record dropped;
      // its members are already included via the selection below).
      const absorbedGroupIds = new Set(
        state.groups.filter((g) => g.members.every((m) => selectedIds[m.kind].has(m.id))).map((g) => g.groupId),
      )
      const members: GroupMemberRef[] = [
        ...state.selectedInstanceIds.map((id) => ({ kind: 'instance' as const, id })),
        ...state.selectedPipeIds.map((id) => ({ kind: 'pipe' as const, id })),
        ...state.selectedShapeIds.map((id) => ({ kind: 'shape' as const, id })),
        ...state.selectedLeaderLineIds.map((id) => ({ kind: 'leaderLine' as const, id })),
        ...state.selectedLayerIds.map((id) => ({ kind: 'layer' as const, id })),
      ]
      const group: Group = { groupId: crypto.randomUUID(), members }
      return {
        ...pushHistory(state),
        groups: [...state.groups.filter((g) => !absorbedGroupIds.has(g.groupId)), group],
        selectedGroupId: group.groupId,
      }
    }),

  ungroup: (groupId) =>
    set((state) => ({
      ...pushHistory(state),
      groups: state.groups.filter((g) => g.groupId !== groupId),
      // The four selection arrays are left exactly as they are — ungrouping
      // demotes a group to a loose multi-select, it doesn't clear it.
      selectedGroupId: null,
    })),

  deleteGroup: (groupId) =>
    set((state) => {
      const group = state.groups.find((g) => g.groupId === groupId)
      if (!group) return {}
      const instanceIds = new Set(group.members.filter((m) => m.kind === 'instance').map((m) => m.id))
      const pipeIds = new Set(group.members.filter((m) => m.kind === 'pipe').map((m) => m.id))
      const shapeIds = new Set(group.members.filter((m) => m.kind === 'shape').map((m) => m.id))
      const leaderLineIds = new Set(group.members.filter((m) => m.kind === 'leaderLine').map((m) => m.id))
      const layerIds = new Set(group.members.filter((m) => m.kind === 'layer').map((m) => m.id))
      // Inlined via computeMixedDeletion rather than calling deleteInstances/
      // deletePipes/etc. — each of those pushes its own history entry, which
      // would turn one "delete group" into several undo steps instead of the
      // required single one. No separate step to drop the group's own
      // record: it ends up with 0 members (all deleted here), and
      // stripDeletedGroupMembers already drops any group under 2 members.
      return {
        ...pushHistory(state),
        ...computeMixedDeletion(state, { instanceIds, pipeIds, shapeIds, leaderLineIds, layerIds }),
        selectedGroupId: null,
        selectedInstanceIds: [],
        selectedPipeIds: [],
        selectedShapeIds: [],
        selectedLeaderLineIds: [],
        selectedLayerIds: [],
        selectedRole: null,
        selectedWaypoint: null,
        selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
        tagRenameError: null,
      }
    }),

  /**
   * v1's shared group edit is style-only (fill/stroke/text color) — see
   * applyStyleFieldToIds for which member kinds support which field. One
   * `pushHistory` call regardless of how many members change, so a
   * group-wide color edit is a single undo step.
   */
  setGroupStyle: (groupId, kind, field, value) =>
    set((state) => {
      const group = state.groups.find((g) => g.groupId === groupId)
      if (!group) return {}
      const ids = new Set(group.members.filter((m) => m.kind === kind).map((m) => m.id))
      const pipeStubInstanceIds =
        kind === 'pipe'
          ? new Set(
              group.members
                .filter((m) => m.kind === 'instance')
                .map((m) => state.instances.find((inst) => inst.instanceId === m.id))
                .filter((inst): inst is ComponentInstance => !!inst && componentHasPipeColorOption(inst.componentTypeId))
                .map((inst) => inst.instanceId),
            )
          : undefined
      return { ...pushHistory(state), ...applyStyleFieldToIds(state, kind, ids, field, value, pipeStubInstanceIds) }
    }),

  /**
   * Same style broadcast as setGroupStyle, but for a loose (ungrouped)
   * multi-selection — reads ids straight from the current selection arrays
   * instead of a persisted Group's members. Lets the properties panel offer
   * the same shared-style editing for "2+ things selected" regardless of
   * whether they've been formally grouped yet.
   */
  setSelectionStyle: (kind, field, value) =>
    set((state) => {
      const ids =
        kind === 'instance'
          ? new Set(state.selectedInstanceIds)
          : kind === 'pipe'
            ? new Set(state.selectedPipeIds)
            : new Set(state.selectedShapeIds)
      const pipeStubInstanceIds =
        kind === 'pipe'
          ? new Set(
              state.instances
                .filter(
                  (inst) => state.selectedInstanceIds.includes(inst.instanceId) && componentHasPipeColorOption(inst.componentTypeId),
                )
                .map((inst) => inst.instanceId),
            )
          : undefined
      return { ...pushHistory(state), ...applyStyleFieldToIds(state, kind, ids, field, value, pipeStubInstanceIds) }
    }),

  setGroupPipeFlag: (groupId, field, value) =>
    set((state) => {
      const group = state.groups.find((g) => g.groupId === groupId)
      if (!group) return {}
      const pipeIds = new Set(group.members.filter((m) => m.kind === 'pipe').map((m) => m.id))
      return { ...pushHistory(state), pipes: applyPipeFlagToIds(state.pipes, pipeIds, field, value) }
    }),

  setSelectionPipeFlag: (field, value) =>
    set((state) => ({
      ...pushHistory(state),
      pipes: applyPipeFlagToIds(state.pipes, new Set(state.selectedPipeIds), field, value),
    })),

  /**
   * Deletes everything currently selected across all four categories at
   * once, one undo step — the loose-multi-select counterpart to deleteGroup.
   */
  deleteSelection: () =>
    set((state) => {
      const instanceIds = new Set(state.selectedInstanceIds)
      const pipeIds = new Set(state.selectedPipeIds)
      const shapeIds = new Set(state.selectedShapeIds)
      const leaderLineIds = new Set(state.selectedLeaderLineIds)
      const layerIds = new Set(state.selectedLayerIds)
      const deletion = computeMixedDeletion(state, { instanceIds, pipeIds, shapeIds, leaderLineIds, layerIds })
      return {
        ...pushHistory(state),
        ...deletion,
        selectedGroupId: clearSelectedGroupIfGone(deletion.groups, state.selectedGroupId),
        selectedInstanceIds: [],
        selectedPipeIds: [],
        selectedShapeIds: [],
        selectedLeaderLineIds: [],
        selectedLayerIds: [],
        selectedRole: null,
        selectedWaypoint: null,
        selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
        tagRenameError: null,
      }
    }),

  duplicateSelection: () =>
    set((state) => {
      const source = gatherSelectionAsEntitySet(state)
      const total =
        source.instances.length + source.pipes.length + source.freeShapes.length + source.leaderLines.length + source.layers.length
      if (total === 0) return {}
      const clone = cloneEntitySet(source, { x: state.gridSize, y: state.gridSize })
      return {
        ...pushHistory(state),
        instances: [...state.instances, ...clone.instances],
        pipes: recomputeVolumeTags([...state.pipes, ...clone.pipes]),
        freeShapes: [...state.freeShapes, ...clone.freeShapes],
        leaderLines: [...state.leaderLines, ...clone.leaderLines],
        layers: [...state.layers, ...clone.layers],
        groups: [...state.groups, ...clone.groups],
        // Re-select the clone (same convention selectMixed/selectGroup use)
        // — this is what makes repeated Ctrl+D stack: the next call's
        // "current selection" is this call's output, with no extra state to
        // track for it.
        selectedInstanceIds: clone.instances.map((i) => i.instanceId),
        selectedPipeIds: clone.pipes.map((p) => p.instanceId),
        selectedShapeIds: clone.freeShapes.map((s) => s.instanceId),
        selectedLeaderLineIds: clone.leaderLines.map((l) => l.instanceId),
        selectedLayerIds: clone.layers.map((l) => l.layerId),
        selectedGroupId: clone.groups[0]?.groupId ?? null,
        selectedRole: null,
        selectedWaypoint: null,
        selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
        tagRenameError: null,
      }
    }),

  copySelectionToClipboard: () => {
    const state = get()
    const payload = gatherSelectionAsEntitySet(state)
    const total =
      payload.instances.length + payload.pipes.length + payload.freeShapes.length + payload.leaderLines.length + payload.layers.length
    // No-op on an empty selection so Ctrl+C with nothing selected doesn't
    // clobber whatever the user already had on their OS clipboard.
    if (total === 0) return
    const envelope: ScryClipboardEnvelope = { scryClipboard: true, version: 1, payload }
    navigator.clipboard.writeText(JSON.stringify(envelope)).catch((err) => {
      // Clipboard writes can reject outside a secure/user-gesture context —
      // log rather than throw so a stray Ctrl+C never crashes the app.
      console.error('Failed to write to clipboard:', err)
    })
  },

  pasteFromClipboardText: (text) =>
    set((state) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return {}
      }
      if (!isScryClipboardEnvelope(parsed)) return {}

      // Repeated Ctrl+V with the *same* clipboard text (nothing new copied
      // in between) chains off the previous paste's own live clones instead
      // of re-cloning the frozen envelope payload — same PowerPoint-style
      // stacking as duplicate, and it correctly follows the user if they
      // dragged the last paste before pasting again. Falls back to the
      // envelope's payload if those ids no longer resolve to anything (e.g.
      // the previous paste was since deleted).
      let source: ScryClipboardPayload | null = null
      if (state.lastPasteText === text && state.lastPastedIds) {
        const prev = state.lastPastedIds
        const matched: ScryClipboardPayload = {
          instances: state.instances.filter((i) => prev.instanceIds.includes(i.instanceId)),
          pipes: state.pipes.filter((p) => prev.pipeIds.includes(p.instanceId)),
          freeShapes: state.freeShapes.filter((s) => prev.shapeIds.includes(s.instanceId)),
          leaderLines: state.leaderLines.filter((l) => prev.leaderLineIds.includes(l.instanceId)),
          layers: state.layers.filter((l): l is ImageLayer => l.kind === 'image' && prev.layerIds.includes(l.layerId)),
          groups: state.groups.filter((g) => g.groupId === prev.groupId),
        }
        const matchedTotal =
          matched.instances.length +
          matched.pipes.length +
          matched.freeShapes.length +
          matched.leaderLines.length +
          matched.layers.length
        if (matchedTotal > 0) source = matched
      }
      if (!source) source = parsed.payload

      const total =
        source.instances.length + source.pipes.length + source.freeShapes.length + source.leaderLines.length + source.layers.length
      if (total === 0) return {}

      const clone = cloneEntitySet(source, { x: state.gridSize, y: state.gridSize })
      const lastPastedIds = {
        instanceIds: clone.instances.map((i) => i.instanceId),
        pipeIds: clone.pipes.map((p) => p.instanceId),
        shapeIds: clone.freeShapes.map((s) => s.instanceId),
        leaderLineIds: clone.leaderLines.map((l) => l.instanceId),
        layerIds: clone.layers.map((l) => l.layerId),
        groupId: clone.groups[0]?.groupId ?? null,
      }
      return {
        ...pushHistory(state),
        instances: [...state.instances, ...clone.instances],
        pipes: recomputeVolumeTags([...state.pipes, ...clone.pipes]),
        freeShapes: [...state.freeShapes, ...clone.freeShapes],
        leaderLines: [...state.leaderLines, ...clone.leaderLines],
        layers: [...state.layers, ...clone.layers],
        groups: [...state.groups, ...clone.groups],
        selectedInstanceIds: lastPastedIds.instanceIds,
        selectedPipeIds: lastPastedIds.pipeIds,
        selectedShapeIds: lastPastedIds.shapeIds,
        selectedLeaderLineIds: lastPastedIds.leaderLineIds,
        selectedLayerIds: lastPastedIds.layerIds,
        selectedGroupId: lastPastedIds.groupId,
        selectedRole: null,
        selectedWaypoint: null,
        selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
        tagRenameError: null,
        lastPasteText: text,
        lastPastedIds,
      }
    }),

  addImageLayer: (name, src, width, height) =>
    set((state) => {
      const layer: ImageLayer = {
        layerId: crypto.randomUUID(),
        name,
        // Locked by default (per the original plan: a background reference
        // image shouldn't be accidentally dragged/nudged) and stays editor-only
        // unless the user explicitly opts it into the export.
        visible: true,
        locked: true,
        kind: 'image',
        src,
        opacity: 1,
        includeInExport: false,
        x: 0,
        y: 0,
        width,
        height,
        connectionPoints: [],
      }
      return { ...pushHistory(state), layers: [...state.layers, layer] }
    }),

  addShapeLayer: (name) => {
    const layerId = crypto.randomUUID()
    set((state) => {
      const shapeLayerCount = state.layers.filter((l) => l.kind === 'vector' && l.layerId !== 'default').length
      const layer: VectorLayer = {
        layerId,
        name: name ?? `Shape layer ${shapeLayerCount + 1}`,
        visible: true,
        locked: false,
        kind: 'vector',
      }
      return { ...pushHistory(state), layers: [...state.layers, layer] }
    })
    return layerId
  },

  setShapeLayer: (shapeId, layerId) =>
    set((state) => ({
      ...pushHistory(state),
      freeShapes: state.freeShapes.map((s) => (s.instanceId === shapeId ? { ...s, layerId } : s)),
    })),

  // Note: doesn't cascade-delete instances/shapes whose layerId pointed at
  // this layer (that's pre-existing behavior, unrelated to grouping) — since
  // no instance/pipe/shape/leaderLine record is actually removed here, there
  // is nothing for a Group to end up dangling on, unlike the delete* actions
  // above.
  deleteLayer: (layerId) =>
    set((state) => {
      const groups = stripDeletedGroupMembers(state.groups, { layer: new Set([layerId]) })
      const removedLayerIds = new Set([layerId])
      return {
        ...pushHistory(state),
        layers: state.layers.filter((l) => l.layerId !== layerId),
        // Same "leave a knot instead of dangling" contract as deleteShapes/deleteInstances — any pipe attached to this layer's connection points survives, frozen at its last position.
        pipes: recomputeVolumeTags(
          detachPipesFromConnectionPointOwners(
            state.pipes,
            state.instances,
            state.layers,
            state.freeShapes,
            removedLayerIds,
            new Set(),
          ),
        ),
        selectedLayerIds: state.selectedLayerIds.filter((id) => id !== layerId),
        groups,
        selectedGroupId: clearSelectedGroupIfGone(groups, state.selectedGroupId),
      }
    }),

  renameLayer: (layerId, name) =>
    set((state) => ({
      ...pushHistory(state),
      layers: state.layers.map((l) => (l.layerId === layerId ? { ...l, name } : l)),
    })),

  setLayerVisible: (layerId, visible) =>
    set((state) => ({
      ...pushHistory(state),
      layers: state.layers.map((l) => (l.layerId === layerId ? { ...l, visible } : l)),
    })),

  setLayerLocked: (layerId, locked) =>
    set((state) => ({
      ...pushHistory(state),
      layers: state.layers.map((l) => (l.layerId === layerId ? { ...l, locked } : l)),
    })),

  setLayerOpacity: (layerId, opacity) =>
    set((state) => ({
      layers: state.layers.map((l) => (l.layerId === layerId && l.kind === 'image' ? { ...l, opacity } : l)),
    })),

  setLayerIncludeInExport: (layerId, included) =>
    set((state) => ({
      ...pushHistory(state),
      layers: state.layers.map((l) =>
        l.layerId === layerId && l.kind === 'image' ? { ...l, includeInExport: included } : l,
      ),
    })),

  setLayerShowGridOverImage: (layerId, show) =>
    set((state) => ({
      ...pushHistory(state),
      layers: state.layers.map((l) =>
        l.layerId === layerId && l.kind === 'image' ? { ...l, showGridOverImage: show } : l,
      ),
    })),

  setLayerRect: (layerId, rect) =>
    set((state) => ({
      ...pushHistory(state),
      layers: state.layers.map((l) => (l.layerId === layerId && l.kind === 'image' ? { ...l, ...rect } : l)),
    })),

  moveLayer: (layerId, direction) =>
    set((state) => {
      const index = state.layers.findIndex((l) => l.layerId === layerId)
      const swapWith = direction === 'up' ? index + 1 : index - 1
      if (index === -1 || swapWith < 0 || swapWith >= state.layers.length) return {}
      const layers = [...state.layers]
      ;[layers[index], layers[swapWith]] = [layers[swapWith], layers[index]]
      return { ...pushHistory(state), layers }
    }),

  // Continuous drag, like moveInstance/moveShape — checkpointed once at
  // drag-start via onDragCheckpoint, not on every pointermove.
  moveImageLayer: (layerId, x, y) =>
    set((state) => ({
      layers: state.layers.map((l) => (l.layerId === layerId && l.kind === 'image' ? { ...l, x, y } : l)),
    })),

  resizeImageLayer: (layerId, rect) =>
    set((state) => ({
      layers: state.layers.map((l) => (l.layerId === layerId && l.kind === 'image' ? { ...l, ...rect } : l)),
    })),

  selectLayers: (layerIds) =>
    set({
      selectedLayerIds: layerIds,
      selectedInstanceIds: layerIds.length > 0 ? [] : get().selectedInstanceIds,
      selectedPipeIds: layerIds.length > 0 ? [] : get().selectedPipeIds,
      selectedShapeIds: layerIds.length > 0 ? [] : get().selectedShapeIds,
      selectedLeaderLineIds: layerIds.length > 0 ? [] : get().selectedLeaderLineIds,
      selectedLeaderLinePoint: layerIds.length > 0 ? null : get().selectedLeaderLinePoint,
      selectedGroupId: layerIds.length > 0 ? null : get().selectedGroupId,
      selectedRole: null,
      selectedWaypoint: null,
      tagRenameError: null,
    }),

  openLayersPanel: () =>
    set({
      layersPanelOpen: true,
      selectedLayerIds: [],
      selectedInstanceIds: [],
      selectedPipeIds: [],
      selectedShapeIds: [],
      selectedLeaderLineIds: [],
      selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
      selectedGroupId: null,
      selectedRole: null,
      selectedWaypoint: null,
      tagRenameError: null,
    }),

  closeLayersPanel: () => set({ layersPanelOpen: false, selectedLayerIds: [] }),

  toggleLayersPanel: () => {
    const state = get()
    if (state.layersPanelOpen || state.selectedLayerIds.length > 0) get().closeLayersPanel()
    else get().openLayersPanel()
  },

  openSearchPanel: () =>
    set({
      searchPanelOpen: true,
      selectedLayerIds: [],
      selectedInstanceIds: [],
      selectedPipeIds: [],
      selectedShapeIds: [],
      selectedLeaderLineIds: [],
      selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
      selectedGroupId: null,
      selectedRole: null,
      selectedWaypoint: null,
      tagRenameError: null,
    }),

  closeSearchPanel: () => set({ searchPanelOpen: false }),

  toggleSearchPanel: () => {
    const state = get()
    if (state.searchPanelOpen) get().closeSearchPanel()
    else get().openSearchPanel()
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchRegexPattern: (pattern) => set({ searchRegexPattern: pattern }),
  setSearchRegexReplacement: (replacement) => set({ searchRegexReplacement: replacement }),

  bulkRenameTagsByRegex: (matches) =>
    set((state) => {
      if (matches.length === 0) return {}
      const byInstance = new Map(matches.filter((m) => m.kind === 'instance').map((m) => [m.id, m.newTag]))
      const byPipe = new Map(matches.filter((m) => m.kind === 'pipe').map((m) => [m.id, m.newTag]))
      return {
        ...pushHistory(state),
        tagRenameError: null,
        instances: state.instances.map((inst) =>
          byInstance.has(inst.instanceId) ? { ...inst, tag: byInstance.get(inst.instanceId)! } : inst,
        ),
        pipes: state.pipes.map((p) => (byPipe.has(p.instanceId) ? { ...p, tag: byPipe.get(p.instanceId)! } : p)),
      }
    }),

  setImageAspectLocked: (locked) => set({ imageAspectLocked: locked }),

  addConnectionPoint: (layerId, relX, relY, keepPlacing = false) =>
    set((state) => {
      const point: ImageConnectionPoint = { pointId: crypto.randomUUID(), relX, relY }
      return {
        ...pushHistory(state),
        layers: state.layers.map((l) =>
          l.layerId === layerId && l.kind === 'image' ? { ...l, connectionPoints: [...l.connectionPoints, point] } : l,
        ),
        tool: keepPlacing ? state.tool : 'select',
        connectionPointTargetLayerId: keepPlacing ? state.connectionPointTargetLayerId : null,
      }
    }),

  deleteConnectionPoint: (layerId, pointId) =>
    set((state) => ({
      ...pushHistory(state),
      layers: state.layers.map((l) =>
        l.layerId === layerId && l.kind === 'image'
          ? { ...l, connectionPoints: l.connectionPoints.filter((p) => p.pointId !== pointId) }
          : l,
      ),
    })),

  addShapeConnectionPoint: (shapeId, relX, relY, keepPlacing = false) =>
    set((state) => {
      const point: ImageConnectionPoint = { pointId: crypto.randomUUID(), relX, relY }
      return {
        ...pushHistory(state),
        freeShapes: state.freeShapes.map((s) =>
          s.instanceId === shapeId ? { ...s, connectionPoints: [...(s.connectionPoints ?? []), point] } : s,
        ),
        tool: keepPlacing ? state.tool : 'select',
        connectionPointTargetShapeId: keepPlacing ? state.connectionPointTargetShapeId : null,
      }
    }),

  deleteShapeConnectionPoint: (shapeId, pointId) =>
    set((state) => ({
      ...pushHistory(state),
      freeShapes: state.freeShapes.map((s) =>
        s.instanceId === shapeId
          ? { ...s, connectionPoints: (s.connectionPoints ?? []).filter((p) => p.pointId !== pointId) }
          : s,
      ),
    })),

  addInstanceConnectionPoint: (instanceId, relX, relY, keepPlacing = false) =>
    set((state) => {
      const point: ImageConnectionPoint = { pointId: crypto.randomUUID(), relX, relY }
      return {
        ...pushHistory(state),
        instances: state.instances.map((i) =>
          i.instanceId === instanceId ? { ...i, connectionPoints: [...(i.connectionPoints ?? []), point] } : i,
        ),
        tool: keepPlacing ? state.tool : 'select',
        connectionPointTargetInstanceId: keepPlacing ? state.connectionPointTargetInstanceId : null,
      }
    }),

  deleteInstanceConnectionPoint: (instanceId, pointId) =>
    set((state) => ({
      ...pushHistory(state),
      instances: state.instances.map((i) =>
        i.instanceId === instanceId
          ? { ...i, connectionPoints: (i.connectionPoints ?? []).filter((p) => p.pointId !== pointId) }
          : i,
      ),
    })),

  selectConnectionPoint: (selection) => set({ selectedConnectionPoint: selection }),

  moveConnectionPoint: (ownerKind, ownerId, pointId, relX, relY) =>
    set((state) => {
      const clampedX = Math.max(0, Math.min(1, relX))
      const clampedY = Math.max(0, Math.min(1, relY))
      if (ownerKind === 'layer') {
        return {
          layers: state.layers.map((l) =>
            l.layerId === ownerId && l.kind === 'image'
              ? {
                  ...l,
                  connectionPoints: l.connectionPoints.map((p) =>
                    p.pointId === pointId ? { ...p, relX: clampedX, relY: clampedY } : p,
                  ),
                }
              : l,
          ),
        }
      }
      if (ownerKind === 'shape') {
        return {
          freeShapes: state.freeShapes.map((s) =>
            s.instanceId === ownerId
              ? {
                  ...s,
                  connectionPoints: (s.connectionPoints ?? []).map((p) =>
                    p.pointId === pointId ? { ...p, relX: clampedX, relY: clampedY } : p,
                  ),
                }
              : s,
          ),
        }
      }
      return {
        instances: state.instances.map((i) =>
          i.instanceId === ownerId
            ? {
                ...i,
                connectionPoints: (i.connectionPoints ?? []).map((p) =>
                  p.pointId === pointId ? { ...p, relX: clampedX, relY: clampedY } : p,
                ),
              }
            : i,
        ),
      }
    }),

  pickTransparentColorAt: async (layerId, relX, relY) => {
    // Exits the eyedropper tool immediately (one-shot, like PowerPoint's
    // own "Set Transparent Color") rather than waiting for the async
    // processing below — the click itself is the completed gesture from
    // the user's perspective.
    set((state) => ({
      tool: 'select',
      pickTransparentColorTargetLayerId: null,
      selectedLayerIds: state.selectedLayerIds.length > 0 ? state.selectedLayerIds : [layerId],
    }))
    const layer = get().layers.find((l) => l.layerId === layerId)
    if (!layer || layer.kind !== 'image') return
    try {
      const hexColor = await samplePixelColor(layer.src, relX, relY)
      const newSrc = await applyTransparentColor(layer.src, hexColor, get().transparentColorTolerance)
      set((state) => ({
        ...pushHistory(state),
        layers: state.layers.map((l) =>
          l.layerId === layerId && l.kind === 'image'
            ? { ...l, src: newSrc, originalSrc: l.originalSrc ?? l.src, transparentColorHex: hexColor }
            : l,
        ),
      }))
    } catch (err) {
      console.error(`Failed to apply transparent color for layer "${layerId}":`, err)
    }
  },

  setTransparentColorTolerance: (tolerance, layerId) => {
    const clamped = Math.max(0, Math.min(255, tolerance))
    set({ transparentColorTolerance: clamped })
    if (!layerId) return
    const layer = get().layers.find((l) => l.layerId === layerId)
    if (!layer || layer.kind !== 'image' || !layer.originalSrc || !layer.transparentColorHex) return
    applyTransparentColor(layer.originalSrc, layer.transparentColorHex, clamped)
      .then((newSrc) => {
        set((state) => ({
          ...pushHistory(state),
          layers: state.layers.map((l) => (l.layerId === layerId && l.kind === 'image' ? { ...l, src: newSrc } : l)),
        }))
      })
      .catch((err) => {
        console.error(`Failed to reapply transparent color for layer "${layerId}":`, err)
      })
  },

  restoreOriginalImage: (layerId) =>
    set((state) => {
      const layer = state.layers.find((l) => l.layerId === layerId)
      if (!layer || layer.kind !== 'image' || !layer.originalSrc) return {}
      return {
        ...pushHistory(state),
        layers: state.layers.map((l) =>
          l.layerId === layerId && l.kind === 'image'
            ? { ...l, src: l.originalSrc!, originalSrc: undefined, transparentColorHex: undefined }
            : l,
        ),
      }
    }),

  resizeImagePixels: async (layerId, targetWidth, targetHeight) => {
    const layer = get().layers.find((l) => l.layerId === layerId)
    if (!layer || layer.kind !== 'image') return
    try {
      const newSrc = await resizeImage(layer.src, targetWidth, targetHeight)
      set((state) => ({
        ...pushHistory(state),
        layers: state.layers.map((l) =>
          l.layerId === layerId && l.kind === 'image' ? { ...l, src: newSrc, originalSrc: l.originalSrc ?? l.src } : l,
        ),
      }))
    } catch (err) {
      console.error(`Failed to resize image for layer "${layerId}":`, err)
    }
  },

  discardOriginalImage: (layerId) =>
    set((state) => {
      const layer = state.layers.find((l) => l.layerId === layerId)
      if (!layer || layer.kind !== 'image' || !layer.originalSrc) return {}
      return {
        ...pushHistory(state),
        layers: state.layers.map((l) =>
          l.layerId === layerId && l.kind === 'image' ? { ...l, originalSrc: undefined, transparentColorHex: undefined } : l,
        ),
      }
    }),

  setProjectName: (name) => set({ projectName: name }),

  refreshProjectList: async () => {
    try {
      const projects = await api.listProjects()
      set({ availableProjects: projects })
    } catch (err) {
      set({ serverStatus: `Failed to list projects: ${(err as Error).message}`, serverStatusKind: 'error' })
    }
  },

  /**
   * Called once on app mount (see App.tsx): a fresh page load otherwise
   * starts from a client-side empty project — `projectName` is already
   * seeded from localStorage (readLastProjectName, whichever project was
   * last open in this browser — falls back to 'my-project' the very first
   * time), but nothing has actually been loaded from the server yet — even
   * though a same-named project may already exist there from a previous
   * session, which made reloading the page look like silent data loss. If
   * the current projectName is among the server's projects, load it for
   * real; otherwise this is genuinely a fresh/never-saved project, left
   * as-is.
   */
  loadInitialProject: async () => {
    try {
      const projects = await api.listProjects()
      set({ availableProjects: projects })
      if (projects.includes(get().projectName)) {
        await get().loadProjectFromServer(get().projectName)
      }
    } catch (err) {
      set({ serverStatus: `Failed to list projects: ${(err as Error).message}`, serverStatusKind: 'error' })
    }
  },

  // Also the autosave debounce's target — see the module-scope subscriber
  // below the store. Cancels any pending debounce first so an explicit Save
  // click and a just-about-to-fire autosave never race each other.
  saveProjectToServer: async () => {
    cancelPendingAutosave()
    const state = get()
    set({ serverBusy: true, serverStatus: null, serverStatusKind: null, syncStatus: 'saving' })
    try {
      const snapshot = buildProjectSnapshot(
        state.projectName,
        state.instances,
        state.pipes,
        state.freeShapes,
        state.layers,
        state.gridSize,
        state.projectMeta?.createdAt,
        state.leaderLines,
        state.groups,
      )
      await api.saveProject(state.projectName, snapshot)
      const projects = await api.listProjects()
      set({
        serverBusy: false,
        serverStatus: `Saved "${state.projectName}".`,
        availableProjects: projects,
        syncStatus: 'synced',
        projectMeta: snapshot.meta,
        syncErrorMessage: null,
      })
    } catch (err) {
      set({
        serverBusy: false,
        serverStatus: `Save failed: ${(err as Error).message}`,
        serverStatusKind: 'error',
        syncStatus: 'error',
        syncErrorMessage: (err as Error).message,
      })
    }
  },

  loadProjectFromServer: async (name) => {
    cancelPendingAutosave()
    set({ serverBusy: true, serverStatus: null, serverStatusKind: null })
    try {
      const project = await api.loadProject(name)
      resyncCounters(project.instances, project.pipes)
      suppressNextAutosaveDirty = true
      set({
        serverBusy: false,
        serverStatus: `Loaded "${name}".`,
        projectName: name,
        instances: project.instances,
        // Fills in volumeTag for any pipe that doesn't have one yet (e.g.
        // data saved before this feature existed); resyncCounters ran first
        // so any tags already present are kept as-is, never renumbered.
        pipes: recomputeVolumeTags(project.pipes),
        // Older saved projects won't have this field at all.
        freeShapes: project.freeShapes ?? [],
        leaderLines: project.leaderLines ?? [],
        layers: project.layers && project.layers.length > 0 ? project.layers : [DEFAULT_VECTOR_LAYER],
        // Older saved projects won't have this field at all either.
        groups: project.groups ?? [],
        selectedInstanceIds: [],
        selectedPipeIds: [],
        selectedRole: null,
        selectedWaypoint: null,
        selectedShapeIds: [],
        selectedLeaderLineIds: [],
        selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
        selectedGroupId: null,
        tagRenameError: null,
        // Undo history from whatever project was open before doesn't apply
        // to a freshly loaded one.
        past: [],
        future: [],
        projectMeta: project.meta,
        syncStatus: 'synced',
        autosavePaused: false,
        syncErrorMessage: null,
      })
    } catch (err) {
      set({ serverBusy: false, serverStatus: `Load failed: ${(err as Error).message}`, serverStatusKind: 'error' })
    }
  },

  exportToServer: async () => {
    const state = get()
    set({ serverBusy: true, serverStatus: null, serverStatusKind: null })
    try {
      const svg = exportProjectToSvg(state.instances, state.pipes, state.freeShapes, state.layers, state.leaderLines)
      await api.exportToServer(state.projectName, svg)
      set({ serverBusy: false, serverStatus: `Exported "${state.projectName}.svg" to the server.` })
    } catch (err) {
      set({ serverBusy: false, serverStatus: `Server export failed: ${(err as Error).message}`, serverStatusKind: 'error' })
    }
  },

  renameProjectOnServer: async (oldName, newName) => {
    set({ serverBusy: true, serverStatus: null, serverStatusKind: null })
    try {
      await api.renameProject(oldName, newName)
      const projects = await api.listProjects()
      set((state) => ({
        serverBusy: false,
        serverStatus: `Renamed "${oldName}" to "${newName}".`,
        availableProjects: projects,
        projectName: state.projectName === oldName ? newName : state.projectName,
        projectMeta:
          state.projectName === oldName && state.projectMeta
            ? { ...state.projectMeta, id: newName, name: newName }
            : state.projectMeta,
      }))
    } catch (err) {
      set({ serverBusy: false, serverStatus: `Rename failed: ${(err as Error).message}`, serverStatusKind: 'error' })
    }
  },

  duplicateProjectOnServer: async (name, newName) => {
    set({ serverBusy: true, serverStatus: null, serverStatusKind: null })
    try {
      await api.duplicateProject(name, newName)
      const projects = await api.listProjects()
      set({ serverBusy: false, serverStatus: `Duplicated "${name}" as "${newName}".`, availableProjects: projects })
    } catch (err) {
      set({ serverBusy: false, serverStatus: `Duplicate failed: ${(err as Error).message}`, serverStatusKind: 'error' })
    }
  },

  trashProjectOnServer: async (name) => {
    set({ serverBusy: true, serverStatus: null, serverStatusKind: null })
    try {
      await api.trashProject(name)
      const projects = await api.listProjects()
      set((state) => {
        const wasOpen = state.projectName === name
        if (wasOpen) cancelPendingAutosave()
        return {
          serverBusy: false,
          serverStatus: `Deleted "${name}".`,
          availableProjects: projects,
          // The file still exists (moved to trash server-side), but it's no
          // longer "this" server file — detach so autosave/polling stop
          // targeting a name that won't show up as changed/found anymore.
          // The in-memory diagram itself is left completely untouched.
          projectMeta: wasOpen ? null : state.projectMeta,
          syncStatus: wasOpen ? 'unsaved' : state.syncStatus,
          autosavePaused: wasOpen ? false : state.autosavePaused,
        }
      })
    } catch (err) {
      set({ serverBusy: false, serverStatus: `Delete failed: ${(err as Error).message}`, serverStatusKind: 'error' })
    }
  },

  exportProjectToFile: () => {
    const state = get()
    const snapshot = buildProjectSnapshot(
      state.projectName,
      state.instances,
      state.pipes,
      state.freeShapes,
      state.layers,
      state.gridSize,
      state.projectMeta?.createdAt,
      state.leaderLines,
      state.groups,
    )
    downloadTextFile(`${state.projectName}.gvproj.json`, JSON.stringify(snapshot, null, 2), 'application/json')
  },

  importProjectFromFile: (project, mode = 'new') => {
    cancelPendingAutosave()
    resyncCounters(project.instances, project.pipes)
    const overwriteCurrent = mode === 'overwrite-current'
    set((state) => ({
      projectName: overwriteCurrent
        ? state.projectName
        : project.meta?.name || project.meta?.id || 'imported-project',
      instances: project.instances,
      pipes: recomputeVolumeTags(project.pipes),
      freeShapes: project.freeShapes ?? [],
      leaderLines: project.leaderLines ?? [],
      layers: project.layers && project.layers.length > 0 ? project.layers : [DEFAULT_VECTOR_LAYER],
      groups: project.groups ?? [],
      selectedInstanceIds: [],
      selectedPipeIds: [],
      selectedRole: null,
      selectedWaypoint: null,
      selectedShapeIds: [],
      selectedLeaderLineIds: [],
      selectedLeaderLinePoint: null,
        selectedConnectionPoint: null,
      selectedGroupId: null,
      tagRenameError: null,
      past: [],
      future: [],
      // 'new': deliberately NOT the imported file's own meta/modifiedAt —
      // this content has never been written to a file on THIS server, so
      // there's nothing yet to compare a poll against; the next Save
      // creates a project under projectName normally. 'overwrite-current':
      // keep the current project's own meta — the next autosave/Save just
      // overwrites that same server file with the imported content, same as
      // if the user had pasted it in by hand.
      projectMeta: overwriteCurrent ? state.projectMeta : null,
      syncStatus: overwriteCurrent ? 'dirty' : 'unsaved',
      autosavePaused: false,
      serverStatus: overwriteCurrent
        ? `Imported "${project.meta?.name ?? 'file'}" into "${state.projectName}".`
        : `Imported "${project.meta?.name ?? 'project'}" from file.`,
      serverStatusKind: null,
    }))
  },

  resolveConflictKeepMine: async () => {
    set({ autosavePaused: false })
    await get().saveProjectToServer()
  },

  resolveConflictReloadTheirs: async () => {
    set({ autosavePaused: false })
    await get().loadProjectFromServer(get().projectName)
  },

  loadProjectVersions: async (name) => {
    set({ versionsLoading: true })
    try {
      const versions = await api.listProjectVersions(name)
      set({ versions, versionsLoading: false })
    } catch (err) {
      set({
        versionsLoading: false,
        serverStatus: `Failed to load version history: ${(err as Error).message}`,
        serverStatusKind: 'error',
      })
    }
  },

  restoreProjectVersion: async (name, timestamp) => {
    set({ serverBusy: true, serverStatus: null, serverStatusKind: null })
    try {
      await api.restoreProjectVersion(name, timestamp)
      if (get().projectName === name) {
        // Pull the now-restored content into the editor too, same as opening it fresh.
        await get().loadProjectFromServer(name)
      }
      const versions = await api.listProjectVersions(name)
      set({ serverBusy: false, serverStatus: `Restored version from ${new Date(timestamp).toLocaleString()}.`, versions })
    } catch (err) {
      set({ serverBusy: false, serverStatus: `Restore failed: ${(err as Error).message}`, serverStatusKind: 'error' })
    }
  },
}))

const AUTOSAVE_DEBOUNCE_MS = 2000
const SYNC_POLL_INTERVAL_MS = 7000

let autosaveTimer: ReturnType<typeof setTimeout> | null = null

function cancelPendingAutosave() {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
}

/**
 * Set right before a `set(...)` call that replaces instances/pipes/etc.
 * with content that's *already* known to match the server (a fresh load,
 * not a local edit) — e.g. loadProjectFromServer's success path. Consumed
 * (and reset) by the very next autosave-subscriber tick so that transition
 * doesn't get misread as a dirty local edit and immediately re-queue a
 * redundant (if harmless) save, which would also flash the sync badge back
 * to "dirty"/"saving" right after a reload/restore that's already in sync.
 */
let suppressNextAutosaveDirty = false

// Autosave: any change to the actual project *content* (the same fields
// undo history tracks — deliberately not gridSize, matching its existing
// "not real content" treatment elsewhere in this file) schedules a save a
// couple of seconds after the user stops editing. Skipped entirely while a
// sync conflict is unresolved, so local edits can never silently overwrite
// someone else's save out from under them mid-conflict.
useProjectStore.subscribe((state, prevState) => {
  const changed =
    state.instances !== prevState.instances ||
    state.pipes !== prevState.pipes ||
    state.freeShapes !== prevState.freeShapes ||
    state.leaderLines !== prevState.leaderLines ||
    state.layers !== prevState.layers ||
    state.groups !== prevState.groups
  if (!changed) return
  if (suppressNextAutosaveDirty) {
    suppressNextAutosaveDirty = false
    return
  }
  if (state.autosavePaused) return
  if (state.syncStatus !== 'dirty') useProjectStore.setState({ syncStatus: 'dirty' })
  cancelPendingAutosave()
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    void useProjectStore.getState().saveProjectToServer()
  }, AUTOSAVE_DEBOUNCE_MS)
})

// Remembers the open project name across reloads (see readLastProjectName)
// — independent of the autosave subscriber above, since this cares about
// *which* project is open, not its content.
useProjectStore.subscribe((state, prevState) => {
  if (state.projectName === prevState.projectName) return
  try {
    localStorage.setItem(LAST_PROJECT_STORAGE_KEY, state.projectName)
  } catch {
    // Storage unavailable (private browsing, quota, ...) — just means the
    // next reload falls back to the hardcoded default, not fatal.
  }
})

// Periodic "did someone else change this" check — deliberately just a
// cheap meta-only fetch, not the full project body (see the server's
// /api/projects/:name/meta route). Never auto-merges or auto-reloads: a
// mismatch only ever sets syncStatus to 'conflict' and pauses autosave: the
// user resolves it explicitly (see resolveConflictKeepMine/ReloadTheirs, or
// exportProjectToFile as a safety net) per an explicit product decision —
// automatic merging was considered and rejected as too high-risk for this
// data model (pipes reference instance ids, tags must stay unique, volumes
// are derived from topology — a naive merge could easily produce a broken
// project).
setInterval(async () => {
  const state = useProjectStore.getState()
  if (state.syncStatus === 'saving' || state.syncStatus === 'conflict' || !state.projectMeta) return
  try {
    const remoteMeta = await api.loadProjectMeta(state.projectName)
    if (remoteMeta.modifiedAt !== state.projectMeta.modifiedAt) {
      cancelPendingAutosave()
      useProjectStore.setState({ syncStatus: 'conflict', autosavePaused: true })
    } else if (state.syncStatus === 'error') {
      // A previously failed poll/save recovered on its own (e.g. the server
      // came back) — not dirty, not mid-save, and now confirmed matching.
      useProjectStore.setState({ syncStatus: 'synced', syncErrorMessage: null })
    }
  } catch (err) {
    // Network hiccup, or the open project was renamed/trashed elsewhere —
    // don't claim a conflict on a failed check, just surface that the sync
    // status couldn't be confirmed right now.
    if (useProjectStore.getState().syncStatus !== 'conflict') {
      useProjectStore.setState({ syncStatus: 'error', syncErrorMessage: (err as Error).message })
    }
  }
}, SYNC_POLL_INTERVAL_MS)

function buildProjectSnapshot(
  name: string,
  instances: ComponentInstance[],
  pipes: PipeInstance[],
  freeShapes: FreeShape[],
  layers: Layer[],
  gridSize: number,
  /** Carried through from the previously known meta so autosaving repeatedly doesn't keep resetting it to "now" — a brand new/never-saved project has none yet, so it's stamped once here. */
  createdAt?: string,
  leaderLines: LeaderLine[] = [],
  groups: Group[] = [],
): Project {
  const now = new Date().toISOString()
  return {
    meta: {
      id: name,
      name,
      canvasWidth: 1000,
      canvasHeight: 700,
      gridSize,
      schemaVersion: 1,
      createdAt: createdAt ?? now,
      modifiedAt: now,
    },
    libraryRefs: [{ package: 'prototype', version: '0.0.1' }],
    layers,
    instances,
    pipes,
    leaderLines,
    freeShapes,
    groups,
  }
}
