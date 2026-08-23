import type { ComponentInstance, Port, RoleInstance, Suffix } from '@svg-editor/shared'
import {
  DEFAULT_INDICATOR_COLOR,
  LABEL_BOX_HEIGHT,
  LABEL_BOX_WIDTH,
  NAME_TEXT_BASELINE_Y,
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

export interface PathShape {
  d: string
  strokeWidth?: number
}

/** An imported raster/SVG image used as the body's base artwork — src is a data URI (client-side only, no asset pipeline). Positioned in the same local (unrotated) coordinate space as everything else on the body. Purely decorative like outlineExtras: an `<image>` can't be recolored via `fill` the way a path can, so it's never part of the indicator silhouette. */
export interface BodyImage {
  src: string
  x: number
  y: number
  width: number
  height: number
}

export interface IconComponentSpec {
  typeId: string
  displayName: string
  tagPrefix: string
  /** Grouping label for the toolbar palette (e.g. "Valves", "Instruments"). */
  category: string
  /** Union of paths making up the "_indicator" status-color silhouette (fill lives only on the group, per CLAUDE.md). */
  indicatorShapes: PathShape[]
  /** Extra decorative-only paths (stubs, blades, ...) drawn alongside the silhouette but never colored by it. */
  outlineExtras?: PathShape[]
  /** Imported image drawn as the base of the body, underneath the indicator/outline shapes. */
  bodyImage?: BodyImage | null
  localBodyCorners: { x: number; y: number }[]
  ports: Port[]
  /** Horizontal center the name/value/setpoint labels stack under. */
  centerX: number
  labelStartY?: number
  /** Which roles are enabled by default on a freshly placed instance (indicator/name/value/setpoint all default false unless set here). */
  defaultEnabled: Partial<Record<Suffix, boolean>>
  /**
   * Lets the user flip the body horizontally per instance (e.g. so a gas
   * cylinder's connector sits on the left or right) via a `mirrored`
   * boolean property. Ports mirror too — see getPortWorldPosition in
   * pipeGeometry.ts, which reads the same `mirrored` property directly off
   * the instance (no separate wiring needed here beyond the visual flip).
   */
  mirrorable?: boolean
  /**
   * Lets the user pick a solid fill color for the body's `indicatorShapes`
   * silhouette via a `fillColor` property — independent of the live
   * "_indicator" status color (which stays exactly as before: black/green/
   * red, controlled by Node-RED, drawn as a separate overlay). Defaults to
   * `defaultFillColor` (black if unset) when the property hasn't been set.
   */
  colorable?: boolean
  defaultFillColor?: string
  /**
   * Extra decorative shapes toggleable per instance via a boolean property
   * (e.g. "standing in a dewar") — drawn underneath the body, never part of
   * the indicator silhouette, off by default.
   */
  optionalExtras?: { propertyKey: string; label: string; shapes: PathShape[] }[]
}

const DEFAULT_LABEL_START_Y = 24
// Equal to the box height so consecutive label boxes' borders sit flush
// against each other (no gap) instead of leaving a visible gap between rows.
const LABEL_ROW_HEIGHT = LABEL_BOX_HEIGHT

/**
 * Factory for the "icon-bodied inline device" pattern shared by every
 * component type that has a rotating body + ports (valve-like): a status
 * silhouette overlay, upright labels that stay clear of the body as it
 * rotates, and matching static export markup. Lets each type (valve,
 * compressor, gas cylinder, ...) be just geometry + a few defaults instead
 * of re-implementing render/update/export from scratch.
 */
export function registerIconComponentType(spec: IconComponentSpec): void {
  const labelStartY = spec.labelStartY ?? DEFAULT_LABEL_START_Y
  const optionalExtras = spec.optionalExtras ?? []

  const instanceOptions: InstanceOptionDescriptor[] = []
  if (spec.mirrorable) {
    instanceOptions.push({ key: 'mirrored', kind: 'boolean', label: 'Mirror horizontally', default: false })
  }
  if (spec.colorable) {
    instanceOptions.push({ key: 'fillColor', kind: 'color', label: 'Fill color', default: spec.defaultFillColor ?? '#000000' })
  }
  for (const extra of optionalExtras) {
    instanceOptions.push({ key: extra.propertyKey, kind: 'boolean', label: extra.label, default: false })
  }

  function isMirrored(instance: ComponentInstance): boolean {
    return spec.mirrorable === true && instance.propertyValues.mirrored === true
  }

  function bodyFillColor(instance: ComponentInstance): string {
    if (!spec.colorable) return 'none'
    const value = instance.propertyValues.fillColor
    return typeof value === 'string' && value ? value : (spec.defaultFillColor ?? '#000000')
  }

  /**
   * Mirroring must flip the body around its own visual center
   * (spec.centerX), not around the instance's anchor (local x=0) — the
   * anchor is usually off to one side of the shape (e.g. the gas cylinder's
   * body spans local x 0..20 with the anchor at its left edge), so a plain
   * scale(-1,1) around 0 would fling the whole shape to the opposite side
   * instead of flipping it in place, throwing off the labels stacked under
   * spec.centerX (which never move — they're siblings of bodyGroup, not
   * affected by its transform). translate(2*centerX,0) scale(-1,1) reflects
   * x around centerX instead: new_x = 2*centerX - x.
   */
  function bodyTransform(instance: ComponentInstance): string {
    const base = `rotate(${fmt(instance.transform.rotationDeg)})`
    if (!isMirrored(instance)) return base
    return `${base} translate(${fmt(2 * spec.centerX)},0) scale(-1,1)`
  }

  function defaultRoles(): RoleInstance[] {
    return packRoleOffsets(
      [
        { role: 'indicator', enabled: spec.defaultEnabled.indicator ?? false, offset: { x: 0, y: 0 } },
        { role: 'name', enabled: spec.defaultEnabled.name ?? true, offset: { x: 0, y: 0 } },
        { role: 'value', enabled: spec.defaultEnabled.value ?? false, offset: { x: 0, y: 0 } },
        { role: 'setpoint', enabled: spec.defaultEnabled.setpoint ?? false, offset: { x: 0, y: 0 } },
      ],
      spec.centerX,
      labelStartY,
      LABEL_ROW_HEIGHT,
      false,
    )
  }

  function centerRoles(roles: RoleInstance[]): RoleInstance[] {
    return packRoleOffsets(roles, spec.centerX, labelStartY, LABEL_ROW_HEIGHT, false)
  }

  function autoPackRoles(roles: RoleInstance[]): RoleInstance[] {
    return packRoleOffsets(roles, spec.centerX, labelStartY, LABEL_ROW_HEIGHT, true)
  }

  function render(group: SVGGElement) {
    const bodyGroup = document.createElementNS(SVG_NS, 'g')
    bodyGroup.setAttribute('class', 'gv-valve-body')

    // Optional decorative extras (e.g. "standing in a dewar") render first —
    // underneath everything else — so the main body visually sits on top of
    // / inside them. Off by default, toggled per instance in update().
    for (const extra of optionalExtras) {
      const extraGroup = document.createElementNS(SVG_NS, 'g')
      extraGroup.setAttribute('class', 'gv-optional-extra')
      extraGroup.setAttribute('data-optional-key', extra.propertyKey)
      for (const shape of extra.shapes) {
        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', shape.d)
        path.setAttribute('fill', 'none')
        path.setAttribute('stroke', '#000000')
        path.setAttribute('stroke-width', String(shape.strokeWidth ?? 1.5))
        extraGroup.appendChild(path)
      }
      bodyGroup.appendChild(extraGroup)
    }

    if (spec.bodyImage) {
      const img = document.createElementNS(SVG_NS, 'image')
      img.setAttribute('x', String(spec.bodyImage.x))
      img.setAttribute('y', String(spec.bodyImage.y))
      img.setAttribute('width', String(spec.bodyImage.width))
      img.setAttribute('height', String(spec.bodyImage.height))
      img.setAttribute('href', spec.bodyImage.src)
      img.setAttribute('class', 'gv-valve-body-image')
      bodyGroup.appendChild(img)
    }

    // Invisible hit-area covering the body silhouette (same geometry as
    // indicatorShapes) — a non-colorable body's indicatorShapes render with
    // fill:none (see bodyFillColor below), and a fill:none path only
    // registers pointer hits along its stroke, not its interior; without
    // this, clicking inside an "empty" circle (e.g. compressor/flow meter
    // with the indicator role off) misses the instance entirely, same
    // problem nameHitArea already solves for the name role's thin text.
    // Always present regardless of indicator/colorable state.
    const bodyHitGroup = document.createElementNS(SVG_NS, 'g')
    bodyHitGroup.setAttribute('class', 'gv-valve-body-hit')
    bodyHitGroup.setAttribute('fill', 'transparent')
    for (const shape of spec.indicatorShapes) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', shape.d)
      bodyHitGroup.appendChild(path)
    }
    bodyGroup.appendChild(bodyHitGroup)

    const indicatorGroup = document.createElementNS(SVG_NS, 'g')
    indicatorGroup.setAttribute('class', 'gv-role gv-role-indicator')
    indicatorGroup.setAttribute('data-role', 'indicator')
    indicatorGroup.setAttribute('fill', DEFAULT_INDICATOR_COLOR)
    for (const shape of spec.indicatorShapes) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', shape.d)
      indicatorGroup.appendChild(path)
    }
    bodyGroup.appendChild(indicatorGroup)

    // The always-visible static body: indicatorShapes get a per-instance fill
    // (none by default, or a user-picked color when spec.colorable — see
    // update()'s bodyFillColor) applied on the GROUP so child paths inherit
    // it; outlineExtras (thin decorative bits like a connector stub) always
    // stay fill:none, kept in their own group so the fill never touches them.
    const bodyFillGroup = document.createElementNS(SVG_NS, 'g')
    bodyFillGroup.setAttribute('class', 'gv-valve-body-fill')
    for (const shape of spec.indicatorShapes) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', shape.d)
      path.setAttribute('stroke', '#000000')
      path.setAttribute('stroke-width', String(shape.strokeWidth ?? 1.5))
      bodyFillGroup.appendChild(path)
    }
    bodyGroup.appendChild(bodyFillGroup)

    const extrasOutlineGroup = document.createElementNS(SVG_NS, 'g')
    extrasOutlineGroup.setAttribute('class', 'gv-valve-outline')
    for (const shape of spec.outlineExtras ?? []) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', shape.d)
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', '#000000')
      path.setAttribute('stroke-width', String(shape.strokeWidth ?? 1.5))
      extrasOutlineGroup.appendChild(path)
    }
    bodyGroup.appendChild(extrasOutlineGroup)

    group.appendChild(bodyGroup)

    if (spec.category === 'Valves') {
      // Valves keep the plain bare-text name label (no background/box) —
      // every other icon-bodied type gets the same boxed style value/setpoint
      // already use (see the `else` branch below).
      const nameGroup = document.createElementNS(SVG_NS, 'g')
      nameGroup.setAttribute('class', 'gv-role gv-role-name')
      nameGroup.setAttribute('data-role', 'name')

      // SVG <text> only registers pointer hits on the actual painted glyphs —
      // without this, clicking near (but not exactly on) the name misses it.
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
    } else {
      group.appendChild(createLabelBoxElement('name'))
    }

    group.appendChild(createLabelBoxElement('value'))
    group.appendChild(createLabelBoxElement('setpoint'))
  }

  function update(group: SVGGElement, instance: ComponentInstance) {
    const { x, y, rotationDeg } = instance.transform
    group.setAttribute('transform', `translate(${x},${y})`)

    const bodyGroup = group.querySelector<SVGGElement>('.gv-valve-body')
    bodyGroup?.setAttribute('transform', bodyTransform(instance))

    const bodyFillGroup = group.querySelector<SVGGElement>('.gv-valve-body-fill')
    bodyFillGroup?.setAttribute('fill', bodyFillColor(instance))

    for (const extra of optionalExtras) {
      const extraGroup = group.querySelector<SVGGElement>(`[data-optional-key="${extra.propertyKey}"]`)
      if (extraGroup) extraGroup.style.display = instance.propertyValues[extra.propertyKey] === true ? '' : 'none'
    }

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
      el.setAttribute('transform', roleTransformAttr(rotated, role.rotationDeg))
      applyRoleBoxStyling(el, role)

      const text = el.querySelector('text')
      if (!text) continue
      text.textContent = role.role === 'name' ? (role.labelTextOverride ?? instance.tag) : PLACEHOLDER_ROLE_TEXT
    }
  }

  function exportInstance(instance: ComponentInstance): string[] {
    const { x, y, rotationDeg } = instance.transform
    const tag = escapeXml(instance.tag)
    const lines: string[] = []

    lines.push(`    <!-- ${tag} (${escapeXml(instance.componentTypeId)}) -->`)

    // Mirrors around spec.centerX, not 0 — see bodyTransform's comment.
    const transformSuffix = isMirrored(instance) ? ` translate(${fmt(2 * spec.centerX)},0) scale(-1,1)` : ''

    // Decorative outline (visible body). Untagged: Node-RED never reads this.
    lines.push(`    <g transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(rotationDeg)})${transformSuffix}">`)
    for (const extra of optionalExtras) {
      if (instance.propertyValues[extra.propertyKey] !== true) continue
      for (const shape of extra.shapes) {
        lines.push(
          `      <path d="${shape.d}" fill="none" stroke="#000000" stroke-width="${shape.strokeWidth ?? 1.5}" />`,
        )
      }
    }
    if (spec.bodyImage) {
      const img = spec.bodyImage
      lines.push(
        `      <image x="${fmt(img.x)}" y="${fmt(img.y)}" width="${fmt(img.width)}" height="${fmt(img.height)}" href="${escapeXml(img.src)}" />`,
      )
    }
    const fillColor = escapeXml(bodyFillColor(instance))
    for (const shape of spec.indicatorShapes) {
      lines.push(
        `      <path d="${shape.d}" fill="${fillColor}" stroke="#000000" stroke-width="${shape.strokeWidth ?? 1.5}" />`,
      )
    }
    for (const shape of spec.outlineExtras ?? []) {
      lines.push(
        `      <path d="${shape.d}" fill="none" stroke="#000000" stroke-width="${shape.strokeWidth ?? 1.5}" />`,
      )
    }
    lines.push(`    </g>`)

    for (const role of instance.roles) {
      if (!role.enabled) continue

      if (role.role === 'indicator') {
        lines.push(
          `    <g id="${tag}_indicator" transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(rotationDeg)})${transformSuffix}" fill="${DEFAULT_INDICATOR_COLOR}">`,
        )
        for (const shape of spec.indicatorShapes) {
          lines.push(`      <path d="${shape.d}" />`)
        }
        lines.push(`    </g>`)
        continue
      }

      const abs = rotatePoint(role.offset, rotationDeg)
      const labelX = x + abs.x
      const labelY = y + abs.y
      const text = role.role === 'name' ? escapeXml(role.labelTextOverride ?? instance.tag) : PLACEHOLDER_ROLE_TEXT

      // name is boxed like value/setpoint for every type except Valves,
      // which keep the plain bare-text label (see the matching branch in
      // render() above) unless the user explicitly picked a color for it.
      const nameIsBoxed = role.role === 'name' && spec.category !== 'Valves'

      lines.push(`    <g id="${tag}_${role.role}" transform="${roleTransformAttr({ x: labelX, y: labelY }, role.rotationDeg)}">`)
      if (role.role === 'value' || role.role === 'setpoint' || nameIsBoxed) {
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
    typeId: spec.typeId,
    displayName: spec.displayName,
    tagPrefix: spec.tagPrefix,
    category: spec.category,
    render,
    update,
    defaultRoles,
    centerRoles,
    autoPackRoles,
    exportInstance,
    localBodyCorners: spec.localBodyCorners,
    ports: spec.ports,
    instanceOptions,
    mirrorAxisX: spec.mirrorable ? spec.centerX : undefined,
  })
}
