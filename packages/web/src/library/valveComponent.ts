import type { ComponentInstance, RoleInstance } from '@svg-editor/shared'
import {
  LABEL_BOX_HEIGHT,
  LABEL_BOX_WIDTH,
  NAME_TEXT_BASELINE_Y,
  SVG_NS,
  applyRoleBoxStyling,
  createLabelBoxElement,
  escapeXml,
  fmt,
  labelBoxExportLines,
  packRoleOffsets,
  roleTransformAttr,
  rotatePoint,
} from './componentUtils'
import { registerComponentType } from './registry'

export const SCREW_DOWN_VALVE_TYPE = 'screw-down-valve'

/**
 * Geometry lifted from SVGs/Templates.svg (shape56 / IND000_indicator), with
 * the y-offset normalized so the shape's own origin is (0,0). Reused as-is
 * so this hard-coded prototype component already matches the real library
 * artwork it will eventually be replaced by (see M3, Library import pipeline).
 */
const OUTLINE_D = 'M0 0 L0 17.01 L34.02 0 L34.02 17.01 L0 0 Z'
const STEM_VERTICAL_D = 'M17.01 8.5 L17.01 -8.5'
const STEM_HORIZONTAL_D = 'M8.5 -8.5 L25.51 -8.5'

/** Horizontal center of the valve body — labels are anchored here so they stay centered under the icon. */
const VALVE_CENTER_X = 17.01

const LABEL_START_Y = 32
const LABEL_ROW_HEIGHT = 20

function defaultValveRoles(): RoleInstance[] {
  return packRoleOffsets(
    [
      { role: 'indicator', enabled: true, offset: { x: 0, y: 0 } },
      { role: 'name', enabled: true, offset: { x: 0, y: 0 } },
      { role: 'value', enabled: false, offset: { x: 0, y: 0 } },
      { role: 'setpoint', enabled: false, offset: { x: 0, y: 0 } },
    ],
    VALVE_CENTER_X,
    LABEL_START_Y,
    LABEL_ROW_HEIGHT,
    false,
  )
}

/**
 * Builds the static, one-time DOM structure for a valve instance. Follows
 * the Node-RED/ui-svg compatibility contract from .claude/CLAUDE.md:
 * - fill for the "_indicator" role lives only on the <g>, never on a child
 *   <path>, so `set_style_attribute` (fill) actually takes effect via CSS
 *   inheritance.
 * - "_name"/"_value"/"_setpoint" roles get a <text> as a direct child.
 *
 * The valve body (indicator + outline) is its own sub-group so instance
 * rotation can be applied to it alone — labels are positioned by rotating
 * their anchor point around the body's origin, but never rotated themselves,
 * so text stays upright while still moving clear of the inlet/outlet ends
 * as the valve is rotated.
 */
function renderScrewDownValve(group: SVGGElement) {
  const bodyGroup = document.createElementNS(SVG_NS, 'g')
  bodyGroup.setAttribute('class', 'gv-valve-body')

  const indicatorGroup = document.createElementNS(SVG_NS, 'g')
  indicatorGroup.setAttribute('class', 'gv-role gv-role-indicator')
  indicatorGroup.setAttribute('data-role', 'indicator')
  indicatorGroup.setAttribute('fill', 'black')
  const indicatorPath = document.createElementNS(SVG_NS, 'path')
  indicatorPath.setAttribute('d', OUTLINE_D)
  indicatorGroup.appendChild(indicatorPath)
  bodyGroup.appendChild(indicatorGroup)

  const outlineGroup = document.createElementNS(SVG_NS, 'g')
  outlineGroup.setAttribute('class', 'gv-valve-outline')
  for (const d of [OUTLINE_D, STEM_VERTICAL_D, STEM_HORIZONTAL_D]) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', '#000000')
    path.setAttribute('stroke-width', '1.5')
    outlineGroup.appendChild(path)
  }
  bodyGroup.appendChild(outlineGroup)

  group.appendChild(bodyGroup)

  const nameGroup = document.createElementNS(SVG_NS, 'g')
  nameGroup.setAttribute('class', 'gv-role gv-role-name')
  nameGroup.setAttribute('data-role', 'name')

  // SVG <text> only registers pointer hits on the actual painted glyphs, not
  // the surrounding whitespace — without this, clicking near (but not
  // exactly on) the name label misses it entirely and falls through to
  // empty-canvas box-select instead of selecting the role.
  const nameHitArea = document.createElementNS(SVG_NS, 'rect')
  nameHitArea.setAttribute('x', String(-LABEL_BOX_WIDTH / 2))
  nameHitArea.setAttribute('y', '0')
  nameHitArea.setAttribute('width', String(LABEL_BOX_WIDTH))
  nameHitArea.setAttribute('height', String(LABEL_BOX_HEIGHT))
  nameHitArea.setAttribute('fill', 'transparent')
  nameHitArea.setAttribute('stroke', 'transparent')
  nameHitArea.setAttribute('stroke-width', '1')
  nameHitArea.dataset.defaultFill = 'transparent'
  nameHitArea.dataset.defaultStroke = 'transparent'
  nameGroup.appendChild(nameHitArea)

  const nameText = document.createElementNS(SVG_NS, 'text')
  nameText.setAttribute('x', '0')
  nameText.setAttribute('y', String(NAME_TEXT_BASELINE_Y))
  nameText.setAttribute('text-anchor', 'middle')
  nameText.setAttribute('dominant-baseline', 'central')
  nameText.setAttribute('font-family', 'Arial')
  nameText.setAttribute('font-size', '10')
  nameGroup.appendChild(nameText)
  group.appendChild(nameGroup)

  group.appendChild(createLabelBoxElement('value'))
  group.appendChild(createLabelBoxElement('setpoint'))
}

