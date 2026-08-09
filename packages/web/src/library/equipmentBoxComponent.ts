import type { ComponentInstance, Port, RoleInstance } from '@svg-editor/shared'
import {
  LABEL_BOX_HEIGHT,
  LABEL_BOX_WIDTH,
  NAME_TEXT_BASELINE_Y,
  SVG_NS,
  createLabelBoxElement,
  escapeXml,
  fmt,
  labelBoxExportLines,
  packRoleOffsets,
  rotatePoint,
} from './componentUtils'
import { registerComponentType, type InstanceOptionDescriptor } from './registry'

export const EQUIPMENT_BOX_TYPE = 'equipment-box'

/**
 * Plain labeled rectangle, generic on purpose. XENON_Viewer_Gassystem_v1.svg
 * uses three different Visio master shapes ("box", "process", "master")
 * that all render identically — a rect + centered label + status color —
 * for a grab-bag of auxiliary equipment (Getter, Cooling water, Th source,
 * Coldhead, Pressure regulator, ...). Rather than one narrow type per label,
 * this is the stand-in for "equipment that doesn't have its own icon yet".
 *
 * Hand-written (not via iconComponentFactory) because its body isn't fixed
 * geometry: the optional "text" property is centered *inside* the box and
 * grows it to fit — width/height and the four ports all derive from that one
 * property at render/update/export time (see computeBoxSize/computePorts),
 * via the registry's getLocalBodyCorners/getPorts per-instance hooks.
 */
const MIN_WIDTH = 40
const MIN_HEIGHT = 30
const TEXT_PADDING_X = 6
const TEXT_PADDING_Y = 6
const FONT_SIZE = 10
const LINE_HEIGHT = FONT_SIZE * 1.2
/** Rough average glyph width for this font/size — same estimation approach FreeShape text hit-boxes use, good enough to size a box (not to lay out exact glyph positions). */
const APPROX_CHAR_WIDTH = FONT_SIZE * 0.62

function boxText(instance: ComponentInstance): string {
  const raw = instance.propertyValues.text
  return typeof raw === 'string' ? raw : ''
}

function textLines(text: string): string[] {
  return text.split('\n')
}

/** The box's own footprint (local, unrotated, top-left anchored at the instance origin) — grows to fit the "text" property, never shrinks below the original fixed size. */
function computeBoxSize(text: string): { width: number; height: number } {
  const trimmed = text.trim()
  if (!trimmed) return { width: MIN_WIDTH, height: MIN_HEIGHT }
  const lines = textLines(text)
  const longest = Math.max(...lines.map((l) => l.length), 1)
  const width = Math.max(MIN_WIDTH, longest * APPROX_CHAR_WIDTH + TEXT_PADDING_X * 2)
  const height = Math.max(MIN_HEIGHT, lines.length * LINE_HEIGHT + TEXT_PADDING_Y * 2)
  return { width, height }
}

/** One connection point centered on each of the box's four sides, following its current (text-dependent) size. */
function computePorts(width: number, height: number): Port[] {
  return [
    { portId: 'left', x: 0, y: height / 2, exitAngleDeg: 180 },
    { portId: 'right', x: width, y: height / 2, exitAngleDeg: 0 },
    { portId: 'top', x: width / 2, y: 0, exitAngleDeg: 270 },
    { portId: 'bottom', x: width / 2, y: height, exitAngleDeg: 90 },
  ]
}

function boxCorners(width: number, height: number): { x: number; y: number }[] {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ]
}

/**
 * name/value/setpoint stack below the box starting at this fixed reference
 * (the box's minimum, untexted height) rather than tracking the box's actual
 * current height — centerRoles/autoPackRoles (registry.ts) don't receive the
 * instance, only the role list, so there's no per-instance size available at
 * that point. A tall multi-line box can end up visually close to its labels;
 * dragging a role (already supported for every type) repositions it by hand.
 */
const LABEL_START_Y = MIN_HEIGHT + 12
const LABEL_ROW_HEIGHT = 20

function bodyFillColor(instance: ComponentInstance): string {
  const value = instance.propertyValues.fillColor
  return typeof value === 'string' && value ? value : '#e5e7eb'
}

function defaultRoles(): RoleInstance[] {
  return packRoleOffsets(
    [
      { role: 'indicator', enabled: true, offset: { x: 0, y: 0 } },
      { role: 'name', enabled: true, offset: { x: 0, y: 0 } },
      { role: 'value', enabled: false, offset: { x: 0, y: 0 } },
      { role: 'setpoint', enabled: false, offset: { x: 0, y: 0 } },
    ],
    MIN_WIDTH / 2,
    LABEL_START_Y,
    LABEL_ROW_HEIGHT,
    false,
  )
}

function centerRoles(roles: RoleInstance[]): RoleInstance[] {
  return packRoleOffsets(roles, MIN_WIDTH / 2, LABEL_START_Y, LABEL_ROW_HEIGHT, false)
}

