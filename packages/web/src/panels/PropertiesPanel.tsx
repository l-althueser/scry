import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore, TAG_PATTERN } from '../state/projectStore'
import {
  previewRegexRename,
  resolveSearchResultWorldPoint,
  searchTags,
  type RegexRenamePreviewRow,
  type TagSearchResult,
} from '../search/tagSearch'
import {
  computeCrossingsForPipe,
  computeDefaultArrowRotation,
  DEFAULT_ARROW_SIZE,
  getDisplayPoints,
  getPipePoints,
  PIPE_DEFAULT_COLOR,
  resolveIndicatorTag,
  type Point,
} from '../pipes/pipeGeometry'
import { DEFAULT_FONT_SIZE, boundsOfPoints } from '../shapes/freeShapeGeometry'
import { loadImageFile } from '../import/loadImageFile'
import { loadImage } from '../import/imageTransparency'
import { estimateDataUriBytes, formatBytes } from '../import/imageResize'
import {
  BOX_ROLE_FILL,
  LABEL_BOX_WIDTH,
  LABEL_ROLE_ORDER,
  componentHasPipeColorOption,
  getComponentType,
  resolveLabelWidth,
  rotatePoint,
  type InstanceOptionDescriptor,
} from '../library'
import { describeComposition, type CompositionCounts } from '../state/selectionDescription'

/** A small "ⓘ" glyph carrying a hover tooltip (native title) — tucks a long explanation out of the way, right next to whatever it explains, instead of a permanent paragraph taking up space below it. */
function InfoIcon({ text }: { text: string }) {
  return (
    <span className="info-icon" title={text}>
      ⓘ
    </span>
  )
}

/** One color field, same single-line layout everywhere it's used: label + swatch + None + Default. `value` null/undefined means "at default". `hint`, if given, becomes an InfoIcon next to the label instead of a separate paragraph. `resettable`, if given, overrides whether "Default" is clickable (defaults to `value != null`) — needed for a multi-selection swatch where `value` is deliberately null to show the placeholder color (the selected elements' colors differ) even though at least one of them still has an override to clear. */
function ColorPickerRow({
  label,
  value,
  defaultValue,
  onChange,
  hint,
  resettable,
}: {
  label: string
  value: string | null | undefined
  defaultValue: string
  onChange: (value: string | null) => void
  hint?: string
  resettable?: boolean
}) {
  const isTransparent = value === 'transparent'
  const canReset = resettable ?? value != null
  return (
    <div className="field-row color-row">
      <span className="color-row-label">
        {label}
        {hint && <InfoIcon text={hint} />}
      </span>
      <input
        type="color"
        value={isTransparent ? defaultValue : (value ?? defaultValue)}
        onChange={(e) => onChange(e.target.value)}
        disabled={isTransparent}
        style={{ flex: '0 0 auto', width: '2rem', padding: 0 }}
      />
      <button onClick={() => onChange('transparent')} disabled={isTransparent}>
        None
      </button>
      <button onClick={() => onChange(null)} disabled={!canReset}>
        Default
      </button>
    </div>
  )
}

type ColorFieldSummary = { value: string | null; resettable: boolean }

/** Summarizes one color field across a multi-selection: `value` is the shared value when every item agrees (including every item being unset/null, i.e. "all at default"), or null when they differ — the swatch then falls back to showing the fieldset's own placeholder color instead of picking one item's value arbitrarily. `resettable` is true whenever at least one item has a non-null override, regardless of whether they agree, so "Default" stays clickable to clear a mixed selection down to all-default in one click. */
function summarizeColorValues(values: (string | null | undefined)[]): ColorFieldSummary {
  if (values.length === 0) return { value: null, resettable: false }
  const normalized = values.map((v) => v ?? null)
  const resettable = normalized.some((v) => v !== null)
  const allSame = normalized.every((v) => v === normalized[0])
  return { value: allSame ? normalized[0] : null, resettable }
}

/**
 * One tag-search result row: click focuses the canvas on it (stays in
 * search mode), double-click selects it (leaves search mode — see the
 * search-mode branch in PropertiesPanel). Its own small inline rename
 * control lets a single tag be fixed without leaving the list; on submit
 * the row naturally drops out of the (live-derived) result list if the new
 * tag no longer matches the current query, same as any live filter.
 */
function SearchResultRow({
  result,
  onFocus,
  onSelect,
  onRename,
}: {
  result: TagSearchResult
  onFocus: () => void
  onSelect: () => void
  onRename: (newTag: string) => void
}) {
  const [renameInput, setRenameInput] = useState(result.tag)
  useEffect(() => setRenameInput(result.tag), [result.tag])

  return (
    <li className="layer-row">
      <button
        className="layer-name-button"
        onClick={onFocus}
        onDoubleClick={onSelect}
        title="Click to focus the canvas on it, double-click to select it"
      >
        {result.tag} <span className="field-hint">({result.kind === 'pipe' ? 'pipe' : 'component'})</span>
      </button>
      <div className="layer-row-buttons">
        <input
          className="project-name-input"
          style={{ width: '7rem' }}
          value={renameInput}
          onChange={(e) => setRenameInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && renameInput.trim() && renameInput !== result.tag) onRename(renameInput.trim())
          }}
        />
        <button
          className="tool-button"
          disabled={!renameInput.trim() || renameInput === result.tag}
          onClick={() => onRename(renameInput.trim())}
        >
          Rename
        </button>
      </div>
    </li>
  )
}

/** One reusable shortcut, keyed so every panel branch references the same keys/wording instead of each hand-writing its own — see ShortcutHint. */
const SHORTCUT = {
  duplicate: { keys: 'Ctrl+D', label: 'Duplicate selection' },
  copy: { keys: 'Ctrl+C', label: 'Copy selection' },
  group: { keys: 'Ctrl+G', label: 'Group selection' },
  ungroup: { keys: 'Ctrl+Shift+G', label: 'Ungroup' },
  deleteOne: { keys: 'Del', label: 'Delete' },
  deleteAll: { keys: 'Del', label: 'Delete all' },
  deselect: { keys: 'Esc', label: 'Deselect' },
  selectAll: { keys: 'Ctrl+A', label: 'Select all' },
  undo: { keys: 'Ctrl+Z', label: 'Undo' },
  redo: { keys: 'Ctrl+Shift+Z', label: 'Redo (also Ctrl+Y)' },
  move: { keys: '↑↓←→', label: 'Move — hold Shift for bigger steps' },
  rotate: { keys: 'R', label: 'Rotate 90°' },
} as const

/** A row of compact key-badges — the visible shortcut only; the full description is a native hover tooltip (title), not permanent text, so the panel stays scannable instead of a paragraph. Fits anywhere the badge's meaning is already obvious from context (e.g. "Del"/"Esc" right after a delete button). */
function ShortcutHint({ items }: { items: readonly { keys: string; label: string }[] }) {
  return (
    <p className="field-hint shortcut-hint">
      {items.map((it) => (
        <kbd key={it.keys + it.label} className="shortcut-badge" title={it.label}>
          {it.keys}
        </kbd>
      ))}
    </p>
  )
}

/** Same badges as ShortcutHint, but each one keeps a short inline word next to it — for shortcuts with no surrounding context to imply what they do (e.g. general app shortcuts on the empty-selection panel), a bare badge reads as a non-sequitur without hovering. */
function LabeledShortcutHint({ items }: { items: readonly { keys: string; word: string; label: string }[] }) {
  return (
    <p className="field-hint shortcut-hint">
      {items.map((it) => (
        <span key={it.keys + it.label} className="shortcut-pair">
          <kbd className="shortcut-badge" title={it.label}>
            {it.keys}
          </kbd>
          {it.word}
        </span>
      ))}
    </p>
  )
}

/**
 * Shared body for "a persisted Group is selected" and "2+ things are
 * selected but not (yet) grouped" — same composition summary, same
 * shared-style broadcast, same action-buttons-plus-hint layout. The style
 * broadcast is split into one fieldset per kind (Labels/Pipes/Shapes) so a
 * swatch only ever touches the kind its section names — no single "Stroke"
 * control silently recoloring label borders, pipe lines, and shape outlines
 * all at once. Leader lines have no style fields at all (see LeaderLine in
 * types.ts) so they never get a section. Differs only in heading, which
 * action buttons are offered, and where the style edit is applied (a
 * Group's members vs. the raw selection) — both wired in by the caller.
 */
