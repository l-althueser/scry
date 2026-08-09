import type { ComponentInstance, RoleInstance, Suffix } from '@svg-editor/shared'
import { LABEL_ROLE_ORDER, createLabelBoxElement, escapeXml, fmt, labelBoxExportLines, packRoleOffsets, rotatePoint } from './componentUtils'
import { registerComponentType } from './registry'

export const PROCESS_INDICATOR_TYPE = 'process-indicator'

const ROW_HEIGHT = 20
/** Unlike the valve, there's no icon to anchor to — name/value/setpoint just stack from the origin. */
const ROLE_ORDER: Suffix[] = LABEL_ROLE_ORDER

function defaultIndicatorRoles(): RoleInstance[] {
  return packRoleOffsets(
    [
      { role: 'name', enabled: true, offset: { x: 0, y: 0 } },
      { role: 'value', enabled: true, offset: { x: 0, y: 0 } },
      { role: 'setpoint', enabled: false, offset: { x: 0, y: 0 } },
    ],
    0,
    0,
    ROW_HEIGHT,
    false,
  )
}

/**
 * A bare instrument tag: just stacked name/value/setpoint boxes, no valve
 * icon and no "_indicator" status role — e.g. a pressure/temperature
 * readout (PI101, TI102, ...) that isn't itself a controllable element.
 * Matches the IND000_name/IND000_value/IND000_setpoint pattern seen in
 * SVGs/Templates.svg. Unlike the valve, the whole thing rotates as a single
 * rigid unit — there's no separate body/inlet-outlet to keep labels clear
 * of, so no special upright-text handling is needed.
 */
function renderProcessIndicator(group: SVGGElement) {
  for (const role of ROLE_ORDER) {
    group.appendChild(createLabelBoxElement(role))
  }
}

function updateProcessIndicator(group: SVGGElement, instance: ComponentInstance) {
  const { x, y, rotationDeg } = instance.transform
  group.setAttribute('transform', `translate(${x},${y}) rotate(${rotationDeg})`)

  for (const role of instance.roles) {
    const el = group.querySelector<SVGGElement>(`.gv-role-${role.role}`)
    if (!el) continue

    el.style.display = role.enabled ? '' : 'none'
    el.id = `${instance.tag}_${role.role}`
    el.setAttribute('transform', `translate(${role.offset.x},${role.offset.y})`)

    const text = el.querySelector('text')
    if (!text) continue
    text.textContent = role.role === 'name' ? instance.tag : 'waiting ...'
  }
}

function exportProcessIndicatorInstance(instance: ComponentInstance): string[] {
  const { x, y, rotationDeg } = instance.transform
  const tag = escapeXml(instance.tag)
  const lines: string[] = []

  lines.push(`    <!-- ${tag} (${escapeXml(instance.componentTypeId)}) -->`)

  for (const role of instance.roles) {
    if (!role.enabled) continue

    // Export is a flat static snapshot, so rotation is baked into both the
    // anchor position and the box's own orientation (the whole tag rotates
    // as one rigid unit, unlike the valve's upright labels).
    const rotated = rotatePoint(role.offset, rotationDeg)
    const labelX = x + rotated.x
    const labelY = y + rotated.y
    const text = role.role === 'name' ? tag : 'waiting ...'

    lines.push(
      `    <g id="${tag}_${role.role}" transform="translate(${fmt(labelX)},${fmt(labelY)}) rotate(${fmt(rotationDeg)})">`,
    )
    lines.push(...labelBoxExportLines('      ', role.role, text))
    lines.push(`    </g>`)
  }

  return lines
}

registerComponentType({
  typeId: PROCESS_INDICATOR_TYPE,
  displayName: 'Process indicator',
  tagPrefix: 'PI',
  category: 'Instruments',
  render: renderProcessIndicator,
  update: updateProcessIndicator,
  defaultRoles: defaultIndicatorRoles,
  centerRoles: (roles) => packRoleOffsets(roles, 0, 0, ROW_HEIGHT, false),
  autoPackRoles: (roles) => packRoleOffsets(roles, 0, 0, ROW_HEIGHT, true),
  exportInstance: exportProcessIndicatorInstance,
  localBodyCorners: [],
  ports: [], // a bare instrument tag isn't a piping element — pipes can't connect to it
})
