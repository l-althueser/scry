import type { PipeInstance } from '@svg-editor/shared'
import { escapeXml, fmt } from '../library/componentUtils'
import {
  computeHopsForPipe,
  curvedPathD,
  midpoint,
  resolveIndicatorTag,
  resolvePipeColor,
  straightPathDWithHops,
  type Point,
} from './pipeGeometry'

/**
 * Export markup for one pipe. The decorative line is always untagged; the
 * "{indicatorTag}_indicator" circle is only emitted when indicatorEnabled,
 * matching how a ComponentInstance only exports its enabled roles. The
 * indicator tag is the pipe's *volume* tag, not its own — every pipe in the
 * same connected volume shares one id, so Node-RED coloring it lights up
 * the whole run at once (see pipes/pipeVolumes.ts). `pointsByPipe` is the raw
 * port/waypoint list (used for curved splines); `displayPointsByPipe` is the
 * per-mode rendering copy (orthogonal-expanded where applicable) used for
 * hop detection and the straight/orthogonal path itself — see
 * getDisplayPoints for why the two must stay separate. `isNameLabelPipe` —
 * whether THIS pipe is the one chosen (via computeNameLabelPipeIds,
 * pipeVolumes.ts) to render its volume's shared "_name" label; every other
 * pipe in the same volume may also have nameEnabled but must not duplicate it.
 */
export function exportPipeInstance(
  pipe: PipeInstance,
  allPipes: PipeInstance[],
  pointsByPipe: Map<string, Point[]>,
  displayPointsByPipe: Map<string, Point[]>,
  isNameLabelPipe: boolean,
): string[] {
  const points = pointsByPipe.get(pipe.instanceId)
  const displayPoints = displayPointsByPipe.get(pipe.instanceId)
  if (!points || !displayPoints) return []

  const tag = escapeXml(pipe.tag)
  const lines: string[] = []
  lines.push(`    <!-- ${tag} (pipe) -->`)

  const d =
    pipe.routingMode === 'curved'
      ? curvedPathD(points)
      : straightPathDWithHops(displayPoints, computeHopsForPipe(pipe.instanceId, allPipes, displayPointsByPipe))

  const color = escapeXml(resolvePipeColor(pipe))
  lines.push(`    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" />`)

  if (pipe.indicatorEnabled) {
    const mid = midpoint(displayPoints)
    const indicatorTag = escapeXml(resolveIndicatorTag(pipe))
    lines.push(
      `    <circle id="${indicatorTag}_indicator" cx="${fmt(mid.x)}" cy="${fmt(mid.y)}" r="5" fill="black" />`,
    )
  }

  if (pipe.nameEnabled && isNameLabelPipe) {
    // Same bare-text style as a component instance's `name` role
    // (createLabelBoxElement's non-box branch) — direct <text> child, no
    // box. Text is the pipe's *volume* tag, same as "_indicator" above.
    const mid = midpoint(displayPoints)
    const nameTag = escapeXml(resolveIndicatorTag(pipe))
    lines.push(
      `    <g id="${nameTag}_name">`,
      `      <text x="${fmt(mid.x)}" y="${fmt(mid.y - 10)}" text-anchor="middle" dominant-baseline="central" font-family="Arial" font-size="10">${nameTag}</text>`,
      `    </g>`,
    )
  }

  return lines
}