function SelectionStylePanel({
  heading,
  counts,
  pipeStubInstanceCount,
  instanceColorSummary,
  pipeColorSummary,
  shapeColorSummary,
  onStyleChange,
  onPipeFlagChange,
  actions,
  footerNote,
  shortcuts,
}: {
  heading: string
  counts: CompositionCounts
  /** Selected instances whose icon has its own small pipe-connector stub (see componentHasPipeColorOption) — folded into the Pipes swatch below alongside real pipes, even when no real pipe is selected. */
  pipeStubInstanceCount: number
  /** Per-field summaries (see summarizeColorValues) across every selected label role, so each swatch shows the shared color when they agree, the placeholder when they don't, and only offers "Default" when at least one is actually overridden. */
  instanceColorSummary: { fill: ColorFieldSummary; stroke: ColorFieldSummary; text: ColorFieldSummary }
  pipeColorSummary: ColorFieldSummary
  shapeColorSummary: { fill: ColorFieldSummary; stroke: ColorFieldSummary }
  onStyleChange: (kind: 'instance' | 'pipe' | 'shape', field: 'fill' | 'stroke' | 'text', value: string | null) => void
  onPipeFlagChange: (field: 'indicatorEnabled' | 'nameEnabled', value: boolean) => void
  actions: { label: string; onClick: () => void; danger?: boolean }[]
  /** Plain-text note for anything that isn't a pure keyboard shortcut (e.g. "double-click a member to edit it individually") — shown above the badge row. */
  footerNote?: string
  shortcuts: readonly { keys: string; label: string }[]
}) {
  return (
    <aside className="properties-panel">
      <h2>{heading}</h2>
      <p className="field-hint">{describeComposition(counts)}</p>

      {counts.instances > 0 && (
        <fieldset className="field roles-field">
          <legend>Labels</legend>
          <p className="field-hint">Applies to every label on every selected instance at once, as a single undo step.</p>
          <ColorPickerRow
            label="Fill"
            value={instanceColorSummary.fill.value}
            resettable={instanceColorSummary.fill.resettable}
            defaultValue="#ffffff"
            onChange={(v) => onStyleChange('instance', 'fill', v)}
          />
          <ColorPickerRow
            label="Border"
            value={instanceColorSummary.stroke.value}
            resettable={instanceColorSummary.stroke.resettable}
            defaultValue="#000000"
            onChange={(v) => onStyleChange('instance', 'stroke', v)}
          />
          <ColorPickerRow
            label="Text"
            value={instanceColorSummary.text.value}
            resettable={instanceColorSummary.text.resettable}
            defaultValue="#000000"
            onChange={(v) => onStyleChange('instance', 'text', v)}
          />
        </fieldset>
      )}

      {(counts.pipes > 0 || pipeStubInstanceCount > 0) && (
        <fieldset className="field roles-field">
          <legend>Pipes</legend>
          <p className="field-hint">
            Applies to every selected pipe{pipeStubInstanceCount > 0 ? " and every selected component's own pipe stub" : ''} at
            once, as a single undo step.
          </p>
          <ColorPickerRow
            label="Line"
            value={pipeColorSummary.value}
            resettable={pipeColorSummary.resettable}
            defaultValue="#000000"
            onChange={(v) => onStyleChange('pipe', 'stroke', v)}
          />

          {counts.pipes > 0 && (
            <>
              <div className="field-row">
                <span style={{ flex: '1 1 auto' }}>Indicator (_pipe)</span>
                <button onClick={() => onPipeFlagChange('indicatorEnabled', true)}>Enable</button>
                <button onClick={() => onPipeFlagChange('indicatorEnabled', false)}>Disable</button>
              </div>
              <div className="field-row">
                <span style={{ flex: '1 1 auto' }}>Name label (_name)</span>
                <button onClick={() => onPipeFlagChange('nameEnabled', true)}>Enable</button>
                <button onClick={() => onPipeFlagChange('nameEnabled', false)}>Disable</button>
              </div>
            </>
          )}
        </fieldset>
      )}

      {counts.shapes > 0 && (
        <fieldset className="field roles-field">
          <legend>Shapes</legend>
          <p className="field-hint">Applies to every selected shape at once, as a single undo step.</p>
          <ColorPickerRow
            label="Fill"
            value={shapeColorSummary.fill.value}
            resettable={shapeColorSummary.fill.resettable}
            defaultValue="#ffffff"
            onChange={(v) => onStyleChange('shape', 'fill', v)}
          />
          <ColorPickerRow
            label="Stroke"
            value={shapeColorSummary.stroke.value}
            resettable={shapeColorSummary.stroke.resettable}
            defaultValue="#000000"
            onChange={(v) => onStyleChange('shape', 'stroke', v)}
          />
        </fieldset>
      )}

      <div className="field-row">
        {actions.map((a) => (
          <button key={a.label} className={a.danger ? 'danger' : undefined} onClick={a.onClick}>
            {a.label}
          </button>
        ))}
      </div>
      {footerNote && <p className="field-hint">{footerNote}</p>}
      <ShortcutHint items={shortcuts} />
    </aside>
  )
}

