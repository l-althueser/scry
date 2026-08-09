import { SVG_NS } from './componentUtils'
import { getComponentType } from './registry'

/**
 * Configures a freshly render()-ed group as a placeholder/ghost preview
 * (used for both the toolbar icon and the canvas placement ghost):
 * - Types with a body/icon shape (localBodyCorners set, e.g. the valve):
 *   show the body, hide the name/value/setpoint label boxes.
 * - Types without one (e.g. process-indicator): the labels *are* the visual
 *   identity, so they're shown instead (positioned via their default
 *   offsets, since render() alone doesn't place them), with short
 *   placeholder text.
 */
export function configurePlaceholderRoles(typeId: string, group: SVGGElement) {
  const def = getComponentType(typeId)

  if (def.localBodyCorners.length > 0) {
    for (const role of ['name', 'value', 'setpoint']) {
      group.querySelector<SVGGElement>(`.gv-role-${role}`)?.style.setProperty('display', 'none')
    }
    return
  }

  for (const role of def.defaultRoles()) {
    const el = group.querySelector<SVGGElement>(`.gv-role-${role.role}`)
    if (!el) continue
    el.style.display = role.enabled ? '' : 'none'
    if (!role.enabled) continue
    el.setAttribute('transform', `translate(${role.offset.x},${role.offset.y})`)
    const text = el.querySelector('text')
    if (text) text.textContent = role.role === 'name' ? 'TAG' : '123'
  }
}

/**
 * Builds a small standalone SVG showing what a component type looks like,
 * reusing the exact same render() DOM output as the live canvas — so the
 * toolbar icon never drifts out of sync with the real appearance.
 */
export function createComponentThumbnail(typeId: string): SVGSVGElement {
  const def = getComponentType(typeId)

  const svg = document.createElementNS(SVG_NS, 'svg')
  const group = document.createElementNS(SVG_NS, 'g')
  def.render(group)
  svg.appendChild(group)
  configurePlaceholderRoles(typeId, group)

  let minX: number
  let minY: number
  let maxX: number
  let maxY: number

  if (def.localBodyCorners.length > 0) {
    const xs = def.localBodyCorners.map((c) => c.x)
    const ys = def.localBodyCorners.map((c) => c.y)
    minX = Math.min(...xs)
    maxX = Math.max(...xs)
    minY = Math.min(...ys)
    maxY = Math.max(...ys)
  } else {
    minX = Infinity
    minY = Infinity
    maxX = -Infinity
    maxY = -Infinity
    for (const role of def.defaultRoles()) {
      if (!role.enabled) continue
      minX = Math.min(minX, role.offset.x - 24)
      maxX = Math.max(maxX, role.offset.x + 24)
      minY = Math.min(minY, role.offset.y)
      maxY = Math.max(maxY, role.offset.y + 16)
    }
    if (!Number.isFinite(minX)) {
      minX = -24
      minY = 0
      maxX = 24
      maxY = 16
    }
  }

  const pad = 4
  svg.setAttribute(
    'viewBox',
    `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`,
  )
  return svg
}
