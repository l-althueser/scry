import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../state/projectStore'
import {
  computeCrossingsForPipe,
  getDisplayPoints,
  getPipePoints,
  PIPE_DEFAULT_COLOR,
  PIPE_NON_CLICKABLE_COLOR,
  resolveIndicatorTag,
  type Point,
} from '../pipes/pipeGeometry'
import { DEFAULT_FONT_SIZE } from '../shapes/freeShapeGeometry'
import { loadImageFile } from '../import/loadImageFile'
import { BOX_ROLE_FILL, LABEL_ROLE_ORDER, getComponentType, rotatePoint } from '../library'
import { describeComposition, type CompositionCounts } from '../state/selectionDescription'

/** One color field, same single-line layout everywhere it's used: label + swatch + None + Default. `value` null/undefined means "at default". */
function ColorPickerRow({
  label,
  value,
  defaultValue,
  onChange,
}: {
  label: string
  value: string | null | undefined
  defaultValue: string
  onChange: (value: string | null) => void
}) {
  const isTransparent = value === 'transparent'
  return (
    <div className="field-row color-row">
      <span className="color-row-label">{label}</span>
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
      <button onClick={() => onChange(null)} disabled={value == null}>
        Default
      </button>
    </div>
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
  onStyleChange,
  onPipeFlagChange,
  actions,
  footerHint,
}: {
  heading: string
  counts: CompositionCounts
  onStyleChange: (field: 'fill' | 'stroke' | 'text', value: string | null) => void
  onPipeFlagChange: (field: 'indicatorEnabled' | 'nameEnabled', value: boolean) => void
  actions: { label: string; onClick: () => void; danger?: boolean }[]
  footerHint: string
}) {
  return (
    <aside className="properties-panel">
      <h2>{heading}</h2>
      <p className="field-hint">{describeComposition(counts)}</p>

      {counts.instances > 0 && (
        <fieldset className="field roles-field">
          <legend>Labels</legend>
          <p className="field-hint">Applies to every label on every selected instance at once, as a single undo step.</p>
          <ColorPickerRow label="Fill" value={null} defaultValue="#ffffff" onChange={(v) => onStyleChange('fill', v)} />
          <ColorPickerRow label="Border" value={null} defaultValue="#000000" onChange={(v) => onStyleChange('stroke', v)} />
          <ColorPickerRow label="Text" value={null} defaultValue="#000000" onChange={(v) => onStyleChange('text', v)} />
        </fieldset>
      )}

      {counts.pipes > 0 && (
        <fieldset className="field roles-field">
          <legend>Pipes</legend>
          <p className="field-hint">Applies to every selected pipe at once, as a single undo step.</p>
          <ColorPickerRow label="Line" value={null} defaultValue="#000000" onChange={(v) => onStyleChange('stroke', v)} />

          <div className="field-row">
            <span style={{ flex: '1 1 auto' }}>Indicator (_indicator)</span>
            <button onClick={() => onPipeFlagChange('indicatorEnabled', true)}>Enable</button>
            <button onClick={() => onPipeFlagChange('indicatorEnabled', false)}>Disable</button>
          </div>
          <div className="field-row">
            <span style={{ flex: '1 1 auto' }}>Name label (_name)</span>
            <button onClick={() => onPipeFlagChange('nameEnabled', true)}>Enable</button>
            <button onClick={() => onPipeFlagChange('nameEnabled', false)}>Disable</button>
          </div>
        </fieldset>
      )}

      {counts.shapes > 0 && (
        <fieldset className="field roles-field">
          <legend>Shapes</legend>
          <p className="field-hint">Applies to every selected shape at once, as a single undo step.</p>
          <ColorPickerRow label="Fill" value={null} defaultValue="#ffffff" onChange={(v) => onStyleChange('fill', v)} />
          <ColorPickerRow label="Stroke" value={null} defaultValue="#000000" onChange={(v) => onStyleChange('stroke', v)} />
        </fieldset>
      )}

      <div className="field-row">
        {actions.map((a) => (
          <button key={a.label} className={a.danger ? 'danger' : undefined} onClick={a.onClick}>
            {a.label}
          </button>
        ))}
      </div>
      <p className="field-hint">{footerHint}</p>
    </aside>
  )
}

