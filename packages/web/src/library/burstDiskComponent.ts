import { registerIconComponentType } from './iconComponentFactory'

export const BURST_DISK_TYPE = 'burst-disk'

/** A compact housing with a diagonal membrane line — the usual simplified rupture-disk symbol, inline like a valve. */
const HOUSING_D = 'M12 0 L22 0 L22 17.01 L12 17.01 Z'
const MEMBRANE_D = 'M12 0 L22 17.01'
const STUB_IN_D = 'M0 8.5 L12 8.5'
const STUB_OUT_D = 'M22 8.5 L34.02 8.5'

registerIconComponentType({
  typeId: BURST_DISK_TYPE,
  displayName: 'Burst disk',
  tagPrefix: 'BD',
  category: 'Equipment',
  indicatorShapes: [{ d: HOUSING_D }],
  // Stubs get strokeWidth 2 to match a connected pipe's own line width (2,
  // see SvgCanvas.ts's pipe rendering) — thinner (the default 1.5) reads as
  // a mismatch right where the pipe actually meets the component.
  outlineExtras: [{ d: MEMBRANE_D }, { d: STUB_IN_D, strokeWidth: 2 }, { d: STUB_OUT_D, strokeWidth: 2 }],
  localBodyCorners: [
    { x: 0, y: 0 },
    { x: 34.02, y: 0 },
    { x: 0, y: 17.01 },
    { x: 34.02, y: 17.01 },
  ],
  ports: [
    { portId: 'in', x: 0, y: 8.5, exitAngleDeg: 180 },
    { portId: 'out', x: 34.02, y: 8.5, exitAngleDeg: 0 },
  ],
  centerX: 17.01,
  defaultEnabled: { indicator: true, name: true },
})
