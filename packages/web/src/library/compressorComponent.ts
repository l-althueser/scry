import { registerIconComponentType } from './iconComponentFactory'

export const COMPRESSOR_TYPE = 'compressor'

const CX = 17.01
const CY = 8.5
const R = 12

const CIRCLE_D = `M${CX + R} ${CY} A${R} ${R} 0 1 0 ${CX - R} ${CY} A${R} ${R} 0 1 0 ${CX + R} ${CY}`
// Two angled lines converging toward the outlet (flow left-to-right, "in"
// on the left, "out" on the right per the ports below) — wide apart at the
// inlet, narrower at the outlet, reading as compression rather than the
// previous X-crossed "fan blade" look. Each endpoint sits exactly on the
// circle (x = CX ± sqrt(R² - offset²) at height CY ∓ offset), so the lines
// visibly touch the circle on both sides instead of floating inside it.
const BLADE_WIDE_Y = 6
const BLADE_NARROW_Y = 3
const bladeLeftX = CX - Math.sqrt(R * R - BLADE_WIDE_Y * BLADE_WIDE_Y)
const bladeRightX = CX + Math.sqrt(R * R - BLADE_NARROW_Y * BLADE_NARROW_Y)
const BLADE1_D = `M${bladeLeftX} ${CY - BLADE_WIDE_Y} L${bladeRightX} ${CY - BLADE_NARROW_Y}`
const BLADE2_D = `M${bladeLeftX} ${CY + BLADE_WIDE_Y} L${bladeRightX} ${CY + BLADE_NARROW_Y}`
const STUB_IN_D = `M0 ${CY} L${CX - R} ${CY}`
const STUB_OUT_D = `M${CX + R} ${CY} L34.02 ${CY}`

registerIconComponentType({
  typeId: COMPRESSOR_TYPE,
  displayName: 'Compressor',
  tagPrefix: 'C',
  category: 'Equipment',
  indicatorShapes: [{ d: CIRCLE_D }],
  // Stubs get strokeWidth 2 to match a connected pipe's own line width — see
  // burstDiskComponent.ts's comment for why.
  outlineExtras: [{ d: BLADE1_D }, { d: BLADE2_D }, { d: STUB_IN_D, strokeWidth: 2 }, { d: STUB_OUT_D, strokeWidth: 2 }],
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
