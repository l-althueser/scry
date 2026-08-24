import type { ComponentInstance, FreeShape, Layer, PipeInstance } from '@svg-editor/shared'
import { getPipePoints, midpoint, type Point } from '../pipes/pipeGeometry'

export interface TagSearchResult {
  kind: 'instance' | 'pipe'
  id: string
  tag: string
  /** Pipe only — shown for context, not itself searched/renamed here (see CLAUDE.md's Node-RED contract; renaming it fans out across a whole connected pipe run via renameVolumeTag). */
  volumeTag?: string | null
}

/** Case-insensitive substring match against ComponentInstance.tag / PipeInstance.tag only — not names, not volumeTag. */
export function searchTags(query: string, instances: ComponentInstance[], pipes: PipeInstance[]): TagSearchResult[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const instanceResults: TagSearchResult[] = instances
    .filter((i) => i.tag.toLowerCase().includes(q))
    .map((i) => ({ kind: 'instance', id: i.instanceId, tag: i.tag }))
  const pipeResults: TagSearchResult[] = pipes
    .filter((p) => p.tag.toLowerCase().includes(q))
    .map((p) => ({ kind: 'pipe', id: p.instanceId, tag: p.tag, volumeTag: p.volumeTag }))
  return [...instanceResults, ...pipeResults]
}

/** World-space point to center the canvas on for a given result — an instance's own anchor, or a pipe's midpoint. */
export function resolveSearchResultWorldPoint(
  result: TagSearchResult,
  instances: ComponentInstance[],
  pipes: PipeInstance[],
  layers: Layer[],
  freeShapes: FreeShape[] = [],
): Point | null {
  if (result.kind === 'instance') {
    const inst = instances.find((i) => i.instanceId === result.id)
    return inst ? { x: inst.transform.x, y: inst.transform.y } : null
  }
  const pipe = pipes.find((p) => p.instanceId === result.id)
  if (!pipe) return null
  const points = getPipePoints(pipe, instances, pipes, layers, freeShapes)
  return points ? midpoint(points) : null
}

export type RegexRenameStatus = 'ok' | 'unchanged' | 'invalid-format' | 'collision'

export interface RegexRenamePreviewRow {
  kind: 'instance' | 'pipe'
  id: string
  oldTag: string
  newTag: string
  status: RegexRenameStatus
}

/**
 * Applies pattern→replacement to every current search result's tag and
 * classifies the outcome, without mutating anything — the caller applies
 * only the `ok` rows via bulkRenameTagsByRegex once the user confirms.
 *
 * Collision policy (matches existing single-rename behavior — see
 * renameInstance vs renamePipeTag in projectStore.ts): a new tag colliding
 * with another INSTANCE tag (in this batch or elsewhere) is allowed — flows
 * through as `ok`, same as renameInstance's own no-conflict-check design;
 * the existing duplicateInstanceTagCount warning already covers surfacing
 * that later. A new tag colliding with any PIPE tag (in this batch or
 * elsewhere) is blocked as `collision`, matching renamePipeTag's own
 * conflict check — pipes never allow tag collisions.
 */
export function previewRegexRename(
  results: TagSearchResult[],
  pattern: string,
  replacement: string,
  allInstanceTags: string[],
  allPipeTags: string[],
  tagPattern: RegExp,
): RegexRenamePreviewRow[] | { error: string } {
  let re: RegExp
  try {
    re = new RegExp(pattern, 'g')
  } catch (err) {
    return { error: `Invalid regex: ${(err as Error).message}` }
  }

  // allInstanceTags/allPipeTags are passed by the caller already excluding
  // the ids being renamed here, so every entry is a genuinely untouched tag.
  const rows: RegexRenamePreviewRow[] = results.map((r) => {
    const newTag = r.tag.replace(re, replacement)
    const status: RegexRenameStatus = newTag === r.tag ? 'unchanged' : tagPattern.test(newTag) ? 'ok' : 'invalid-format'
    return { kind: r.kind, id: r.id, oldTag: r.tag, newTag, status }
  })

  const pipeTagCounts = new Map<string, number>()
  for (const r of rows) {
    if (r.status === 'ok' && r.kind === 'pipe') pipeTagCounts.set(r.newTag, (pipeTagCounts.get(r.newTag) ?? 0) + 1)
  }

  return rows.map((r) => {
    if (r.status !== 'ok') return r
    const collidesWithinBatchAsPipe = r.kind === 'pipe' && (pipeTagCounts.get(r.newTag) ?? 0) > 1
    const collidesWithExistingPipeTag = allPipeTags.includes(r.newTag)
    const collidesInstanceVsPipe = r.kind === 'instance' && allPipeTags.includes(r.newTag)
    const collidesPipeVsInstance = r.kind === 'pipe' && allInstanceTags.includes(r.newTag)
    if (collidesWithinBatchAsPipe || collidesWithExistingPipeTag || collidesInstanceVsPipe || collidesPipeVsInstance) {
      return { ...r, status: 'collision' }
    }
    return r
  })
}
