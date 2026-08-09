import { create } from 'zustand'
import {
  isPortRef,
  type ComponentInstance,
  type FreePoint,
  type FreeShape,
  type FreeShapeKind,
  type FreeShapeStyle,
  type ImageConnectionPoint,
  type ImageLayer,
  type Layer,
  type LeaderLine,
  type LeaderLineEndpoint,
  type PipeInstance,
  type PortRef,
  type Project,
  type ProjectMeta,
  type RoutingMode,
  type Suffix,
  type TextAlign,
  type Waypoint,
} from '@svg-editor/shared'
import { getComponentType, rotatePoint } from '../library'
import type { Tool, Point } from '../canvas/SvgCanvas'
import * as api from '../api/client'
import { exportProjectToSvg } from '../export/svgExport'
import { downloadTextFile } from '../export/downloadFile'
import { computePipeVolumeGroups } from '../pipes/pipeVolumes'
import { detachPipesFromInstances, getPipePoints, PIPE_POINT_PREFIX, pipePointPortId } from '../pipes/pipeGeometry'
import { detachLeaderLinesFromInstances } from '../leaderLines/leaderLineGeometry'
import { computeAutoRoute } from '../routing/autoRoute'
import { DEFAULT_FONT_SIZE, DEFAULT_SHAPE_STYLE } from '../shapes/freeShapeGeometry'

/** The one always-present vector content layer — instances/pipes/shapes all implicitly live here (no per-instance layer assignment UI yet). */
const DEFAULT_VECTOR_LAYER: Layer = { layerId: 'default', name: 'Default', visible: true, locked: false, kind: 'vector' }

