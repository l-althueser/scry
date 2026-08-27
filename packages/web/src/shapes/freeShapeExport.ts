import type { FreeShape } from '@svg-editor/shared'
import { escapeXml, fmt } from '../library/componentUtils'
import {
  DEFAULT_FONT_SIZE,
  TEXT_LINE_HEIGHT,
  ellipseAttrs,
  pointsAttr,
  rectAttrs,
  splitTextLines,
  textAnchorFor,
} from './freeShapeGeometry'

/** Plain, untagged SVG markup for one annotation shape — never matches the Node-RED tag regex, purely decorative. */
export function exportFreeShape(shape: FreeShape): string[] {
  const fill = shape.style.fill ?? 'none'
  const stroke = escapeXml(shape.style.stroke)
  const strokeWidth = fmt(shape.style.strokeWidth)

  switch (shape.kind) {
    case 'rect': {
      const { x, y, width, height } = rectAttrs(shape.points)
      return [
        `    <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" fill="${escapeXml(fill)}" stroke="${stroke}" stroke-width="${strokeWidth}" />`,
      ]
    }
    case 'ellipse': {
      const { cx, cy, rx, ry } = ellipseAttrs(shape.points)
      return [
        `    <ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(rx)}" ry="${fmt(ry)}" fill="${escapeXml(fill)}" stroke="${stroke}" stroke-width="${strokeWidth}" />`,
      ]
    }
    case 'line': {
      const [a, b] = shape.points
      return [
        `    <line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" stroke="${stroke}" stroke-width="${strokeWidth}" />`,
      ]
    }
    case 'polygon':
      return [
        `    <polygon points="${pointsAttr(shape.points)}" fill="${escapeXml(fill)}" stroke="${stroke}" stroke-width="${strokeWidth}" />`,
      ]
    case 'text': {
      const [a] = shape.points
      const fontSize = shape.fontSize ?? DEFAULT_FONT_SIZE
      const anchor = textAnchorFor(shape.textAlign)
      const lineHeight = fontSize * TEXT_LINE_HEIGHT
      const tspans = splitTextLines(shape.text)
        .map((line, i) => `<tspan x="${fmt(a.x)}" y="${fmt(a.y + i * lineHeight)}">${escapeXml(line)}</tspan>`)
        .join('')
      const transform = shape.rotationDeg ? ` transform="rotate(${fmt(shape.rotationDeg)} ${fmt(a.x)} ${fmt(a.y)})"` : ''
      return [
        `    <text font-family="Arial" font-size="${fmt(fontSize)}" text-anchor="${anchor}" fill="${stroke}"${transform}>${tspans}</text>`,
      ]
    }
  }
}