export function PropertiesPanel() {
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
  const deleteInstance = useProjectStore((s) => s.deleteInstance)
  const rotateInstance = useProjectStore((s) => s.rotateInstance)
  const centerRoles = useProjectStore((s) => s.centerRoles)
  const renamePipeTag = useProjectStore((s) => s.renamePipeTag)
  const renameVolumeTag = useProjectStore((s) => s.renameVolumeTag)
  const setPipeIndicatorEnabled = useProjectStore((s) => s.setPipeIndicatorEnabled)
  const setPipeNameEnabled = useProjectStore((s) => s.setPipeNameEnabled)
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
  const deleteShapes = useProjectStore((s) => s.deleteShapes)
  const selectedLayerId = useProjectStore((s) => s.selectedLayerId)
  const layersPanelOpen = useProjectStore((s) => s.layersPanelOpen)
  const layers = useProjectStore((s) => s.layers)
  const addImageLayer = useProjectStore((s) => s.addImageLayer)
  const renameLayer = useProjectStore((s) => s.renameLayer)
  const setLayerVisible = useProjectStore((s) => s.setLayerVisible)
  const setLayerLocked = useProjectStore((s) => s.setLayerLocked)
  const setLayerOpacity = useProjectStore((s) => s.setLayerOpacity)
  const setLayerIncludeInExport = useProjectStore((s) => s.setLayerIncludeInExport)
  const setLayerRect = useProjectStore((s) => s.setLayerRect)
  const imageAspectLocked = useProjectStore((s) => s.imageAspectLocked)
  const setImageAspectLocked = useProjectStore((s) => s.setImageAspectLocked)
  const moveLayer = useProjectStore((s) => s.moveLayer)
  const deleteLayer = useProjectStore((s) => s.deleteLayer)
  const selectLayer = useProjectStore((s) => s.selectLayer)
  const openLayersPanel = useProjectStore((s) => s.openLayersPanel)
  const closeLayersPanel = useProjectStore((s) => s.closeLayersPanel)
  const deleteConnectionPoint = useProjectStore((s) => s.deleteConnectionPoint)
  const setTool = useProjectStore((s) => s.setTool)
  const checkpointHistory = useProjectStore((s) => s.checkpointHistory)

  const selected = instances.filter((i) => selectedInstanceIds.includes(i.instanceId))
  const instance = selected.length === 1 ? selected[0] : undefined

  const selectedPipes = pipes.filter((p) => selectedPipeIds.includes(p.instanceId))
  const pipe = selectedPipes.length === 1 ? selectedPipes[0] : undefined

  const selectedShapes = freeShapes.filter((s) => selectedShapeIds.includes(s.instanceId))
  const shape = selectedShapes.length === 1 ? selectedShapes[0] : undefined

  const selectedLeaderLines = leaderLines.filter((l) => selectedLeaderLineIds.includes(l.instanceId))

  const selectedLayer = layers.find((l) => l.layerId === selectedLayerId)

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

  const volumeSiblings = pipe ? pipes.filter((p) => p.volumeTag === pipe.volumeTag) : []

  // Display-point map (per pipe's own routing mode) for crossing detection —
  // mirrors what SvgCanvas/pipeExport actually render, so the "Crossings"
  // list below matches what's visible on the canvas.
  const displayPointsByPipe = useMemo(() => {
    const map = new Map<string, Point[]>()
    for (const p of pipes) {
      const pts = getPipePoints(p, instances, pipes, layers)
      if (pts) map.set(p.instanceId, getDisplayPoints(p, pts))
    }
    return map
  }, [pipes, instances, layers])

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
    }

    return (
      <SelectionStylePanel
        heading="Group selected"
        counts={counts}
        onStyleChange={(field, value) => setGroupStyle(selectedGroupId, field, value)}
        onPipeFlagChange={(field, value) => setGroupPipeFlag(selectedGroupId, field, value)}
        actions={[
          { label: 'Duplicate', onClick: () => duplicateSelection() },
          { label: 'Copy', onClick: () => copySelectionToClipboard() },
          { label: 'Ungroup', onClick: () => ungroup(selectedGroupId) },
          { label: 'Delete group', onClick: () => deleteGroup(selectedGroupId), danger: true },
        ]}
        footerHint="Double-click a member to edit it individually. Ctrl/Cmd+D to duplicate, Ctrl/Cmd+C to copy, Ctrl/Cmd+Shift+G to ungroup, Escape to deselect."
      />
    )
  }

  // A loose (ungrouped) multi-select spanning 2+ things, of any mix of
  // kinds — same shared-style/delete/Group-it-up experience as an actual
  // Group, just not persisted yet. Checked before every per-kind branch
  // below (pipes/shapes/leaderLines/instances) so none of their single-item
  // priority ordering swallows a mixed selection into e.g. "1 pipe
  // selected" while ignoring instances also selected alongside it.
  const totalSelected = selected.length + selectedPipes.length + selectedShapes.length + selectedLeaderLines.length
  if (totalSelected > 1) {
    return (
      <SelectionStylePanel
        heading={`${totalSelected} selected`}
        counts={{
          instances: selected.length,
          pipes: selectedPipes.length,
          shapes: selectedShapes.length,
          leaderLines: selectedLeaderLines.length,
        }}
        onStyleChange={(field, value) => setSelectionStyle(field, value)}
        onPipeFlagChange={(field, value) => setSelectionPipeFlag(field, value)}
        actions={[
          { label: 'Duplicate', onClick: () => duplicateSelection() },
          { label: 'Copy', onClick: () => copySelectionToClipboard() },
          { label: 'Group', onClick: () => createGroup() },
          { label: 'Delete all', onClick: () => deleteSelection(), danger: true },
        ]}
        footerHint="Ctrl/Cmd+D to duplicate, Ctrl/Cmd+C to copy, Ctrl/Cmd+G to group, Delete/Backspace to remove all, Escape to deselect."
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
            <span>Volume</span>
            <input
              value={volumeTagInput}
              onChange={(e) => {
                setVolumeTagInput(e.target.value)
                renameVolumeTag(pipe.instanceId, e.target.value)
              }}
            />
          </label>
          <p className="field-hint">
            {volumeSiblings.length > 1
              ? `Shared with ${volumeSiblings.length - 1} other connected pipe${volumeSiblings.length - 1 === 1 ? '' : 's'} (no valve/component in between) — gas fills this whole run at once, so they all share one "_indicator" id.`
              : 'Not connected to any other pipe right now (a component, e.g. a valve, sits between it and everything else) — its own one-pipe volume.'}
          </p>
        </fieldset>

        <fieldset className="field roles-field">
          <legend>Indicator &amp; color</legend>
          <label className="role-checkbox">
            <input
              type="checkbox"
              checked={pipe.indicatorEnabled}
              onChange={(e) => setPipeIndicatorEnabled(pipe.instanceId, e.target.checked)}
            />
            clickable / colorable (_indicator)
          </label>
          <p className="field-hint">
            {pipe.indicatorEnabled ? (
              <>
                Exports as <code>{resolveIndicatorTag(pipe)}_indicator</code> — a small dot at each
                connected segment&apos;s own midpoint, all sharing that id, so coloring it in Node-RED
                lights up the whole connected run at once.
              </>
            ) : (
              "Currently just a decorative line — Node-RED can't target it."
            )}{' '}
            {volumeSiblings.length > 1
              ? `Toggling this applies to all ${volumeSiblings.length} pipes in this connected run, not just this segment.`
              : null}
          </p>

          <ColorPickerRow
            label="Line"
            value={pipe.strokeColor}
            defaultValue={pipe.indicatorEnabled ? PIPE_DEFAULT_COLOR : PIPE_NON_CLICKABLE_COLOR}
            onChange={(v) => setPipeColor(pipe.instanceId, v)}
          />
          <p className="field-hint">
            {pipe.strokeColor
              ? `Custom color${volumeSiblings.length > 1 ? ' — applies to the whole connected run' : ''} overrides the default.`
              : pipe.indicatorEnabled
                ? 'Default: black (indicator enabled).'
                : 'Default: light gray (no indicator, purely decorative).'}
          </p>

          <label className="role-checkbox">
            <input
              type="checkbox"
              checked={pipe.nameEnabled}
              onChange={(e) => setPipeNameEnabled(pipe.instanceId, e.target.checked)}
            />
            show name label (_name)
          </label>
          <p className="field-hint">
            Bare text showing <code>{resolveIndicatorTag(pipe)}</code> — the volume tag, same as above.
            {volumeSiblings.length > 1
              ? ` This run has ${volumeSiblings.length} connected segments; toggling this applies to all of them, but only one shows the label (at whichever segment has the most waypoints) instead of one per segment.`
              : " Shown at this pipe's midpoint."}
          </p>
        </fieldset>

        <fieldset className="field roles-field">
          <legend>Routing</legend>
          <label className="role-checkbox">
            <input
              type="radio"
              name="routing-mode"
              checked={pipe.routingMode === 'straight' || pipe.routingMode === 'manual'}
              onChange={() => setPipeRoutingMode(pipe.instanceId, 'straight')}
            />
            Straight (supports crossing hop-arcs)
          </label>
          <label className="role-checkbox">
            <input
              type="radio"
              name="routing-mode"
              checked={pipe.routingMode === 'orthogonal'}
              onChange={() => setPipeRoutingMode(pipe.instanceId, 'orthogonal')}
            />
            Orthogonal (right-angle bends, supports hop-arcs)
          </label>
          <label className="role-checkbox">
            <input
              type="radio"
              name="routing-mode"
              checked={pipe.routingMode === 'curved'}
              onChange={() => setPipeRoutingMode(pipe.instanceId, 'curved')}
            />
            Curved (smooth spline, no hop-arcs)
          </label>
        </fieldset>

        <p className="field-hint">
          Double-click anywhere on the line to add a new waypoint there. Drag a waypoint dot to
          reshape the run (snaps to the grid and to nearby ports/pipe points), or nudge the selected
          one with arrow keys — hold Shift while dragging to lock movement to horizontal/vertical
          from the waypoint&apos;s start position. Select a waypoint and press Delete/Backspace to
          remove just that one. The two square end handles are the pipe&apos;s actual connection
          points — drag one onto another port/pipe point to reattach it there, or drop it on empty
          space to disconnect that end (it stays put as a fixed point). To move the component an
          end is attached to instead of the pipe, click/drag its body elsewhere or use its own
          drag-handle rather than the exact port pixel. Deleting a connected component also leaves
          the pipe in place with a fixed knot where it used to attach.
        </p>

        <div className="field-row">
          <button onClick={() => autoRoutePipe(pipe.instanceId)}>Auto-route (avoid components)</button>
        </div>
        <p className="field-hint">
          Replaces this pipe&apos;s waypoints with a grid path that steps around other components&apos;
          bounding boxes, and switches routing to orthogonal. Starting point, not a constraint — drag
          waypoints afterward same as any other pipe.
        </p>
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
        <p className="field-hint">Shortcuts: Delete/Backspace to remove, Escape to deselect.</p>
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
        <h2>Shape properties</h2>
        <p className="field-hint">
          Purely a visual annotation — untagged, so Node-RED never reads or targets it.
        </p>

        {shape.kind === 'text' && (
          <fieldset className="field roles-field">
            <legend>Text</legend>
            <label className="field">
              <span>Content</span>
              <textarea
                rows={3}
                value={shapeTextInput}
                onChange={(e) => {
                  setShapeTextInput(e.target.value)
                  setShapeText(shape.instanceId, e.target.value)
                }}
              />
            </label>
            <p className="field-hint">Press Enter for a line break — multi-line text is fully supported.</p>
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

        <p className="field-hint">Drag the shape on the canvas to move it (Shift locks to horizontal/vertical).</p>

        <div className="field-row">
          <button className="danger" onClick={() => deleteShapes([shape.instanceId])}>
            Delete
          </button>
        </div>
        <p className="field-hint">Shortcuts: Delete/Backspace to remove, Escape to deselect.</p>
      </aside>
    )
  }

  if (selectedLeaderLines.length > 0) {
    return (
      <aside className="properties-panel">
        <h2>{selectedLeaderLines.length === 1 ? 'Leader line selected' : `${selectedLeaderLines.length} leader lines selected`}</h2>
        <p className="field-hint">
          A freeform annotation pointer — purely visual, untagged, so Node-RED never reads or targets it.
        </p>
        <p className="field-hint">
          Drag its end point (or an interior waypoint) on the canvas to reposition it — no grid snapping.
        </p>
        <div className="field-row">
          <button
            className="danger"
            onClick={() => deleteLeaderLines(selectedLeaderLines.map((l) => l.instanceId))}
          >
            {selectedLeaderLines.length === 1 ? 'Delete' : 'Delete all'}
          </button>
        </div>
        <p className="field-hint">Shortcuts: Delete/Backspace to remove, Escape to deselect.</p>
      </aside>
    )
  }

  if (selectedLayerId) {
    if (!selectedLayer) {
      return (
        <aside className="properties-panel">
          <p className="properties-empty">Layer no longer exists.</p>
        </aside>
      )
    }
    if (selectedLayer.kind !== 'image') {
      return (
        <aside className="properties-panel">
          <div className="field-row">
            <button onClick={() => openLayersPanel()}>&larr; All layers</button>
          </div>
          <p className="properties-empty">This layer has no additional settings.</p>
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
          <label className="role-checkbox">
            <input
              type="checkbox"
              checked={layer.locked}
              onChange={(e) => setLayerLocked(layer.layerId, e.target.checked)}
            />
            locked
          </label>
          <p className="field-hint">
            {layer.locked
              ? "Dragging on the canvas is disabled while locked — untick this to reposition it there, or just edit X/Y/Width/Height below."
              : 'Drag the image on the canvas to move it (Shift locks to horizontal/vertical).'}
          </p>

          <label className="role-checkbox">
            <input
              type="checkbox"
              checked={layer.includeInExport}
              onChange={(e) => setLayerIncludeInExport(layer.layerId, e.target.checked)}
            />
            include in exported SVG
          </label>

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
          <legend>Geometry</legend>
          <label className="role-checkbox">
            <input
              type="checkbox"
              checked={imageAspectLocked}
              onChange={(e) => setImageAspectLocked(e.target.checked)}
            />
            lock aspect ratio
          </label>
          <p className="field-hint">
            Also applies to the corner drag-handles on the canvas — hold Shift while dragging one to
            temporarily flip this lock.
          </p>

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
              <span>
                #{i + 1} ({(cp.relX * 100).toFixed(0)}%, {(cp.relY * 100).toFixed(0)}%)
              </span>
              <button className="danger" onClick={() => deleteConnectionPoint(layer.layerId, cp.pointId)}>
                Delete
              </button>
            </div>
          ))}
        </fieldset>
        <div className="field-row">
          <button onClick={() => setTool('place-connection-point', layer.layerId)}>Add connection point</button>
        </div>
        <p className="field-hint">
          Click &quot;Add connection point&quot;, then click a spot on the image — pipes can snap
          to it afterwards, and it stays put on the image (as a % of its width/height) through
          later drags/resizes. Shift while clicking keeps adding several in a row.
        </p>

        <div className="field-row">
          <button className="danger" onClick={() => deleteLayer(layer.layerId)}>
            Delete layer
          </button>
        </div>
        <p className="field-hint">Shortcuts: Delete/Backspace to remove, Escape to deselect.</p>
      </aside>
    )
  }

  if (layersPanelOpen && selected.length === 0) {
    // Top of the visual list = top of the z-order; layers array is stored bottom-first.
    const displayLayers = [...layers].reverse()

    return (
      <aside className="properties-panel">
        <div className="field-row properties-panel-header">
          <h2>Image layers</h2>
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
          {displayLayers.map((layer, displayIndex) => (
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
                onClick={() => selectLayer(layer.layerId)}
                title={layer.kind === 'image' ? 'Click for settings, position, and connection points' : layer.name}
              >
                {layer.kind === 'image' && layer.locked ? '\u{1F512} ' : ''}
                {layer.name}
              </button>
              {layer.kind === 'image' && (
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
                  <button className="tool-button danger" title="Delete layer" onClick={() => deleteLayer(layer.layerId)}>
                    &times;
                  </button>
                </div>
              )}
            </li>
          ))}
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
          Drag on empty canvas to box-select. Ctrl/Cmd+click toggles one instance, Ctrl/Cmd+drag
          adds to the selection, Ctrl/Cmd+A selects all. Shift+drag on empty canvas pans; Shift
          while dragging an instance, label, or waypoint locks movement to horizontal/vertical.
          Shift while placing/drawing keeps the tool active for placing/drawing several in a row.
          Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y to redo.
        </p>
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
        <legend>Roles</legend>
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
        <p className="field-hint">
          Exports as <code>{instance.tag}_&lt;role&gt;</code> for each enabled role. Click a
          box/label on the canvas to select it individually (orange outline) — drag it, or nudge it
          with arrow keys (Shift for bigger steps) for fine placement.
        </p>
      </fieldset>

      {instance.roles
        .filter((role) => LABEL_ROLE_ORDER.includes(role.role) && role.enabled)
        .map((role) => {
          const worldPos = rotatePoint(role.offset, instance.transform.rotationDeg)
          worldPos.x += instance.transform.x
          worldPos.y += instance.transform.y
          return (
            <fieldset key={role.role} className="field roles-field">
              <legend>Label: {role.role}</legend>
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
        return (
          <fieldset className="field roles-field">
            <legend>Options</legend>
            {options.map((opt) => {
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
              if (opt.kind === 'select') {
                const value = typeof raw === 'string' ? raw : (opt.default as string)
                return (
                  <label key={opt.key} className="field">
                    <span>{opt.label}</span>
                    <select
                      value={value}
                      onChange={(e) => setInstancePropertyValue(instance.instanceId, opt.key, e.target.value)}
                    >
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
            })}
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

      <div className="field-row">
        <button onClick={() => centerRoles(instance.instanceId)}>Re-center labels</button>
      </div>

      <div className="field-row">
        <button onClick={() => rotateInstance(instance.instanceId, 90)}>Rotate 90&deg;</button>
        <button className="danger" onClick={() => deleteInstance(instance.instanceId)}>
          Delete
        </button>
      </div>
      <p className="field-hint">
        Shortcuts: arrow keys to move (Shift for bigger steps), R to rotate, Delete/Backspace to
        remove, Escape to deselect.
      </p>
    </aside>
  )
}
