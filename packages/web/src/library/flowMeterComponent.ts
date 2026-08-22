import { registerIconComponentType } from './iconComponentFactory'

export const FLOW_METER_TYPE = 'flow-meter'

const CX = 17.01
const CY = 8.5
const R = 12

/**
 * Round body with a top and a bottom arc, each spanning the circle from its
 * upper/lower-left to its upper/lower-right edge and bulging toward the
 * center, pinching the flow path down to a narrow open gap in the middle
 * (restriction-orifice / venturi flow meter symbol) — the whole circle is
 * the colorable "_indicator" silhouette, the arcs are just decoration drawn
 * on top.
 */
const ARC_ANGLE_RAD = (38 * Math.PI) / 180 // endpoints' angle above/below the horizontal centerline
const ARC_HALF_GAP = R * 0.2 // how far the pinch stops short of fully closing at the center

const ARC_RX = R * Math.cos(ARC_ANGLE_RAD) // forced: endpoints share a y, so this is the half chord width
const ARC_ENDPOINT_Y_OFFSET = R * Math.sin(ARC_ANGLE_RAD)
const ARC_RY = ARC_ENDPOINT_Y_OFFSET - ARC_HALF_GAP // free: controls how deep the bulge reaches toward center

const CIRCLE_D = `M${CX + R} ${CY} A${R} ${R} 0 1 0 ${CX - R} ${CY} A${R} ${R} 0 1 0 ${CX + R} ${CY}`
const TOP_ARC_D = `M${CX - ARC_RX} ${CY - ARC_ENDPOINT_Y_OFFSET} A${ARC_RX} ${ARC_RY} 0 0 0 ${CX + ARC_RX} ${CY - ARC_ENDPOINT_Y_OFFSET}`
const BOTTOM_ARC_D = `M${CX - ARC_RX} ${CY + ARC_ENDPOINT_Y_OFFSET} A${ARC_RX} ${ARC_RY} 0 0 1 ${CX + ARC_RX} ${CY + ARC_ENDPOINT_Y_OFFSET}`
const STUB_IN_D = `M0 ${CY} L${CX - R} ${CY}`
const STUB_OUT_D = `M${CX + R} ${CY} L34.02 ${CY}`

registerIconComponentType({
  typeId: FLOW_METER_TYPE,
  displayName: 'Flow meter',
  tagPrefix: 'FM',
  category: 'Instruments',
  indicatorShapes: [{ d: CIRCLE_D }],
  // Stubs get strokeWidth 2 to match a connected pipe's own line width — see
  // burstDiskComponent.ts's comment for why.
  outlineExtras: [
    { d: TOP_ARC_D },
    { d: BOTTOM_ARC_D },
    { d: STUB_IN_D, strokeWidth: 2 },
    { d: STUB_OUT_D, strokeWidth: 2 },
  ],
  localBodyCorners: [
    { x: 0, y: CY - R },
    { x: 34.02, y: CY - R },
    { x: 0, y: CY + R },
    { x: 34.02, y: CY + R },
  ],
  ports: [
    { portId: 'in', x: 0, y: CY, exitAngleDeg: 180 },
    { portId: 'out', x: 34.02, y: CY, exitAngleDeg: 0 },
  ],
  centerX: CX,
  defaultEnabled: { name: true, value: true },
})
