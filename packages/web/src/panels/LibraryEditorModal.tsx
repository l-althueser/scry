import { useRef, useState } from 'react'
import type { Suffix } from '@svg-editor/shared'
import {
  computeBoundingCorners,
  defaultPrimitive,
  listComponentTypes,
  primitiveToPathD,
  saveCustomComponentType,
  deleteCustomComponentType,
  slugifyTypeId,
  useCustomComponentSpecs,
  useLibrarySyncStatus,
  type BodyImage,
  type CustomComponentSpec,
  type CustomOptionalExtra,
  type ShapePrimitive,
} from '../library'
import { useProjectStore } from '../state/projectStore'
import { loadImageFile } from '../import/loadImageFile'

const LIBRARY_SYNC_LABELS: Record<string, string> = {
  idle: 'Loading…',
  syncing: 'Saving to server…',
  synced: 'Synced',
  error: 'Sync error',
}

const ALL_ROLES: Suffix[] = ['indicator', 'name', 'value', 'setpoint']
/** A freshly imported image is scaled to fit within this many local units on its longer side, so it starts out roughly the same size as the built-in icons (~20-40 units) instead of at raw, much larger, pixel dimensions. */
const IMPORTED_IMAGE_MAX_DIM = 40

function emptyDraft(): CustomComponentSpec {
  return {
    typeId: '',
    displayName: '',
    tagPrefix: '',
    category: 'Custom',
    indicatorPrimitives: [],
    outlinePrimitives: [defaultPrimitive('rect')],
    bodyImage: null,
    ports: [],
    centerX: 0,
    labelStartY: 32,
    defaultEnabled: { name: true },
    mirrorable: false,
    colorable: false,
    defaultFillColor: '#000000',
    optionalExtras: [],
  }
}

function emptyOptionalExtra(): CustomOptionalExtra {
  return { propertyKey: `extra${Math.random().toString(36).slice(2, 6)}`, label: 'New option', shapes: [] }
}

function NumInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="shape-num-input">
      <span>{label}</span>
      <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} />
    </label>
  )
}

function ShapePrimitiveRow({
  primitive,
  onChange,
  onDelete,
}: {
  primitive: ShapePrimitive
  onChange: (p: ShapePrimitive) => void
  onDelete: () => void
}) {
  return (
    <div className="field-row shape-primitive-row">
      <span className="shape-primitive-kind">{primitive.kind}</span>
      {primitive.kind === 'rect' && (
        <>
          <NumInput label="cx" value={primitive.cx} onChange={(v) => onChange({ ...primitive, cx: v })} />
          <NumInput label="cy" value={primitive.cy} onChange={(v) => onChange({ ...primitive, cy: v })} />
          <NumInput label="w" value={primitive.width} onChange={(v) => onChange({ ...primitive, width: v })} />
          <NumInput label="h" value={primitive.height} onChange={(v) => onChange({ ...primitive, height: v })} />
        </>
      )}
      {primitive.kind === 'ellipse' && (
        <>
          <NumInput label="cx" value={primitive.cx} onChange={(v) => onChange({ ...primitive, cx: v })} />
          <NumInput label="cy" value={primitive.cy} onChange={(v) => onChange({ ...primitive, cy: v })} />
          <NumInput label="rx" value={primitive.rx} onChange={(v) => onChange({ ...primitive, rx: v })} />
          <NumInput label="ry" value={primitive.ry} onChange={(v) => onChange({ ...primitive, ry: v })} />
        </>
      )}
      {primitive.kind === 'line' && (
        <>
          <NumInput label="x1" value={primitive.x1} onChange={(v) => onChange({ ...primitive, x1: v })} />
          <NumInput label="y1" value={primitive.y1} onChange={(v) => onChange({ ...primitive, y1: v })} />
          <NumInput label="x2" value={primitive.x2} onChange={(v) => onChange({ ...primitive, x2: v })} />
          <NumInput label="y2" value={primitive.y2} onChange={(v) => onChange({ ...primitive, y2: v })} />
        </>
      )}
      {primitive.kind === 'path' && (
        <input
          className="shape-primitive-path-input"
          value={primitive.d}
          onChange={(e) => onChange({ ...primitive, d: e.target.value })}
          placeholder="M0 0 L10 10 ..."
        />
      )}
      <NumInput
        label="stroke"
        value={primitive.strokeWidth ?? 1.5}
        onChange={(v) => onChange({ ...primitive, strokeWidth: v })}
      />
      <button className="danger" onClick={onDelete} title="Delete shape">
        &times;
      </button>
    </div>
  )
}

