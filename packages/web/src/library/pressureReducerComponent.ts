import { registerIconComponentType } from './iconComponentFactory'

export const PRESSURE_REDUCER_TYPE = 'pressure-reducer'

/**
 * The standard simplified P&ID symbol for a pressure-reducing valve: two
 * triangles of different size meeting tip-to-tip — the larger triangle on
 * the (higher-pressure) inlet side, the smaller one on the (lower-pressure)
 * outlet side. Unlike the valve bowtie (valveComponent.ts), which is one
 * self-intersecting path forming two equal-sized triangles, the two
 * triangles here differ in height, so they're kept as two separate
 * `indicatorShapes` paths whose apexes both land on the exact same point
 * (17.01, 12) instead of relying on path self-intersection.
 */
const BIG_TRIANGLE_D = 'M0 0 L0 24 L17.01 12 Z'
// Narrower than the big triangle (base pulled in from x=34.02 to x=26) —
// a short stub (STUB_OUT_D) bridges the remaining gap out to the port.
const SMALL_TRIANGLE_D = 'M26 7 L26 17 L17.01 12 Z'
const STUB_OUT_D = 'M26 12 L34.02 12'

registerIconComponentType({
  typeId: PRESSURE_REDUCER_TYPE,
  displayName: 'Pressure reducer (PR)',
  tagPrefix: 'PR',
  category: 'Valves',
  indicatorShapes: [{ d: BIG_TRIANGLE_D }, { d: SMALL_TRIANGLE_D }],
  // Stub gets strokeWidth 2 to match a connected pipe's own line width, same
  // convention burstDiskComponent.ts uses for its stubs.
  outlineExtras: [{ d: STUB_OUT_D, strokeWidth: 2 }],
  localBodyCorners: [
    { x: 0, y: 0 },
    { x: 34.02, y: 0 },
    { x: 0, y: 24 },
    { x: 34.02, y: 24 },
  ],
  ports: [
    { portId: 'in', x: 0, y: 12, exitAngleDeg: 180 },
    { portId: 'out', x: 34.02, y: 12, exitAngleDeg: 0 },
  ],
  centerX: 17.01,
  defaultEnabled: { indicator: true, name: true },
})
