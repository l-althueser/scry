import { registerIconComponentType } from './iconComponentFactory'

export const COMPRESSOR_TYPE = 'compressor'

const CX = 17.01
const CY = 8.5
const R = 12

const CIRCLE_D = `M${CX + R} ${CY} A${R} ${R} 0 1 0 ${CX - R} ${CY} A${R} ${R} 0 1 0 ${CX + R} ${CY}`
const BLADE1_D = `M${CX - 6} ${CY - 6} L${CX + 6} ${CY + 6}`
const BLADE2_D = `M${CX - 6} ${CY + 6} L${CX + 6} ${CY - 6}`
const STUB_IN_D = `M0 ${CY} L${CX - R} ${CY}`
const STUB_OUT_D = `M${CX + R} ${CY} L34.02 ${CY}`

registerIconComponentType({
  typeId: COMPRESSOR_TYPE,
  displayName: 'Compressor',
  tagPrefix: 'C',
  category: 'Equipment',
  indicatorShapes: [{ d: CIRCLE_D }],
  outlineExtras: [{ d: BLADE1_D }, { d: BLADE2_D }, { d: STUB_IN_D }, { d: STUB_OUT_D }],
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
  defaultEnabled: { indicator: true, name: true },
})
