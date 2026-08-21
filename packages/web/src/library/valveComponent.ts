import { registerIconComponentType } from './iconComponentFactory'

export const SCREW_DOWN_VALVE_TYPE = 'screw-down-valve'

/**
 * Geometry lifted from SVGs/Templates.svg (shape56 / IND000_indicator), with
 * the y-offset normalized so the shape's own origin is (0,0) — same bowtie
 * body the other valve-like types (relief-valve, pneumatic-valve) reuse,
 * just topped with a T-bar handwheel stem instead of a spring/actuator.
 */
const OUTLINE_D = 'M0 0 L0 17.01 L34.02 0 L34.02 17.01 L0 0 Z'
const STEM_VERTICAL_D = 'M17.01 8.5 L17.01 -8.5'
const STEM_HORIZONTAL_D = 'M8.5 -8.5 L25.51 -8.5'

registerIconComponentType({
  typeId: SCREW_DOWN_VALVE_TYPE,
  displayName: 'Manual valve (HV)',
  tagPrefix: 'HV',
  category: 'Valves',
  indicatorShapes: [{ d: OUTLINE_D }],
  outlineExtras: [{ d: STEM_VERTICAL_D }, { d: STEM_HORIZONTAL_D }],
  localBodyCorners: [
    { x: 0, y: -8.5 },
    { x: 34.02, y: -8.5 },
    { x: 0, y: 17.01 },
    { x: 34.02, y: 17.01 },
  ],
  // The bowtie's pinch point is at the center (17.01, ~8.5); the two wide
  // ends at the left/right edges are the natural inlet/outlet connections.
  ports: [
    { portId: 'in', x: 0, y: 8.5, exitAngleDeg: 180 },
    { portId: 'out', x: 34.02, y: 8.5, exitAngleDeg: 0 },
  ],
  centerX: 17.01,
  defaultEnabled: { indicator: true, name: true },
})
