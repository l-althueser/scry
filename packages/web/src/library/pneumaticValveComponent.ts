import { registerIconComponentType } from './iconComponentFactory'

export const PNEUMATIC_VALVE_TYPE = 'pneumatic-valve'

/**
 * Same bowtie body as the manual valve (screw-down-valve/HV), but topped
 * with a small actuator housing instead of a hand-wheel T-bar — the usual
 * P&ID distinction between manually and pneumatically operated valves.
 */
const OUTLINE_D = 'M0 0 L0 17.01 L34.02 0 L34.02 17.01 L0 0 Z'
const STEM_D = 'M17.01 8.5 L17.01 -8.5'
const ACTUATOR_D = 'M11.01 -20.5 L23.01 -20.5 L23.01 -8.5 L11.01 -8.5 Z'

registerIconComponentType({
  typeId: PNEUMATIC_VALVE_TYPE,
  displayName: 'Pneumatic valve (PV)',
  tagPrefix: 'PV',
  category: 'Valves',
  indicatorShapes: [{ d: OUTLINE_D }],
  outlineExtras: [{ d: STEM_D }, { d: ACTUATOR_D }],
  localBodyCorners: [
    { x: 0, y: -20.5 },
    { x: 34.02, y: -20.5 },
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
