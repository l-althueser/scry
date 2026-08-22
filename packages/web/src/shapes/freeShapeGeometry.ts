import type { FreeShape, FreeShapeStyle, TextAlign } from '@svg-editor/shared'
import { nearestPointOnPolylineIndexed, pointAlongPolyline } from '../geometry/polyline'

export interface Point {
  x: number
  y: number
}

export const DEFAULT_SHAPE_STYLE: FreeShapeStyle = {
  stroke: '#000000',
  strokeWidth: 2,
  fill: null,
}

export const DEFAULT_FONT_SIZE = 16
/** Multiplied by font size to get the vertical spacing between wrapped lines — shared by the live canvas render and the exported SVG's <tspan>s so they match. */
export const TEXT_LINE_HEIGHT = 1.2

/** SVG `text-anchor` for a text shape's alignment — undefined/'left' (the only behavior before alignment existed) maps to 'start'. */
export function textAnchorFor(align: TextAlign | undefined): 'start' | 'middle' | 'end' {
  if (align === 'center') return 'middle'
  if (align === 'right') return 'end'
  return 'start'
}

/** A text shape's content split into rendered lines — `\n` is the only line break a user can type (via the textarea in the properties panel). */
export function splitTextLines(text: string | undefined): string[] {
  return (text ?? '').split('\n')
}

/** Bounding-box rect attributes from two opposite corners (order-independent, unlike a raw SVG <rect>). */
export function rectAttrs(points: Point[]): { x: number; y: number; width: number; height: number } {
  const [a, b] = points
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  }
}

/** Ellipse inscribed in the bounding box of two opposite corners. */
export function ellipseAttrs(points: Point[]): { cx: number; cy: number; rx: number; ry: number } {
  const [a, b] = points
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    rx: Math.abs(b.x - a.x) / 2,
    ry: Math.abs(b.y - a.y) / 2,
  }
}

export function pointsAttr(points: Point[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ')
}

export function boundsOfPoints(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

function nearestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return { x: a.x, y: a.y }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return { x: a.x + t * dx, y: a.y + t * dy }
}

function nearestPointOnPolyline(p: Point, points: Point[]): Point {
  let best = points[0]
  let bestDist = Infinity
  for (let i = 0; i < points.length - 1; i++) {
    const candidate = nearestPointOnSegment(p, points[i], points[i + 1])
    const d = Math.hypot(candidate.x - p.x, candidate.y - p.y)
    if (d < bestDist) {
      bestDist = d
      best = candidate
    }
  }
  return best
}

/**
 * The point list a shape's border is walked as — rect/polygon as a full
 * closed perimeter (last point repeats the first), line as its one open
 * segment. Ellipse approximates its border with its bounding box's
 * perimeter (not a true oval outline, but enough to dock a leader line onto
 * "roughly the right side"). Text has no border. Exposed separately from
 * nearestPointOnShapeBorder so a persisted LeaderLineBorderRef
 * (segmentIndex/t) can be resolved back to a point later via
 * pointAlongPolyline, walking the shape's CURRENT points — which is what
 * makes the anchor track the shape through drags/resizes.
 */
export function shapeBorderPoints(shape: FreeShape): Point[] | null {
  if (shape.kind === 'rect' || shape.kind === 'ellipse') {
    const { x, y, width, height } = rectAttrs(shape.points)
    const corners = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ]
    return [...corners, corners[0]]
  }
  if (shape.kind === 'line') return [shape.points[0], shape.points[1]]
  if (shape.kind === 'polygon') return [...shape.points, shape.points[0]]
  return null
}

/**
 * Closest point on a shape's own outline to `p` — used by the leader-line
 * tool to "dock" an endpoint precisely onto a shape's border/line instead of
 * wherever the cursor happened to land nearby (see SvgCanvas's
 * findShapeAnchorNear). Text is deliberately not supported — no border to
 * dock onto.
 */
export function nearestPointOnShapeBorder(shape: FreeShape, p: Point): Point | null {
  const points = shapeBorderPoints(shape)
  if (!points) return null
  if (shape.kind === 'line') return nearestPointOnSegment(p, points[0], points[1])
  return nearestPointOnPolyline(p, points)
}

/** Same search as nearestPointOnShapeBorder, but also returns which segment/t to persist as a LeaderLineBorderRef — see resolveShapeBorderPoint for the inverse. */
export function nearestPointOnShapeBorderIndexed(
  shape: FreeShape,
  p: Point,
): { point: Point; segmentIndex: number; t: number; dist: number } | null {
  const points = shapeBorderPoints(shape)
  if (!points) return null
  return nearestPointOnPolylineIndexed(points, p)
}

/** Resolves a LeaderLineBorderRef's (segmentIndex, t) back to a live world point on `shape`'s current border — null if the shape's kind no longer has a border (e.g. changed) or the indices are out of range. */
export function resolveShapeBorderPoint(shape: FreeShape, segmentIndex: number, t: number): Point | null {
  const points = shapeBorderPoints(shape)
  if (!points) return null
  return pointAlongPolyline(points, segmentIndex, t)
}
