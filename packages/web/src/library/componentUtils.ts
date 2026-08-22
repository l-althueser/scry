import type { RoleInstance, Suffix } from '@svg-editor/shared'

export const SVG_NS = 'http://www.w3.org/2000/svg'

/** name/value/setpoint are laid out relative to the icon/body, stacked in this order; indicator is never part of the stack. */
export const LABEL_ROLE_ORDER: Suffix[] = ['name', 'value', 'setpoint']

/** Editor-only placeholder shown for value/setpoint before Node-RED ever writes a real one — never exported/read as data, just a visual stand-in. Shared so every component type's preview text matches. */
export const PLACEHOLDER_ROLE_TEXT = 'waiting ...'

/**
 * Default fill for an "_indicator" role before Node-RED ever touches it —
 * purely this editor's own static/preview color, both in the live canvas
 * and in the exported SVG. Distinct from Node-RED's own runtime color
 * scheme (Black/LawnGreen/IndianRed per .claude/CLAUDE.md's documented
 * contract) — a live Node-RED flow overwrites this with "Black" on init
 * regardless, so this only affects what's visible before that happens (or
 * if the SVG is ever viewed outside Node-RED).
 */
export const DEFAULT_INDICATOR_COLOR = 'gray'

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

/** The transform for a positioned role group: translate into place, then spin the label around its own anchor by its own (independent of the parent's) rotation. */
export function roleTransformAttr(offset: { x: number; y: number }, rotationDeg: number | undefined): string {
  return `translate(${fmt(offset.x)},${fmt(offset.y)}) rotate(${fmt(rotationDeg ?? 0)})`
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
 * but its text still needs to sit at this same vertical anchor within its
 * row (matching where text sits inside a LABEL_BOX_HEIGHT-tall box) so that
 * name-to-value spacing looks the same as value-to-setpoint spacing.
 * Paired with `dominant-baseline="central"` (see createLabelBoxElement /
 * labelBoxExportLines) rather than a hand-picked baseline offset — a fixed
 * offset only centers one specific font-size, and was consistently off by
 * ~0.5px here since name (font-size 10) and value/setpoint (font-size 9)
 * shared one constant. `dominant-baseline: central` centers correctly for
 * any font size/string, verified against getBBox() for every role.
 */
export const NAME_TEXT_BASELINE_Y = LABEL_BOX_HEIGHT / 2

/**
 * World-space corners of a role's label box (closed loop, last point repeats
 * the first) — used to snap/track a leader-line endpoint onto a label's
 * border (see LeaderLineBorderRef, leaderLineGeometry.ts). value/setpoint
 * get a real box+text element for every component type
 * (createLabelBoxElement); `name` renders as bare text with no visible box
 * for most component types, but still gets the same LABEL_BOX_WIDTH/HEIGHT
 * footprint here on purpose — an invisible-but-real snap target at the same
 * size/position a box would occupy, rather than only the plain center point
 * (LeaderLineEndpointRef) it had before this. `indicator` is a status
 * overlay shaped like the component's own icon, not a generic rect, so it's
 * the only role that returns null here. One known simplification: a few
 * component types (e.g. process-indicator) rotate their whole group
 * including labels, so this box's true on-screen orientation there also
 * includes the instance's own rotation, not just the role's independent one
 * — same center-point-only limitation resolveLeaderLineEndpoint already has
 * for every type, not a new inaccuracy introduced here.
 */
export function roleBoxCorners(
  instance: { transform: { x: number; y: number; rotationDeg: number } },
  role: Pick<RoleInstance, 'role' | 'offset' | 'rotationDeg'>,
): { x: number; y: number }[] | null {
  if (role.role === 'indicator') return null
  const anchor = rotatePoint(role.offset, instance.transform.rotationDeg)
  const worldAnchor = { x: instance.transform.x + anchor.x, y: instance.transform.y + anchor.y }
  const half = LABEL_BOX_WIDTH / 2
  const localCorners = [
    { x: -half, y: 0 },
    { x: half, y: 0 },
    { x: half, y: LABEL_BOX_HEIGHT },
    { x: -half, y: LABEL_BOX_HEIGHT },
  ]
  const rot = role.rotationDeg ?? 0
  const corners = localCorners.map((c) => {
    const r = rotatePoint(c, rot)
    return { x: worldAnchor.x + r.x, y: worldAnchor.y + r.y }
  })
  return [...corners, corners[0]]
}

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
  text.setAttribute('y', String(LABEL_BOX_HEIGHT / 2))
  text.setAttribute('text-anchor', 'middle')
  text.setAttribute('dominant-baseline', 'central')
  text.setAttribute('font-family', 'Arial')
  text.setAttribute('font-size', '9')
  g.appendChild(text)

  return g
}

/**
 * Applies a role's color overrides (background/border/text) onto its
 * already-built DOM. Falls back to the rect's own `data-default-fill` /
 * `data-default-stroke` (set at creation time) when a field is unset, or to
 * BOX_ROLE_FILL/black if the rect didn't specify one — this is how `name`'s
 * click-target rect (invisible by default in most types, see e.g.
 * valveComponent's `nameHitArea`) stays transparent until the user actually
 * picks a color for it, while still remaining paintable (unlike the old
 * "skip if currently transparent" check, which locked it invisible forever).
 */
export function applyRoleBoxStyling(el: SVGGElement, role: RoleInstance): void {
  const rect = el.querySelector('rect')
  if (rect) {
    const defaultFill = rect.dataset.defaultFill ?? BOX_ROLE_FILL[role.role] ?? '#ffffff'
    const defaultStroke = rect.dataset.defaultStroke ?? '#000000'
    rect.setAttribute('fill', role.fillColor ?? defaultFill)
    rect.setAttribute('stroke', role.strokeColor ?? defaultStroke)
  }
  const text = el.querySelector('text')
  if (text) text.setAttribute('fill', role.textColor ?? '#000000')
}

export function fmt(n: number): string {
  return Number(n.toFixed(2)).toString()
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Export markup for one box+text label role, matching createLabelBoxElement's appearance — colors default to the same values it/applyRoleBoxStyling use when not overridden. */
export function labelBoxExportLines(
  indent: string,
  role: string,
  text: string,
  colors?: { fill?: string | null; stroke?: string | null; textColor?: string | null },
): string[] {
  const fill = colors?.fill ?? BOX_ROLE_FILL[role] ?? '#ffffff'
  const stroke = colors?.stroke ?? '#000000'
  const textColor = colors?.textColor ?? '#000000'
  return [
    `${indent}<rect x="${-LABEL_BOX_WIDTH / 2}" y="0" width="${LABEL_BOX_WIDTH}" height="${LABEL_BOX_HEIGHT}" fill="${fill}" stroke="${stroke}" stroke-width="1" />`,
    `${indent}<text x="0" y="${LABEL_BOX_HEIGHT / 2}" text-anchor="middle" dominant-baseline="central" font-family="Arial" font-size="9" fill="${textColor}">${escapeXml(text)}</text>`,
  ]
}
