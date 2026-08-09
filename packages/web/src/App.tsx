import { useEffect, useMemo, useRef, useState } from 'react'
import type { FreeShapeKind, Project } from '@svg-editor/shared'
import { CanvasView } from './canvas/CanvasView'
import { PropertiesPanel } from './panels/PropertiesPanel'
import { LibraryEditorModal } from './panels/LibraryEditorModal'
import { ProjectsModal } from './panels/ProjectsModal'
import { BASE_GRID_SIZE, useProjectStore } from './state/projectStore'
import type { Point } from './canvas/SvgCanvas'
import { downloadSvgFile, exportProjectToSvg } from './export/svgExport'
import { listComponentTypes, useCustomComponentSpecs } from './library'
import { ComponentIcon } from './components/ComponentIcon'

const SYNC_STATUS_LABELS: Record<string, string> = {
  unsaved: 'Not saved yet',
  dirty: 'Unsaved changes…',
  saving: 'Saving…',
  synced: 'Synced',
  conflict: 'Out of sync',
  error: 'Sync error',
}

interface ShapeToolDef {
  kind: FreeShapeKind
  label: string
  icon: JSX.Element
}

const SHAPE_TOOLS: ShapeToolDef[] = [
  {
    kind: 'rect',
    label: 'Rectangle',
    icon: (
      <svg viewBox="0 0 28 28">
        <rect x="4" y="7" width="20" height="14" fill="none" stroke="#000000" strokeWidth="2.5" />
      </svg>
    ),
  },
  {
    kind: 'ellipse',
    label: 'Ellipse',
    icon: (
      <svg viewBox="0 0 28 28">
        <ellipse cx="14" cy="14" rx="10" ry="7" fill="none" stroke="#000000" strokeWidth="2.5" />
      </svg>
    ),
  },
  {
    kind: 'line',
    label: 'Line',
    icon: (
      <svg viewBox="0 0 28 28">
        <line x1="4" y1="21" x2="24" y2="7" stroke="#000000" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    kind: 'polygon',
    label: 'Polygon / freehand',
    icon: (
      <svg viewBox="0 0 28 28">
        <polygon points="14,4 24,11 20,23 8,23 4,11" fill="none" stroke="#000000" strokeWidth="2.5" />
      </svg>
    ),
  },
  {
    kind: 'text',
    label: 'Text field',
    icon: (
      <svg viewBox="0 0 28 28">
        <text x="14" y="21" textAnchor="middle" fontFamily="Arial" fontSize="20" fontWeight="bold" fill="#000000">
          T
        </text>
      </svg>
    ),
  },
]

/** Groups the palette by category (Valves, Instruments, Equipment, ...) in first-seen order, for a toolbar that scales past a handful of types. */
function groupByCategory<T extends { category: string }>(items: T[]): { category: string; items: T[] }[] {
  const order: string[] = []
  const byCategory = new Map<string, T[]>()
  for (const item of items) {
    if (!byCategory.has(item.category)) {
      byCategory.set(item.category, [])
      order.push(item.category)
    }
    byCategory.get(item.category)!.push(item)
  }
  return order.map((category) => ({ category, items: byCategory.get(category)! }))
}

// Only guards actual text entry — a focused checkbox (e.g. a just-toggled
// role checkbox in the properties panel) must not block arrow-key nudging.
const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'])

function isTypingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') {
    return !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type)
  }
  return false
}

const ARROW_DIRECTIONS: Record<string, Point> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
}

/** Grid-size toggle options: standard (the app's usual default) plus two finer subdivisions, derived from it rather than separate hardcoded numbers. */
const GRID_SIZE_OPTIONS = [
  { label: '1×', value: BASE_GRID_SIZE },
  { label: '½×', value: BASE_GRID_SIZE / 2 },
  { label: '¼×', value: BASE_GRID_SIZE / 4 },
]

