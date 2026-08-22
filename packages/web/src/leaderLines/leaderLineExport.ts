import type { ComponentInstance, FreeShape, Layer, LeaderLine, PipeInstance } from '@svg-editor/shared'
import { getLeaderLinePoints, leaderLinePathD } from './leaderLineGeometry'

/** Small filled circle at the "to" end, reading as an arrowhead/pointer without needing an actual <marker> def. */
const DOT_RADIUS = 3

/** Plain, untagged SVG markup — never matches the Node-RED tag regex, purely a visual annotation pointing from a label to a spot (e.g. on a background image). */
export function exportLeaderLine(
  line: LeaderLine,
  instances: ComponentInstance[],
  pipes: PipeInstance[],
  freeShapes: FreeShape[],
  layers: Layer[],
): string[] {
  const points = getLeaderLinePoints(line, instances, pipes, freeShapes, layers)
  if (!points) return []
  const d = leaderLinePathD(points)
  const last = points[points.length - 1]
  return [
    `    <path d="${d}" fill="none" stroke="#555555" stroke-width="1.25" stroke-dasharray="4 2" />`,
    `    <circle cx="${last.x}" cy="${last.y}" r="${DOT_RADIUS}" fill="#555555" />`,
  ]
}
