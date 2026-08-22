import type { ComponentInstance, FreeShape, Layer, LeaderLine, PipeInstance } from '@svg-editor/shared'
import {
  LABEL_BOX_HEIGHT,
  LABEL_BOX_WIDTH,
  escapeXml,
  getComponentType,
  resolveLocalBodyCorners,
  rotatePoint,
} from '../library'
import { exportLeaderLine } from '../leaderLines/leaderLineExport'
import { getLeaderLinePoints } from '../leaderLines/leaderLineGeometry'
import { exportPipeInstance } from '../pipes/pipeExport'
import { getDisplayPoints, getPipePoints, type Point } from '../pipes/pipeGeometry'
import { exportFreeShape } from '../shapes/freeShapeExport'
import { boundsOfPoints } from '../shapes/freeShapeGeometry'

const PADDING = 40
const DEFAULT_VIEWBOX = { minX: 0, minY: 0, maxX: 400, maxY: 300 }

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * Serializes the current instances and pipes into a clean, hand-inspectable
 * SVG that follows the Node-RED/ui-svg compatibility contract documented in
 * .claude/CLAUDE.md:
 * - a real viewBox/width/height on the root
 * - <g id="viewport"> as the top-level content group
 * - <g id="{tag}_{role}"> per enabled role, with <text> as a direct child
 *   for name/value/setpoint
 * - fill for "_indicator" lives only on that element, never on a child <path>
 * - no SvgPublishData, no Visio-era metadata
 *
 * Per-instance markup is delegated to each component type's own
 * exportInstance() (see library/registry.ts); per-pipe markup to
 * pipes/pipeExport.ts — this function only handles the document shell and
 * the shared viewBox sizing.
 */
export function exportProjectToSvg(
  instances: ComponentInstance[],
  pipes: PipeInstance[] = [],
  freeShapes: FreeShape[] = [],
  layers: Layer[] = [],
  leaderLines: LeaderLine[] = [],
): string {
  const bounds = computeBounds(instances, pipes, freeShapes, layers, leaderLines)
  const vbX = bounds.minX - PADDING
  const vbY = bounds.minY - PADDING
  const vbW = bounds.maxX - bounds.minX + PADDING * 2
  const vbH = bounds.maxY - bounds.minY + PADDING * 2

  const lines: string[] = []
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(vbX)} ${fmt(vbY)} ${fmt(vbW)} ${fmt(vbH)}" width="${fmt(vbW)}" height="${fmt(vbH)}">`,
  )
  lines.push(`  <g id="viewport" fill="none">`)

  // Background image layers render first (bottom of the stack), so the
  // rest of the diagram draws on top of the reference image.
  for (const layer of layers) {
    if (layer.kind !== 'image' || !layer.includeInExport) continue
    lines.push(
      `    <image x="${fmt(layer.x)}" y="${fmt(layer.y)}" width="${fmt(layer.width)}" height="${fmt(layer.height)}" opacity="${fmt(layer.opacity)}" href="${escapeXml(layer.src)}" />`,
    )
  }

  // Pipes render next (behind components), matching the canvas layer order.
  const pointsByPipe = new Map<string, Point[]>()
  const displayPointsByPipe = new Map<string, Point[]>()
  for (const pipe of pipes) {
    const pts = getPipePoints(pipe, instances, pipes, layers)
    if (pts) {
      pointsByPipe.set(pipe.instanceId, pts)
      displayPointsByPipe.set(pipe.instanceId, getDisplayPoints(pipe, pts))
    }
  }
  for (const pipe of pipes) {
    lines.push(...exportPipeInstance(pipe, pipes, pointsByPipe, displayPointsByPipe))
  }

  for (const inst of instances) {
    lines.push(...getComponentType(inst.componentTypeId).exportInstance(inst))
  }

  // Annotation shapes render last (on top) — they're typically call-outs/highlights meant to sit over the diagram.
  for (const shape of freeShapes) {
    lines.push(...exportFreeShape(shape))
  }

  // Leader lines render last of all — annotation pointers meant to sit above everything, including free shapes.
  for (const line of leaderLines) {
    lines.push(...exportLeaderLine(line, instances, pipes, freeShapes, layers))
  }

  lines.push(`  </g>`)
  lines.push(`</svg>`)
  return lines.join('\n')
}

/** Rough body/label/pipe/shape/image-layer bounding box, used to size the export viewBox. */
function computeBounds(
  instances: ComponentInstance[],
  pipes: PipeInstance[],
  freeShapes: FreeShape[],
  layers: Layer[],
  leaderLines: LeaderLine[] = [],
): Bounds {
  const hasImageLayer = layers.some((l) => l.kind === 'image')
  if (
    instances.length === 0 &&
    pipes.length === 0 &&
    freeShapes.length === 0 &&
    leaderLines.length === 0 &&
    !hasImageLayer
  ) {
    return { ...DEFAULT_VIEWBOX }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const inst of instances) {
    const { x, y, rotationDeg } = inst.transform
    const def = getComponentType(inst.componentTypeId)

    for (const corner of resolveLocalBodyCorners(def, inst)) {
      const r = rotatePoint(corner, rotationDeg)
      minX = Math.min(minX, x + r.x)
      maxX = Math.max(maxX, x + r.x)
      minY = Math.min(minY, y + r.y)
      maxY = Math.max(maxY, y + r.y)
    }

    for (const role of inst.roles) {
      if (role.role === 'indicator' || !role.enabled) continue
      const r = rotatePoint(role.offset, rotationDeg)
      const corners = [
        { x: r.x - LABEL_BOX_WIDTH / 2, y: r.y },
        { x: r.x + LABEL_BOX_WIDTH / 2, y: r.y + LABEL_BOX_HEIGHT },
      ]
      for (const c of corners) {
        minX = Math.min(minX, x + c.x)
        maxX = Math.max(maxX, x + c.x)
        minY = Math.min(minY, y + c.y)
        maxY = Math.max(maxY, y + c.y)
      }
    }
  }

  for (const pipe of pipes) {
    const points = getPipePoints(pipe, instances, pipes, layers)
    if (!points) continue
    for (const p of points) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
  }

  for (const shape of freeShapes) {
    const b = boundsOfPoints(shape.points)
    minX = Math.min(minX, b.minX)
    maxX = Math.max(maxX, b.maxX)
    minY = Math.min(minY, b.minY)
    maxY = Math.max(maxY, b.maxY)
  }

  for (const layer of layers) {
    if (layer.kind !== 'image') continue
    minX = Math.min(minX, layer.x)
    maxX = Math.max(maxX, layer.x + layer.width)
    minY = Math.min(minY, layer.y)
    maxY = Math.max(maxY, layer.y + layer.height)
  }

  for (const line of leaderLines) {
    const points = getLeaderLinePoints(line, instances, pipes, freeShapes, layers)
    if (!points) continue
    for (const p of points) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
  }

  if (!Number.isFinite(minX)) return { ...DEFAULT_VIEWBOX }
  return { minX, minY, maxX, maxY }
}

function fmt(n: number): string {
  return Number(n.toFixed(2)).toString()
}

export function downloadSvgFile(filename: string, svgContent: string) {
  const blob = new Blob([svgContent], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
