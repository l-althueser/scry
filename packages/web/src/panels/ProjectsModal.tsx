import { useEffect, useState } from 'react'
import { useProjectStore } from '../state/projectStore'

type PendingAction = { kind: 'rename' | 'duplicate'; name: string; input: string } | null

/** Reasonable starting point for a project name derived from another one — trimmed to the same NAME_PATTERN the server enforces (letters/digits/_/- only). */
function slugifyProjectName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-')
}

export function ProjectsModal({ onClose }: { onClose: () => void }) {
  const availableProjects = useProjectStore((s) => s.availableProjects)
  const projectName = useProjectStore((s) => s.projectName)
  const serverBusy = useProjectStore((s) => s.serverBusy)
  const serverStatus = useProjectStore((s) => s.serverStatus)
  const loadProjectFromServer = useProjectStore((s) => s.loadProjectFromServer)
  const renameProjectOnServer = useProjectStore((s) => s.renameProjectOnServer)
  const duplicateProjectOnServer = useProjectStore((s) => s.duplicateProjectOnServer)
  const trashProjectOnServer = useProjectStore((s) => s.trashProjectOnServer)
  const refreshProjectList = useProjectStore((s) => s.refreshProjectList)
  const versions = useProjectStore((s) => s.versions)
  const versionsLoading = useProjectStore((s) => s.versionsLoading)
  const loadProjectVersions = useProjectStore((s) => s.loadProjectVersions)
  const restoreProjectVersion = useProjectStore((s) => s.restoreProjectVersion)

  const [pending, setPending] = useState<PendingAction>(null)
  const [confirmTrash, setConfirmTrash] = useState<string | null>(null)
  const [historyFor, setHistoryFor] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null)

  // The list is otherwise only refreshed as a side effect of actions taken
  // *in this session* (save/rename/duplicate/trash) — it doesn't pick up
  // projects created/renamed/deleted elsewhere until something re-fetches
  // it, so do that every time this modal is opened rather than trusting
  // whatever was cached from page load.
  useEffect(() => {
    refreshProjectList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggleHistory(name: string) {
    setPending(null)
    setConfirmTrash(null)
    if (historyFor === name) {
      setHistoryFor(null)
      return
    }
    setHistoryFor(name)
    setConfirmRestore(null)
    loadProjectVersions(name)
  }

  function startRename(name: string) {
    setConfirmTrash(null)
    setPending({ kind: 'rename', name, input: name })
  }

  function startDuplicate(name: string) {
    setConfirmTrash(null)
    setPending({ kind: 'duplicate', name, input: slugifyProjectName(`${name}-copy`) })
  }

  async function confirmPending() {
    if (!pending) return
    const newName = slugifyProjectName(pending.input.trim())
    if (!newName || newName === pending.name) {
      setPending(null)
      return
    }
    if (pending.kind === 'rename') {
      await renameProjectOnServer(pending.name, newName)
    } else {
      await duplicateProjectOnServer(pending.name, newName)
    }
    setPending(null)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="field-row properties-panel-header">
          <h2>Projects</h2>
          <button className="tool-button" disabled={serverBusy} onClick={() => refreshProjectList()}>
            Refresh
          </button>
          <button className="tool-button" title="Close" onClick={onClose}>
            &times;
          </button>
        </div>

        <p className="field-hint">
          Open, rename, duplicate, or delete a saved project. Deleting keeps the file on the server
          (just hidden here) — nothing is permanently destroyed.
        </p>
        {serverStatus && <p className="field-hint">{serverStatus}</p>}

        <ul className="layer-list">
          {availableProjects.length === 0 && <p className="field-hint">No projects saved on the server yet.</p>}
          {availableProjects.map((name) => (
            <li key={name} className="layer-row-wrapper">
            <div className="layer-row">
              {pending && pending.kind === 'rename' && pending.name === name ? (
                <>
                  <input
                    className="project-name-input"
                    autoFocus
                    value={pending.input}
                    onChange={(e) => setPending({ ...pending, input: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmPending()
                      if (e.key === 'Escape') setPending(null)
                    }}
                  />
                  <div className="layer-row-buttons">
                    <button className="tool-button" disabled={serverBusy} onClick={confirmPending}>
                      Save
                    </button>
                    <button className="tool-button" onClick={() => setPending(null)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : pending && pending.kind === 'duplicate' && pending.name === name ? (
                <>
                  <input
                    className="project-name-input"
                    autoFocus
                    value={pending.input}
                    onChange={(e) => setPending({ ...pending, input: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmPending()
                      if (e.key === 'Escape') setPending(null)
                    }}
                  />
                  <div className="layer-row-buttons">
                    <button className="tool-button" disabled={serverBusy} onClick={confirmPending}>
                      Duplicate as this
                    </button>
                    <button className="tool-button" onClick={() => setPending(null)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : confirmTrash === name ? (
                <>
                  <span className="layer-name-button" style={{ cursor: 'default' }}>
                    Delete "{name}"?
                  </span>
                  <div className="layer-row-buttons">
                    <button
                      className="tool-button danger"
                      disabled={serverBusy}
                      onClick={async () => {
                        await trashProjectOnServer(name)
                        setConfirmTrash(null)
                      }}
                    >
                      Delete
                    </button>
                    <button className="tool-button" onClick={() => setConfirmTrash(null)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="layer-name-button" style={{ cursor: 'default' }}>
                    {name}
                    {name === projectName && <span className="field-hint"> (open)</span>}
                  </span>
                  <div className="layer-row-buttons">
                    <button
                      className="tool-button"
                      disabled={serverBusy}
                      onClick={async () => {
                        await loadProjectFromServer(name)
                        onClose()
                      }}
                    >
                      Open
                    </button>
                    <button className="tool-button" disabled={serverBusy} onClick={() => startRename(name)}>
                      Rename
                    </button>
                    <button className="tool-button" disabled={serverBusy} onClick={() => startDuplicate(name)}>
                      Duplicate
                    </button>
                    <button
                      className={historyFor === name ? 'tool-button active' : 'tool-button'}
                      disabled={serverBusy}
                      onClick={() => toggleHistory(name)}
                    >
                      History
                    </button>
                    <button
                      className="tool-button danger"
                      disabled={serverBusy}
                      onClick={() => {
                        setPending(null)
                        setConfirmTrash(name)
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>

              {historyFor === name && (
                <div className="version-history">
                  <p className="field-hint">
                    Automatic snapshots, at most one every 10 minutes — the project itself is always the
                    true latest version. Restoring saves the current state as a version too, so nothing is
                    lost either way.
                  </p>
                  {versionsLoading && <p className="field-hint">Loading…</p>}
                  {!versionsLoading && versions.length === 0 && (
                    <p className="field-hint">No earlier versions yet — check back after ~10 minutes of edits.</p>
                  )}
                  {!versionsLoading && versions.length > 0 && (
                    <ul className="layer-list">
                      {versions.map((v) => (
                        <li key={v.timestamp} className="layer-row">
                          <span className="layer-name-button" style={{ cursor: 'default' }}>
                            {new Date(v.timestamp).toLocaleString()}
                          </span>
                          {confirmRestore === v.timestamp ? (
                            <div className="layer-row-buttons">
                              <span className="field-hint">Restore this version?</span>
                              <button
                                className="tool-button danger"
                                disabled={serverBusy}
                                onClick={async () => {
                                  await restoreProjectVersion(name, v.timestamp)
                                  setConfirmRestore(null)
                                }}
                              >
                                Restore
                              </button>
                              <button className="tool-button" onClick={() => setConfirmRestore(null)}>
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="layer-row-buttons">
                              <button
                                className="tool-button"
                                disabled={serverBusy}
                                onClick={() => setConfirmRestore(v.timestamp)}
                              >
                                Restore
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
