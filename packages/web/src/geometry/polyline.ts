// Tiny, dependency-free polyline math shared by shape borders, pipe
// polylines, and role label boxes — all three ultimately resolve a leader
// line's LeaderLineBorderRef (segmentIndex/t) against "some point list",
// just built differently (see leaderLineGeometry.ts's resolveLeaderLineEndpoint).

export interface Point {
  x: number
  y: number
}

/** Point at `t` (0..1) along the segment from `a` to `b`. */
export function pointOnSegment(a: Point, b: Point, t: number): Point {
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
}

/** Resolves a (segmentIndex, t) pair back to a world point along `points` — the inverse of nearestPointOnPolylineIndexed. Clamps segmentIndex into range so a stale ref (e.g. a pipe that lost waypoints) degrades to its nearest remaining edge instead of throwing. */
export function pointAlongPolyline(points: Point[], segmentIndex: number, t: number): Point | null {
  if (points.length < 2) return points[0] ?? null
  const maxIndex = points.length - 2
  const i = Math.max(0, Math.min(maxIndex, segmentIndex))
  return pointOnSegment(points[i], points[i + 1], t)
}

/** Closest point on the open polyline `points` (no implicit closing segment) to `p`, expressed as which segment and how far along it — the encoding a LeaderLineBorderRef persists so it can be re-resolved against the target's live (possibly changed) geometry later via pointAlongPolyline. */
export function nearestPointOnPolylineIndexed(
  points: Point[],
  p: Point,
): { point: Point; segmentIndex: number; t: number; dist: number } | null {
  if (points.length < 2) return null
  let best: { point: Point; segmentIndex: number; t: number; dist: number } | null = null
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
    const point = pointOnSegment(a, b, t)
    const dist = Math.hypot(point.x - p.x, point.y - p.y)
    if (!best || dist < best.dist) best = { point, segmentIndex: i, t, dist }
  }
  return best
}