/** The "1x"/standard grid size — the toolbar's grid toggle offers this plus 1/2x and 1/4x, derived from it rather than hardcoded separately. */
export const BASE_GRID_SIZE = 20

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
  for (const group of bySizeDesc) {
    const existingTags = Array.from(new Set(group.map((p) => p.volumeTag).filter((t): t is string => !!t))).sort(
      compareTagNumbers,
    )
    const tag = existingTags.find((t) => !usedTags.has(t)) ?? nextVolumeTag()
    usedTags.add(tag)
    for (const p of group) tagByPipeId.set(p.instanceId, tag)
  }
  return pipes.map((p) => {
    const tag = tagByPipeId.get(p.instanceId)
    return tag && tag !== p.volumeTag ? { ...p, volumeTag: tag } : p
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
        strokeColor: anchor.strokeColor ?? continuing.strokeColor ?? null,
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

interface HistorySnapshot {
  instances: ComponentInstance[]
  pipes: PipeInstance[]
  freeShapes: FreeShape[]
  layers: Layer[]
  leaderLines: LeaderLine[]
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
  state: Pick<ProjectState, 'instances' | 'pipes' | 'freeShapes' | 'layers' | 'leaderLines' | 'past'>,
): Pick<ProjectState, 'past' | 'future'> {
  const snapshot = snapshotOf(state)
  const past = [...state.past, snapshot]
  if (past.length > MAX_HISTORY) past.shift()
  return { past, future: [] }
}

function snapshotOf(
  state: Pick<ProjectState, 'instances' | 'pipes' | 'freeShapes' | 'layers' | 'leaderLines'>,
): HistorySnapshot {
  return {
    instances: state.instances,
    pipes: state.pipes,
    freeShapes: state.freeShapes,
    layers: state.layers,
    leaderLines: state.leaderLines,
  }
}


/** Letters, then optional digits — a practical subset of the tag pattern documented in .claude/CLAUDE.md. */
const TAG_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/

export interface RoleSelection {
  instanceId: string
  role: Suffix
}

/**
 * Arrow-key nudge steps. Default is a small, fine-grained step for precise
 * placement; Shift+arrow jumps by a full grid cell for fast repositioning.
 * A selected role always moves in even finer, sub-grid steps.
 */
const INSTANCE_NUDGE_STEP = 4
const INSTANCE_NUDGE_STEP_FAST = 20
const ROLE_NUDGE_STEP = 1
const ROLE_NUDGE_STEP_FAST = 5
const WAYPOINT_NUDGE_STEP = 1
const WAYPOINT_NUDGE_STEP_FAST = 5

interface ProjectState {
  instances: ComponentInstance[]
  selectedInstanceIds: string[]
  selectedRole: RoleSelection | null
  pipes: PipeInstance[]
  selectedPipeIds: string[]
  selectedWaypoint: { pipeId: string; index: number } | null
  freeShapes: FreeShape[]
  selectedShapeIds: string[]
  leaderLines: LeaderLine[]
  selectedLeaderLineIds: string[]
  /** Which point of the selected leader line is being edited — mirrors selectedWaypoint's shape, 'from'/'to' or a waypoint index. */
  selectedLeaderLinePoint: { leaderLineId: string; point: 'from' | 'to' | number } | null
  layers: Layer[]
  selectedLayerId: string | null
  /** Drives the layers list view in the (right) properties panel — toggled from a toolbar button, since there's no dedicated left-hand layers panel anymore. */
  layersPanelOpen: boolean
  /** Shared by the width/height panel fields and the canvas corner-drag handles, so both respect the same lock. */
  imageAspectLocked: boolean
  tool: Tool
  placingType: string | null
  drawingShapeKind: FreeShapeKind | null
  connectionPointTargetLayerId: string | null
  gridSize: number
  tagRenameError: string | null
  /** Set when autoRoutePipe fails to find an obstacle-free path (e.g. fully boxed in); cleared on the next successful route or pipe (re)selection. */
  routeError: string | null
  groupDragOrigins: Record<string, Point> | null
  /** Free pipe knots riding along with the current group drag — see beginGroupDrag's doc comment. */
  groupDragPipePoints: { pipeId: string; point: 'from' | 'to' | number; origin: Point }[] | null
  past: HistorySnapshot[]
  future: HistorySnapshot[]

  projectName: string
  availableProjects: string[]
  serverStatus: string | null
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
  deleteInstance: (instanceId: string) => void
  deleteInstances: (instanceIds: string[]) => void
  rotateInstance: (instanceId: string, deltaDeg: number) => void
  renameInstance: (instanceId: string, newTag: string) => void
  /** Generic per-instance customization (mirror/fill-color/optional-extras — see InstanceOptionDescriptor) — not every type offers any. */
  setInstancePropertyValue: (instanceId: string, key: string, value: string | number | boolean | null) => void
  setRoleEnabled: (instanceId: string, role: Suffix, enabled: boolean) => void
  /** worldRelativeOffset is relative to the instance origin, not yet compensated for rotation. */
  moveRole: (instanceId: string, role: Suffix, worldRelativeOffset: Point) => void
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

  /** Pushes one undo checkpoint without changing any state — call once at the start of a multi-step drag. */
  checkpointHistory: () => void
  undo: () => void
  redo: () => void

  addPipe: (fromPort: PortRef | FreePoint, toPort: PortRef | FreePoint, waypoints: Waypoint[], keepDrawing?: boolean) => void
  deletePipes: (pipeIds: string[]) => void
  renamePipeTag: (pipeId: string, newTag: string) => void
  renameVolumeTag: (pipeId: string, newTag: string) => void
  setPipeIndicatorEnabled: (pipeId: string, enabled: boolean) => void
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
  /** Grid A* re-route around other components' bounding boxes; replaces the pipe's waypoints and switches it to 'orthogonal' mode. Sets routeError if no path is found. */
  autoRoutePipe: (pipeId: string) => void
  selectPipes: (pipeIds: string[]) => void
  selectWaypoint: (selection: { pipeId: string; index: number } | null) => void

  /** keepDrawing is true when Shift was held, so the tool stays active for drawing several shapes in a row. */
  addFreeShape: (
    kind: FreeShapeKind,
    points: Point[],
    keepDrawing?: boolean,
  ) => void
  deleteShapes: (shapeIds: string[]) => void
  moveShape: (shapeId: string, points: Point[]) => void
  setShapeStyle: (shapeId: string, style: Partial<FreeShapeStyle>) => void
  setShapeText: (shapeId: string, text: string) => void
  setShapeFontSize: (shapeId: string, fontSize: number) => void
  setShapeTextAlign: (shapeId: string, textAlign: TextAlign) => void
  selectShapes: (shapeIds: string[]) => void

  /** Adds a finished leader line from a completed draw-tool interaction (from/waypoints/to already resolved by the canvas). */
  addLeaderLine: (from: LeaderLineEndpoint, waypoints: Point[], to: Point) => void
  deleteLeaderLines: (leaderLineIds: string[]) => void
  /** Continuous drag, like moveShape/moveInstance — checkpointed once at drag-start via onDragCheckpoint. Moves the 'to' endpoint or a waypoint by index. */
  moveLeaderLinePoint: (leaderLineId: string, point: 'to' | number, pos: Point) => void
  /** Same drag pattern as moveLeaderLinePoint, but for 'from' — its value is a full LeaderLineEndpoint (a role ref when the drag re-anchors onto a different label, otherwise a plain point). */
  moveLeaderLineFrom: (leaderLineId: string, from: LeaderLineEndpoint) => void
  selectLeaderLines: (leaderLineIds: string[]) => void
  selectLeaderLinePoint: (selection: { leaderLineId: string; point: 'from' | 'to' | number } | null) => void

  addImageLayer: (name: string, src: string, width: number, height: number) => void
  deleteLayer: (layerId: string) => void
  renameLayer: (layerId: string, name: string) => void
  setLayerVisible: (layerId: string, visible: boolean) => void
  setLayerLocked: (layerId: string, locked: boolean) => void
  setLayerOpacity: (layerId: string, opacity: number) => void
  setLayerIncludeInExport: (layerId: string, included: boolean) => void
  setLayerRect: (layerId: string, rect: { x: number; y: number; width: number; height: number }) => void
  moveLayer: (layerId: string, direction: 'up' | 'down') => void
  moveImageLayer: (layerId: string, x: number, y: number) => void
  /** Continuous drag, like moveImageLayer — checkpointed once at drag-start via onDragCheckpoint. */
  resizeImageLayer: (layerId: string, rect: { x: number; y: number; width: number; height: number }) => void
  selectLayer: (layerId: string | null) => void
  /** Opens the layers list view (clearing any other selection) — e.g. from the toolbar button. */
  openLayersPanel: () => void
  /** Closes the layers list view and deselects any layer whose settings were showing. */
  closeLayersPanel: () => void
  toggleLayersPanel: () => void
  setImageAspectLocked: (locked: boolean) => void
  /** keepPlacing is true when Shift was held, so the tool stays active for placing several points in a row. */
  addConnectionPoint: (layerId: string, relX: number, relY: number, keepPlacing?: boolean) => void
  deleteConnectionPoint: (layerId: string, pointId: string) => void

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
  freeShapes: [],
  selectedShapeIds: [],
  leaderLines: [],
  selectedLeaderLineIds: [],
  selectedLeaderLinePoint: null,
  layers: [DEFAULT_VECTOR_LAYER],
  selectedLayerId: null,
  layersPanelOpen: false,
  imageAspectLocked: true,
  tool: 'select',
  placingType: null,
  drawingShapeKind: null,
  connectionPointTargetLayerId: null,
  gridSize: BASE_GRID_SIZE,
  tagRenameError: null,
  routeError: null,
  groupDragOrigins: null,
  groupDragPipePoints: null,
  past: [],
  future: [],

  projectName: 'my-project',
  availableProjects: [],
  serverStatus: null,
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

  deleteInstance: (instanceId) =>
    set((state) => {
      const removed = new Set([instanceId])
      return {
        ...pushHistory(state),
        instances: state.instances.filter((inst) => inst.instanceId !== instanceId),
        // Pipes attached to the deleted instance are kept, not removed — the
        // detached end becomes a fixed FreePoint ("knot") at the port's last
        // position instead of a dangling reference that would otherwise
        // silently stop rendering.
        pipes: recomputeVolumeTags(detachPipesFromInstances(state.pipes, state.instances, removed)),
        leaderLines: detachLeaderLinesFromInstances(state.leaderLines, state.instances, removed),
        selectedInstanceIds: state.selectedInstanceIds.filter((id) => id !== instanceId),
        selectedRole: state.selectedRole?.instanceId === instanceId ? null : state.selectedRole,
        tagRenameError: null,
      }
    }),

  deleteInstances: (instanceIds) =>
    set((state) => {
      const removed = new Set(instanceIds)
      return {
        ...pushHistory(state),
        instances: state.instances.filter((inst) => !removed.has(inst.instanceId)),
        pipes: recomputeVolumeTags(detachPipesFromInstances(state.pipes, state.instances, removed)),
        leaderLines: detachLeaderLinesFromInstances(state.leaderLines, state.instances, removed),
        selectedInstanceIds: state.selectedInstanceIds.filter((id) => !removed.has(id)),
        selectedRole:
          state.selectedRole && removed.has(state.selectedRole.instanceId) ? null : state.selectedRole,
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
      const conflict =
        state.instances.some((inst) => inst.tag === trimmed && inst.instanceId !== instanceId) ||
        state.pipes.some((pipe) => pipe.tag === trimmed)
      if (conflict) {
        return { tagRenameError: `Tag "${trimmed}" is already in use.` }
      }
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
      const pipePointOrigins: { pipeId: string; point: 'from' | 'to' | number; origin: Point }[] = []
      for (const ref of pipePoints) {
        const pipe = state.pipes.find((p) => p.instanceId === ref.pipeId)
        if (!pipe) continue
        const origin =
          ref.point === 'from'
            ? (!isPortRef(pipe.fromPort) ? pipe.fromPort : null)
            : ref.point === 'to'
              ? (!isPortRef(pipe.toPort) ? pipe.toPort : null)
              : (pipe.waypoints[ref.point] ?? null)
        if (origin) pipePointOrigins.push({ ...ref, origin: { x: origin.x, y: origin.y } })
      }
      return { ...pushHistory(state), groupDragOrigins: origins, groupDragPipePoints: pipePointOrigins }
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
      return {
        pipes,
        instances: state.instances.map((inst) => {
          const origin = origins[inst.instanceId]
          if (!origin) return inst
          return { ...inst, transform: { ...inst.transform, x: origin.x + delta.x, y: origin.y + delta.y } }
        }),
      }
    }),

  endGroupDrag: () => set({ groupDragOrigins: null, groupDragPipePoints: null }),

  selectInstances: (instanceIds) =>
    set({
      selectedInstanceIds: instanceIds,
      selectedRole: null,
      selectedPipeIds: instanceIds.length > 0 ? [] : get().selectedPipeIds,
      selectedWaypoint: null,
      selectedShapeIds: instanceIds.length > 0 ? [] : get().selectedShapeIds,
      selectedLayerId: instanceIds.length > 0 ? null : get().selectedLayerId,
      selectedLeaderLineIds: instanceIds.length > 0 ? [] : get().selectedLeaderLineIds,
      selectedLeaderLinePoint: instanceIds.length > 0 ? null : get().selectedLeaderLinePoint,
      tagRenameError: null,
    }),

  selectAll: () =>
    set((state) => ({
      selectedInstanceIds: state.instances.map((inst) => inst.instanceId),
      selectedRole: null,
      selectedPipeIds: [],
      selectedWaypoint: null,
      selectedShapeIds: [],
      selectedLayerId: null,
      selectedLeaderLineIds: [],
      selectedLeaderLinePoint: null,
      tagRenameError: null,
    })),

  selectRole: (selection) => set({ selectedRole: selection }),

  nudgeSelection: (direction, fine) =>
    set((state) => {
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

      if (state.selectedInstanceIds.length > 0) {
        const step = fine ? INSTANCE_NUDGE_STEP_FAST : INSTANCE_NUDGE_STEP
        const delta = { x: direction.x * step, y: direction.y * step }
        return {
          ...pushHistory(state),
          instances: state.instances.map((inst) =>
            state.selectedInstanceIds.includes(inst.instanceId)
              ? { ...inst, transform: { ...inst.transform, x: inst.transform.x + delta.x, y: inst.transform.y + delta.y } }
              : inst,
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
      // Switching tools deselects a selected image layer — except arming
      // the connection-point tool from that same layer's own "Add
      // connection point" button, which isn't "another tool" from the
      // user's perspective, just a mode of editing the selected layer.
      selectedLayerId:
        tool === 'place-connection-point' && componentTypeId === state.selectedLayerId
          ? state.selectedLayerId
          : null,
    })),

  cancelTool: () =>
    set({ tool: 'select', placingType: null, drawingShapeKind: null, connectionPointTargetLayerId: null }),

  setGridSize: (size) => set({ gridSize: size }),

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
        // Old selections may point at instances/pipes/shapes that no longer
        // exist (or exist again) after rewinding — simplest correct behavior
        // is to just clear them rather than try to reconcile.
        selectedInstanceIds: [],
        selectedRole: null,
        selectedPipeIds: [],
        selectedWaypoint: null,
        selectedShapeIds: [],
        selectedLayerId: null,
        selectedLeaderLineIds: [],
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
        selectedInstanceIds: [],
        selectedRole: null,
        selectedPipeIds: [],
        selectedWaypoint: null,
        selectedShapeIds: [],
        selectedLayerId: null,
        selectedLeaderLineIds: [],
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
        indicatorEnabled: false,
        strokeColor: null,
        volumeTag: null,
        hopOverrides: {},
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
    set((state) => ({
      ...pushHistory(state),
      pipes: recomputeVolumeTags(state.pipes.filter((p) => !pipeIds.includes(p.instanceId))),
      selectedPipeIds: state.selectedPipeIds.filter((id) => !pipeIds.includes(id)),
      selectedWaypoint:
        state.selectedWaypoint && pipeIds.includes(state.selectedWaypoint.pipeId)
          ? null
          : state.selectedWaypoint,
    })),

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

  setPipeIndicatorEnabled: (pipeId, enabled) =>
    set((state) => ({
      ...pushHistory(state),
      pipes: state.pipes.map((p) => (p.instanceId === pipeId ? { ...p, indicatorEnabled: enabled } : p)),
    })),

  setPipeColor: (pipeId, color) =>
    set((state) => ({
      ...pushHistory(state),
      pipes: state.pipes.map((p) => (p.instanceId === pipeId ? { ...p, strokeColor: color } : p)),
    })),

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

  insertPipeWaypoint: (pipeId, index, pt) =>
    set((state) => ({
      ...pushHistory(state),
      pipes: state.pipes.map((p) =>
        p.instanceId === pipeId
          ? {
              ...p,
              waypoints: [
                ...p.waypoints.slice(0, index),
                { x: pt.x, y: pt.y, kind: 'corner' as const },
                ...p.waypoints.slice(index),
              ],
            }
          : p,
      ),
      selectedPipeIds: [pipeId],
      selectedInstanceIds: [],
      selectedRole: null,
      selectedShapeIds: [],
      selectedLayerId: null,
      selectedWaypoint: { pipeId, index },
      tagRenameError: null,
      routeError: null,
    })),

  deletePipeWaypoint: (pipeId, index) =>
    set((state) => ({
      ...pushHistory(state),
      pipes: state.pipes.map((p) =>
        p.instanceId === pipeId ? { ...p, waypoints: p.waypoints.filter((_, i) => i !== index) } : p,
      ),
      selectedWaypoint: null,
    })),

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

  autoRoutePipe: (pipeId) =>
    set((state) => {
      const pipe = state.pipes.find((p) => p.instanceId === pipeId)
      if (!pipe) return {}
      const ignoreInstanceIds = new Set<string>()
      if (isPortRef(pipe.fromPort)) ignoreInstanceIds.add(pipe.fromPort.instanceId)
      if (isPortRef(pipe.toPort)) ignoreInstanceIds.add(pipe.toPort.instanceId)

      const waypoints = computeAutoRoute(pipe, state.instances, state.pipes, state.layers, {
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
      selectedShapeIds: pipeIds.length > 0 ? [] : get().selectedShapeIds,
      selectedLayerId: pipeIds.length > 0 ? null : get().selectedLayerId,
      selectedLeaderLineIds: pipeIds.length > 0 ? [] : get().selectedLeaderLineIds,
      selectedLeaderLinePoint: pipeIds.length > 0 ? null : get().selectedLeaderLinePoint,
      tagRenameError: null,
      routeError: null,
    }),

  selectWaypoint: (selection) => set({ selectedWaypoint: selection }),

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
    set((state) => ({
      ...pushHistory(state),
      freeShapes: state.freeShapes.filter((s) => !shapeIds.includes(s.instanceId)),
      selectedShapeIds: state.selectedShapeIds.filter((id) => !shapeIds.includes(id)),
    })),

  moveShape: (shapeId, points) =>
    set((state) => ({
      freeShapes: state.freeShapes.map((s) => (s.instanceId === shapeId ? { ...s, points } : s)),
    })),

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

  selectShapes: (shapeIds) =>
    set({
      selectedShapeIds: shapeIds,
      selectedInstanceIds: shapeIds.length > 0 ? [] : get().selectedInstanceIds,
      selectedPipeIds: shapeIds.length > 0 ? [] : get().selectedPipeIds,
      selectedRole: null,
      selectedWaypoint: null,
      selectedLayerId: shapeIds.length > 0 ? null : get().selectedLayerId,
      selectedLeaderLineIds: shapeIds.length > 0 ? [] : get().selectedLeaderLineIds,
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
        tagRenameError: null,
        tool: 'select',
      }
    }),

  deleteLeaderLines: (leaderLineIds) =>
    set((state) => ({
      ...pushHistory(state),
      leaderLines: state.leaderLines.filter((l) => !leaderLineIds.includes(l.instanceId)),
      selectedLeaderLineIds: state.selectedLeaderLineIds.filter((id) => !leaderLineIds.includes(id)),
      selectedLeaderLinePoint:
        state.selectedLeaderLinePoint && leaderLineIds.includes(state.selectedLeaderLinePoint.leaderLineId)
          ? null
          : state.selectedLeaderLinePoint,
    })),

  // Continuous drag, like moveShape/moveInstance — checkpointed once at
  // drag-start via onDragCheckpoint, not on every pointermove.
  moveLeaderLinePoint: (leaderLineId, point, pos) =>
    set((state) => ({
      leaderLines: state.leaderLines.map((l) => {
        if (l.instanceId !== leaderLineId) return l
        if (point === 'to') return { ...l, to: pos }
        return { ...l, waypoints: l.waypoints.map((wp, i) => (i === point ? pos : wp)) }
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
      selectedLayerId: leaderLineIds.length > 0 ? null : get().selectedLayerId,
      selectedLeaderLinePoint: null,
      tagRenameError: null,
    }),

  selectLeaderLinePoint: (selection) => set({ selectedLeaderLinePoint: selection }),

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

  deleteLayer: (layerId) =>
    set((state) => ({
      ...pushHistory(state),
      layers: state.layers.filter((l) => l.layerId !== layerId),
      selectedLayerId: state.selectedLayerId === layerId ? null : state.selectedLayerId,
    })),

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

  selectLayer: (layerId) =>
    set({
      selectedLayerId: layerId,
      selectedInstanceIds: layerId ? [] : get().selectedInstanceIds,
      selectedPipeIds: layerId ? [] : get().selectedPipeIds,
      selectedShapeIds: layerId ? [] : get().selectedShapeIds,
      selectedLeaderLineIds: layerId ? [] : get().selectedLeaderLineIds,
      selectedLeaderLinePoint: layerId ? null : get().selectedLeaderLinePoint,
      selectedRole: null,
      selectedWaypoint: null,
      tagRenameError: null,
    }),

  openLayersPanel: () =>
    set({
      layersPanelOpen: true,
      selectedLayerId: null,
      selectedInstanceIds: [],
      selectedPipeIds: [],
      selectedShapeIds: [],
      selectedLeaderLineIds: [],
      selectedLeaderLinePoint: null,
      selectedRole: null,
      selectedWaypoint: null,
      tagRenameError: null,
    }),

  closeLayersPanel: () => set({ layersPanelOpen: false, selectedLayerId: null }),

  toggleLayersPanel: () => {
    const state = get()
    if (state.layersPanelOpen || state.selectedLayerId) get().closeLayersPanel()
    else get().openLayersPanel()
  },

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

  setProjectName: (name) => set({ projectName: name }),

  refreshProjectList: async () => {
    try {
      const projects = await api.listProjects()
      set({ availableProjects: projects })
    } catch (err) {
      set({ serverStatus: `Failed to list projects: ${(err as Error).message}` })
    }
  },

  /**
   * Called once on app mount (see App.tsx): a fresh page load otherwise
   * starts from the client-side default empty project (projectName:
   * 'my-project', but nothing actually loaded from the server) even though
   * a same-named project may already exist there from a previous session —
   * reloading the page looked like silent data loss. If the current
   * projectName is among the server's projects, load it for real; otherwise
   * this is genuinely a fresh/never-saved project, left as-is.
   */
  loadInitialProject: async () => {
    try {
      const projects = await api.listProjects()
      set({ availableProjects: projects })
      if (projects.includes(get().projectName)) {
        await get().loadProjectFromServer(get().projectName)
      }
    } catch (err) {
      set({ serverStatus: `Failed to list projects: ${(err as Error).message}` })
    }
  },

  // Also the autosave debounce's target — see the module-scope subscriber
  // below the store. Cancels any pending debounce first so an explicit Save
  // click and a just-about-to-fire autosave never race each other.
  saveProjectToServer: async () => {
    cancelPendingAutosave()
    const state = get()
    set({ serverBusy: true, serverStatus: null, syncStatus: 'saving' })
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
        syncStatus: 'error',
        syncErrorMessage: (err as Error).message,
      })
    }
  },

  loadProjectFromServer: async (name) => {
    cancelPendingAutosave()
    set({ serverBusy: true, serverStatus: null })
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
        selectedInstanceIds: [],
        selectedPipeIds: [],
        selectedRole: null,
        selectedWaypoint: null,
        selectedShapeIds: [],
        selectedLeaderLineIds: [],
        selectedLeaderLinePoint: null,
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
      set({ serverBusy: false, serverStatus: `Load failed: ${(err as Error).message}` })
    }
  },

  exportToServer: async () => {
    const state = get()
    set({ serverBusy: true, serverStatus: null })
    try {
      const svg = exportProjectToSvg(state.instances, state.pipes, state.freeShapes, state.layers, state.leaderLines)
      await api.exportToServer(state.projectName, svg)
      set({ serverBusy: false, serverStatus: `Exported "${state.projectName}.svg" to the server.` })
    } catch (err) {
      set({ serverBusy: false, serverStatus: `Server export failed: ${(err as Error).message}` })
    }
  },

  renameProjectOnServer: async (oldName, newName) => {
    set({ serverBusy: true, serverStatus: null })
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
      set({ serverBusy: false, serverStatus: `Rename failed: ${(err as Error).message}` })
    }
  },

  duplicateProjectOnServer: async (name, newName) => {
    set({ serverBusy: true, serverStatus: null })
    try {
      await api.duplicateProject(name, newName)
      const projects = await api.listProjects()
      set({ serverBusy: false, serverStatus: `Duplicated "${name}" as "${newName}".`, availableProjects: projects })
    } catch (err) {
      set({ serverBusy: false, serverStatus: `Duplicate failed: ${(err as Error).message}` })
    }
  },

  trashProjectOnServer: async (name) => {
    set({ serverBusy: true, serverStatus: null })
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
      set({ serverBusy: false, serverStatus: `Delete failed: ${(err as Error).message}` })
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
      selectedInstanceIds: [],
      selectedPipeIds: [],
      selectedRole: null,
      selectedWaypoint: null,
      selectedShapeIds: [],
      selectedLeaderLineIds: [],
      selectedLeaderLinePoint: null,
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
      set({ versionsLoading: false, serverStatus: `Failed to load version history: ${(err as Error).message}` })
    }
  },

  restoreProjectVersion: async (name, timestamp) => {
    set({ serverBusy: true, serverStatus: null })
    try {
      await api.restoreProjectVersion(name, timestamp)
      if (get().projectName === name) {
        // Pull the now-restored content into the editor too, same as opening it fresh.
        await get().loadProjectFromServer(name)
      }
      const versions = await api.listProjectVersions(name)
      set({ serverBusy: false, serverStatus: `Restored version from ${new Date(timestamp).toLocaleString()}.`, versions })
    } catch (err) {
      set({ serverBusy: false, serverStatus: `Restore failed: ${(err as Error).message}` })
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
    state.layers !== prevState.layers
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
  }
}
