import type { ComponentInstance, Port, RoleInstance } from '@svg-editor/shared'
import {
  DEFAULT_INDICATOR_COLOR,
  LABEL_BOX_HEIGHT,
  PLACEHOLDER_ROLE_TEXT,
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

/** The box's own text-driven floor (local, unrotated, top-left anchored at the instance origin) — grows to fit the "text" property, never shrinks below the original fixed size. */
function computeBoxSize(text: string): { width: number; height: number } {
  const trimmed = text.trim()
  if (!trimmed) return { width: MIN_WIDTH, height: MIN_HEIGHT }
  const lines = textLines(text)
  const longest = Math.max(...lines.map((l) => l.length), 1)
  const width = Math.max(MIN_WIDTH, longest * APPROX_CHAR_WIDTH + TEXT_PADDING_X * 2)
  const height = Math.max(MIN_HEIGHT, lines.length * LINE_HEIGHT + TEXT_PADDING_Y * 2)
  return { width, height }
}

/** The box's actual rendered size: the text-driven floor, or a larger manual override from corner-drag resizing (SvgCanvas's resize-instance handles) — never smaller than what the current text needs. */
function effectiveBoxSize(instance: ComponentInstance): { width: number; height: number } {
  const min = computeBoxSize(boxText(instance))
  const w = instance.propertyValues.width
  const h = instance.propertyValues.height
  return {
    width: Math.max(min.width, typeof w === 'number' ? w : 0),
    height: Math.max(min.height, typeof h === 'number' ? h : 0),
  }
}

type PolygonShape = 'diamond' | 'connector-arrow' | 'double-connector-arrow' | 'block-arrow' | 'double-block-arrow'
type BoxShape = 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'cylinder' | PolygonShape

const POLYGON_SHAPES: readonly PolygonShape[] = [
  'diamond',
  'connector-arrow',
  'double-connector-arrow',
  'block-arrow',
  'double-block-arrow',
]
const ALL_SHAPES: readonly BoxShape[] = ['rectangle', 'rounded-rectangle', 'ellipse', 'cylinder', ...POLYGON_SHAPES]

function isPolygonShape(shape: BoxShape): shape is PolygonShape {
  return (POLYGON_SHAPES as readonly string[]).includes(shape)
}

/** Flowchart/tank "cylinder": an elliptical cap top and bottom, joined by straight sides — the standard vessel/storage-tank symbol. Cap height scales with the box but stays legible at small sizes. */
function cylinderCapHeight(width: number, height: number): number {
  return Math.max(4, Math.min(height * 0.2, width * 0.4, height / 2 - 1))
}

/** Outline including the visible front arc of the bottom cap (the top cap's own outline doubles as the "lid" — see cylinderLidD for the extra seam line across its back edge). */
function cylinderBodyD(width: number, height: number): string {
  const rx = width / 2
  const ry = cylinderCapHeight(width, height)
  return `M0 ${fmt(ry)} A${fmt(rx)} ${fmt(ry)} 0 0 0 ${fmt(width)} ${fmt(ry)} L${fmt(width)} ${fmt(height - ry)} A${fmt(rx)} ${fmt(ry)} 0 0 0 0 ${fmt(height - ry)} Z`
}

/** One full-ellipse trace at a given cap's y-center, as its own path subcommand (see cylinderLidD, which combines one of these per cap). */
function ellipseTraceD(width: number, ry: number, cy: number): string {
  const rx = width / 2
  return `M0 ${fmt(cy)} A${fmt(rx)} ${fmt(ry)} 0 0 0 ${fmt(width)} ${fmt(cy)} A${fmt(rx)} ${fmt(ry)} 0 0 0 0 ${fmt(cy)}`
}

/**
 * Both caps traced as complete ellipses (not just the front arc already part
 * of cylinderBodyD's silhouette) — a true tank/vessel look where both the
 * top and bottom disks are fully visible, rather than the flowchart/database
 * convention of a full top ellipse and a bare front arc on the bottom.
 * Combining both into one path (two "M" subcommands) avoids a second DOM
 * element — render()/update() just set this one path's "d".
 */
function cylinderLidD(width: number, height: number): string {
  const ry = cylinderCapHeight(width, height)
  return `${ellipseTraceD(width, ry, ry)} ${ellipseTraceD(width, ry, height - ry)}`
}

function boxShape(instance: ComponentInstance): BoxShape {
  const raw = instance.propertyValues.shape
  return typeof raw === 'string' && (ALL_SHAPES as readonly string[]).includes(raw) ? (raw as BoxShape) : 'rectangle'
}

/** connector-arrow: how far the point tapers in from the flat end, as a fraction of width. */
const CONNECTOR_ARROW_TAPER_FRACTION = 0.7
/** double-connector-arrow: how far each end's point tapers in, as a fraction of width (from its own end). */
const DOUBLE_CONNECTOR_ARROW_TAPER_FRACTION = 0.3
/** block-arrow (shaft + triangular head): how much of the width the head takes, and how much of the height the shaft takes (centered). */
const BLOCK_ARROW_HEAD_WIDTH_FRACTION = 0.35
const BLOCK_ARROW_SHAFT_HEIGHT_FRACTION = 0.5
/** double-block-arrow: each head's share of the width (from its own end); the shaft fills whatever's left in the middle. */
const DOUBLE_BLOCK_ARROW_HEAD_WIDTH_FRACTION = 0.25
const DOUBLE_BLOCK_ARROW_SHAFT_HEIGHT_FRACTION = 0.5

/**
 * Point list for every non-rect/non-ellipse shape, always pointing local +x
 * ("east"; rotate the instance to point elsewhere): a rhombus; a
 * flowchart-style off-page-connector (rectangle tapering to a point), single-
 * and double-ended; a classic block arrow (shaft + triangular head), single-
 * and double-ended.
 */
function polygonPoints(shape: PolygonShape, width: number, height: number): string {
  let points: { x: number; y: number }[]
  if (shape === 'diamond') {
    points = [
      { x: width / 2, y: 0 },
      { x: width, y: height / 2 },
      { x: width / 2, y: height },
      { x: 0, y: height / 2 },
    ]
  } else if (shape === 'connector-arrow') {
    points = [
      { x: 0, y: 0 },
      { x: width * CONNECTOR_ARROW_TAPER_FRACTION, y: 0 },
      { x: width, y: height / 2 },
      { x: width * CONNECTOR_ARROW_TAPER_FRACTION, y: height },
      { x: 0, y: height },
    ]
  } else if (shape === 'double-connector-arrow') {
    const taper = width * DOUBLE_CONNECTOR_ARROW_TAPER_FRACTION
    points = [
      { x: 0, y: height / 2 },
      { x: taper, y: 0 },
      { x: width - taper, y: 0 },
      { x: width, y: height / 2 },
      { x: width - taper, y: height },
      { x: taper, y: height },
    ]
  } else if (shape === 'block-arrow') {
    const headX = width * (1 - BLOCK_ARROW_HEAD_WIDTH_FRACTION)
    const shaftTop = (height * (1 - BLOCK_ARROW_SHAFT_HEIGHT_FRACTION)) / 2
    const shaftBottom = height - shaftTop
    points = [
      { x: 0, y: shaftTop },
      { x: headX, y: shaftTop },
      { x: headX, y: 0 },
      { x: width, y: height / 2 },
      { x: headX, y: height },
      { x: headX, y: shaftBottom },
      { x: 0, y: shaftBottom },
    ]
  } else {
    // shape === 'double-block-arrow'
    const headW = width * DOUBLE_BLOCK_ARROW_HEAD_WIDTH_FRACTION
    const shaftTop = (height * (1 - DOUBLE_BLOCK_ARROW_SHAFT_HEIGHT_FRACTION)) / 2
    const shaftBottom = height - shaftTop
    points = [
      { x: 0, y: height / 2 },
      { x: headW, y: 0 },
      { x: headW, y: shaftTop },
      { x: width - headW, y: shaftTop },
      { x: width - headW, y: 0 },
      { x: width, y: height / 2 },
      { x: width - headW, y: height },
      { x: width - headW, y: shaftBottom },
      { x: headW, y: shaftBottom },
      { x: headW, y: height },
    ]
  }
  return points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')
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
const LABEL_START_Y = MIN_HEIGHT + 5
// Equal to the box height so consecutive label boxes' borders sit flush
// against each other (no gap) instead of leaving a visible gap between rows.
const LABEL_ROW_HEIGHT = LABEL_BOX_HEIGHT

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

/**
 * Builds the three shape-slot elements a box's body can be — a rect (serves
 * both rectangle and rounded-rectangle via rx), an ellipse, and a polygon
 * (serves both diamond and arrow via its points) — all but one hidden via
 * display:none, same "build every variant once, toggle display" convention
 * iconComponentFactory uses for optional decorative extras. update() shows/
 * sizes whichever one matches the instance's current shape. Sized to the
 * untexted minimum here so a render()-only context (the toolbar/palette
 * preview icon, which never calls update() — see preview.ts) still shows a
 * properly-sized box instead of a 0×0 shape; update() resizes the active one
 * for any real placed instance.
 */
function appendShapeSlots(group: SVGGElement, withStroke: boolean) {
  const rect = document.createElementNS(SVG_NS, 'rect')
  rect.setAttribute('class', 'gv-eqbox-shape-rect')
  rect.setAttribute('width', String(MIN_WIDTH))
  rect.setAttribute('height', String(MIN_HEIGHT))
  group.appendChild(rect)

  const ellipse = document.createElementNS(SVG_NS, 'ellipse')
  ellipse.setAttribute('class', 'gv-eqbox-shape-ellipse')
  ellipse.style.display = 'none'
  group.appendChild(ellipse)

  const polygon = document.createElementNS(SVG_NS, 'polygon')
  polygon.setAttribute('class', 'gv-eqbox-shape-polygon')
  polygon.style.display = 'none'
  group.appendChild(polygon)

  const cylinder = document.createElementNS(SVG_NS, 'path')
  cylinder.setAttribute('class', 'gv-eqbox-shape-cylinder')
  cylinder.style.display = 'none'
  group.appendChild(cylinder)

  if (withStroke) {
    for (const el of [rect, ellipse, polygon, cylinder]) {
      el.setAttribute('stroke', '#000000')
      el.setAttribute('stroke-width', '1.5')
    }
  }
}

/** Shows/sizes whichever of `group`'s three shape slots (see appendShapeSlots) matches `shape`, hiding the other two. */
function applyShapeToGroup(group: SVGGElement, shape: BoxShape, width: number, height: number) {
  const rect = group.querySelector<SVGRectElement>('.gv-eqbox-shape-rect')
  const ellipse = group.querySelector<SVGEllipseElement>('.gv-eqbox-shape-ellipse')
  const polygon = group.querySelector<SVGPolygonElement>('.gv-eqbox-shape-polygon')
  const cylinder = group.querySelector<SVGPathElement>('.gv-eqbox-shape-cylinder')
  const isRect = shape === 'rectangle' || shape === 'rounded-rectangle'
  const isPolygon = isPolygonShape(shape)
  const isCylinder = shape === 'cylinder'
  if (cylinder) {
    cylinder.style.display = isCylinder ? '' : 'none'
    if (isCylinder) cylinder.setAttribute('d', cylinderBodyD(width, height))
  }
  if (rect) {
    rect.style.display = isRect ? '' : 'none'
    rect.setAttribute('width', String(width))
    rect.setAttribute('height', String(height))
    rect.setAttribute('rx', shape === 'rounded-rectangle' ? String(Math.min(width, height) * 0.15) : '0')
  }
  if (ellipse) {
    ellipse.style.display = shape === 'ellipse' ? '' : 'none'
    ellipse.setAttribute('cx', String(width / 2))
    ellipse.setAttribute('cy', String(height / 2))
    ellipse.setAttribute('rx', String(width / 2))
    ellipse.setAttribute('ry', String(height / 2))
  }
  if (polygon) {
    polygon.style.display = isPolygon ? '' : 'none'
    if (isPolygon) polygon.setAttribute('points', polygonPoints(shape, width, height))
  }
}

function render(group: SVGGElement) {
  const bodyGroup = document.createElementNS(SVG_NS, 'g')
  bodyGroup.setAttribute('class', 'gv-valve-body')

  const indicatorGroup = document.createElementNS(SVG_NS, 'g')
  indicatorGroup.setAttribute('class', 'gv-role gv-role-indicator')
  indicatorGroup.setAttribute('data-role', 'indicator')
  indicatorGroup.setAttribute('fill', DEFAULT_INDICATOR_COLOR)
  appendShapeSlots(indicatorGroup, false)
  bodyGroup.appendChild(indicatorGroup)

  // The always-visible static box (colorable fill, independent of the live
  // "_indicator" status overlay above) — same two-groups-same-shape split as
  // iconComponentFactory, so the indicator's fill lives only on its own
  // group per CLAUDE.md's contract.
  const bodyFillGroup = document.createElementNS(SVG_NS, 'g')
  bodyFillGroup.setAttribute('class', 'gv-valve-body-fill')
  bodyFillGroup.setAttribute('fill', '#e5e7eb')
  appendShapeSlots(bodyFillGroup, true)
  bodyGroup.appendChild(bodyFillGroup)

  // The cylinder's "lid" seam — the top cap's back edge, drawn on top of the
  // fill/indicator groups so it stays visible regardless of their color.
  // Not a shape slot like the other three (see appendShapeSlots): purely
  // decorative, never part of the fill/indicator silhouette itself.
  const cylinderLid = document.createElementNS(SVG_NS, 'path')
  cylinderLid.setAttribute('class', 'gv-eqbox-cylinder-lid')
  cylinderLid.setAttribute('fill', 'none')
  cylinderLid.setAttribute('stroke', '#000000')
  cylinderLid.setAttribute('stroke-width', '1.5')
  cylinderLid.style.display = 'none'
  bodyGroup.appendChild(cylinderLid)

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

  group.appendChild(createLabelBoxElement('name'))
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
  const { width, height } = effectiveBoxSize(instance)
  const shape = boxShape(instance)

  const bodyFillGroup = group.querySelector<SVGGElement>('.gv-valve-body-fill')
  if (bodyFillGroup) {
    applyShapeToGroup(bodyFillGroup, shape, width, height)
    bodyFillGroup.setAttribute('fill', bodyFillColor(instance))
  }

  const boxTextEl = group.querySelector<SVGTextElement>('.gv-eqbox-text')
  if (boxTextEl) renderBoxTextInto(boxTextEl, text, width, height)

  const cylinderLid = group.querySelector<SVGPathElement>('.gv-eqbox-cylinder-lid')
  if (cylinderLid) {
    cylinderLid.style.display = shape === 'cylinder' ? '' : 'none'
    if (shape === 'cylinder') cylinderLid.setAttribute('d', cylinderLidD(width, height))
  }

  const indicatorRole = instance.roles.find((r) => r.role === 'indicator')
  const indicatorGroup = group.querySelector<SVGGElement>('.gv-role-indicator')
  if (indicatorGroup) {
    applyShapeToGroup(indicatorGroup, shape, width, height)
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
    el.setAttribute('transform', roleTransformAttr(rotated, role.rotationDeg))
    applyRoleBoxStyling(el, role)

    const roleText = el.querySelector('text')
    if (!roleText) continue
    roleText.textContent = role.role === 'name' ? (role.labelTextOverride ?? instance.tag) : PLACEHOLDER_ROLE_TEXT
  }
}

/** The exported markup for one of the three shape slots — mirrors applyShapeToGroup's element choice, no fill attr of its own when extraAttrs omits one (the indicator group's fill lives exclusively on its own `<g>`, per CLAUDE.md's Node-RED contract). */
function shapeSvgElement(shape: BoxShape, width: number, height: number, extraAttrs: string): string {
  if (shape === 'ellipse') {
    return `<ellipse cx="${fmt(width / 2)}" cy="${fmt(height / 2)}" rx="${fmt(width / 2)}" ry="${fmt(height / 2)}"${extraAttrs} />`
  }
  if (shape === 'cylinder') {
    return `<path d="${cylinderBodyD(width, height)}"${extraAttrs} />`
  }
  if (isPolygonShape(shape)) {
    return `<polygon points="${polygonPoints(shape, width, height)}"${extraAttrs} />`
  }
  const rx = shape === 'rounded-rectangle' ? ` rx="${fmt(Math.min(width, height) * 0.15)}"` : ''
  return `<rect width="${fmt(width)}" height="${fmt(height)}"${rx}${extraAttrs} />`
}

function exportInstance(instance: ComponentInstance): string[] {
  const { x, y, rotationDeg } = instance.transform
  const tag = escapeXml(instance.tag)
  const lines: string[] = []
  const text = boxText(instance)
  const { width, height } = effectiveBoxSize(instance)
  const shape = boxShape(instance)

  lines.push(`    <!-- ${tag} (${escapeXml(instance.componentTypeId)}) -->`)

  lines.push(`    <g transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(rotationDeg)})">`)
  const fillColor = escapeXml(bodyFillColor(instance))
  lines.push(`      ${shapeSvgElement(shape, width, height, ` fill="${fillColor}" stroke="#000000" stroke-width="1.5"`)}`)
  if (shape === 'cylinder') {
    lines.push(`      <path d="${cylinderLidD(width, height)}" fill="none" stroke="#000000" stroke-width="1.5" />`)
  }
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
        `    <g id="${tag}_indicator" transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(rotationDeg)})" fill="${DEFAULT_INDICATOR_COLOR}">`,
      )
      lines.push(`      ${shapeSvgElement(shape, width, height, '')}`)
      lines.push(`    </g>`)
      continue
    }

    const abs = rotatePoint(role.offset, rotationDeg)
    const labelX = x + abs.x
    const labelY = y + abs.y
    const roleText = role.role === 'name' ? escapeXml(role.labelTextOverride ?? instance.tag) : PLACEHOLDER_ROLE_TEXT

    lines.push(`    <g id="${tag}_${role.role}" transform="${roleTransformAttr({ x: labelX, y: labelY }, role.rotationDeg)}">`)
    lines.push(
      ...labelBoxExportLines('      ', role.role, roleText, {
        fill: role.fillColor,
        stroke: role.strokeColor,
        textColor: role.textColor,
      }),
    )
    lines.push(`    </g>`)
  }

  return lines
}