function autoPackRoles(roles: RoleInstance[]): RoleInstance[] {
  return packRoleOffsets(roles, MIN_WIDTH / 2, LABEL_START_Y, LABEL_ROW_HEIGHT, true)
}

function render(group: SVGGElement) {
  const bodyGroup = document.createElementNS(SVG_NS, 'g')
  bodyGroup.setAttribute('class', 'gv-valve-body')

  const indicatorGroup = document.createElementNS(SVG_NS, 'g')
  indicatorGroup.setAttribute('class', 'gv-role gv-role-indicator')
  indicatorGroup.setAttribute('data-role', 'indicator')
  indicatorGroup.setAttribute('fill', 'black')
  const indicatorRect = document.createElementNS(SVG_NS, 'rect')
  // Sized to the untexted minimum here so a render()-only context (the
  // toolbar/palette preview icon, which never calls update() — see
  // preview.ts) still shows a properly-sized box instead of a 0×0 rect;
  // update() resizes both rects together for any real placed instance.
  indicatorRect.setAttribute('width', String(MIN_WIDTH))
  indicatorRect.setAttribute('height', String(MIN_HEIGHT))
  indicatorGroup.appendChild(indicatorRect)
  bodyGroup.appendChild(indicatorGroup)

  // The always-visible static box (colorable fill, independent of the live
  // "_indicator" status overlay above) — same two-groups-same-shape split as
  // iconComponentFactory, so the indicator's fill lives only on its own
  // group per CLAUDE.md's contract.
  const bodyFillGroup = document.createElementNS(SVG_NS, 'g')
  bodyFillGroup.setAttribute('class', 'gv-valve-body-fill')
  bodyFillGroup.setAttribute('fill', '#e5e7eb')
  const fillRect = document.createElementNS(SVG_NS, 'rect')
  fillRect.setAttribute('width', String(MIN_WIDTH))
  fillRect.setAttribute('height', String(MIN_HEIGHT))
  fillRect.setAttribute('stroke', '#000000')
  fillRect.setAttribute('stroke-width', '1.5')
  bodyFillGroup.appendChild(fillRect)
  bodyGroup.appendChild(bodyFillGroup)

  // The optional centered label baked directly into the box — not a
  // Node-RED role (no data-role/id): purely static decorative text, same as
  // how "_name" text is always baked at export time rather than updated live.
  const boxTextEl = document.createElementNS(SVG_NS, 'text')
  boxTextEl.setAttribute('class', 'gv-eqbox-text')
  boxTextEl.setAttribute('text-anchor', 'middle')
  boxTextEl.setAttribute('font-family', 'Arial')
  boxTextEl.setAttribute('font-size', String(FONT_SIZE))
  boxTextEl.style.pointerEvents = 'none'
  bodyGroup.appendChild(boxTextEl)

  group.appendChild(bodyGroup)

  const nameGroup = document.createElementNS(SVG_NS, 'g')
  nameGroup.setAttribute('class', 'gv-role gv-role-name')
  nameGroup.setAttribute('data-role', 'name')

  const nameHitArea = document.createElementNS(SVG_NS, 'rect')
  nameHitArea.setAttribute('x', String(-LABEL_BOX_WIDTH / 2))
  nameHitArea.setAttribute('y', '0')
  nameHitArea.setAttribute('width', String(LABEL_BOX_WIDTH))
  nameHitArea.setAttribute('height', String(LABEL_BOX_HEIGHT))
  nameHitArea.setAttribute('fill', 'transparent')
  nameGroup.appendChild(nameHitArea)

  const nameText = document.createElementNS(SVG_NS, 'text')
  nameText.setAttribute('x', '0')
  nameText.setAttribute('y', String(NAME_TEXT_BASELINE_Y))
  nameText.setAttribute('text-anchor', 'middle')
  nameText.setAttribute('font-family', 'Arial')
  nameText.setAttribute('font-size', '10')
  nameGroup.appendChild(nameText)
  group.appendChild(nameGroup)

  group.appendChild(createLabelBoxElement('value'))
  group.appendChild(createLabelBoxElement('setpoint'))
}

/** Rebuilds the box text's <tspan>s to the current instance text — same multi-line/centered approach as FreeShape text (see shapes/freeShapeGeometry.ts). */
function renderBoxTextInto(el: SVGTextElement, text: string, width: number, height: number) {
  while (el.firstChild) el.removeChild(el.firstChild)
  const lines = textLines(text)
  const totalHeight = lines.length * LINE_HEIGHT
  const firstBaselineY = height / 2 - totalHeight / 2 + LINE_HEIGHT * 0.8
  lines.forEach((line, i) => {
    const tspan = document.createElementNS(SVG_NS, 'tspan')
    tspan.setAttribute('x', String(width / 2))
    tspan.setAttribute('y', String(firstBaselineY + i * LINE_HEIGHT))
    tspan.textContent = line
    el.appendChild(tspan)
  })
}

