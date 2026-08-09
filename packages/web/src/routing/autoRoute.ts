import type { ComponentInstance, Layer, PipeInstance, Waypoint } from '@svg-editor/shared'
import { rotatePoint } from '../library/componentUtils'
import { getComponentType, resolveLocalBodyCorners } from '../library/registry'
import { getPipePoints, type Point } from '../pipes/pipeGeometry'

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Extra clearance around a component's own body box, so a routed line doesn't hug the outline. */
const OBSTACLE_MARGIN = 8

/** Caps the A* grid so a very large canvas/small cell size can't blow up search time; the cell size is coarsened to fit if needed. */
const MAX_GRID_NODES = 6000

function instanceWorldBounds(instance: ComponentInstance): Bounds {
  const def = getComponentType(instance.componentTypeId)
  const { x, y, rotationDeg } = instance.transform
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const corner of resolveLocalBodyCorners(def, instance)) {
    const r = rotatePoint(corner, rotationDeg)
    minX = Math.min(minX, x + r.x)
    maxX = Math.max(maxX, x + r.x)
    minY = Math.min(minY, y + r.y)
    maxY = Math.max(maxY, y + r.y)
  }
  if (!Number.isFinite(minX)) return { minX: x, minY: y, maxX: x, maxY: y }
  return {
    minX: minX - OBSTACLE_MARGIN,
    minY: minY - OBSTACLE_MARGIN,
    maxX: maxX + OBSTACLE_MARGIN,
    maxY: maxY + OBSTACLE_MARGIN,
  }
}

/** Collapses runs of collinear points down to just their turn points (endpoints always kept). */
function simplifyCollinear(points: Point[]): Point[] {
  if (points.length <= 2) return points
  const result: Point[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1]
    const cur = points[i]
    const next = points[i + 1]
    const d1x = Math.sign(cur.x - prev.x)
    const d1y = Math.sign(cur.y - prev.y)
    const d2x = Math.sign(next.x - cur.x)
    const d2y = Math.sign(next.y - cur.y)
    if (d1x === d2x && d1y === d2y) continue
    result.push(cur)
  }
  result.push(points[points.length - 1])
  return result
}

interface GridPoint {
  gx: number
  gy: number
}

/**
 * 4-directional grid A* between start and end, treating each obstacle's
 * bounding box as blocked cells. The search region is just the start/end
 * bounding box plus padding (not the whole canvas) — keeps the grid small
 * for a one-shot user action; a target boxed in well beyond that padding
 * simply won't find a path (returns null), which is an accepted limitation
 * of this first version rather than a full unbounded search.
 */
