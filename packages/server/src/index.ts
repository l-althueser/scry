import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { EXAMPLE_GAS_SYSTEM_PROJECT } from './exampleProject.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000
// Defaults match the monorepo layout for local dev; overridden by env vars in Docker.
const WEB_DIST = process.env.WEB_DIST ?? path.resolve(__dirname, '../../web/dist')
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(__dirname, '../../../data')
const PROJECTS_DIR = path.join(DATA_DIR, 'projects')
const LIBRARIES_DIR = path.join(DATA_DIR, 'libraries')
const EXPORT_DIR = path.join(DATA_DIR, 'export')
// "Deleting" a project moves its file here instead of unlinking it — the
// user explicitly asked for delete to keep the file on disk, just hidden
// from the project list (no restore UI yet, but nothing is destroyed).
const TRASH_DIR = path.join(PROJECTS_DIR, '.trash')
// One subfolder per project, holding timestamped snapshots — see maybeSnapshotVersion.
const VERSIONS_DIR = path.join(PROJECTS_DIR, '.versions')

for (const dir of [PROJECTS_DIR, LIBRARIES_DIR, EXPORT_DIR, TRASH_DIR, VERSIONS_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}

// Only safe filename characters — projects/exports are written straight to disk by this name.
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const TIMESTAMP_PATTERN = /^\d+$/
/** At most one automatic version snapshot per project in any 10-minute window (an explicit restore always snapshots the pre-restore state regardless, see the restore route). */
const MIN_VERSION_INTERVAL_MS = 10 * 60 * 1000

function projectFilePath(name: string): string {
  return path.join(PROJECTS_DIR, `${name}.json`)
}

function trashFilePath(name: string): string {
  return path.join(TRASH_DIR, `${name}.json`)
}

/** Custom component types authored in the Library Editor — one shared file, not per-package, since there's only ever been one implicit "custom" collection so far (see PUT /api/library/custom-types). */
function customTypesFilePath(): string {
  return path.join(LIBRARIES_DIR, 'custom-types.json')
}

function versionsDirFor(name: string): string {
  return path.join(VERSIONS_DIR, name)
}

function versionFilePath(name: string, timestamp: number | string): string {
  return path.join(versionsDirFor(name), `${timestamp}.json`)
}

/** Version timestamps (ms since epoch, also the filename) for a project, newest first. */
async function listVersionTimestamps(name: string): Promise<number[]> {
  try {
    const files = await fsp.readdir(versionsDirFor(name))
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => Number(f.replace(/\.json$/, '')))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a)
  } catch {
    return []
  }
}

/**
 * Snapshots whatever is CURRENTLY saved for `name` (the outgoing version,
 * about to be overwritten) into .versions/<name>/<now>.json — but only if
 * at least MIN_VERSION_INTERVAL_MS has passed since the last snapshot (or
 * there isn't one yet), so a burst of autosaves doesn't produce a version
 * per keystroke-adjacent save. The *current* main project file is always
 * the true latest state regardless — it doesn't need its own version entry.
 */
async function maybeSnapshotVersion(name: string): Promise<void> {
  let existing: string
  try {
    existing = await fsp.readFile(projectFilePath(name), 'utf8')
  } catch {
    return // first-ever save of this project — nothing to snapshot yet
  }
  const [last] = await listVersionTimestamps(name)
  if (last !== undefined && Date.now() - last < MIN_VERSION_INTERVAL_MS) return
  await fsp.mkdir(versionsDirFor(name), { recursive: true })
  await fsp.writeFile(versionFilePath(name, Date.now()), existing, 'utf8')
}

function exportFilePath(name: string): string {
  return path.join(EXPORT_DIR, `${name}.svg`)
}

function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name)
}

/** Rewrites a saved project's meta.id/meta.name to match its (possibly new) file name, and bumps modifiedAt — used by rename/duplicate so the file's own identity never drifts from the name it's saved under. */
async function readProjectRenamed(sourcePath: string, newName: string): Promise<string> {
  const raw = await fsp.readFile(sourcePath, 'utf8')
  const project = JSON.parse(raw)
  project.meta = { ...project.meta, id: newName, name: newName, modifiedAt: new Date().toISOString() }
  return JSON.stringify(project, null, 2)
}

async function seedExampleProject() {
  const target = projectFilePath(EXAMPLE_GAS_SYSTEM_PROJECT.meta.id)
  if (fs.existsSync(target)) return
  await fsp.writeFile(target, JSON.stringify(EXAMPLE_GAS_SYSTEM_PROJECT, null, 2), 'utf8')
  console.log(`Seeded example project: ${target}`)
}