function updateScrewDownValve(group: SVGGElement, instance: ComponentInstance) {
  const { x, y, rotationDeg } = instance.transform
  group.setAttribute('transform', `translate(${x},${y})`)

  const bodyGroup = group.querySelector<SVGGElement>('.gv-valve-body')
  bodyGroup?.setAttribute('transform', `rotate(${rotationDeg})`)

  const indicatorRole = instance.roles.find((r) => r.role === 'indicator')
  const indicatorGroup = group.querySelector<SVGGElement>('.gv-role-indicator')
  if (indicatorGroup) {
    indicatorGroup.style.display = indicatorRole?.enabled ? '' : 'none'
    indicatorGroup.id = `${instance.tag}_indicator`
  }

  for (const role of instance.roles) {
    if (role.role === 'indicator') continue
    const el = group.querySelector<SVGGElement>(`.gv-role-${role.role}`)
    if (!el) continue

    el.style.display = role.enabled ? '' : 'none'
    el.id = `${instance.tag}_${role.role}`
    // Rotate the anchor point with the valve so labels stay clear of the
    // (now rotated) inlet/outlet; the label's own rotationDeg (independent
    // of the valve's) still applies on top so it doesn't have to stay upright.
    const rotated = rotatePoint(role.offset, rotationDeg)
    el.setAttribute('transform', roleTransformAttr(rotated, role.rotationDeg))
    applyRoleBoxStyling(el, role)

    const text = el.querySelector('text')
    if (!text) continue
    text.textContent = role.role === 'name' ? instance.tag : 'waiting ...'
  }
}

function exportValveInstance(instance: ComponentInstance): string[] {
  const { x, y, rotationDeg } = instance.transform
  const tag = escapeXml(instance.tag)
  const lines: string[] = []

  lines.push(`    <!-- ${tag} (${escapeXml(instance.componentTypeId)}) -->`)

  // Decorative outline (visible valve body). Untagged: Node-RED never reads this.
  lines.push(`    <g transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(rotationDeg)})">`)
  for (const d of [OUTLINE_D, STEM_VERTICAL_D, STEM_HORIZONTAL_D]) {
    lines.push(`      <path d="${d}" fill="none" stroke="#000000" stroke-width="1.5" />`)
  }
  lines.push(`    </g>`)

  for (const role of instance.roles) {
    if (!role.enabled) continue

    if (role.role === 'indicator') {
      lines.push(
        `    <g id="${tag}_indicator" transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(rotationDeg)})" fill="black">`,
      )
      lines.push(`      <path d="${OUTLINE_D}" />`)
      lines.push(`    </g>`)
      continue
    }

    const abs = rotatePoint(role.offset, rotationDeg)
    const labelX = x + abs.x
    const labelY = y + abs.y
    const text = role.role === 'name' ? tag : 'waiting ...'

    lines.push(`    <g id="${tag}_${role.role}" transform="${roleTransformAttr({ x: labelX, y: labelY }, role.rotationDeg)}">`)
    if (role.role === 'value' || role.role === 'setpoint') {
      lines.push(
        ...labelBoxExportLines('      ', role.role, text, {
          fill: role.fillColor,
          stroke: role.strokeColor,
          textColor: role.textColor,
        }),
      )
    } else if (role.fillColor || role.strokeColor) {
      lines.push(
        ...labelBoxExportLines('      ', role.role, text, {
          fill: role.fillColor ?? 'transparent',
          stroke: role.strokeColor ?? 'transparent',
          textColor: role.textColor,
        }),
      )
    } else {
      lines.push(
        `      <text x="0" y="${NAME_TEXT_BASELINE_Y}" text-anchor="middle" dominant-baseline="central" font-family="Arial" font-size="10" fill="${role.textColor ?? '#000000'}">${escapeXml(text)}</text>`,
      )
    }
    lines.push(`    </g>`)
  }

  return lines
}

registerComponentType({
  typeId: SCREW_DOWN_VALVE_TYPE,
  displayName: 'Manual valve (HV)',
  tagPrefix: 'HV',
  category: 'Valves',
  render: renderScrewDownValve,
  update: updateScrewDownValve,
  defaultRoles: defaultValveRoles,
  centerRoles: (roles) => packRoleOffsets(roles, VALVE_CENTER_X, LABEL_START_Y, LABEL_ROW_HEIGHT, false),
  autoPackRoles: (roles) => packRoleOffsets(roles, VALVE_CENTER_X, LABEL_START_Y, LABEL_ROW_HEIGHT, true),
  exportInstance: exportValveInstance,
  localBodyCorners: [
    { x: 0, y: -8.5 },
    { x: 34.02, y: -8.5 },
    { x: 0, y: 17.01 },
    { x: 34.02, y: 17.01 },
  ],
  // The bowtie's pinch point is at the center (17.01, ~8.5); the two wide
  // ends at the left/right edges are the natural inlet/outlet connections.
  ports: [
    { portId: 'in', x: 0, y: 8.5, exitAngleDeg: 180 },
    { portId: 'out', x: 34.02, y: 8.5, exitAngleDeg: 0 },
  ],
})
