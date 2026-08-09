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
  outlineExtras: [{ d: MEMBRANE_D }, { d: STUB_IN_D }, { d: STUB_OUT_D }],
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