const app = express()
app.use(express.json({ limit: '20mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.get('/api/projects', async (_req, res) => {
  try {
    const files = await fsp.readdir(PROJECTS_DIR)
    const projects = files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    res.json({ projects })
  } catch (err) {
    console.error('Failed to list projects:', err)
    res.status(500).json({ error: 'failed to list projects' })
  }
})

app.get('/api/projects/:name', async (req, res) => {
  const { name } = req.params
  if (!NAME_PATTERN.test(name)) {
    res.status(400).json({ error: 'invalid project name' })
    return
  }
  try {
    const content = await fsp.readFile(projectFilePath(name), 'utf8')
    res.type('application/json').send(content)
  } catch {
    res.status(404).json({ error: 'project not found' })
  }
})

app.put('/api/projects/:name', async (req, res) => {
  const { name } = req.params
  if (!NAME_PATTERN.test(name)) {
    res.status(400).json({ error: 'invalid project name' })
    return
  }
  try {
    await maybeSnapshotVersion(name)
    await fsp.writeFile(projectFilePath(name), JSON.stringify(req.body, null, 2), 'utf8')
    res.json({ status: 'ok' })
  } catch (err) {
    console.error(`Failed to save project "${name}":`, err)
    res.status(500).json({ error: 'failed to save project' })
  }
})

app.get('/api/projects/:name/versions', async (req, res) => {
  const { name } = req.params
  if (!isValidName(name)) {
    res.status(400).json({ error: 'invalid project name' })
    return
  }
  const timestamps = await listVersionTimestamps(name)
  const versions = await Promise.all(
    timestamps.map(async (timestamp) => {
      try {
        const raw = await fsp.readFile(versionFilePath(name, timestamp), 'utf8')
        const project = JSON.parse(raw)
        return { timestamp, modifiedAt: project.meta?.modifiedAt ?? null }
      } catch {
        return { timestamp, modifiedAt: null }
      }
    }),
  )
  res.json({ versions })
})

app.get('/api/projects/:name/versions/:timestamp', async (req, res) => {
  const { name, timestamp } = req.params
  if (!isValidName(name) || !TIMESTAMP_PATTERN.test(timestamp)) {
    res.status(400).json({ error: 'invalid project name or version' })
    return
  }
  try {
    const content = await fsp.readFile(versionFilePath(name, timestamp), 'utf8')
    res.type('application/json').send(content)
  } catch {
    res.status(404).json({ error: 'version not found' })
  }
})

app.post('/api/projects/:name/versions/:timestamp/restore', async (req, res) => {
  const { name, timestamp } = req.params
  if (!isValidName(name) || !TIMESTAMP_PATTERN.test(timestamp)) {
    res.status(400).json({ error: 'invalid project name or version' })
    return
  }
  try {
    const versionRaw = await fsp.readFile(versionFilePath(name, timestamp), 'utf8')
    // Preserve whatever was live immediately before the restore, regardless
    // of the normal 10-minute throttle — a restore should never be the
    // thing that makes an in-between state unrecoverable.
    try {
      const currentRaw = await fsp.readFile(projectFilePath(name), 'utf8')
      await fsp.mkdir(versionsDirFor(name), { recursive: true })
      await fsp.writeFile(versionFilePath(name, Date.now()), currentRaw, 'utf8')
    } catch {
      // No current file yet — nothing to preserve.
    }

    const restored = JSON.parse(versionRaw)
    restored.meta = { ...restored.meta, id: name, name, modifiedAt: new Date().toISOString() }
    await fsp.writeFile(projectFilePath(name), JSON.stringify(restored, null, 2), 'utf8')
    res.json({ status: 'ok' })
  } catch (err) {
    console.error(`Failed to restore version ${timestamp} of "${name}":`, err)
    res.status(404).json({ error: 'version not found' })
  }
})

// Cheap poll target for the client's periodic "is the server copy newer than
// what I last saw" check — just the meta block, not the whole project body.
app.get('/api/projects/:name/meta', async (req, res) => {
  const { name } = req.params
  if (!isValidName(name)) {
    res.status(400).json({ error: 'invalid project name' })
    return
  }
  try {
    const content = await fsp.readFile(projectFilePath(name), 'utf8')
    const project = JSON.parse(content)
    res.json({ meta: project.meta })
  } catch {
    res.status(404).json({ error: 'project not found' })
  }
})

// "Delete" moves the file into .trash/ rather than unlinking it — nothing
// on disk is actually destroyed, it just stops showing up in the list.
app.delete('/api/projects/:name', async (req, res) => {
  const { name } = req.params
  if (!isValidName(name)) {
    res.status(400).json({ error: 'invalid project name' })
    return
  }
  try {
    await fsp.rename(projectFilePath(name), trashFilePath(name))
    res.json({ status: 'ok' })
  } catch (err) {
    console.error(`Failed to trash project "${name}":`, err)
    res.status(404).json({ error: 'project not found' })
  }
})

app.post('/api/projects/:name/rename', async (req, res) => {
  const { name } = req.params
  const newName = req.body?.newName
  if (!isValidName(name) || typeof newName !== 'string' || !isValidName(newName)) {
    res.status(400).json({ error: 'invalid project name' })
    return
  }
  if (fs.existsSync(projectFilePath(newName))) {
    res.status(409).json({ error: `A project named "${newName}" already exists.` })
    return
  }
  try {
    const content = await readProjectRenamed(projectFilePath(name), newName)
    await fsp.writeFile(projectFilePath(newName), content, 'utf8')
    await fsp.unlink(projectFilePath(name))
    res.json({ status: 'ok' })
  } catch (err) {
    console.error(`Failed to rename project "${name}" to "${newName}":`, err)
    res.status(404).json({ error: 'project not found' })
  }
})

app.post('/api/projects/:name/duplicate', async (req, res) => {
  const { name } = req.params
  const newName = req.body?.newName
  if (!isValidName(name) || typeof newName !== 'string' || !isValidName(newName)) {
    res.status(400).json({ error: 'invalid project name' })
    return
  }
  if (fs.existsSync(projectFilePath(newName))) {
    res.status(409).json({ error: `A project named "${newName}" already exists.` })
    return
  }
  try {
    const content = await readProjectRenamed(projectFilePath(name), newName)
    await fsp.writeFile(projectFilePath(newName), content, 'utf8')
    res.json({ status: 'ok' })
  } catch (err) {
    console.error(`Failed to duplicate project "${name}" to "${newName}":`, err)
    res.status(404).json({ error: 'project not found' })
  }
})

// Custom component types are shared across every browser/machine that talks
// to this server — a single JSON blob (small, edited rarely compared to
// project content) rather than one file per type; simplicity over the
// plan's literal `libraries/<package>/components/<type>.json` layout.
app.get('/api/library/custom-types', async (_req, res) => {
  try {
    const content = await fsp.readFile(customTypesFilePath(), 'utf8')
    res.type('application/json').send(content)
  } catch {
    res.json({ customTypes: [] })
  }
})

app.put('/api/library/custom-types', async (req, res) => {
  try {
    await fsp.mkdir(LIBRARIES_DIR, { recursive: true })
    await fsp.writeFile(customTypesFilePath(), JSON.stringify(req.body, null, 2), 'utf8')
    res.json({ status: 'ok' })
  } catch (err) {
    console.error('Failed to save custom component library:', err)
    res.status(500).json({ error: 'failed to save custom component library' })
  }
})

app.post('/api/export/:name', async (req, res) => {
  const { name } = req.params
  if (!NAME_PATTERN.test(name)) {
    res.status(400).json({ error: 'invalid project name' })
    return
  }
  const svg = req.body?.svg
  if (typeof svg !== 'string') {
    res.status(400).json({ error: 'missing svg content' })
    return
  }
  const filePath = exportFilePath(name)
  try {
    await fsp.writeFile(filePath, svg, 'utf8')
    res.json({ status: 'ok', path: filePath })
  } catch (err) {
    console.error(`Failed to export "${name}":`, err)
    res.status(500).json({ error: 'failed to export svg' })
  }
})

// Serve the built web app in production (packages/web/dist after `npm run build`).
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'))
  })
}

// Safety net for anything the per-route try/catch blocks above miss (e.g. malformed JSON bodies).
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled server error:', err)
  res.status(500).json({ error: 'internal server error' })
})

await seedExampleProject()

app.listen(PORT, () => {
  console.log(`Scry server listening on :${PORT}`)
  console.log(`  projects:  ${PROJECTS_DIR}`)
  console.log(`  libraries: ${LIBRARIES_DIR}`)
  console.log(`  export:    ${EXPORT_DIR}`)
})