export default function App() {
  const tool = useProjectStore((s) => s.tool)
  const placingType = useProjectStore((s) => s.placingType)
  const drawingShapeKind = useProjectStore((s) => s.drawingShapeKind)
  const setTool = useProjectStore((s) => s.setTool)
  const gridSize = useProjectStore((s) => s.gridSize)
  const setGridSize = useProjectStore((s) => s.setGridSize)
  const cancelTool = useProjectStore((s) => s.cancelTool)
  const instances = useProjectStore((s) => s.instances)
  const instanceCount = instances.length
  const pipes = useProjectStore((s) => s.pipes)
  const freeShapes = useProjectStore((s) => s.freeShapes)
  const leaderLines = useProjectStore((s) => s.leaderLines)
  const layers = useProjectStore((s) => s.layers)
  const selectedInstanceIds = useProjectStore((s) => s.selectedInstanceIds)
  const selectedRole = useProjectStore((s) => s.selectedRole)
  const selectedPipeIds = useProjectStore((s) => s.selectedPipeIds)
  const selectedWaypoint = useProjectStore((s) => s.selectedWaypoint)
  const selectedShapeIds = useProjectStore((s) => s.selectedShapeIds)
  const selectedLeaderLineIds = useProjectStore((s) => s.selectedLeaderLineIds)
  const selectLeaderLines = useProjectStore((s) => s.selectLeaderLines)
  const deleteLeaderLines = useProjectStore((s) => s.deleteLeaderLines)
  const selectedLayerId = useProjectStore((s) => s.selectedLayerId)
  const layersPanelOpen = useProjectStore((s) => s.layersPanelOpen)
  const toggleLayersPanel = useProjectStore((s) => s.toggleLayersPanel)
  const closeLayersPanel = useProjectStore((s) => s.closeLayersPanel)
  const deleteLayer = useProjectStore((s) => s.deleteLayer)
  const selectInstances = useProjectStore((s) => s.selectInstances)
  const selectRole = useProjectStore((s) => s.selectRole)
  const selectPipes = useProjectStore((s) => s.selectPipes)
  const selectWaypoint = useProjectStore((s) => s.selectWaypoint)
  const selectShapes = useProjectStore((s) => s.selectShapes)
  const selectAll = useProjectStore((s) => s.selectAll)
  const deleteInstances = useProjectStore((s) => s.deleteInstances)
  const deletePipes = useProjectStore((s) => s.deletePipes)
  const deletePipeWaypoint = useProjectStore((s) => s.deletePipeWaypoint)
  const deleteShapes = useProjectStore((s) => s.deleteShapes)
  const rotateInstance = useProjectStore((s) => s.rotateInstance)
  const nudgeSelection = useProjectStore((s) => s.nudgeSelection)
  const undo = useProjectStore((s) => s.undo)
  const redo = useProjectStore((s) => s.redo)
  const canUndo = useProjectStore((s) => s.past.length > 0)
  const canRedo = useProjectStore((s) => s.future.length > 0)

  const projectName = useProjectStore((s) => s.projectName)
  const setProjectName = useProjectStore((s) => s.setProjectName)
  const serverStatus = useProjectStore((s) => s.serverStatus)
  const serverBusy = useProjectStore((s) => s.serverBusy)
  const loadInitialProject = useProjectStore((s) => s.loadInitialProject)
  const saveProjectToServer = useProjectStore((s) => s.saveProjectToServer)
  const exportToServer = useProjectStore((s) => s.exportToServer)
  const exportProjectToFile = useProjectStore((s) => s.exportProjectToFile)
  const importProjectFromFile = useProjectStore((s) => s.importProjectFromFile)
  const syncStatus = useProjectStore((s) => s.syncStatus)
  const syncErrorMessage = useProjectStore((s) => s.syncErrorMessage)
  const resolveConflictKeepMine = useProjectStore((s) => s.resolveConflictKeepMine)
  const resolveConflictReloadTheirs = useProjectStore((s) => s.resolveConflictReloadTheirs)

  const [libraryEditorOpen, setLibraryEditorOpen] = useState(false)
  const [projectsModalOpen, setProjectsModalOpen] = useState(false)
  const importFileInputRef = useRef<HTMLInputElement>(null)

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as Partial<Project>
      if (!Array.isArray(parsed.instances) || !Array.isArray(parsed.pipes)) {
        throw new Error('Not a recognizable project file (missing instances/pipes).')
      }
      const overwriteCurrent = window.confirm(
        `Overwrite the currently open project ("${projectName}") with this file?\n\n` +
          `OK: replace "${projectName}"'s content with the imported file (saved over it next time it syncs).\n` +
          `Cancel: import it as a separate, new project instead.`,
      )
      importProjectFromFile(parsed as Project, overwriteCurrent ? 'overwrite-current' : 'new')
    } catch (err) {
      console.error('Failed to import project file:', err)
      window.alert(`Could not import that file: ${(err as Error).message}`)
    }
  }
  // Its identity changes whenever a custom type is added/edited/deleted — used
  // purely as a recompute trigger, listComponentTypes() itself reads the live registry.
  const customSpecs = useCustomComponentSpecs()
  const componentGroups = useMemo(() => groupByCategory(listComponentTypes()), [customSpecs])

  useEffect(() => {
    loadInitialProject()
  }, [loadInitialProject])

  useEffect(() => {
    function onKeyDown(evt: KeyboardEvent) {
      if (isTypingInField(evt.target)) return

      if ((evt.key === 'a' || evt.key === 'A') && (evt.ctrlKey || evt.metaKey)) {
        evt.preventDefault()
        selectAll()
        return
      }

      if ((evt.ctrlKey || evt.metaKey) && (evt.key === 'z' || evt.key === 'Z')) {
        evt.preventDefault()
        if (evt.shiftKey) redo()
        else undo()
        return
      }

      if ((evt.ctrlKey || evt.metaKey) && (evt.key === 'y' || evt.key === 'Y')) {
        evt.preventDefault()
        redo()
        return
      }

      if (evt.key === 'Escape') {
        evt.preventDefault()
        if (tool !== 'select') {
          cancelTool()
        } else if (selectedWaypoint) {
          selectWaypoint(null)
        } else if (selectedRole) {
          selectRole(null)
        } else if (selectedPipeIds.length > 0) {
          selectPipes([])
        } else if (selectedShapeIds.length > 0) {
          selectShapes([])
        } else if (selectedLeaderLineIds.length > 0) {
          selectLeaderLines([])
        } else if (selectedInstanceIds.length > 0) {
          selectInstances([])
        } else if (selectedLayerId || layersPanelOpen) {
          closeLayersPanel()
        }
        return
      }

      const direction = ARROW_DIRECTIONS[evt.key]
      if (direction && (selectedWaypoint || selectedRole || selectedInstanceIds.length > 0)) {
        evt.preventDefault()
        nudgeSelection(direction, evt.shiftKey)
        return
      }

      if (evt.key === 'Delete' || evt.key === 'Backspace') {
        if (selectedWaypoint) {
          evt.preventDefault()
          deletePipeWaypoint(selectedWaypoint.pipeId, selectedWaypoint.index)
        } else if (selectedPipeIds.length > 0) {
          evt.preventDefault()
          deletePipes(selectedPipeIds)
        } else if (selectedShapeIds.length > 0) {
          evt.preventDefault()
          deleteShapes(selectedShapeIds)
        } else if (selectedLeaderLineIds.length > 0) {
          evt.preventDefault()
          deleteLeaderLines(selectedLeaderLineIds)
        } else if (selectedInstanceIds.length > 0) {
          evt.preventDefault()
          deleteInstances(selectedInstanceIds)
        } else if (selectedLayerId) {
          evt.preventDefault()
          deleteLayer(selectedLayerId)
        }
        return
      }

      if ((evt.key === 'r' || evt.key === 'R') && selectedInstanceIds.length > 0) {
        evt.preventDefault()
        for (const id of selectedInstanceIds) rotateInstance(id, 90)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    tool,
    selectedInstanceIds,
    selectedRole,
    selectedPipeIds,
    selectedWaypoint,
    selectedShapeIds,
    selectedLeaderLineIds,
    selectedLayerId,
    layersPanelOpen,
    cancelTool,
    selectInstances,
    selectRole,
    selectPipes,
    selectWaypoint,
    selectShapes,
    selectLeaderLines,
    selectAll,
    deleteInstances,
    deletePipes,
    deletePipeWaypoint,
    deleteShapes,
    deleteLeaderLines,
    deleteLayer,
    closeLayersPanel,
    rotateInstance,
    nudgeSelection,
    undo,
    redo,
  ])

  return (
    <div className="app-shell">
      <header className="app-toolbar">
        <span className="app-title">
          <svg viewBox="0 0 32 32" className="app-title-icon" aria-hidden="true">
            <circle cx="16" cy="14" r="11" fill="#c4b5fd" stroke="#4c1d95" strokeWidth="1" />
            <path d="M9 26 Q16 30 23 26 L22 23 Q16 25.5 10 23 Z" fill="#4c1d95" />
            <path
              d="M9.5 8.5 A9 9 0 0 1 20 6.2"
              fill="none"
              stroke="#ffffff"
              strokeWidth="1.6"
              strokeLinecap="round"
              opacity={0.75}
            />
          </svg>
          Scry
        </span>
        <div className="app-tools">
          <button
            className={tool === 'select' ? 'tool-button active' : 'tool-button'}
            onClick={() => setTool('select')}
          >
            Select
          </button>
          {componentGroups.map((group) => (
            <span key={group.category} className="toolbar-group" role="group" aria-label={group.category}>
              {group.items.map((def) => (
                <button
                  key={def.typeId}
                  className={
                    tool === 'place' && placingType === def.typeId
                      ? 'tool-button icon-button icon-only active'
                      : 'tool-button icon-button icon-only'
                  }
                  onClick={() => setTool('place', def.typeId)}
                  title={`${group.category}: ${def.displayName}`}
                >
                  <ComponentIcon typeId={def.typeId} />
                </button>
              ))}
            </span>
          ))}
          <span className="toolbar-divider" aria-hidden="true" />
          <button
            className={tool === 'draw-pipe' ? 'tool-button icon-button active' : 'tool-button icon-button'}
            onClick={() => setTool('draw-pipe')}
            title="Click a port (or a point on another pipe, to branch off it) to start — or click empty space to start a free-floating end there. Click waypoints to bend, click another port/pipe point to finish. Snaps to the grid and to nearby ports/pipe points; hold Shift to lock a segment horizontal/vertical. Shift on the finishing click keeps drawing. Escape with no waypoints yet cancels; with waypoints placed, it keeps the pipe up to the last point instead (continue it later by drawing from that dangling end — it reconnects into one pipe automatically)."
          >
            <span className="component-icon" aria-hidden="true">
              <svg viewBox="0 0 28 28">
                <line x1="4" y1="22" x2="24" y2="6" stroke="#000000" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </span>
            Draw pipe
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          <span className="toolbar-group" role="group" aria-label="Shapes">
            {SHAPE_TOOLS.map((shapeTool) => (
              <button
                key={shapeTool.kind}
                className={
                  tool === 'draw-shape' && drawingShapeKind === shapeTool.kind
                    ? 'tool-button icon-button icon-only active'
                    : 'tool-button icon-button icon-only'
                }
                onClick={() => setTool('draw-shape', shapeTool.kind)}
                title={
                  shapeTool.kind === 'polygon'
                    ? 'Polygon / freehand: click to add each vertex (3+), finish with a double-click or by clicking back near the start point. Escape cancels the in-progress shape.'
                    : shapeTool.kind === 'text'
                      ? 'Text field: click to place, then edit its content in the properties panel.'
                      : `${shapeTool.label}: drag from corner to corner. Shift on the finishing click keeps drawing.`
                }
              >
                <span className="component-icon" aria-hidden="true">
                  {shapeTool.icon}
                </span>
              </button>
            ))}
          </span>
          <span className="toolbar-divider" aria-hidden="true" />
          <button
            className={tool === 'draw-leader-line' ? 'tool-button icon-button active' : 'tool-button icon-button'}
            onClick={() => setTool('draw-leader-line')}
            title="Leader line: click a _name/_value/_setpoint label (or empty space, e.g. on a background image) to start, click to add waypoints, double-click to finish. Purely a visual annotation pointer — never snaps to the grid."
          >
            <span className="component-icon" aria-hidden="true">
              <svg viewBox="0 0 28 28">
                <path
                  d="M4 6 L16 18"
                  fill="none"
                  stroke="#000000"
                  strokeWidth="2.5"
                  strokeDasharray="3 2.5"
                  strokeLinecap="round"
                />
                <circle cx="20" cy="22" r="3" fill="#000000" />
              </svg>
            </span>
            Leader line
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          <button
            className={layersPanelOpen || selectedLayerId ? 'tool-button icon-button active' : 'tool-button icon-button'}
            onClick={() => toggleLayersPanel()}
            title="Image layers: add background/reference images, drag or lock them, and place pipe connection points on them. Opens in the properties panel."
          >
            <span className="component-icon" aria-hidden="true">
              <svg viewBox="0 0 28 28">
                <rect x="3" y="5" width="22" height="16" rx="1.5" fill="none" stroke="#000000" strokeWidth="2.5" />
                <circle cx="9.5" cy="11" r="2.3" fill="none" stroke="#000000" strokeWidth="2.2" />
                <path d="M4 19 L11 12 L16 17 L20 13 L24.5 18" fill="none" stroke="#000000" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
            </span>
            Image layers
          </button>
          <button
            className={libraryEditorOpen ? 'tool-button icon-button active' : 'tool-button icon-button'}
            onClick={() => setLibraryEditorOpen(true)}
            title="Component library: define your own component types (geometry, ports, roles) instead of relying only on the built-in ones."
          >
            <span className="component-icon" aria-hidden="true">
              <svg viewBox="0 0 28 28">
                <rect x="4" y="4" width="8" height="8" fill="none" stroke="#000000" strokeWidth="2.2" />
                <circle cx="20" cy="8" r="4" fill="none" stroke="#000000" strokeWidth="2.2" />
                <path d="M4 24 L12 16 L20 24 Z" fill="none" stroke="#000000" strokeWidth="2.2" strokeLinejoin="round" />
              </svg>
            </span>
            Library
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          <span className="toolbar-group" role="group" aria-label="Grid size">
            {GRID_SIZE_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                className={gridSize === opt.value ? 'tool-button active' : 'tool-button'}
                onClick={() => setGridSize(opt.value)}
                title={`Grid + snap spacing: ${opt.value} units`}
              >
                {opt.label}
              </button>
            ))}
          </span>
          <span className="toolbar-divider" aria-hidden="true" />
          <button className="tool-button" disabled={!canUndo} onClick={() => undo()} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button
            className="tool-button"
            disabled={!canRedo}
            onClick={() => redo()}
            title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
          >
            Redo
          </button>
          <button
            className="tool-button"
            disabled={instanceCount === 0 && pipes.length === 0 && freeShapes.length === 0}
            onClick={() =>
              downloadSvgFile('export.svg', exportProjectToSvg(instances, pipes, freeShapes, layers, leaderLines))
            }
          >
            Export SVG
          </button>
        </div>
      </header>
      <div className="app-project-bar">
        <input
          className="project-name-input"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="project name"
        />
        <span
          className={`sync-badge sync-badge-${syncStatus}`}
          title={syncStatus === 'error' && syncErrorMessage ? syncErrorMessage : undefined}
        >
          {SYNC_STATUS_LABELS[syncStatus]}
        </span>
        <button className="tool-button" disabled={serverBusy} onClick={() => saveProjectToServer()}>
          Save
        </button>
        <button className="tool-button" onClick={() => setProjectsModalOpen(true)}>
          Projects&hellip;
        </button>
        <button className="tool-button" onClick={() => importFileInputRef.current?.click()}>
          Import&hellip;
        </button>
        <input
          ref={importFileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={handleImportFile}
        />
        <button
          className="tool-button"
          disabled={instanceCount === 0 && pipes.length === 0 && freeShapes.length === 0}
          onClick={() => exportProjectToFile()}
        >
          Export project&hellip;
        </button>
        <button
          className="tool-button"
          disabled={serverBusy || (instanceCount === 0 && pipes.length === 0 && freeShapes.length === 0)}
          onClick={() => exportToServer()}
        >
          Export to server
        </button>
        {serverStatus && <span className="server-status">{serverStatus}</span>}
      </div>
      {syncStatus === 'conflict' && (
        <div className="conflict-banner">
          <span>
            Someone else saved changes to "{projectName}" while you had unsynced local edits. Autosave is
            paused so nothing gets silently overwritten — pick how to resolve it:
          </span>
          <div className="field-row">
            <button className="tool-button" onClick={() => exportProjectToFile()}>
              Export local copy
            </button>
            <button className="tool-button" onClick={() => resolveConflictKeepMine()}>
              Keep mine (overwrite server)
            </button>
            <button className="tool-button" onClick={() => resolveConflictReloadTheirs()}>
              Reload theirs (discard local)
            </button>
          </div>
        </div>
      )}
      <div className="app-body">
        <CanvasView />
        <PropertiesPanel />
      </div>
      <footer className="app-statusbar">
        <span>
          {instanceCount} instance{instanceCount === 1 ? '' : 's'}, {pipes.length} pipe
          {pipes.length === 1 ? '' : 's'}, {freeShapes.length} shape{freeShapes.length === 1 ? '' : 's'},{' '}
          {leaderLines.length} leader line{leaderLines.length === 1 ? '' : 's'}
        </span>
        <span>
          {selectedWaypoint
            ? `editing waypoint ${selectedWaypoint.index} of ${selectedWaypoint.pipeId}`
            : selectedRole
              ? `editing ${selectedRole.role} of ${selectedRole.instanceId}`
              : selectedPipeIds.length > 0
                ? `${selectedPipeIds.length} pipe${selectedPipeIds.length === 1 ? '' : 's'} selected`
                : selectedShapeIds.length > 0
                  ? `${selectedShapeIds.length} shape${selectedShapeIds.length === 1 ? '' : 's'} selected`
                  : selectedLeaderLineIds.length > 0
                    ? `${selectedLeaderLineIds.length} leader line${selectedLeaderLineIds.length === 1 ? '' : 's'} selected`
                    : selectedInstanceIds.length === 0
                      ? 'nothing selected'
                      : selectedInstanceIds.length === 1
                        ? `selected: ${selectedInstanceIds[0]}`
                        : `${selectedInstanceIds.length} selected`}
        </span>
      </footer>
      {libraryEditorOpen && <LibraryEditorModal onClose={() => setLibraryEditorOpen(false)} />}
      {projectsModalOpen && <ProjectsModal onClose={() => setProjectsModalOpen(false)} />}
    </div>
  )
}
