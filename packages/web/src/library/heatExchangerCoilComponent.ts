import { registerIconComponentType } from './iconComponentFactory'

export const HEAT_EXCHANGER_COIL_TYPE = 'heat-exchanger-coil'

/**
 * Second, alternate heat-exchanger symbol: a circular shell with an internal
 * chevron ("coil") glyph and two stacked pipes exiting together on the
 * right (the coil's own two connections), plus one straight-through stub on
 * the top and bottom (a second, independent fluid path passing through the
 * shell) — four ports total, none of them a simple symmetric left/right
 * pair. Distinct from heatExchangerComponent.ts's rectangular tube-bundle
 * symbol; which one to use is a per-instance/per-diagram drawing choice.
 */
const CX = 16
const CY = 16
const R = 16
const CIRCLE_D = `M${CX - R} ${CY} A${R} ${R} 0 1 0 ${CX + R} ${CY} A${R} ${R} 0 1 0 ${CX - R} ${CY}`

const CHEVRON_TOP_Y = 10
const CHEVRON_BOTTOM_Y = 22
const CHEVRON_LEFT_X = 8
const CHEVRON_TIP_X = 18
const RIGHT_PORT_X = CX + R + 6

// The chevron's own two segments (decorative "coil" glyph, not a pipe).
const CHEVRON_D = `M${CHEVRON_LEFT_X} ${CHEVRON_TOP_Y} L${CHEVRON_TIP_X} ${CY} L${CHEVRON_LEFT_X} ${CHEVRON_BOTTOM_Y}`
// The coil's two connections — each runs from the chevron's own corner
// straight out to its port on the right, matching a connected pipe's own
// line width (2) where it meets the port.
const PIPE_TOP_D = `M${CHEVRON_LEFT_X} ${CHEVRON_TOP_Y} L${RIGHT_PORT_X} ${CHEVRON_TOP_Y}`
const PIPE_BOTTOM_D = `M${CHEVRON_LEFT_X} ${CHEVRON_BOTTOM_Y} L${RIGHT_PORT_X} ${CHEVRON_BOTTOM_Y}`

// Independent top/bottom straight-through stub (a second fluid path).
const STUB_TOP_Y = -6
const STUB_BOTTOM_Y = 2 * R + 6
const STUB_TOP_D = `M${CX} 0 L${CX} ${STUB_TOP_Y}`
const STUB_BOTTOM_D = `M${CX} ${2 * R} L${CX} ${STUB_BOTTOM_Y}`

registerIconComponentType({
  typeId: HEAT_EXCHANGER_COIL_TYPE,
  displayName: 'Heat exchanger (coil) (HE)',
  tagPrefix: 'HE',
  category: 'Equipment',
  indicatorShapes: [{ d: CIRCLE_D }],
  outlineExtras: [{ d: CHEVRON_D }],
  pipeStubs: [
    { d: PIPE_TOP_D, strokeWidth: 2 },
    { d: PIPE_BOTTOM_D, strokeWidth: 2 },
    { d: STUB_TOP_D, strokeWidth: 2 },
    { d: STUB_BOTTOM_D, strokeWidth: 2 },
  ],
  localBodyCorners: [
    { x: 0, y: STUB_TOP_Y },
    { x: RIGHT_PORT_X, y: STUB_TOP_Y },
    { x: 0, y: STUB_BOTTOM_Y },
    { x: RIGHT_PORT_X, y: STUB_BOTTOM_Y },
  ],
  ports: [
    { portId: 'top', x: CX, y: STUB_TOP_Y, exitAngleDeg: 270 },
    { portId: 'bottom', x: CX, y: STUB_BOTTOM_Y, exitAngleDeg: 90 },
    { portId: 'coilIn', x: RIGHT_PORT_X, y: CHEVRON_TOP_Y, exitAngleDeg: 0 },
    { portId: 'coilOut', x: RIGHT_PORT_X, y: CHEVRON_BOTTOM_Y, exitAngleDeg: 0 },
  ],
  centerX: CX,
  // Body's lowest extent is the bottom stub tip, not the circle itself.
  labelStartY: STUB_BOTTOM_Y + 0.5,
  defaultEnabled: { indicator: false, name: false },
})