function ShapePrimitiveList({
  title,
  primitives,
  onChange,
}: {
  title: string
  primitives: ShapePrimitive[]
  onChange: (next: ShapePrimitive[]) => void
}) {
  return (
    <fieldset className="field roles-field">
      <legend>{title}</legend>
      {primitives.map((p, i) => (
        <ShapePrimitiveRow
          key={i}
          primitive={p}
          onChange={(next) => onChange(primitives.map((existing, idx) => (idx === i ? next : existing)))}
          onDelete={() => onChange(primitives.filter((_, idx) => idx !== i))}
        />
      ))}
      <div className="field-row">
        <button onClick={() => onChange([...primitives, defaultPrimitive('rect')])}>+ Rectangle</button>
        <button onClick={() => onChange([...primitives, defaultPrimitive('ellipse')])}>+ Ellipse</button>
        <button onClick={() => onChange([...primitives, defaultPrimitive('line')])}>+ Line</button>
        <button onClick={() => onChange([...primitives, defaultPrimitive('path')])}>+ Path</button>
      </div>
    </fieldset>
  )
}

function svgPointFromEvent(svg: SVGSVGElement, evt: React.MouseEvent): { x: number; y: number } {
  const pt = svg.createSVGPoint()
  pt.x = evt.clientX
  pt.y = evt.clientY
  const ctm = svg.getScreenCTM()
  if (!ctm) return { x: 0, y: 0 }
  const local = pt.matrixTransform(ctm.inverse())
  return { x: Math.round(local.x), y: Math.round(local.y) }
}