export function PropertiesPanel({ onFocusResult }: { onFocusResult: (point: Point) => void }) {
  const selectedInstanceIds = useProjectStore((s) => s.selectedInstanceIds)
  const instances = useProjectStore((s) => s.instances)
  const selectedPipeIds = useProjectStore((s) => s.selectedPipeIds)
  const pipes = useProjectStore((s) => s.pipes)
  const selectedShapeIds = useProjectStore((s) => s.selectedShapeIds)
  const freeShapes = useProjectStore((s) => s.freeShapes)
  const selectedLeaderLineIds = useProjectStore((s) => s.selectedLeaderLineIds)
  const leaderLines = useProjectStore((s) => s.leaderLines)
  const deleteLeaderLines = useProjectStore((s) => s.deleteLeaderLines)
  const selectedGroupId = useProjectStore((s) => s.selectedGroupId)
  const groups = useProjectStore((s) => s.groups)
  const createGroup = useProjectStore((s) => s.createGroup)
  const ungroup = useProjectStore((s) => s.ungroup)
  const deleteGroup = useProjectStore((s) => s.deleteGroup)
  const duplicateSelection = useProjectStore((s) => s.duplicateSelection)
  const copySelectionToClipboard = useProjectStore((s) => s.copySelectionToClipboard)
  const setGroupStyle = useProjectStore((s) => s.setGroupStyle)
  const setSelectionStyle = useProjectStore((s) => s.setSelectionStyle)
  const setGroupPipeFlag = useProjectStore((s) => s.setGroupPipeFlag)
  const setSelectionPipeFlag = useProjectStore((s) => s.setSelectionPipeFlag)
  const deleteSelection = useProjectStore((s) => s.deleteSelection)
  const tagRenameError = useProjectStore((s) => s.tagRenameError)
  const renameInstance = useProjectStore((s) => s.renameInstance)
  const setRoleEnabled = useProjectStore((s) => s.setRoleEnabled)
  const setInstancePropertyValue = useProjectStore((s) => s.setInstancePropertyValue)
  const setInstancePosition = useProjectStore((s) => s.setInstancePosition)
  const setRolePosition = useProjectStore((s) => s.setRolePosition)
  const setRoleRotation = useProjectStore((s) => s.setRoleRotation)
  const setRoleColor = useProjectStore((s) => s.setRoleColor)
  const setRoleLabelTextOverride = useProjectStore((s) => s.setRoleLabelTextOverride)
  const deleteInstance = useProjectStore((s) => s.deleteInstance)
  const rotateInstance = useProjectStore((s) => s.rotateInstance)
  const centerRoles = useProjectStore((s) => s.centerRoles)
  const renamePipeTag = useProjectStore((s) => s.renamePipeTag)
  const renameVolumeTag = useProjectStore((s) => s.renameVolumeTag)
  const setPipeIndicatorEnabled = useProjectStore((s) => s.setPipeIndicatorEnabled)
  const setPipeNameEnabled = useProjectStore((s) => s.setPipeNameEnabled)
  const selectedWaypoint = useProjectStore((s) => s.selectedWaypoint)
  const selectedEndpoint = useProjectStore((s) => s.selectedEndpoint)
  const setPipeArrow = useProjectStore((s) => s.setPipeArrow)
  const setPipeColor = useProjectStore((s) => s.setPipeColor)
  const setPipeRoutingMode = useProjectStore((s) => s.setPipeRoutingMode)
  const setHopOverride = useProjectStore((s) => s.setHopOverride)
  const autoRoutePipe = useProjectStore((s) => s.autoRoutePipe)
  const routeError = useProjectStore((s) => s.routeError)
  const deletePipes = useProjectStore((s) => s.deletePipes)
  const setShapeStyle = useProjectStore((s) => s.setShapeStyle)
  const setShapeText = useProjectStore((s) => s.setShapeText)
  const setShapeFontSize = useProjectStore((s) => s.setShapeFontSize)
  const setShapeTextAlign = useProjectStore((s) => s.setShapeTextAlign)
  const resizeShape = useProjectStore((s) => s.resizeShape)
  const deleteShapes = useProjectStore((s) => s.deleteShapes)
  const selectedLayerIds = useProjectStore((s) => s.selectedLayerIds)
  const layersPanelOpen = useProjectStore((s) => s.layersPanelOpen)
  const layers = useProjectStore((s) => s.layers)
  const addImageLayer = useProjectStore((s) => s.addImageLayer)
  const addShapeLayer = useProjectStore((s) => s.addShapeLayer)
  const setShapeLayer = useProjectStore((s) => s.setShapeLayer)
  const renameLayer = useProjectStore((s) => s.renameLayer)
  const setLayerVisible = useProjectStore((s) => s.setLayerVisible)
  const setLayerLocked = useProjectStore((s) => s.setLayerLocked)
  const setLayerOpacity = useProjectStore((s) => s.setLayerOpacity)
  const setLayerIncludeInExport = useProjectStore((s) => s.setLayerIncludeInExport)
  const setLayerShowGridOverImage = useProjectStore((s) => s.setLayerShowGridOverImage)
  const setLayerRect = useProjectStore((s) => s.setLayerRect)
  const imageAspectLocked = useProjectStore((s) => s.imageAspectLocked)
  const setImageAspectLocked = useProjectStore((s) => s.setImageAspectLocked)
  const moveLayer = useProjectStore((s) => s.moveLayer)
  const deleteLayer = useProjectStore((s) => s.deleteLayer)
  const selectLayers = useProjectStore((s) => s.selectLayers)
  const openLayersPanel = useProjectStore((s) => s.openLayersPanel)
  const closeLayersPanel = useProjectStore((s) => s.closeLayersPanel)
  const deleteConnectionPoint = useProjectStore((s) => s.deleteConnectionPoint)
  const deleteShapeConnectionPoint = useProjectStore((s) => s.deleteShapeConnectionPoint)
  const deleteInstanceConnectionPoint = useProjectStore((s) => s.deleteInstanceConnectionPoint)
  const selectedConnectionPoint = useProjectStore((s) => s.selectedConnectionPoint)
  const selectConnectionPoint = useProjectStore((s) => s.selectConnectionPoint)
  const setTool = useProjectStore((s) => s.setTool)
  const tool = useProjectStore((s) => s.tool)
  const pickTransparentColorTargetLayerId = useProjectStore((s) => s.pickTransparentColorTargetLayerId)
  const transparentColorTolerance = useProjectStore((s) => s.transparentColorTolerance)
  const setTransparentColorTolerance = useProjectStore((s) => s.setTransparentColorTolerance)
  const restoreOriginalImage = useProjectStore((s) => s.restoreOriginalImage)
  const resizeImagePixels = useProjectStore((s) => s.resizeImagePixels)
  const discardOriginalImage = useProjectStore((s) => s.discardOriginalImage)
  const checkpointHistory = useProjectStore((s) => s.checkpointHistory)
  const searchPanelOpen = useProjectStore((s) => s.searchPanelOpen)
  const closeSearchPanel = useProjectStore((s) => s.closeSearchPanel)
  const searchQuery = useProjectStore((s) => s.searchQuery)
  const setSearchQuery = useProjectStore((s) => s.setSearchQuery)
  const searchRegexPattern = useProjectStore((s) => s.searchRegexPattern)
  const setSearchRegexPattern = useProjectStore((s) => s.setSearchRegexPattern)
  const searchRegexReplacement = useProjectStore((s) => s.searchRegexReplacement)
  const setSearchRegexReplacement = useProjectStore((s) => s.setSearchRegexReplacement)
  const bulkRenameTagsByRegex = useProjectStore((s) => s.bulkRenameTagsByRegex)
  const selectInstances = useProjectStore((s) => s.selectInstances)
  const selectPipes = useProjectStore((s) => s.selectPipes)

  const selected = instances.filter((i) => selectedInstanceIds.includes(i.instanceId))
  const instance = selected.length === 1 ? selected[0] : undefined

  // Doesn't block anything (unlike renameInstance's own live uniqueness
  // check, which only guards a fresh rename) — a duplicate can still exist
  // from an older/imported project, or two custom types sharing a tag
  // prefix, and per CLAUDE.md's Node-RED contract, Node-RED's tag-discovery
  // regex silently lets the last matching occurrence in the exported SVG
  // text win on a collision rather than erroring, so this is worth flagging
  // even though it might be intentional (e.g. deliberately sharing an
  // "_indicator" tag isn't done this way — that's volumeTag on pipes, whose
  // shared id is "_pipe", not "_indicator").
  const duplicateInstanceTagCount = instance
    ? instances.filter((i) => i.tag === instance.tag).length
    : 0

  const selectedPipes = pipes.filter((p) => selectedPipeIds.includes(p.instanceId))
  const pipe = selectedPipes.length === 1 ? selectedPipes[0] : undefined

  const selectedShapes = freeShapes.filter((s) => selectedShapeIds.includes(s.instanceId))
  const shape = selectedShapes.length === 1 ? selectedShapes[0] : undefined

  const selectedLeaderLines = leaderLines.filter((l) => selectedLeaderLineIds.includes(l.instanceId))

  const selectedLayer = selectedLayerIds.length === 1 ? layers.find((l) => l.layerId === selectedLayerIds[0]) : undefined
  const vectorLayers = layers.filter((l) => l.kind === 'vector')

  // Computed unconditionally (not inside the search-mode branch below) so
  // this stays a plain hook call every render, same as every other useMemo
  // in this component — React's rules of hooks don't allow a hook call to
  // become conditional across renders, which a branch-local useMemo would.
  const searchResults = useMemo(
    () => searchTags(searchQuery, instances, pipes),
    [searchQuery, instances, pipes],
  )
  const regexPreview: RegexRenamePreviewRow[] | { error: string } | null = useMemo(() => {
    if (!searchRegexPattern) return null
    const renamedIds = new Set(searchResults.map((r) => r.id))
    const otherInstanceTags = instances.filter((i) => !renamedIds.has(i.instanceId)).map((i) => i.tag)
    const otherPipeTags = pipes.filter((p) => !renamedIds.has(p.instanceId)).map((p) => p.tag)
    return previewRegexRename(
      searchResults,
      searchRegexPattern,
      searchRegexReplacement,
      otherInstanceTags,
      otherPipeTags,
      TAG_PATTERN,
    )
  }, [searchResults, searchRegexPattern, searchRegexReplacement, instances, pipes])

  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const { src, width, height } = await loadImageFile(file)
      addImageLayer(file.name, src, width, height)
    } catch (err) {
      console.error('Failed to load image layer:', err)
    }
  }

  const [tagInput, setTagInput] = useState('')
  const [pipeTagInput, setPipeTagInput] = useState('')
  const [volumeTagInput, setVolumeTagInput] = useState('')
  const [shapeTextInput, setShapeTextInput] = useState('')
  const [layerNameInput, setLayerNameInput] = useState('')
  const [imageSizeInfo, setImageSizeInfo] = useState<{ width: number; height: number; bytes: number } | null>(null)
  const [resizeWidth, setResizeWidth] = useState(1)
  const [resizeHeight, setResizeHeight] = useState(1)
  const [resizeAspectLocked, setResizeAspectLocked] = useState(true)
  const [shapeAspectLocked, setShapeAspectLocked] = useState(true)

  useEffect(() => {
    setTagInput(instance?.tag ?? '')
  }, [instance?.instanceId, instance?.tag])

  useEffect(() => {
    setPipeTagInput(pipe?.tag ?? '')
  }, [pipe?.instanceId, pipe?.tag])

  useEffect(() => {
    setVolumeTagInput(pipe?.volumeTag ?? '')
  }, [pipe?.instanceId, pipe?.volumeTag])

  useEffect(() => {
    setShapeTextInput(shape?.text ?? '')
  }, [shape?.instanceId, shape?.text])

  useEffect(() => {
    setLayerNameInput(selectedLayer?.name ?? '')
  }, [selectedLayer?.layerId, selectedLayer?.name])

  useEffect(() => {
    if (!selectedLayer || selectedLayer.kind !== 'image') {
      setImageSizeInfo(null)
      return
    }
    const src = selectedLayer.src
    let cancelled = false
    loadImage(src)
      .then((img) => {
        if (cancelled) return
        const info = { width: img.naturalWidth, height: img.naturalHeight, bytes: estimateDataUriBytes(src) }
        setImageSizeInfo(info)
        setResizeWidth(info.width)
        setResizeHeight(info.height)
      })
      .catch(() => {
        if (!cancelled) setImageSizeInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [selectedLayer?.layerId, selectedLayer?.kind === 'image' ? selectedLayer.src : undefined])

  const volumeSiblings = pipe ? pipes.filter((p) => p.volumeTag === pipe.volumeTag) : []

  // Display-point map (per pipe's own routing mode) for crossing detection —
  // mirrors what SvgCanvas/pipeExport actually render, so the "Crossings"
  // list below matches what's visible on the canvas.
  const displayPointsByPipe = useMemo(() => {
    const map = new Map<string, Point[]>()
    for (const p of pipes) {
      const pts = getPipePoints(p, instances, pipes, layers, freeShapes)
      if (pts) map.set(p.instanceId, getDisplayPoints(p, pts))
    }
    return map
  }, [pipes, instances, layers, freeShapes])

  const crossings =
    pipe && pipe.routingMode !== 'curved' ? computeCrossingsForPipe(pipe.instanceId, pipes, displayPointsByPipe) : []

  // Checked before every other selection-category branch below: a group
  // selection means the four selection arrays currently equal exactly one
  // Group's membership (see selectGroup) — takes priority over pipes/
  // shapes/leaderLines/instances branches, none of which know about groups.
  // Double-click-to-enter (SvgCanvas) always re-selects just the one entered
  // member via a single-category select action, which clears selectedGroupId
  // — so entering a group naturally falls through to the normal
  // single-instance/pipe/shape/leader-line editors below, unchanged.
  if (selectedGroupId) {
    const group = groups.find((g) => g.groupId === selectedGroupId)
    if (!group) {
      return (
        <aside className="properties-panel">
          <p className="properties-empty">Select an instance or pipe to edit its properties.</p>
        </aside>
      )
    }
    const counts: CompositionCounts = {
      instances: group.members.filter((m) => m.kind === 'instance').length,
      pipes: group.members.filter((m) => m.kind === 'pipe').length,
      shapes: group.members.filter((m) => m.kind === 'shape').length,
      leaderLines: group.members.filter((m) => m.kind === 'leaderLine').length,
      images: group.members.filter((m) => m.kind === 'layer').length,
    }

    const groupInstances = group.members
      .filter((m) => m.kind === 'instance')
      .map((m) => instances.find((inst) => inst.instanceId === m.id))
      .filter((inst): inst is (typeof instances)[number] => !!inst)
    const groupPipeStubInstances = groupInstances.filter((inst) => componentHasPipeColorOption(inst.componentTypeId))
    const groupPipes = group.members
      .filter((m) => m.kind === 'pipe')
      .map((m) => pipes.find((p) => p.instanceId === m.id))
      .filter((p): p is (typeof pipes)[number] => !!p)
    const groupShapes = group.members
      .filter((m) => m.kind === 'shape')
      .map((m) => freeShapes.find((s) => s.instanceId === m.id))
      .filter((s): s is (typeof freeShapes)[number] => !!s)
    const groupLabelRoles = groupInstances.flatMap((inst) => inst.roles.filter((r) => r.role !== 'indicator'))

    return (
      <SelectionStylePanel
        heading="Group selected"
        counts={counts}
        pipeStubInstanceCount={groupPipeStubInstances.length}
        instanceColorSummary={{
          fill: summarizeColorValues(groupLabelRoles.map((r) => r.fillColor)),
          stroke: summarizeColorValues(groupLabelRoles.map((r) => r.strokeColor)),
          text: summarizeColorValues(groupLabelRoles.map((r) => r.textColor)),
        }}
        pipeColorSummary={summarizeColorValues([
          ...groupPipes.map((p) => p.strokeColor),
          ...groupPipeStubInstances.map((inst) =>
            typeof inst.propertyValues.pipeColor === 'string' ? inst.propertyValues.pipeColor : null,
          ),
        ])}
        shapeColorSummary={{
          fill: summarizeColorValues(groupShapes.map((s) => s.style.fill)),
          stroke: summarizeColorValues(groupShapes.map((s) => s.style.stroke)),
        }}
        onStyleChange={(kind, field, value) => setGroupStyle(selectedGroupId, kind, field, value)}
        onPipeFlagChange={(field, value) => setGroupPipeFlag(selectedGroupId, field, value)}
        actions={[
          { label: 'Duplicate', onClick: () => duplicateSelection() },
          { label: 'Copy', onClick: () => copySelectionToClipboard() },
          { label: 'Ungroup', onClick: () => ungroup(selectedGroupId) },
          { label: 'Delete group', onClick: () => deleteGroup(selectedGroupId), danger: true },
        ]}
        footerNote="Double-click a member to edit it individually."
        shortcuts={[SHORTCUT.duplicate, SHORTCUT.copy, SHORTCUT.ungroup, SHORTCUT.deselect]}
      />
    )
  }

  // A loose (ungrouped) multi-select spanning 2+ things, of any mix of
  // kinds — same shared-style/delete/Group-it-up experience as an actual
  // Group, just not persisted yet. Checked before every per-kind branch
  // below (pipes/shapes/leaderLines/instances) so none of their single-item
  // priority ordering swallows a mixed selection into e.g. "1 pipe
  // selected" while ignoring instances also selected alongside it.
  const totalSelected =
    selected.length + selectedPipes.length + selectedShapes.length + selectedLeaderLines.length + selectedLayerIds.length
  if (totalSelected > 1) {
    const selectedPipeStubInstances = selected.filter((inst) => componentHasPipeColorOption(inst.componentTypeId))
    const selectedLabelRoles = selected.flatMap((inst) => inst.roles.filter((r) => r.role !== 'indicator'))
    return (
      <SelectionStylePanel
        heading={`${totalSelected} selected`}
        counts={{
          instances: selected.length,
          pipes: selectedPipes.length,
          shapes: selectedShapes.length,
          leaderLines: selectedLeaderLines.length,
          images: selectedLayerIds.length,
        }}
        pipeStubInstanceCount={selectedPipeStubInstances.length}
        instanceColorSummary={{
          fill: summarizeColorValues(selectedLabelRoles.map((r) => r.fillColor)),
          stroke: summarizeColorValues(selectedLabelRoles.map((r) => r.strokeColor)),
          text: summarizeColorValues(selectedLabelRoles.map((r) => r.textColor)),
        }}
        pipeColorSummary={summarizeColorValues([
          ...selectedPipes.map((p) => p.strokeColor),
          ...selectedPipeStubInstances.map((inst) =>
            typeof inst.propertyValues.pipeColor === 'string' ? inst.propertyValues.pipeColor : null,
          ),
        ])}
        shapeColorSummary={{
          fill: summarizeColorValues(selectedShapes.map((s) => s.style.fill)),
          stroke: summarizeColorValues(selectedShapes.map((s) => s.style.stroke)),
        }}
        onStyleChange={(kind, field, value) => setSelectionStyle(kind, field, value)}
        onPipeFlagChange={(field, value) => setSelectionPipeFlag(field, value)}
        actions={[
          { label: 'Duplicate', onClick: () => duplicateSelection() },
          { label: 'Copy', onClick: () => copySelectionToClipboard() },
          { label: 'Group', onClick: () => createGroup() },
          { label: 'Delete all', onClick: () => deleteSelection(), danger: true },
        ]}
        shortcuts={[SHORTCUT.duplicate, SHORTCUT.copy, SHORTCUT.group, SHORTCUT.deleteAll, SHORTCUT.deselect]}
      />
    )
  }

  if (selectedPipes.length > 0) {
    if (!pipe) {
      // Unreachable: 2+ pipes (or a pipe plus anything else) is intercepted
      // by the mixed-selection branch above — kept as a type-safe fallback.
      return (
        <aside className="properties-panel">
          <p className="properties-empty">Select an instance or pipe to edit its properties.</p>
        </aside>
      )
    }

    return (
      <aside className="properties-panel">
        <h2>Pipe properties</h2>

        <fieldset className="field roles-field">
          <legend>Identity</legend>
          <label className="field">
            <span>Tag</span>
            <input
              value={pipeTagInput}
              onChange={(e) => {
                setPipeTagInput(e.target.value)
                renamePipeTag(pipe.instanceId, e.target.value)
              }}
            />
          </label>
          {tagRenameError && <p className="field-error">{tagRenameError}</p>}

          <label className="field">
            <span>
              Volume
              <InfoIcon
                text={
                  volumeSiblings.length > 1
                    ? `Shared with ${volumeSiblings.length - 1} other connected pipe${volumeSiblings.length - 1 === 1 ? '' : 's'} (no valve/component in between) — gas fills this whole run at once, so they all share one "_pipe" id.`
                    : 'Not connected to any other pipe right now (a component, e.g. a valve, sits between it and everything else) — its own one-pipe volume.'
                }
              />
            </span>
            <input
              value={volumeTagInput}
              onChange={(e) => {
                setVolumeTagInput(e.target.value)
                renameVolumeTag(pipe.instanceId, e.target.value)
              }}
            />
          </label>
        </fieldset>

        <fieldset className="field roles-field">
          <legend>Indicator &amp; color</legend>
          <label
            className="role-checkbox"
            title={
              (pipe.indicatorEnabled
                ? `Exports as ${resolveIndicatorTag(pipe)}_pipe — the pipe's own line, not a separate dot, so it's clickable/colorable along its whole length. Every segment in this connected run shares that id, so coloring it in Node-RED lights up the whole run at once.`
                : "Currently just a decorative line — Node-RED can't target it.") +
              (volumeSiblings.length > 1
                ? ` Toggling this applies to all ${volumeSiblings.length} pipes in this connected run, not just this segment.`
                : '')
            }
          >
            <input
              type="checkbox"
              checked={pipe.indicatorEnabled}
              onChange={(e) => setPipeIndicatorEnabled(pipe.instanceId, e.target.checked)}
            />
            clickable / colorable (_pipe)
          </label>

          <ColorPickerRow
            label="Line"
            value={pipe.strokeColor}
            defaultValue={PIPE_DEFAULT_COLOR}
            onChange={(v) => setPipeColor(pipe.instanceId, v)}
            hint={
              pipe.strokeColor
                ? `Custom color${volumeSiblings.length > 1 ? ' — applies to the whole connected run' : ''} overrides the default.`
                : 'Default: black.'
            }
          />

          <label
            className="role-checkbox"
            title={
              `Bare text showing ${resolveIndicatorTag(pipe)} — the volume tag, same as the indicator.` +
              (volumeSiblings.length > 1
                ? ` This run has ${volumeSiblings.length} connected segments; toggling this applies to all of them, but only one shows the label (at whichever segment has the most waypoints) instead of one per segment.`
                : " Shown at this pipe's midpoint.")
            }
          >
            <input
              type="checkbox"
              checked={pipe.nameEnabled}
              onChange={(e) => setPipeNameEnabled(pipe.instanceId, e.target.checked)}
            />
            show name label (_name)
          </label>
        </fieldset>

        {(() => {
          // The point currently focused for THIS pipe, if any — either an
          // interior waypoint or an end — expressed as a full-point-list
          // index (see PipeArrow's own doc comment for why: 0 = fromPort,
          // the last index = toPort, else waypointIndex + 1).
          let pointIndex: number | null = null
          if (selectedWaypoint && selectedWaypoint.pipeId === pipe.instanceId) {
            pointIndex = selectedWaypoint.index + 1
          } else if (selectedEndpoint && selectedEndpoint.pipeId === pipe.instanceId) {
            const rawPoints = getPipePoints(pipe, instances, pipes, layers, freeShapes)
            pointIndex = selectedEndpoint.side === 'from' ? 0 : rawPoints ? rawPoints.length - 1 : null
          }
          if (pointIndex === null) return null

          const arrow = (pipe.arrows ?? []).find((a) => a.pointIndex === pointIndex)
          const idx = pointIndex
          return (
            <fieldset className="field roles-field">
              <legend>Arrow at this point</legend>
              <label
                className="role-checkbox"
                title="Purely decorative — never read by Node-RED, just a visual direction cue."
              >
                <input
                  type="checkbox"
                  checked={!!arrow}
                  onChange={(e) => {
                    if (!e.target.checked) {
                      setPipeArrow(pipe.instanceId, idx, null)
                      return
                    }
                    const rawPoints = getPipePoints(pipe, instances, pipes, layers, freeShapes)
                    const rotationDeg = rawPoints ? computeDefaultArrowRotation(rawPoints, idx) : 0
                    setPipeArrow(pipe.instanceId, idx, { size: DEFAULT_ARROW_SIZE, rotationDeg })
                  }}
                />
                show arrow
              </label>
              {arrow && (
                <div className="field-row">
                  <label className="field">
                    <span>Size</span>
                    <input
                      type="number"
                      min={2}
                      max={100}
                      value={arrow.size}
                      onChange={(e) =>
                        setPipeArrow(pipe.instanceId, idx, {
                          size: Number(e.target.value) || DEFAULT_ARROW_SIZE,
                          rotationDeg: arrow.rotationDeg,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Rotation (&deg;)</span>
                    <input
                      type="number"
                      value={Math.round(arrow.rotationDeg)}
                      onChange={(e) =>
                        setPipeArrow(pipe.instanceId, idx, {
                          size: arrow.size,
                          rotationDeg: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </label>
                </div>
              )}
            </fieldset>
          )
        })()}

        <fieldset className="field roles-field">
          <legend>Routing</legend>
          <label className="role-checkbox" title="Supports crossing hop-arcs">
            <input
              type="radio"
              name="routing-mode"
              checked={pipe.routingMode === 'straight' || pipe.routingMode === 'manual'}
              onChange={() => setPipeRoutingMode(pipe.instanceId, 'straight')}
            />
            Straight
          </label>
          <label className="role-checkbox" title="Right-angle bends, supports hop-arcs">
            <input
              type="radio"
              name="routing-mode"
              checked={pipe.routingMode === 'orthogonal'}
              onChange={() => setPipeRoutingMode(pipe.instanceId, 'orthogonal')}
            />
            Orthogonal
          </label>
          <label className="role-checkbox" title="Smooth spline, no hop-arcs">
            <input
              type="radio"
              name="routing-mode"
              checked={pipe.routingMode === 'curved'}
              onChange={() => setPipeRoutingMode(pipe.instanceId, 'curved')}
            />
            Curved
          </label>
        </fieldset>

        <p className="field-hint">
          Canvas editing
          <InfoIcon
            text="Double-click anywhere on the line to add a new waypoint there. Drag a waypoint dot to reshape the run (snaps to the grid and to nearby ports/pipe points), or nudge the selected one with arrow keys — hold Shift while dragging to lock movement to horizontal/vertical from the waypoint's start position. Select a waypoint and press Delete/Backspace to remove just that one. The two square end handles are the pipe's actual connection points — drag one onto another port/pipe point to reattach it there, or drop it on empty space to disconnect that end (it stays put as a fixed point). To move the component an end is attached to instead of the pipe, click/drag its body elsewhere or use its own drag-handle rather than the exact port pixel. Deleting a connected component also leaves the pipe in place with a fixed knot where it used to attach."
          />
        </p>

        <div className="field-row">
          <button
            onClick={() => autoRoutePipe(pipe.instanceId)}
            title="Replaces this pipe's waypoints with a grid path that steps around other components' bounding boxes, and switches routing to orthogonal. Starting point, not a constraint — drag waypoints afterward same as any other pipe."
          >
            Auto-route (avoid components)
          </button>
        </div>
        {routeError && <p className="field-error">{routeError}</p>}

        {crossings.length > 0 && (
          <fieldset className="field roles-field">
            <legend>Crossings ({crossings.length})</legend>
            {crossings.map((c) => {
              const other = pipes.find((p) => p.instanceId === c.otherPipeId)
              return (
                <div key={c.id} className="field-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ flex: '1 1 auto' }}>
                    vs. {other?.tag ?? c.otherPipeId} —{' '}
                    {c.hopsHere ? 'this pipe hops' : 'other pipe hops'}
                    {c.overridden ? ' (manual)' : ' (default)'}
                  </span>
                  <button
                    disabled={c.hopsHere}
                    onClick={() => setHopOverride(pipe.instanceId, c.otherPipeId, c.id, 'self')}
                  >
                    Hop here
                  </button>
                  <button
                    disabled={!c.hopsHere}
                    onClick={() => setHopOverride(pipe.instanceId, c.otherPipeId, c.id, 'other')}
                  >
                    Don&apos;t hop
                  </button>
                  <button
                    disabled={!c.overridden}
                    onClick={() => setHopOverride(pipe.instanceId, c.otherPipeId, c.id, null)}
                  >
                    Reset
                  </button>
                </div>
              )
            })}
          </fieldset>
        )}

        <div className="field-row">
          <button className="danger" onClick={() => deletePipes([pipe.instanceId])}>
            Delete
          </button>
        </div>
        <ShortcutHint items={[SHORTCUT.deleteOne, SHORTCUT.deselect]} />
      </aside>
    )
  }

  if (selectedShapes.length > 0) {
    if (!shape) {
      // Unreachable: 2+ shapes (or a shape plus anything else) is
      // intercepted by the mixed-selection branch above — kept as a
      // type-safe fallback.
      return (
        <aside className="properties-panel">
          <p className="properties-empty">Select an instance or pipe to edit its properties.</p>
        </aside>
      )
    }

    return (
      <aside className="properties-panel">
        <h2 title="Purely a visual annotation — untagged, so Node-RED never reads or targets it.">Shape properties</h2>

        <label className="field">
          <span>
            Layer
            <InfoIcon text="Which layer this shape paints on — reorder layers in the Layers panel to put a shape behind or in front of an image layer." />
          </span>
          <select
            value={shape.layerId}
            onChange={(e) => {
              if (e.target.value === '__new__') {
                const newLayerId = addShapeLayer()
                setShapeLayer(shape.instanceId, newLayerId)
              } else {
                setShapeLayer(shape.instanceId, e.target.value)
              }
            }}
          >
            {vectorLayers.map((l) => (
              <option key={l.layerId} value={l.layerId}>
                {l.name}
              </option>
            ))}
            <option value="__new__">New layer…</option>
          </select>
        </label>

        {shape.kind === 'text' && (
          <fieldset className="field roles-field">
            <legend>Text</legend>
            <label className="field">
              <span>
                Content
                <InfoIcon text="Press Enter for a line break — multi-line text is fully supported." />
              </span>
              <textarea
                rows={3}
                value={shapeTextInput}
                onChange={(e) => {
                  setShapeTextInput(e.target.value)
                  setShapeText(shape.instanceId, e.target.value)
                }}
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span>Font size</span>
                <input
                  type="number"
                  min={6}
                  max={200}
                  value={shape.fontSize ?? DEFAULT_FONT_SIZE}
                  onChange={(e) => setShapeFontSize(shape.instanceId, Number(e.target.value) || DEFAULT_FONT_SIZE)}
                />
              </label>
              <label className="field">
                <span>Align</span>
                <select
                  value={shape.textAlign ?? 'left'}
                  onChange={(e) => setShapeTextAlign(shape.instanceId, e.target.value as 'left' | 'center' | 'right')}
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </label>
            </div>
          </fieldset>
        )}

        <fieldset className="field roles-field">
          <legend>Style</legend>
          <div className="field-row color-row">
            <span className="color-row-label">{shape.kind === 'text' ? 'Text' : 'Stroke'}</span>
            <input
              type="color"
              value={shape.style.stroke}
              onChange={(e) => setShapeStyle(shape.instanceId, { stroke: e.target.value })}
              style={{ flex: '0 0 auto', width: '2rem', padding: 0 }}
            />
          </div>

          {shape.kind !== 'line' && shape.kind !== 'text' && (
            <>
              <label className="role-checkbox">
                <input
                  type="checkbox"
                  checked={shape.style.fill !== null}
                  onChange={(e) =>
                    setShapeStyle(shape.instanceId, { fill: e.target.checked ? shape.style.stroke : null })
                  }
                />
                filled
              </label>
              {shape.style.fill !== null && (
                <div className="field-row color-row">
                  <span className="color-row-label">Fill</span>
                  <input
                    type="color"
                    value={shape.style.fill}
                    onChange={(e) => setShapeStyle(shape.instanceId, { fill: e.target.value })}
                    style={{ flex: '0 0 auto', width: '2rem', padding: 0 }}
                  />
                </div>
              )}
            </>
          )}

          <label className="field">
            <span>Stroke width</span>
            <input
              type="number"
              min={0}
              max={40}
              value={shape.style.strokeWidth}
              onChange={(e) => setShapeStyle(shape.instanceId, { strokeWidth: Number(e.target.value) || 0 })}
            />
          </label>
        </fieldset>

        {shape.kind !== 'text' &&
          (() => {
            const { minX, minY, maxX, maxY } = boundsOfPoints(shape.points)
            const width = maxX - minX
            const height = maxY - minY
            return (
              <fieldset className="field roles-field">
                <legend>Geometry</legend>
                <label className="role-checkbox">
                  <input
                    type="checkbox"
                    checked={shapeAspectLocked}
                    onChange={(e) => setShapeAspectLocked(e.target.checked)}
                  />
                  lock aspect ratio
                </label>
                <div className="field-row">
                  <label className="field">
                    <span>Width</span>
                    <input
                      type="number"
                      min={1}
                      value={Math.round(width)}
                      onChange={(e) => {
                        const newWidth = Math.max(1, Number(e.target.value) || 1)
                        const newHeight = shapeAspectLocked && width > 0 ? Math.max(1, Math.round((newWidth * height) / width)) : height
                        resizeShape(shape.instanceId, newWidth, newHeight)
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>Height</span>
                    <input
                      type="number"
                      min={1}
                      value={Math.round(height)}
                      onChange={(e) => {
                        const newHeight = Math.max(1, Number(e.target.value) || 1)
                        const newWidth = shapeAspectLocked && height > 0 ? Math.max(1, Math.round((newHeight * width) / height)) : width
                        resizeShape(shape.instanceId, newWidth, newHeight)
                      }}
                    />
                  </label>
                </div>
              </fieldset>
            )
          })()}

        {shape.kind !== 'text' && (
          <fieldset className="field roles-field">
            <legend>Connection points ({(shape.connectionPoints ?? []).length})</legend>
            {(shape.connectionPoints ?? []).length === 0 && <p className="field-hint">None yet.</p>}
            {(shape.connectionPoints ?? []).map((cp, i) => (
              <div key={cp.pointId} className="field-row">
                <button
                  className={
                    selectedConnectionPoint?.ownerKind === 'shape' &&
                    selectedConnectionPoint.ownerId === shape.instanceId &&
                    selectedConnectionPoint.pointId === cp.pointId
                      ? 'tool-button active'
                      : 'tool-button'
                  }
                  onClick={() =>
                    selectConnectionPoint({ ownerKind: 'shape', ownerId: shape.instanceId, pointId: cp.pointId })
                  }
                  title="Click to highlight on canvas — drag its handle there, or use arrow keys, to reposition it."
                >
                  #{i + 1} ({(cp.relX * 100).toFixed(0)}%, {(cp.relY * 100).toFixed(0)}%)
                </button>
                <button className="danger" onClick={() => deleteShapeConnectionPoint(shape.instanceId, cp.pointId)}>
                  Delete
                </button>
              </div>
            ))}
            <div className="field-row">
              <button
                onClick={() => setTool('place-connection-point-shape', shape.instanceId)}
                title="Click, then click a spot on the shape — pipes can snap to it afterwards, and it stays put on the shape (as a % of its bounding box) through later moves/resizes. Shift while clicking keeps adding several in a row."
              >
                Add connection point
              </button>
            </div>
          </fieldset>
        )}

        <p className="field-hint">Drag the shape on the canvas to move it (Shift locks to horizontal/vertical).</p>

        <div className="field-row">
          <button className="danger" onClick={() => deleteShapes([shape.instanceId])}>
            Delete
          </button>
        </div>
        <ShortcutHint items={[SHORTCUT.deleteOne, SHORTCUT.deselect]} />
      </aside>
    )
  }

  if (selectedLeaderLines.length > 0) {
    return (
      <aside className="properties-panel">
        <h2 title="A freeform annotation pointer — purely visual, untagged, so Node-RED never reads or targets it. Drag its end point (or an interior waypoint) on the canvas to reposition it — no grid snapping.">
          {selectedLeaderLines.length === 1 ? 'Leader line selected' : `${selectedLeaderLines.length} leader lines selected`}
        </h2>
        <div className="field-row">
          <button
            className="danger"
            onClick={() => deleteLeaderLines(selectedLeaderLines.map((l) => l.instanceId))}
          >
            {selectedLeaderLines.length === 1 ? 'Delete' : 'Delete all'}
          </button>
        </div>
        <ShortcutHint items={[SHORTCUT.deleteOne, SHORTCUT.deselect]} />
      </aside>
    )
  }

  if (selectedLayerIds.length === 1) {
    if (!selectedLayer) {
      return (
        <aside className="properties-panel">
          <p className="properties-empty">Layer no longer exists.</p>
        </aside>
      )
    }
    if (selectedLayer.kind !== 'image') {
      const vectorLayer = selectedLayer
      return (
        <aside className="properties-panel">
          <div className="field-row">
            <button onClick={() => openLayersPanel()}>&larr; All layers</button>
          </div>
          <label className="field">
            <span>Name</span>
            <input
              value={layerNameInput}
              onChange={(e) => {
                setLayerNameInput(e.target.value)
                renameLayer(vectorLayer.layerId, e.target.value)
              }}
            />
          </label>
          <label
            className="role-checkbox"
            title="Locked shapes on this layer can't be selected, dragged, resized, or nudged on the canvas — same rule as a locked image layer. Untick to edit them again, or use this layer's settings/properties panel entry point instead."
          >
            <input
              type="checkbox"
              checked={vectorLayer.locked}
              onChange={(e) => setLayerLocked(vectorLayer.layerId, e.target.checked)}
            />
            locked
          </label>
        </aside>
      )
    }
    const layer = selectedLayer

    return (
      <aside className="properties-panel">
        <div className="field-row">
          <button onClick={() => openLayersPanel()}>&larr; All layers</button>
        </div>
        <h2>Layer properties</h2>

        <label className="field">
          <span>Name</span>
          <input
            value={layerNameInput}
            onChange={(e) => {
              setLayerNameInput(e.target.value)
              renameLayer(layer.layerId, e.target.value)
            }}
          />
        </label>

        <fieldset className="field roles-field">
          <legend>Display</legend>
          <label
            className="role-checkbox"
            title={
              layer.locked
                ? "Dragging on the canvas is disabled while locked — untick this to reposition it there, or just edit X/Y/Width/Height below."
                : 'Drag the image on the canvas to move it (Shift locks to horizontal/vertical).'
            }
          >
            <input
              type="checkbox"
              checked={layer.locked}
              onChange={(e) => setLayerLocked(layer.layerId, e.target.checked)}
            />
            locked
          </label>

          <label className="role-checkbox">
            <input
              type="checkbox"
              checked={layer.includeInExport}
              onChange={(e) => setLayerIncludeInExport(layer.layerId, e.target.checked)}
            />
            include in exported SVG
          </label>

          <label className="role-checkbox">
            <input
              type="checkbox"
              checked={layer.showGridOverImage ?? false}
              onChange={(e) => setLayerShowGridOverImage(layer.layerId, e.target.checked)}
            />
            show grid over this image
          </label>

          <label className="field">
            <span>
              Color offset
              <InfoIcon text="How close a pixel's color has to be to the clicked one to also become transparent (per color channel, 0-255). 0 = exact match only; higher catches JPEG noise, anti-aliased edges, or an off-white background too — but too high can eat into colors you meant to keep." />
            </span>
            <input
              type="number"
              min={0}
              max={255}
              value={transparentColorTolerance}
              onChange={(e) => setTransparentColorTolerance(Number(e.target.value) || 0, layer.layerId)}
            />
          </label>

          <div className="field-row">
            <button
              onClick={() => setTool('pick-transparent-color', layer.layerId)}
              title="Click, then click a pixel on the image — that color (within the offset below) becomes transparent everywhere in the image, same as PowerPoint's 'Set Transparent Color' (e.g. removing a white background)."
            >
              Set transparent color
            </button>
            {layer.originalSrc && (
              <button
                onClick={() => restoreOriginalImage(layer.layerId)}
                title="Undo every 'Set transparent color' edit and go back to the originally imported image."
              >
                Restore original image
              </button>
            )}
          </div>
          {tool === 'pick-transparent-color' && pickTransparentColorTargetLayerId === layer.layerId && (
            <p className="field-hint">Click a pixel on the image to make that color transparent…</p>
          )}

          <label className="field">
            <span>Opacity ({Math.round(layer.opacity * 100)}%)</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={layer.opacity}
              onPointerDown={() => checkpointHistory()}
              onChange={(e) => setLayerOpacity(layer.layerId, Number(e.target.value))}
            />
          </label>
        </fieldset>

        <fieldset className="field roles-field">
          <legend>File size</legend>
          <p className="field-hint">
            {imageSizeInfo
              ? `${imageSizeInfo.width} × ${imageSizeInfo.height} px · ${formatBytes(imageSizeInfo.bytes)}`
              : 'Loading…'}
          </p>
          <div className="layer-rect-grid">
            <label className="field">
              <span>Width (px)</span>
              <input
                type="number"
                min={1}
                value={resizeWidth}
                onChange={(e) => {
                  const width = Math.max(1, Number(e.target.value) || 1)
                  const height =
                    resizeAspectLocked && imageSizeInfo && resizeWidth > 0
                      ? Math.max(1, Math.round((width * resizeHeight) / resizeWidth))
                      : resizeHeight
                  setResizeWidth(width)
                  setResizeHeight(height)
                }}
              />
            </label>
            <label className="field">
              <span>Height (px)</span>
              <input
                type="number"
                min={1}
                value={resizeHeight}
                onChange={(e) => {
                  const height = Math.max(1, Number(e.target.value) || 1)
                  const width =
                    resizeAspectLocked && imageSizeInfo && resizeHeight > 0
                      ? Math.max(1, Math.round((height * resizeWidth) / resizeHeight))
                      : resizeWidth
                  setResizeHeight(height)
                  setResizeWidth(width)
                }}
              />
            </label>
          </div>
          <label className="role-checkbox">
            <input
              type="checkbox"
              checked={resizeAspectLocked}
              onChange={(e) => setResizeAspectLocked(e.target.checked)}
            />
            lock aspect ratio
          </label>
          <div className="field-row">
            <button
              onClick={() => resizeImagePixels(layer.layerId, resizeWidth, resizeHeight)}
              title="Re-encodes the image at this native pixel size to shrink its file size — this is independent of the on-canvas Width/Height below, which only control its display size."
            >
              Resize image
            </button>
            {layer.originalSrc && (
              <button
                className="danger"
                onClick={() => {
                  if (
                    confirm(
                      'Permanently discard the original full-size image and keep only the current, smaller version? This cannot be undone once you save/close the project.',
                    )
                  ) {
                    discardOriginalImage(layer.layerId)
                  }
                }}
                title="Frees the storage the pre-edit original is holding onto — after this, 'Restore original image' is gone."
              >
                Discard original (keep this size)
              </button>
            )}
          </div>
        </fieldset>

        <fieldset className="field roles-field">
          <legend>Geometry</legend>
          <label
            className="role-checkbox"
            title="Also applies to the corner drag-handles on the canvas — hold Shift while dragging one to temporarily flip this lock."
          >
            <input
              type="checkbox"
              checked={imageAspectLocked}
              onChange={(e) => setImageAspectLocked(e.target.checked)}
            />
            lock aspect ratio
          </label>

          <div className="layer-rect-grid">
            <label className="field">
              <span>X</span>
              <input
                type="number"
                value={layer.x}
                onChange={(e) =>
                  setLayerRect(layer.layerId, {
                    x: Number(e.target.value) || 0,
                    y: layer.y,
                    width: layer.width,
                    height: layer.height,
                  })
                }
              />
            </label>
            <label className="field">
              <span>Y</span>
              <input
                type="number"
                value={layer.y}
                onChange={(e) =>
                  setLayerRect(layer.layerId, {
                    x: layer.x,
                    y: Number(e.target.value) || 0,
                    width: layer.width,
                    height: layer.height,
                  })
                }
              />
            </label>
            <label className="field">
              <span>Width</span>
              <input
                type="number"
                min={1}
                value={layer.width}
                onChange={(e) => {
                  const width = Math.max(1, Number(e.target.value) || 1)
                  const height =
                    imageAspectLocked && layer.width > 0
                      ? Math.max(1, Math.round((width * layer.height) / layer.width))
                      : layer.height
                  setLayerRect(layer.layerId, { x: layer.x, y: layer.y, width, height })
                }}
              />
            </label>
            <label className="field">
              <span>Height</span>
              <input
                type="number"
                min={1}
                value={layer.height}
                onChange={(e) => {
                  const height = Math.max(1, Number(e.target.value) || 1)
                  const width =
                    imageAspectLocked && layer.height > 0
                      ? Math.max(1, Math.round((height * layer.width) / layer.height))
                      : layer.width
                  setLayerRect(layer.layerId, { x: layer.x, y: layer.y, width, height })
                }}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="field roles-field">
          <legend>Connection points ({layer.connectionPoints.length})</legend>
          {layer.connectionPoints.length === 0 && <p className="field-hint">None yet.</p>}
          {layer.connectionPoints.map((cp, i) => (
            <div key={cp.pointId} className="field-row">
              <button
                className={
                  selectedConnectionPoint?.ownerKind === 'layer' &&
                  selectedConnectionPoint.ownerId === layer.layerId &&
                  selectedConnectionPoint.pointId === cp.pointId
                    ? 'tool-button active'
                    : 'tool-button'
                }
                onClick={() => selectConnectionPoint({ ownerKind: 'layer', ownerId: layer.layerId, pointId: cp.pointId })}
                title="Click to highlight on canvas — drag its handle there, or use arrow keys, to reposition it."
              >
                #{i + 1} ({(cp.relX * 100).toFixed(0)}%, {(cp.relY * 100).toFixed(0)}%)
              </button>
              <button className="danger" onClick={() => deleteConnectionPoint(layer.layerId, cp.pointId)}>
                Delete
              </button>
            </div>
          ))}
        </fieldset>
        <div className="field-row">
          <button
            onClick={() => setTool('place-connection-point', layer.layerId)}
            title="Click, then click a spot on the image — pipes can snap to it afterwards, and it stays put on the image (as a % of its width/height) through later drags/resizes. Shift while clicking keeps adding several in a row."
          >
            Add connection point
          </button>
        </div>

        <div className="field-row">
          <button className="danger" onClick={() => deleteLayer(layer.layerId)}>
            Delete layer
          </button>
        </div>
        <ShortcutHint items={[SHORTCUT.deleteOne, SHORTCUT.deselect]} />
      </aside>
    )
  }

  if (searchPanelOpen && selected.length === 0 && selectedPipes.length === 0) {
    return (
      <aside className="properties-panel">
        <div className="field-row properties-panel-header">
          <h2>Search tags</h2>
          <button className="tool-button" title="Close" onClick={() => closeSearchPanel()}>
            &times;
          </button>
        </div>

        <div className="field-row">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tag (e.g. HV208 or HV)"
            autoFocus
          />
        </div>
        {searchQuery.trim() && (
          <p className="field-hint">
            {searchResults.length} match{searchResults.length === 1 ? '' : 'es'}
          </p>
        )}

        <ul className="layer-list">
          {searchResults.map((result) => (
            <SearchResultRow
              key={`${result.kind}-${result.id}`}
              result={result}
              onFocus={() => {
                const point = resolveSearchResultWorldPoint(result, instances, pipes, layers, freeShapes)
                if (point) onFocusResult(point)
              }}
              onSelect={() => {
                closeSearchPanel()
                if (result.kind === 'instance') selectInstances([result.id])
                else selectPipes([result.id])
              }}
              onRename={(newTag) => {
                if (result.kind === 'instance') renameInstance(result.id, newTag)
                else renamePipeTag(result.id, newTag)
              }}
            />
          ))}
        </ul>

        <fieldset className="field roles-field">
          <legend>
            Regex rename
            <InfoIcon text="Applies to the tags currently listed above only — search first to narrow the scope, then replace across all of them at once." />
          </legend>
          <div className="field-row">
            <label className="field">
              <span>Pattern</span>
              <input
                type="text"
                value={searchRegexPattern}
                onChange={(e) => setSearchRegexPattern(e.target.value)}
                placeholder="HV"
              />
            </label>
            <label className="field">
              <span>Replacement</span>
              <input
                type="text"
                value={searchRegexReplacement}
                onChange={(e) => setSearchRegexReplacement(e.target.value)}
                placeholder="MV"
              />
            </label>
          </div>

          {regexPreview && 'error' in regexPreview && <p className="field-error">{regexPreview.error}</p>}

          {regexPreview && Array.isArray(regexPreview) && regexPreview.length > 0 && (
            <>
              <ul className="layer-list">
                {regexPreview.map((row) => (
                  <li key={`${row.kind}-${row.id}`} className="layer-row">
                    <span className="layer-name-button" style={{ cursor: 'default' }}>
                      {row.oldTag} → {row.newTag}{' '}
                      {row.status === 'invalid-format' && <span className="field-error">invalid tag format</span>}
                      {row.status === 'collision' && <span className="field-error">collides with another tag</span>}
                      {row.status === 'unchanged' && <span className="field-hint">unchanged</span>}
                    </span>
                  </li>
                ))}
              </ul>
              <button
                className="tool-button"
                disabled={
                  !regexPreview.some((r) => r.status === 'ok') ||
                  regexPreview.some((r) => r.status === 'invalid-format' || r.status === 'collision')
                }
                onClick={() =>
                  bulkRenameTagsByRegex(
                    regexPreview
                      .filter((r) => r.status === 'ok')
                      .map((r) => ({ kind: r.kind, id: r.id, newTag: r.newTag })),
                  )
                }
              >
                Apply to {regexPreview.filter((r) => r.status === 'ok').length} tag
                {regexPreview.filter((r) => r.status === 'ok').length === 1 ? '' : 's'}
              </button>
            </>
          )}
        </fieldset>
      </aside>
    )
  }

  if (layersPanelOpen && selected.length === 0) {
    // Top of the visual list = top of the z-order; layers array is stored bottom-first.
    const displayLayers = [...layers].reverse()

    return (
      <aside className="properties-panel">
        <div className="field-row properties-panel-header">
          <h2>Layers</h2>
          <button className="tool-button" title="Close" onClick={() => closeLayersPanel()}>
            &times;
          </button>
        </div>

        <div className="field-row">
          <button className="tool-button" onClick={() => fileInputRef.current?.click()}>
            Add image layer
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleFileChosen} />
        </div>

        <ul className="layer-list">
          {displayLayers.map((layer, displayIndex) => {
            const isDefaultVectorLayer = layer.kind === 'vector' && layer.layerId === 'default'
            const shapeLayerNonEmpty =
              layer.kind === 'vector' && !isDefaultVectorLayer && freeShapes.some((s) => s.layerId === layer.layerId)
            return (
              <li key={layer.layerId} className="layer-row">
                <label className="layer-visible-toggle" title={layer.visible ? 'Hide layer' : 'Show layer'}>
                  <input
                    type="checkbox"
                    checked={layer.visible}
                    onChange={(e) => setLayerVisible(layer.layerId, e.target.checked)}
                  />
                </label>
                <button
                  className="layer-name-button"
                  onClick={() => selectLayers([layer.layerId])}
                  title={layer.kind === 'image' ? 'Click for settings, position, and connection points' : 'Click to rename or lock this layer'}
                >
                  {layer.locked ? '\u{1F512} ' : ''}
                  {layer.name}
                </button>
                <div className="layer-row-buttons">
                  <button
                    className="tool-button"
                    disabled={displayIndex === 0}
                    title="Move up"
                    onClick={() => moveLayer(layer.layerId, 'up')}
                  >
                    &uarr;
                  </button>
                  <button
                    className="tool-button"
                    disabled={displayIndex === displayLayers.length - 1}
                    title="Move down"
                    onClick={() => moveLayer(layer.layerId, 'down')}
                  >
                    &darr;
                  </button>
                  {!isDefaultVectorLayer && (
                    <button
                      className="tool-button danger"
                      disabled={shapeLayerNonEmpty}
                      title={shapeLayerNonEmpty ? 'Move or delete this layer’s shapes first' : 'Delete layer'}
                      onClick={() => deleteLayer(layer.layerId)}
                    >
                      &times;
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        <p className="field-hint">Click a layer&apos;s name to edit its settings here.</p>
      </aside>
    )
  }

  if (selected.length === 0) {
    return (
      <aside className="properties-panel">
        <p className="properties-empty">Select an instance or pipe to edit its properties.</p>
        <p className="field-hint">
          Drag on empty canvas to box-select. <kbd className="shortcut-badge">Ctrl/Cmd+click</kbd>{' '}
          toggles one instance, <kbd className="shortcut-badge">Ctrl/Cmd+drag</kbd> adds to the
          selection. <kbd className="shortcut-badge">Shift+drag</kbd> on empty canvas pans;{' '}
          <kbd className="shortcut-badge">Shift</kbd> while dragging an instance, label, or
          waypoint locks movement to horizontal/vertical. <kbd className="shortcut-badge">Shift</kbd>{' '}
          while placing/drawing keeps the tool active for placing/drawing several in a row.
        </p>
        <LabeledShortcutHint
          items={[
            { ...SHORTCUT.selectAll, word: 'select all' },
            { ...SHORTCUT.undo, word: 'undo' },
            { ...SHORTCUT.redo, word: 'redo' },
          ]}
        />
      </aside>
    )
  }

  if (!instance) {
    // Unreachable in practice: selected.length > 1 is intercepted by the
    // mixed-selection branch above, and selected.length === 0 by the
    // "nothing selected" branch — kept only as a type-safe fallback.
    return (
      <aside className="properties-panel">
        <p className="properties-empty">Select an instance or pipe to edit its properties.</p>
      </aside>
    )
  }

  return (
    <aside className="properties-panel">
      <h2>Properties</h2>

      <fieldset className="field roles-field">
        <legend>Identity</legend>
        <label className="field">
          <span>Tag</span>
          <input
            value={tagInput}
            onChange={(e) => {
              setTagInput(e.target.value)
              renameInstance(instance.instanceId, e.target.value)
            }}
          />
        </label>
        {tagRenameError && <p className="field-error">{tagRenameError}</p>}
        {!tagRenameError && duplicateInstanceTagCount > 1 && (
          <p className="field-warning">Tag "{instance.tag}" is used by {duplicateInstanceTagCount} instances.</p>
        )}

        <div className="field-row">
          <label className="field">
            <span>X</span>
            <input
              type="number"
              value={instance.transform.x}
              onChange={(e) =>
                setInstancePosition(instance.instanceId, { x: Number(e.target.value) || 0, y: instance.transform.y })
              }
            />
          </label>
          <label className="field">
            <span>Y</span>
            <input
              type="number"
              value={instance.transform.y}
              onChange={(e) =>
                setInstancePosition(instance.instanceId, { x: instance.transform.x, y: Number(e.target.value) || 0 })
              }
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="field roles-field">
        <legend>
          Roles
          <InfoIcon
            text={`Exports as ${instance.tag}_<role> for each enabled role. Click a box/label on the canvas to select it individually (orange outline) — drag it, or nudge it with arrow keys (Shift for bigger steps) for fine placement.`}
          />
        </legend>
        {instance.roles.map((role) => (
          <label key={role.role} className="role-checkbox">
            <input
              type="checkbox"
              checked={role.enabled}
              onChange={(e) => setRoleEnabled(instance.instanceId, role.role, e.target.checked)}
            />
            {role.role}
          </label>
        ))}
      </fieldset>

      {(() => {
        const rawLabelWidth = instance.propertyValues.labelWidth
        const userLabelWidth = typeof rawLabelWidth === 'number' ? rawLabelWidth : LABEL_BOX_WIDTH
        const effectiveLabelWidth = resolveLabelWidth(instance)
        const autoGrown = effectiveLabelWidth > userLabelWidth + 0.01
        return (
          <fieldset className="field roles-field">
            <legend>
              Label width
              <InfoIcon text="Shared by every label box on this instance (name/value/setpoint) so they all line up. Grows automatically past this if the name text needs more room; never shrinks below it." />
            </legend>
            <div className="field-row">
              <label className="field">
                <span>Width</span>
                <input
                  type="number"
                  min={1}
                  value={userLabelWidth}
                  onChange={(e) =>
                    setInstancePropertyValue(instance.instanceId, 'labelWidth', Math.max(1, Number(e.target.value) || 1))
                  }
                />
              </label>
              <button
                disabled={typeof rawLabelWidth !== 'number'}
                onClick={() => setInstancePropertyValue(instance.instanceId, 'labelWidth', null)}
              >
                Default
              </button>
            </div>
            {autoGrown && (
              <p className="field-hint">
                Auto-widened to {Math.round(effectiveLabelWidth)} to fit the name — shrink the name or accept this width.
              </p>
            )}
          </fieldset>
        )
      })()}

      {instance.roles
        .filter((role) => LABEL_ROLE_ORDER.includes(role.role) && role.enabled)
        .map((role) => {
          const worldPos = rotatePoint(role.offset, instance.transform.rotationDeg)
          worldPos.x += instance.transform.x
          worldPos.y += instance.transform.y
          return (
            <fieldset key={role.role} className="field roles-field">
              <legend>Label: {role.role}</legend>
              {role.role === 'name' && (
                <label className="field">
                  <span>Display text</span>
                  <input
                    type="text"
                    placeholder={instance.tag}
                    value={role.labelTextOverride ?? ''}
                    onChange={(e) => setRoleLabelTextOverride(instance.instanceId, e.target.value)}
                  />
                </label>
              )}
              <div className="field-row">
                <label className="field">
                  <span>X</span>
                  <input
                    type="number"
                    value={Math.round(worldPos.x * 100) / 100}
                    onChange={(e) =>
                      setRolePosition(instance.instanceId, role.role, {
                        x: Number(e.target.value) || 0,
                        y: worldPos.y,
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Y</span>
                  <input
                    type="number"
                    value={Math.round(worldPos.y * 100) / 100}
                    onChange={(e) =>
                      setRolePosition(instance.instanceId, role.role, {
                        x: worldPos.x,
                        y: Number(e.target.value) || 0,
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Rot.</span>
                  <input
                    type="number"
                    value={role.rotationDeg ?? 0}
                    onChange={(e) => setRoleRotation(instance.instanceId, role.role, Number(e.target.value) || 0)}
                  />
                </label>
              </div>
              <ColorPickerRow
                label="Fill"
                value={role.fillColor}
                defaultValue={BOX_ROLE_FILL[role.role] ?? '#ffffff'}
                onChange={(v) => setRoleColor(instance.instanceId, role.role, 'fillColor', v)}
              />
              <ColorPickerRow
                label="Border"
                value={role.strokeColor}
                defaultValue="#000000"
                onChange={(v) => setRoleColor(instance.instanceId, role.role, 'strokeColor', v)}
              />
              <ColorPickerRow
                label="Text"
                value={role.textColor}
                defaultValue="#000000"
                onChange={(v) => setRoleColor(instance.instanceId, role.role, 'textColor', v)}
              />
            </fieldset>
          )
        })}

      {(() => {
        const options = getComponentType(instance.componentTypeId).instanceOptions
        if (!options || options.length === 0) return null
        const renderOption = (opt: InstanceOptionDescriptor) => {
          const raw = instance.propertyValues[opt.key]
          if (opt.kind === 'boolean') {
            const checked = typeof raw === 'boolean' ? raw : (opt.default as boolean)
            return (
              <label key={opt.key} className="role-checkbox">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setInstancePropertyValue(instance.instanceId, opt.key, e.target.checked)}
                />
                {opt.label}
              </label>
            )
          }
          if (opt.kind === 'text') {
            const text = typeof raw === 'string' ? raw : (opt.default as string)
            return (
              <label key={opt.key} className="field">
                <span>{opt.label}</span>
                <textarea
                  rows={3}
                  value={text}
                  onChange={(e) => setInstancePropertyValue(instance.instanceId, opt.key, e.target.value)}
                />
              </label>
            )
          }
          if (opt.kind === 'number') {
            const num = typeof raw === 'number' ? raw : (opt.default as number)
            return (
              <label key={opt.key} className="field">
                <span>{opt.label}</span>
                <input
                  type="number"
                  value={num}
                  min={opt.min}
                  max={opt.max}
                  step={opt.step}
                  onChange={(e) => setInstancePropertyValue(instance.instanceId, opt.key, Number(e.target.value))}
                />
              </label>
            )
          }
          if (opt.kind === 'select') {
            const value = typeof raw === 'string' ? raw : (opt.default as string)
            return (
              <label key={opt.key} className="field">
                <span>{opt.label}</span>
                <select value={value} onChange={(e) => setInstancePropertyValue(instance.instanceId, opt.key, e.target.value)}>
                  {opt.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )
          }
          const color = typeof raw === 'string' && raw ? raw : (opt.default as string)
          return (
            <ColorPickerRow
              key={opt.key}
              label={opt.label}
              value={typeof raw === 'string' && raw ? raw : null}
              defaultValue={color}
              onChange={(v) => setInstancePropertyValue(instance.instanceId, opt.key, v)}
            />
          )
        }
        const rows: InstanceOptionDescriptor[][] = []
        for (const opt of options) {
          const last = rows[rows.length - 1]
          if (opt.row && last && last[0]?.row === opt.row) last.push(opt)
          else rows.push([opt])
        }
        return (
          <fieldset className="field roles-field">
            <legend>Options</legend>
            {rows.map((group) =>
              group.length > 1 ? (
                <div className="field-row" key={group.map((o) => o.key).join('+')}>
                  {group.map(renderOption)}
                </div>
              ) : (
                renderOption(group[0])
              ),
            )}
          </fieldset>
        )
      })()}

      {(() => {
        const resizable = getComponentType(instance.componentTypeId).resizable
        if (!resizable) return null
        const hasOverride =
          typeof instance.propertyValues[resizable.widthKey] === 'number' ||
          typeof instance.propertyValues[resizable.heightKey] === 'number'
        return (
          <div className="field-row">
            <button
              onClick={() => {
                setInstancePropertyValue(instance.instanceId, resizable.widthKey, null)
                setInstancePropertyValue(instance.instanceId, resizable.heightKey, null)
              }}
              disabled={!hasOverride}
            >
              Reset size (fit to text)
            </button>
          </div>
        )
      })()}

      <fieldset className="field roles-field">
        <legend>Connection points ({(instance.connectionPoints ?? []).length})</legend>
        {(instance.connectionPoints ?? []).length === 0 && <p className="field-hint">None yet.</p>}
        {(instance.connectionPoints ?? []).map((cp, i) => (
          <div key={cp.pointId} className="field-row">
            <button
              className={
                selectedConnectionPoint?.ownerKind === 'instance' &&
                selectedConnectionPoint.ownerId === instance.instanceId &&
                selectedConnectionPoint.pointId === cp.pointId
                  ? 'tool-button active'
                  : 'tool-button'
              }
              onClick={() =>
                selectConnectionPoint({ ownerKind: 'instance', ownerId: instance.instanceId, pointId: cp.pointId })
              }
              title="Click to highlight on canvas — drag its handle there, or use arrow keys, to reposition it."
            >
              #{i + 1} ({(cp.relX * 100).toFixed(0)}%, {(cp.relY * 100).toFixed(0)}%)
            </button>
            <button className="danger" onClick={() => deleteInstanceConnectionPoint(instance.instanceId, cp.pointId)}>
              Delete
            </button>
          </div>
        ))}
        <div className="field-row">
          <button
            onClick={() => setTool('place-connection-point-instance', instance.instanceId)}
            title="Click, then click a spot on the component — pipes can snap to it afterwards, in addition to its regular ports, and it stays put on the component (as a % of its own bounding box) through later moves/rotations. Shift while clicking keeps adding several in a row."
          >
            Add connection point
          </button>
        </div>
      </fieldset>

      <div className="field-row">
        <button onClick={() => centerRoles(instance.instanceId)}>Re-center labels</button>
      </div>

      <div className="field-row">
        <button onClick={() => rotateInstance(instance.instanceId, 90)}>Rotate 90&deg;</button>
        <button className="danger" onClick={() => deleteInstance(instance.instanceId)}>
          Delete
        </button>
      </div>
      <ShortcutHint items={[SHORTCUT.move, SHORTCUT.rotate, SHORTCUT.deleteOne, SHORTCUT.deselect]} />
    </aside>
  )
}
