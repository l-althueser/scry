import { registerIconComponentType } from './iconComponentFactory'

export const FLOW_METER_TYPE = 'flow-meter'

const CX = 17.01
const CY = 8.5
const R = 12

/**
 * Round body with two inward-hugging arcs from top to bottom pole, splitting
 * it into three visual lobes (a common mass-flow-controller "ball" symbol) —
 * the whole circle is the colorable "_indicator" silhouette, the arcs are
 * just decoration drawn on top.
 */
const CIRCLE_D = `M${CX + R} ${CY} A${R} ${R} 0 1 0 ${CX - R} ${CY} A${R} ${R} 0 1 0 ${CX + R} ${CY}`
const LEFT_ARC_D = `M${CX} ${CY - R} A${R} ${R} 0 0 0 ${CX} ${CY + R}`
const RIGHT_ARC_D = `M${CX} ${CY - R} A${R} ${R} 0 0 1 ${CX} ${CY + R}`
const STUB_IN_D = `M0 ${CY} L${CX - R} ${CY}`
const STUB_OUT_D = `M${CX + R} ${CY} L34.02 ${CY}`

registerIconComponentType({
  typeId: FLOW_METER_TYPE,
  displayName: 'Flow meter',
  tagPrefix: 'FM',
  category: 'Instruments',
  indicatorShapes: [{ d: CIRCLE_D }],
  outlineExtras: [{ d: LEFT_ARC_D }, { d: RIGHT_ARC_D }, { d: STUB_IN_D }, { d: STUB_OUT_D }],
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
