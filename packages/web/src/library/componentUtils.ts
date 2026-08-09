import type { RoleInstance, Suffix } from '@svg-editor/shared'

export const SVG_NS = 'http://www.w3.org/2000/svg'

/** name/value/setpoint are laid out relative to the icon/body, stacked in this order; indicator is never part of the stack. */
export const LABEL_ROLE_ORDER: Suffix[] = ['name', 'value', 'setpoint']

/**
 * Packs the enabled name/value/setpoint roles into a gap-free vertical
 * stack (value above setpoint when both are enabled — see LABEL_ROLE_ORDER),
 * without touching the position of a `manuallyPositioned` role: those are
 * skipped, and the remaining auto-positioned roles just stack among
 * themselves, so a manually dragged label doesn't jump when a sibling role
 * gets toggled on/off elsewhere.
 *
 * `respectManual: false` (used by the explicit "Re-center labels" action)
 * instead resets *every* stack role, clearing the manual flag as it goes —
 * an explicit user request to tidy everything up should actually do that,
 * even for previously-dragged labels.
 */
export function packRoleOffsets(
  roles: RoleInstance[],
  centerX: number,
  startY: number,
  rowHeight: number,
  respectManual: boolean,
): RoleInstance[] {
  let cursor = startY
  return roles.map((role) => {
    if (role.role === 'indicator' || !LABEL_ROLE_ORDER.includes(role.role) || !role.enabled) return role
    if (respectManual && role.manuallyPositioned) return role
    const offset = { x: centerX, y: cursor }
    cursor += rowHeight
    return { ...role, offset, manuallyPositioned: false }
  })
}

export function rotatePoint(pt: { x: number; y: number }, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return { x: pt.x * cos - pt.y * sin, y: pt.x * sin + pt.y * cos }
}

export const LABEL_BOX_WIDTH = 48
export const LABEL_BOX_HEIGHT = 16

/**
 * The "name" role renders as bare text (no box), unlike value/setpoint —
 * but its text still needs to sit at this same baseline y within its row
 * (matching where text sits inside a LABEL_BOX_HEIGHT-tall box) so that
 * name-to-value spacing looks the same as value-to-setpoint spacing. A
 * plain text element with y=0 would put its baseline (and so the visible
 * glyphs, which grow upward from there) right at the top of the row instead
 * — visually a much bigger gap to whatever role is packed below it.
 */
export const NAME_TEXT_BASELINE_Y = LABEL_BOX_HEIGHT / 2 + 3

/** Roles rendered as a filled box + text, styled after Templates.svg's IND000_value/IND000_setpoint. */
export const BOX_ROLE_FILL: Partial<Record<string, string>> = {
  value: '#d8d8d8',
  setpoint: '#ffffff',
  name: '#ffffff',
}

/** A centered box+text label DOM element for one role, shared by every component type that uses this style. */
export function createLabelBoxElement(role: string): SVGGElement {
  const g = document.createElementNS(SVG_NS, 'g')
  g.setAttribute('class', `gv-role gv-role-${role}`)
  g.setAttribute('data-role', role)

  const rect = document.createElementNS(SVG_NS, 'rect')
  rect.setAttribute('x', String(-LABEL_BOX_WIDTH / 2))
  rect.setAttribute('y', '0')
  rect.setAttribute('width', String(LABEL_BOX_WIDTH))
  rect.setAttribute('height', String(LABEL_BOX_HEIGHT))
  rect.setAttribute('fill', BOX_ROLE_FILL[role] ?? '#ffffff')
  rect.setAttribute('stroke', '#000000')
  rect.setAttribute('stroke-width', '1')
  g.appendChild(rect)

  const text = document.createElementNS(SVG_NS, 'text')
  text.setAttribute('x', '0')
  text.setAttribute('y', String(LABEL_BOX_HEIGHT / 2 + 3))
  text.setAttribute('text-anchor', 'middle')
  text.setAttribute('font-family', 'Arial')
  text.setAttribute('font-size', '9')
  g.appendChild(text)

  return g
}

export function fmt(n: number): string {
  return Number(n.toFixed(2)).toString()
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Export markup for one box+text label role, matching createLabelBoxElement's appearance. */
export function labelBoxExportLines(indent: string, role: string, text: string): string[] {
  const fill = BOX_ROLE_FILL[role] ?? '#ffffff'
  return [
    `${indent}<rect x="${-LABEL_BOX_WIDTH / 2}" y="0" width="${LABEL_BOX_WIDTH}" height="${LABEL_BOX_HEIGHT}" fill="${fill}" stroke="#000000" stroke-width="1" />`,
    `${indent}<text x="0" y="${LABEL_BOX_HEIGHT / 2 + 3}" text-anchor="middle" font-family="Arial" font-size="9" fill="#000000">${escapeXml(text)}</text>`,
  ]
}