function findGridPath(start: Point, end: Point, obstacles: Bounds[], cellSize: number): Point[] | null {
  const pad = Math.max(cellSize * 6, 160)
  const minX = Math.min(start.x, end.x) - pad
  const minY = Math.min(start.y, end.y) - pad
  const maxX = Math.max(start.x, end.x) + pad
  const maxY = Math.max(start.y, end.y) + pad

  let effectiveCellSize = cellSize
  const rawCols = Math.max(2, Math.ceil((maxX - minX) / effectiveCellSize))
  const rawRows = Math.max(2, Math.ceil((maxY - minY) / effectiveCellSize))
  if (rawCols * rawRows > MAX_GRID_NODES) {
    const scale = Math.sqrt((rawCols * rawRows) / MAX_GRID_NODES)
    effectiveCellSize = cellSize * scale
  }
  const cols = Math.max(2, Math.ceil((maxX - minX) / effectiveCellSize))
  const rows = Math.max(2, Math.ceil((maxY - minY) / effectiveCellSize))

  const toWorld = (g: GridPoint): Point => ({ x: minX + g.gx * effectiveCellSize, y: minY + g.gy * effectiveCellSize })
  const isBlocked = (g: GridPoint): boolean => {
    const p = toWorld(g)
    return obstacles.some((b) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY)
  }
  const clamp = (g: GridPoint): GridPoint => ({
    gx: Math.min(Math.max(g.gx, 0), cols),
    gy: Math.min(Math.max(g.gy, 0), rows),
  })
  const snap = (p: Point): GridPoint =>
    clamp({ gx: Math.round((p.x - minX) / effectiveCellSize), gy: Math.round((p.y - minY) / effectiveCellSize) })

  const s = snap(start)
  const e = snap(end)
  const key = (g: GridPoint) => `${g.gx},${g.gy}`
  const h = (g: GridPoint) => Math.abs(g.gx - e.gx) + Math.abs(g.gy - e.gy)

  const gScore = new Map<string, number>([[key(s), 0]])
  const cameFrom = new Map<string, string>()
  const open = new Map<string, { g: GridPoint; f: number }>([[key(s), { g: s, f: h(s) }]])
  const closed = new Set<string>()
  const dirs: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]

  while (open.size > 0) {
    let currentKey = ''
    let bestF = Infinity
    for (const [k, v] of open) {
      if (v.f < bestF) {
        bestF = v.f
        currentKey = k
      }
    }
    const current = open.get(currentKey)!
    open.delete(currentKey)
    closed.add(currentKey)

    if (current.g.gx === e.gx && current.g.gy === e.gy) {
      const keys: string[] = [currentKey]
      let k = currentKey
      while (cameFrom.has(k)) {
        k = cameFrom.get(k)!
        keys.push(k)
      }
      keys.reverse()
      return keys.map((pk) => {
        const [gx, gy] = pk.split(',').map(Number)
        return toWorld({ gx, gy })
      })
    }

    const currentG = gScore.get(currentKey) ?? 0
    for (const [dx, dy] of dirs) {
      const ng = { gx: current.g.gx + dx, gy: current.g.gy + dy }
      if (ng.gx < 0 || ng.gy < 0 || ng.gx > cols || ng.gy > rows) continue
      const nk = key(ng)
      if (closed.has(nk)) continue
      const isEndpoint = (ng.gx === e.gx && ng.gy === e.gy) || (ng.gx === s.gx && ng.gy === s.gy)
      if (!isEndpoint && isBlocked(ng)) continue
      const tentative = currentG + 1
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        cameFrom.set(nk, currentKey)
        gScore.set(nk, tentative)
        open.set(nk, { g: ng, f: tentative + h(ng) })
      }
    }
  }
  return null
}

export interface AutoRouteOptions {
  /** Grid cell size — normally the project's grid size, so routed corners land on grid lines. */
  cellSize: number
  /** Instances excluded from the obstacle set (normally the pipe's own two endpoint components). */
  ignoreInstanceIds: Set<string>
}

/**
 * Obstacle-avoiding auto-route: grid A* from the pipe's current start to its
 * current end, treating every other component's bounding box as blocked.
 * Returns a fresh waypoint list (always an ordinary, further hand-editable
 * waypoint list per the plan — auto-routing is a starting point, not a
 * constraint) or null if no path was found within the search region.
 */
export function computeAutoRoute(
  pipe: PipeInstance,
  instances: ComponentInstance[],
  pipes: PipeInstance[],
  layers: Layer[],
  options: AutoRouteOptions,
): Waypoint[] | null {
  const points = getPipePoints(pipe, instances, pipes, layers)
  if (!points) return null
  const start = points[0]
  const end = points[points.length - 1]

  const obstacles = instances
    .filter((inst) => !options.ignoreInstanceIds.has(inst.instanceId))
    .map(instanceWorldBounds)

  const path = findGridPath(start, end, obstacles, options.cellSize)
  if (!path) return null

  path[0] = start
  path[path.length - 1] = end
  const simplified = simplifyCollinear(path)
  const interior = simplified.slice(1, -1)
  return interior.map((p) => ({ x: p.x, y: p.y, kind: 'corner' as const }))
}
