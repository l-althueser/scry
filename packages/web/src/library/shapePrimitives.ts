import type { PathShape } from './iconComponentFactory'

/**
 * Parametric building blocks for the Library Editor's shape lists — kept as
 * editable numbers (not flattened to a path `d` string) so a saved custom
 * type's geometry can be re-opened and adjusted later, not just appended to.
 * Converted to a `PathShape` (what `registerIconComponentType` actually
 * consumes) only at registration time, via `primitiveToPathShape`.
 */
export type ShapePrimitive =
  | { kind: 'rect'; cx: number; cy: number; width: number; height: number; strokeWidth?: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; strokeWidth?: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; strokeWidth?: number }
  | { kind: 'path'; d: string; strokeWidth?: number }

export const SHAPE_PRIMITIVE_KINDS: ShapePrimitive['kind'][] = ['rect', 'ellipse', 'line', 'path']

export function defaultPrimitive(kind: ShapePrimitive['kind']): ShapePrimitive {
  switch (kind) {
    case 'rect':
      return { kind: 'rect', cx: 0, cy: 0, width: 20, height: 20 }
    case 'ellipse':
      return { kind: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 10 }
    case 'line':
      return { kind: 'line', x1: -10, y1: 0, x2: 10, y2: 0 }
    case 'path':
      return { kind: 'path', d: 'M-10 -10 L10 -10 L0 10 Z' }
  }
}

export function primitiveToPathD(p: ShapePrimitive): string {
  switch (p.kind) {
    case 'rect': {
      const x = p.cx - p.width / 2
      const y = p.cy - p.height / 2
      return `M${x} ${y} L${x + p.width} ${y} L${x + p.width} ${y + p.height} L${x} ${y + p.height} Z`
    }
    case 'ellipse': {
      const { cx, cy, rx, ry } = p
      if (rx === 0 || ry === 0) return ''
      return `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
    }
    case 'line':
      return `M${p.x1} ${p.y1} L${p.x2} ${p.y2}`
    case 'path':
      return p.d
  }
}

export function primitiveToPathShape(p: ShapePrimitive): PathShape {
  return { d: primitiveToPathD(p), strokeWidth: p.strokeWidth }
}

/** Extent (unrotated, local) of one primitive — used to auto-derive the type's body bounding box. */
function primitiveBounds(p: ShapePrimitive): { minX: number; minY: number; maxX: number; maxY: number } | null {
  switch (p.kind) {
    case 'rect':
      return {
        minX: p.cx - p.width / 2,
        minY: p.cy - p.height / 2,
        maxX: p.cx + p.width / 2,
        maxY: p.cy + p.height / 2,
      }
    case 'ellipse':
      return { minX: p.cx - p.rx, minY: p.cy - p.ry, maxX: p.cx + p.rx, maxY: p.cy + p.ry }
    case 'line':
      return { minX: Math.min(p.x1, p.x2), minY: Math.min(p.y1, p.y2), maxX: Math.max(p.x1, p.x2), maxY: Math.max(p.y1, p.y2) }
    case 'path':
      return null // raw path data isn't parsed for bounds — falls back to whatever else contributes to the box.
  }
}

/** Auto-derived `localBodyCorners` for the type — the 4 corners of the bounding box of every shape (plus the body image, if any) combined, with a small fallback so an empty/path-only spec still gets a sane (non-zero) export viewBox. */
export function computeBoundingCorners(
  primitives: ShapePrimitive[],
  bodyImage?: { x: number; y: number; width: number; height: number } | null,
): { x: number; y: number }[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of primitives) {
    const b = primitiveBounds(p)
    if (!b) continue
    minX = Math.min(minX, b.minX)
    minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX)
    maxY = Math.max(maxY, b.maxY)
  }
  if (bodyImage) {
    minX = Math.min(minX, bodyImage.x)
    minY = Math.min(minY, bodyImage.y)
    maxX = Math.max(maxX, bodyImage.x + bodyImage.width)
    maxY = Math.max(maxY, bodyImage.y + bodyImage.height)
  }
  if (!Number.isFinite(minX)) {
    minX = -20
    minY = -20
    maxX = 20
    maxY = 20
  }
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
}