const instanceOptions: InstanceOptionDescriptor[] = [
  { key: 'fillColor', kind: 'color', label: 'Fill color', default: '#e5e7eb' },
  { key: 'text', kind: 'text', label: 'Box text (centered, grows the box to fit)', default: '' },
  {
    key: 'shape',
    kind: 'select',
    label: 'Shape',
    default: 'rectangle',
    options: [
      { value: 'rectangle', label: 'Rectangle' },
      { value: 'rounded-rectangle', label: 'Rounded rectangle' },
      { value: 'ellipse', label: 'Ellipse' },
      { value: 'cylinder', label: 'Cylinder' },
      { value: 'diamond', label: 'Diamond' },
      { value: 'connector-arrow', label: 'Arrow (off-page connector)' },
      { value: 'double-connector-arrow', label: 'Double arrow (off-page connector)' },
      { value: 'block-arrow', label: 'Arrow (pointed head)' },
      { value: 'double-block-arrow', label: 'Double arrow (pointed head)' },
    ],
  },
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
    const { width, height } = effectiveBoxSize(instance)
    return boxCorners(width, height)
  },
  getPorts: (instance) => {
    const { width, height } = effectiveBoxSize(instance)
    return computePorts(width, height)
  },
  resizable: {
    minSize: (instance) => computeBoxSize(boxText(instance)),
    widthKey: 'width',
    heightKey: 'height',
  },
  instanceOptions,
})