function LivePreview({
  draft,
  placingPort,
  onAddPort,
  onRemovePort,
}: {
  draft: CustomComponentSpec
  placingPort: boolean
  onAddPort: (x: number, y: number) => void
  onRemovePort: (portId: string) => void
}) {
  const optionalExtraShapes = (draft.optionalExtras ?? []).flatMap((e) => e.shapes)
  const corners = computeBoundingCorners(
    [...draft.indicatorPrimitives, ...draft.outlinePrimitives, ...optionalExtraShapes],
    draft.bodyImage,
  )
  const xs = corners.map((c) => c.x)
  const ys = corners.map((c) => c.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const boxW = Math.max(...xs) - minX
  const boxH = Math.max(...ys) - minY

  return (
    <svg
      className="library-preview-svg"
      viewBox="-70 -70 140 140"
      onClick={(e) => {
        if (!placingPort) return
        const svg = e.currentTarget
        const { x, y } = svgPointFromEvent(svg, e)
        onAddPort(x, y)
      }}
      style={{ cursor: placingPort ? 'crosshair' : 'default' }}
    >
      <line x1="-70" y1="0" x2="70" y2="0" className="library-preview-axis" />
      <line x1="0" y1="-70" x2="0" y2="70" className="library-preview-axis" />
      <rect x={minX} y={minY} width={boxW} height={boxH} className="library-preview-bounds" />
      {draft.bodyImage && (
        <image
          x={draft.bodyImage.x}
          y={draft.bodyImage.y}
          width={draft.bodyImage.width}
          height={draft.bodyImage.height}
          href={draft.bodyImage.src}
        />
      )}
      {optionalExtraShapes.map((p, i) => (
        <path
          key={`x${i}`}
          d={primitiveToPathD(p)}
          fill="none"
          stroke="#9ca3af"
          strokeDasharray="3 2"
          strokeWidth={p.strokeWidth ?? 1.5}
        />
      ))}
      {draft.outlinePrimitives.map((p, i) => (
        <path key={`o${i}`} d={primitiveToPathD(p)} fill="none" stroke="#000000" strokeWidth={p.strokeWidth ?? 1.5} />
      ))}
      {draft.indicatorPrimitives.map((p, i) => (
        <path
          key={`i${i}`}
          d={primitiveToPathD(p)}
          fill={draft.colorable ? (draft.defaultFillColor ?? '#000000') : 'none'}
          stroke="#000000"
          strokeWidth={p.strokeWidth ?? 1.5}
        />
      ))}
      {draft.centerX !== undefined && (
        <circle cx={draft.centerX} cy={draft.labelStartY ?? 32} r="2" className="library-preview-label-anchor" />
      )}
      {draft.ports.map((port) => (
        <circle
          key={port.portId}
          cx={port.x}
          cy={port.y}
          r="4"
          className="gv-port-marker"
          style={{ cursor: 'pointer' }}
          onClick={(e) => {
            e.stopPropagation()
            onRemovePort(port.portId)
          }}
        >
          <title>{`${port.portId} — click to remove`}</title>
        </circle>
      ))}
    </svg>
  )
}

interface LibraryEditorModalProps {
  onClose: () => void
}

export function LibraryEditorModal({ onClose }: LibraryEditorModalProps) {
  const customSpecs = useCustomComponentSpecs()
  const librarySync = useLibrarySyncStatus()
  const instances = useProjectStore((s) => s.instances)
  const [draft, setDraft] = useState<CustomComponentSpec | null>(null)
  const [placingPort, setPlacingPort] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [imageAspectLocked, setImageAspectLocked] = useState(true)
  const imageInputRef = useRef<HTMLInputElement>(null)

  async function handleImageChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !draft) return
    try {
      const { src, width: naturalWidth, height: naturalHeight } = await loadImageFile(file)
      const scale = IMPORTED_IMAGE_MAX_DIM / Math.max(naturalWidth, naturalHeight)
      const width = Math.round(naturalWidth * scale)
      const height = Math.round(naturalHeight * scale)
      const bodyImage: BodyImage = { src, x: -width / 2, y: -height / 2, width, height }
      setDraft({ ...draft, bodyImage })
      setImageError(null)
    } catch (err) {
      setImageError(err instanceof Error ? err.message : 'Failed to load image.')
    }
  }

  function startNew() {
    setDraft(emptyDraft())
    setPlacingPort(false)
    setFormError(null)
    setImageError(null)
  }

  function startEdit(spec: CustomComponentSpec) {
    setDraft(spec)
    setPlacingPort(false)
    setFormError(null)
    setImageError(null)
  }

  function cancelEdit() {
    setDraft(null)
    setPlacingPort(false)
    setFormError(null)
    setImageError(null)
  }

  function handleDelete(typeId: string) {
    const inUse = instances.filter((i) => i.componentTypeId === typeId).length
    if (inUse > 0) {
      setDeleteError(`${inUse} placed instance${inUse === 1 ? '' : 's'} still use this type — delete them first.`)
      return
    }
    setDeleteError(null)
    deleteCustomComponentType(typeId)
  }

  function handleSave() {
    if (!draft) return
    const displayName = draft.displayName.trim()
    const tagPrefix = draft.tagPrefix.trim()
    const category = draft.category.trim() || 'Custom'
    if (!displayName) {
      setFormError('Name is required.')
      return
    }
    if (!tagPrefix) {
      setFormError('Tag prefix is required.')
      return
    }
    const typeId = draft.typeId || slugifyTypeId(displayName)
    const collision = listComponentTypes().find((t) => t.tagPrefix === tagPrefix && t.typeId !== typeId)
    if (collision) {
      setFormError(
        `Tag prefix "${tagPrefix}" is already used by "${collision.displayName}" — placed instances of both types would end up with ambiguous-looking tags. Pick a different prefix.`,
      )
      return
    }
    saveCustomComponentType({ ...draft, typeId, displayName, tagPrefix, category })
    setDraft(null)
    setPlacingPort(false)
    setFormError(null)
    setImageError(null)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal library-editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="field-row properties-panel-header">
          <h2>Component library</h2>
          <span
            className={`sync-badge sync-badge-${librarySync.state === 'error' ? 'error' : librarySync.state === 'syncing' ? 'saving' : librarySync.state === 'synced' ? 'synced' : 'unsaved'}`}
            title={librarySync.message ?? undefined}
          >
            {LIBRARY_SYNC_LABELS[librarySync.state]}
          </span>
          <button className="tool-button" title="Close" onClick={onClose}>
            &times;
          </button>
        </div>
        <p className="field-hint">
          Custom types are shared with every browser/machine that connects to this server, not just
          this one.
        </p>

        {!draft && (
          <>
            <p className="field-hint">
              Custom component types you define here show up in the toolbar palette alongside the
              built-in ones, usable exactly the same way — same ports, roles, and export behavior.
            </p>
            <div className="field-row">
              <button onClick={startNew}>+ New custom type</button>
            </div>
            {deleteError && <p className="field-error">{deleteError}</p>}
            <ul className="layer-list">
              {customSpecs.length === 0 && <p className="field-hint">No custom types yet.</p>}
              {customSpecs.map((spec) => (
                <li key={spec.typeId} className="layer-row">
                  <span className="layer-name-button" style={{ cursor: 'default' }}>
                    {spec.displayName}{' '}
                    <span className="field-hint">
                      ({spec.tagPrefix}, {spec.category}, {spec.ports.length} port{spec.ports.length === 1 ? '' : 's'})
                    </span>
                  </span>
                  <div className="layer-row-buttons">
                    <button className="tool-button" onClick={() => startEdit(spec)}>
                      Edit
                    </button>
                    <button className="tool-button danger" onClick={() => handleDelete(spec.typeId)}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {draft && (
          <div className="library-editor-form">
            <div className="library-editor-columns">
              <div className="library-editor-fields">
                <label className="field">
                  <span>Name</span>
                  <input
                    value={draft.displayName}
                    onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Tag prefix</span>
                  <input value={draft.tagPrefix} onChange={(e) => setDraft({ ...draft, tagPrefix: e.target.value })} />
                </label>
                <label className="field">
                  <span>Category</span>
                  <input
                    list="library-editor-categories"
                    value={draft.category}
                    onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  />
                  <datalist id="library-editor-categories">
                    {Array.from(new Set(listComponentTypes().map((t) => t.category))).map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </label>

                <fieldset className="field roles-field">
                  <legend>Roles enabled by default</legend>
                  {ALL_ROLES.map((role) => (
                    <label key={role} className="role-checkbox">
                      <input
                        type="checkbox"
                        checked={draft.defaultEnabled[role] ?? false}
                        onChange={(e) =>
                          setDraft({ ...draft, defaultEnabled: { ...draft.defaultEnabled, [role]: e.target.checked } })
                        }
                      />
                      {role}
                    </label>
                  ))}
                </fieldset>

                <div className="layer-rect-grid">
                  <NumInput label="label centerX" value={draft.centerX} onChange={(v) => setDraft({ ...draft, centerX: v })} />
                  <NumInput
                    label="label startY"
                    value={draft.labelStartY ?? 32}
                    onChange={(v) => setDraft({ ...draft, labelStartY: v })}
                  />
                </div>

                <fieldset className="field roles-field">
                  <legend>Ports ({draft.ports.length})</legend>
                  {draft.ports.map((port, i) => (
                    <div key={port.portId} className="field-row">
                      <input
                        value={port.portId}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            ports: draft.ports.map((p, idx) => (idx === i ? { ...p, portId: e.target.value } : p)),
                          })
                        }
                      />
                      <NumInput
                        label="x"
                        value={port.x}
                        onChange={(v) =>
                          setDraft({ ...draft, ports: draft.ports.map((p, idx) => (idx === i ? { ...p, x: v } : p)) })
                        }
                      />
                      <NumInput
                        label="y"
                        value={port.y}
                        onChange={(v) =>
                          setDraft({ ...draft, ports: draft.ports.map((p, idx) => (idx === i ? { ...p, y: v } : p)) })
                        }
                      />
                      <NumInput
                        label="angle"
                        value={port.exitAngleDeg}
                        onChange={(v) =>
                          setDraft({
                            ...draft,
                            ports: draft.ports.map((p, idx) => (idx === i ? { ...p, exitAngleDeg: v } : p)),
                          })
                        }
                      />
                      <button
                        className="danger"
                        onClick={() => setDraft({ ...draft, ports: draft.ports.filter((_, idx) => idx !== i) })}
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                  <div className="field-row">
                    <button
                      className={placingPort ? 'tool-button active' : 'tool-button'}
                      onClick={() => setPlacingPort((v) => !v)}
                    >
                      {placingPort ? 'Click the preview to place a port… (click again to stop)' : 'Place port on preview'}
                    </button>
                  </div>
                </fieldset>

                <fieldset className="field roles-field">
                  <legend>Instance options</legend>
                  <p className="field-hint">
                    Customizations offered to the user for each placed instance of this type, in its
                    properties panel — the same mechanism the built-in gas cylinder uses for its
                    mirror/color/dewar options.
                  </p>
                  <label className="role-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.mirrorable ?? false}
                      onChange={(e) => setDraft({ ...draft, mirrorable: e.target.checked })}
                    />
                    Mirrorable (user can flip the body left/right, around its own center)
                  </label>
                  <label className="role-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.colorable ?? false}
                      onChange={(e) => setDraft({ ...draft, colorable: e.target.checked })}
                    />
                    Colorable body fill (a solid, per-instance-recolorable fill instead of always
                    outline-only) — independent of the live "_indicator" status color
                  </label>
                  {draft.colorable && (
                    <label className="field">
                      <span>Default fill color</span>
                      <input
                        type="color"
                        value={draft.defaultFillColor ?? '#000000'}
                        onChange={(e) => setDraft({ ...draft, defaultFillColor: e.target.value })}
                        style={{ flex: '0 0 auto', width: '2.5rem', padding: 0 }}
                      />
                    </label>
                  )}
                </fieldset>

                <fieldset className="field roles-field">
                  <legend>Optional extras ({(draft.optionalExtras ?? []).length})</legend>
                  <p className="field-hint">
                    Decorative shapes the user can toggle on/off per placed instance (e.g. "standing
                    in a dewar" for the gas cylinder) — drawn underneath the main body, off by
                    default.
                  </p>
                  {(draft.optionalExtras ?? []).map((extra, i) => (
                    <div key={extra.propertyKey} className="library-editor-extra">
                      <div className="field-row">
                        <input
                          value={extra.label}
                          onChange={(e) => {
                            const next = [...(draft.optionalExtras ?? [])]
                            next[i] = { ...extra, label: e.target.value }
                            setDraft({ ...draft, optionalExtras: next })
                          }}
                          placeholder="Option label shown to the user"
                        />
                        <button
                          className="danger"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              optionalExtras: (draft.optionalExtras ?? []).filter((_, idx) => idx !== i),
                            })
                          }
                          title="Delete this optional extra"
                        >
                          &times;
                        </button>
                      </div>
                      <ShapePrimitiveList
                        title={`Shapes (${extra.shapes.length})`}
                        primitives={extra.shapes}
                        onChange={(nextShapes) => {
                          const next = [...(draft.optionalExtras ?? [])]
                          next[i] = { ...extra, shapes: nextShapes }
                          setDraft({ ...draft, optionalExtras: next })
                        }}
                      />
                    </div>
                  ))}
                  <div className="field-row">
                    <button
                      onClick={() =>
                        setDraft({ ...draft, optionalExtras: [...(draft.optionalExtras ?? []), emptyOptionalExtra()] })
                      }
                    >
                      + Optional extra
                    </button>
                  </div>
                </fieldset>

                <fieldset className="field roles-field">
                  <legend>Body image (optional)</legend>
                  <p className="field-hint">
                    Import a PNG/JPG/SVG to use as the body&apos;s base artwork instead of (or
                    alongside) hand-drawn shapes. Purely decorative like the outline shapes — it
                    can&apos;t be recolored as the status indicator, since a raster/embedded image
                    has no `fill` to change.
                  </p>
                  <div className="field-row">
                    <button onClick={() => imageInputRef.current?.click()}>
                      {draft.bodyImage ? 'Replace image' : 'Import image'}
                    </button>
                    {draft.bodyImage && (
                      <button className="danger" onClick={() => setDraft({ ...draft, bodyImage: null })}>
                        Remove image
                      </button>
                    )}
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={handleImageChosen}
                    />
                  </div>
                  {imageError && <p className="field-error">{imageError}</p>}
                  {draft.bodyImage && (
                    <>
                      <label className="role-checkbox">
                        <input
                          type="checkbox"
                          checked={imageAspectLocked}
                          onChange={(e) => setImageAspectLocked(e.target.checked)}
                        />
                        lock aspect ratio
                      </label>
                      <div className="layer-rect-grid">
                        <NumInput
                          label="x"
                          value={draft.bodyImage.x}
                          onChange={(v) => setDraft({ ...draft, bodyImage: { ...draft.bodyImage!, x: v } })}
                        />
                        <NumInput
                          label="y"
                          value={draft.bodyImage.y}
                          onChange={(v) => setDraft({ ...draft, bodyImage: { ...draft.bodyImage!, y: v } })}
                        />
                        <NumInput
                          label="width"
                          value={draft.bodyImage.width}
                          onChange={(v) => {
                            const img = draft.bodyImage!
                            const width = Math.max(1, v)
                            const height =
                              imageAspectLocked && img.width > 0 ? Math.max(1, Math.round((width * img.height) / img.width)) : img.height
                            setDraft({ ...draft, bodyImage: { ...img, width, height } })
                          }}
                        />
                        <NumInput
                          label="height"
                          value={draft.bodyImage.height}
                          onChange={(v) => {
                            const img = draft.bodyImage!
                            const height = Math.max(1, v)
                            const width =
                              imageAspectLocked && img.height > 0 ? Math.max(1, Math.round((height * img.width) / img.height)) : img.width
                            setDraft({ ...draft, bodyImage: { ...img, width, height } })
                          }}
                        />
                      </div>
                    </>
                  )}
                </fieldset>

                <ShapePrimitiveList
                  title={`Indicator shapes (status-color silhouette, ${draft.indicatorPrimitives.length})`}
                  primitives={draft.indicatorPrimitives}
                  onChange={(next) => setDraft({ ...draft, indicatorPrimitives: next })}
                />
                <ShapePrimitiveList
                  title={`Outline shapes (decorative, ${draft.outlinePrimitives.length})`}
                  primitives={draft.outlinePrimitives}
                  onChange={(next) => setDraft({ ...draft, outlinePrimitives: next })}
                />
              </div>

              <div className="library-editor-preview">
                <LivePreview
                  draft={draft}
                  placingPort={placingPort}
                  onAddPort={(x, y) =>
                    setDraft({
                      ...draft,
                      ports: [...draft.ports, { portId: `p${draft.ports.length + 1}`, x, y, exitAngleDeg: 0 }],
                    })
                  }
                  onRemovePort={(portId) => setDraft({ ...draft, ports: draft.ports.filter((p) => p.portId !== portId) })}
                />
                <p className="field-hint">
                  Imported image sits at the back, black = indicator (status-color) shapes, gray =
                  outline shapes on top of that, dashed = the auto-computed body bounding box,
                  green dots = ports, orange dot = where labels start stacking.
                </p>
              </div>
            </div>

            {formError && <p className="field-error">{formError}</p>}
            {deleteError && <p className="field-error">{deleteError}</p>}

            <div className="field-row">
              <button onClick={handleSave}>Save</button>
              <button onClick={cancelEdit}>Cancel</button>
              {draft.typeId && (
                <button
                  className="danger"
                  onClick={() => {
                    handleDelete(draft.typeId)
                    if (!instances.some((i) => i.componentTypeId === draft.typeId)) cancelEdit()
                  }}
                >
                  Delete type
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
