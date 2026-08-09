import type { Project } from '@svg-editor/shared'
import type { CustomComponentSpec } from '../library/customTypes'

const API_BASE = '/api'

async function expectOk(res: Response, action: string): Promise<Response> {
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${action} failed (${res.status}): ${body || res.statusText}`)
  }
  return res
}

export async function listProjects(): Promise<string[]> {
  const res = await expectOk(await fetch(`${API_BASE}/projects`), 'Listing projects')
  const data = (await res.json()) as { projects: string[] }
  return data.projects
}

export async function loadProject(name: string): Promise<Project> {
  const res = await expectOk(await fetch(`${API_BASE}/projects/${encodeURIComponent(name)}`), 'Loading project')
  return (await res.json()) as Project
}

export async function saveProject(name: string, project: Project): Promise<void> {
  await expectOk(
    await fetch(`${API_BASE}/projects/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
    }),
    'Saving project',
  )
}

/** Cheap poll target — just meta.modifiedAt, not the whole project body — for detecting a change on the server without re-fetching everything. */
export async function loadProjectMeta(name: string): Promise<Project['meta']> {
  const res = await expectOk(
    await fetch(`${API_BASE}/projects/${encodeURIComponent(name)}/meta`),
    'Checking project sync status',
  )
  const data = (await res.json()) as { meta: Project['meta'] }
  return data.meta
}

export async function renameProject(name: string, newName: string): Promise<void> {
  await expectOk(
    await fetch(`${API_BASE}/projects/${encodeURIComponent(name)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName }),
    }),
    'Renaming project',
  )
}

export async function duplicateProject(name: string, newName: string): Promise<void> {
  await expectOk(
    await fetch(`${API_BASE}/projects/${encodeURIComponent(name)}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName }),
    }),
    'Duplicating project',
  )
}

/** Soft-delete: the server moves the file into a hidden trash directory rather than unlinking it. */
export async function trashProject(name: string): Promise<void> {
  await expectOk(
    await fetch(`${API_BASE}/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    'Deleting project',
  )
}

export interface ProjectVersionInfo {
  /** Ms-since-epoch, also the version's id for the get/restore endpoints below. */
  timestamp: number
  modifiedAt: string | null
}

export async function listProjectVersions(name: string): Promise<ProjectVersionInfo[]> {
  const res = await expectOk(
    await fetch(`${API_BASE}/projects/${encodeURIComponent(name)}/versions`),
    'Listing project versions',
  )
  const data = (await res.json()) as { versions: ProjectVersionInfo[] }
  return data.versions
}

export async function loadProjectVersion(name: string, timestamp: number): Promise<Project> {
  const res = await expectOk(
    await fetch(`${API_BASE}/projects/${encodeURIComponent(name)}/versions/${timestamp}`),
    'Loading project version',
  )
  return (await res.json()) as Project
}

/** Restores a past version as the project's current content server-side (the pre-restore state is itself snapshotted as a new version first, so this is never a one-way trip). */
export async function restoreProjectVersion(name: string, timestamp: number): Promise<void> {
  await expectOk(
    await fetch(`${API_BASE}/projects/${encodeURIComponent(name)}/versions/${timestamp}/restore`, {
      method: 'POST',
    }),
    'Restoring project version',
  )
}

/** The whole custom-component-type collection is shared across every browser/machine talking to this server — see loadCustomTypes/saveCustomTypes in library/customTypes.ts for the local-cache-plus-server-sync usage. */
export async function loadCustomTypesFromServer(): Promise<CustomComponentSpec[]> {
  const res = await expectOk(await fetch(`${API_BASE}/library/custom-types`), 'Loading component library')
  const data = (await res.json()) as { customTypes: CustomComponentSpec[] }
  return data.customTypes
}

export async function saveCustomTypesToServer(customTypes: CustomComponentSpec[]): Promise<void> {
  await expectOk(
    await fetch(`${API_BASE}/library/custom-types`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customTypes }),
    }),
    'Saving component library',
  )
}

export async function exportToServer(name: string, svg: string): Promise<void> {
  await expectOk(
    await fetch(`${API_BASE}/export/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ svg }),
    }),
    'Exporting to server',
  )
}
