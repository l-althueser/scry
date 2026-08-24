import { registerIconComponentType } from './iconComponentFactory'

export const RELIEF_VALVE_TYPE = 'relief-valve'

/**
 * Same bowtie body as the manual/pneumatic valves, topped with a vertical
 * stem and three diagonal "spring" ticks instead of a hand-wheel or
 * actuator box — the standard simplified P&ID symbol for a spring-loaded
 * pressure relief valve. Found in XENON_Viewer_Gassystem_v1.svg as
 * "relief--valves" (a mangled Visio MasterName), a safety-critical
 * component that had no equivalent in this library before.
 */
const OUTLINE_D = 'M0 0 L0 17.01 L34.02 0 L34.02 17.01 L0 0 Z'
const STEM_D = 'M17.01 8.5 L17.01 -19.5'
const TICK1_D = 'M11 -8.5 L23 -12.5'
const TICK2_D = 'M11 -12.5 L23 -16.5'
const TICK3_D = 'M11 -16.5 L23 -19.5'

registerIconComponentType({
  typeId: RELIEF_VALVE_TYPE,
  displayName: 'Relief valve (RV)',
  tagPrefix: 'RV',
  category: 'Valves',
  indicatorShapes: [{ d: OUTLINE_D }],
  outlineExtras: [{ d: STEM_D }, { d: TICK1_D }, { d: TICK2_D }, { d: TICK3_D }],
  localBodyCorners: [
    { x: 0, y: -19.5 },
    { x: 34.02, y: -19.5 },
    { x: 0, y: 17.01 },
    { x: 34.02, y: 17.01 },
  ],
  ports: [
    { portId: 'in', x: 0, y: 8.5, exitAngleDeg: 180 },
    { portId: 'out', x: 34.02, y: 8.5, exitAngleDeg: 0 },
  ],
  centerX: 17.01,
  // Body's bottom edge sits at y=17.01 (see localBodyCorners above) — same
  // near-flush label gap as the manual valve (HV), see valveComponent.ts.
  labelStartY: 17.5,
  defaultEnabled: { indicator: true, name: true },
})
