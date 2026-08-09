import { useSyncExternalStore } from 'react'
import type { Port, Suffix } from '@svg-editor/shared'
import { registerIconComponentType, type BodyImage, type IconComponentSpec } from './iconComponentFactory'
import { unregisterComponentType } from './registry'
import { computeBoundingCorners, primitiveToPathShape, type ShapePrimitive } from './shapePrimitives'
import * as api from '../api/client'

/**
 * The persisted, re-editable form of a Library-Editor-authored component
 * type — kept as parametric shape primitives (not flattened path `d`
 * strings) so it can be reopened and adjusted later. Registered at runtime
 * via registerIconComponentType (see specToIconSpec), the same generic
 * factory every built-in "icon-bodied" type (compressor, gas cylinder, ...)
 * already goes through — a custom type is otherwise indistinguishable from
 * a built-in one anywhere else in the app (canvas, export, toolbar icon).
 */
/** A custom type's own decorative extra, toggleable per placed instance — see IconComponentSpec.optionalExtras. */
export interface CustomOptionalExtra {
  /** Key into ComponentInstance.propertyValues — must be unique within one type's optionalExtras list. */
  propertyKey: string
  label: string
  shapes: ShapePrimitive[]
}

export interface CustomComponentSpec {
  typeId: string
  displayName: string
  tagPrefix: string
  category: string
  indicatorPrimitives: ShapePrimitive[]
  outlinePrimitives: ShapePrimitive[]
  /** An imported raster/SVG image (data URI) used as the body's base artwork — see BodyImage. */
  bodyImage?: BodyImage | null
  ports: Port[]
  centerX: number
  labelStartY?: number
  defaultEnabled: Partial<Record<Suffix, boolean>>
  /** Lets a placed instance be flipped horizontally (around centerX) — see IconComponentSpec.mirrorable. */
  mirrorable?: boolean
  /** Lets a placed instance pick its own body fill color instead of always fill:none — see IconComponentSpec.colorable. */
  colorable?: boolean
  defaultFillColor?: string
  optionalExtras?: CustomOptionalExtra[]
}

const STORAGE_KEY = 'gv-custom-component-types'

function loadPersisted(): CustomComponentSpec[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persist(specs: CustomComponentSpec[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(specs))
  } catch {
    // Storage full/unavailable (private browsing, etc.) — the custom type still
    // works for the rest of this session, it just won't survive a reload.
  }
}

export function specToIconSpec(spec: CustomComponentSpec): IconComponentSpec {
  const optionalExtras = spec.optionalExtras ?? []
  return {
    typeId: spec.typeId,
    displayName: spec.displayName,
    tagPrefix: spec.tagPrefix,
    category: spec.category,
    indicatorShapes: spec.indicatorPrimitives.map(primitiveToPathShape),
    outlineExtras: spec.outlinePrimitives.map(primitiveToPathShape),
    bodyImage: spec.bodyImage,
    localBodyCorners: computeBoundingCorners(
      [...spec.indicatorPrimitives, ...spec.outlinePrimitives, ...optionalExtras.flatMap((e) => e.shapes)],
      spec.bodyImage,
    ),
    ports: spec.ports,
    centerX: spec.centerX,
    labelStartY: spec.labelStartY,
    defaultEnabled: spec.defaultEnabled,
    mirrorable: spec.mirrorable,
    colorable: spec.colorable,
    defaultFillColor: spec.defaultFillColor,
    optionalExtras: optionalExtras.map((e) => ({
      propertyKey: e.propertyKey,
      label: e.label,
      shapes: e.shapes.map(primitiveToPathShape),
    })),
  }
}

// Loaded from localStorage and registered immediately (synchronously, at
// module load, before the app ever renders) so custom types are usable
// right away even before the server round-trip below completes — the
// server is the shared source of truth once reachable, this cache is what
// makes the app still work offline / on a slow connection to it.
let customSpecs: CustomComponentSpec[] = loadPersisted()
for (const spec of customSpecs) registerIconComponentType(specToIconSpec(spec))

type Listener = () => void
const listeners = new Set<Listener>()

function notify() {
  for (const l of listeners) l()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): CustomComponentSpec[] {
  return customSpecs
}

/** Reactive list of custom types — re-renders whenever one is added/edited/deleted, or the server sync completes. */
export function useCustomComponentSpecs(): CustomComponentSpec[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}

export function getCustomComponentSpec(typeId: string): CustomComponentSpec | undefined {
  return customSpecs.find((s) => s.typeId === typeId)
}

export interface LibrarySyncStatus {
  state: 'idle' | 'syncing' | 'synced' | 'error'
  message: string | null
}

let librarySyncStatus: LibrarySyncStatus = { state: 'idle', message: null }

function setSyncStatus(next: LibrarySyncStatus) {
  librarySyncStatus = next
  notify()
}

/** Reactive server-sync status for a small status indicator in the Library Editor — separate from useCustomComponentSpecs so a component can watch just this without re-rendering on every local edit. */
export function useLibrarySyncStatus(): LibrarySyncStatus {
  return useSyncExternalStore(subscribe, () => librarySyncStatus)
}

/** Pushes the full current collection to the server — the whole array every time (rare edits, small payload), not a per-type diff. */
async function pushToServer() {
  setSyncStatus({ state: 'syncing', message: null })
  try {
    await api.saveCustomTypesToServer(customSpecs)
    setSyncStatus({ state: 'synced', message: null })
  } catch (err) {
    setSyncStatus({ state: 'error', message: (err as Error).message })
  }
}

/**
 * Pulls the shared server collection and makes it authoritative locally:
 * unregisters any locally-cached type the server no longer has (deleted by
 * someone else, on another machine), then (re)registers everything the
 * server *does* have and refreshes the localStorage cache to match. Run
 * once at startup (see the bottom of this file) — not polled periodically
 * like project sync, since custom types change far less often and a stale
 * local copy is low-stakes (just reload the page to pick up someone else's
 * additions).
 */
async function pullFromServer() {
  try {
    const serverSpecs = await api.loadCustomTypesFromServer()
    const serverIds = new Set(serverSpecs.map((s) => s.typeId))
    for (const old of customSpecs) {
      if (!serverIds.has(old.typeId)) unregisterComponentType(old.typeId)
    }
    customSpecs = serverSpecs
    for (const spec of customSpecs) registerIconComponentType(specToIconSpec(spec))
    persist(customSpecs)
    setSyncStatus({ state: 'synced', message: null })
    notify()
  } catch (err) {
    // Server unreachable (or nothing saved there yet) — keep the localStorage
    // cache already registered above rather than clearing everything out.
    setSyncStatus({ state: 'error', message: (err as Error).message })
  }
}

/** Registers (add or edit — same typeId overwrites) and persists a custom type, locally and to the server. */
export function saveCustomComponentType(spec: CustomComponentSpec) {
  customSpecs = [...customSpecs.filter((s) => s.typeId !== spec.typeId), spec]
  persist(customSpecs)
  registerIconComponentType(specToIconSpec(spec))
  notify()
  void pushToServer()
}

export function deleteCustomComponentType(typeId: string) {
  customSpecs = customSpecs.filter((s) => s.typeId !== typeId)
  persist(customSpecs)
  unregisterComponentType(typeId)
  notify()
  void pushToServer()
}

export function slugifyTypeId(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return `custom-${slug || 'type'}-${Math.random().toString(36).slice(2, 8)}`
}

void pullFromServer()