function update(group: SVGGElement, instance: ComponentInstance) {
  const { x, y, rotationDeg } = instance.transform
  group.setAttribute('transform', `translate(${x},${y})`)

  const bodyGroup = group.querySelector<SVGGElement>('.gv-valve-body')
  bodyGroup?.setAttribute('transform', `rotate(${fmt(rotationDeg)})`)

  const text = boxText(instance)
  const { width, height } = computeBoxSize(text)

  const indicatorRect = group.querySelector<SVGRectElement>('.gv-role-indicator rect')
  indicatorRect?.setAttribute('width', String(width))
  indicatorRect?.setAttribute('height', String(height))

  const fillRect = group.querySelector<SVGRectElement>('.gv-valve-body-fill rect')
  fillRect?.setAttribute('width', String(width))
  fillRect?.setAttribute('height', String(height))

  const bodyFillGroup = group.querySelector<SVGGElement>('.gv-valve-body-fill')
  bodyFillGroup?.setAttribute('fill', bodyFillColor(instance))

  const boxTextEl = group.querySelector<SVGTextElement>('.gv-eqbox-text')
  if (boxTextEl) renderBoxTextInto(boxTextEl, text, width, height)

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
    const rotated = rotatePoint(role.offset, rotationDeg)
    el.setAttribute('transform', `translate(${rotated.x},${rotated.y})`)

    const roleText = el.querySelector('text')
    if (!roleText) continue
    roleText.textContent = role.role === 'name' ? instance.tag : 'waiting ...'
  }
}

function exportInstance(instance: ComponentInstance): string[] {
  const { x, y, rotationDeg } = instance.transform
  const tag = escapeXml(instance.tag)
  const lines: string[] = []
  const text = boxText(instance)
  const { width, height } = computeBoxSize(text)

  lines.push(`    <!-- ${tag} (${escapeXml(instance.componentTypeId)}) -->`)

  lines.push(`    <g transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(rotationDeg)})">`)
  const fillColor = escapeXml(bodyFillColor(instance))
  lines.push(
    `      <rect width="${fmt(width)}" height="${fmt(height)}" fill="${fillColor}" stroke="#000000" stroke-width="1.5" />`,
  )
  if (text.trim()) {
    const bodyLines = textLines(text)
    const totalHeight = bodyLines.length * LINE_HEIGHT
    const firstBaselineY = height / 2 - totalHeight / 2 + LINE_HEIGHT * 0.8
    lines.push(
      `      <text x="${fmt(width / 2)}" text-anchor="middle" font-family="Arial" font-size="${FONT_SIZE}" fill="#000000">`,
    )
    bodyLines.forEach((line, i) => {
      lines.push(
        `        <tspan x="${fmt(width / 2)}" y="${fmt(firstBaselineY + i * LINE_HEIGHT)}">${escapeXml(line)}</tspan>`,
      )
    })
    lines.push(`      </text>`)
  }
  lines.push(`    </g>`)

  for (const role of instance.roles) {
    if (!role.enabled) continue

    if (role.role === 'indicator') {
      lines.push(
        `    <g id="${tag}_indicator" transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(rotationDeg)})" fill="black">`,
      )
      lines.push(`      <rect width="${fmt(width)}" height="${fmt(height)}" />`)
      lines.push(`    </g>`)
      continue
    }

    const abs = rotatePoint(role.offset, rotationDeg)
    const labelX = x + abs.x
    const labelY = y + abs.y
    const roleText = role.role === 'name' ? tag : 'waiting ...'

    lines.push(`    <g id="${tag}_${role.role}" transform="translate(${fmt(labelX)},${fmt(labelY)})">`)
    if (role.role === 'value' || role.role === 'setpoint') {
      lines.push(...labelBoxExportLines('      ', role.role, roleText))
    } else {
      lines.push(
        `      <text x="0" y="${NAME_TEXT_BASELINE_Y}" text-anchor="middle" font-family="Arial" font-size="10" fill="#000000">${escapeXml(roleText)}</text>`,
      )
    }
    lines.push(`    </g>`)
  }

  return lines
}

const instanceOptions: InstanceOptionDescriptor[] = [
  { key: 'fillColor', kind: 'color', label: 'Fill color', default: '#e5e7eb' },
  { key: 'text', kind: 'text', label: 'Box text (centered, grows the box to fit)', default: '' },
]

registerComponentType({
  typeId: EQUIPMENT_BOX_TYPE,
  displayName: 'Equipment box',
  tagPrefix: 'EQ',
  category: 'Equipment',
  render,
  update,
  defaultRoles,
  centerRoles,
  autoPackRoles,
  exportInstance,
  localBodyCorners: boxCorners(MIN_WIDTH, MIN_HEIGHT),
  ports: computePorts(MIN_WIDTH, MIN_HEIGHT),
  getLocalBodyCorners: (instance) => {
    const { width, height } = computeBoxSize(boxText(instance))
    return boxCorners(width, height)
  },
  getPorts: (instance) => {
    const { width, height } = computeBoxSize(boxText(instance))
    return computePorts(width, height)
  },
  instanceOptions,
})
