import { registerIconComponentType } from './iconComponentFactory'
import type { PathShape } from './iconComponentFactory'

export const HEAT_EXCHANGER_TYPE = 'heat-exchanger'

/**
 * Tube-bundle heat exchanger symbol: a housing box with a vertical tube
 * bundle and a full corner-to-corner "X" (the usual simplified P&ID symbol
 * for the two fluid paths crossing inside a shared shell), plus four short
 * stub connectors with a perpendicular end-cap tick at each corner — one
 * inlet+outlet pair per side, each pair its own independent flow circuit
 * (e.g. tube side vs. shell side). Ports sit at the outer tip of each stub,
 * outside the housing box itself. Unlike every other icon-factory type so
 * far, ports aren't a symmetric in/out pair; nothing in iconComponentFactory
 * assumes exactly two, so this needed no factory changes.
 */
const WIDTH = 28
const HEIGHT = 32
const STUB_LENGTH = 6
const STUB_Y_TOP = 4
const STUB_Y_BOTTOM = HEIGHT - 4
const CAP_HALF = 3

const HOUSING_D = `M0 0 L${WIDTH} 0 L${WIDTH} ${HEIGHT} L0 ${HEIGHT} Z`
// Runs corner-to-corner between the stub heights (not the housing's own
// corners) so each diagonal lines up with where the pipe stubs enter the
// box — e.g. top-left stub through to bottom-right stub.
const DIAGONAL1_D = `M0 ${STUB_Y_TOP} L${WIDTH} ${STUB_Y_BOTTOM}`
const DIAGONAL2_D = `M0 ${STUB_Y_BOTTOM} L${WIDTH} ${STUB_Y_TOP}`

// Vertical tube bundle, evenly spaced across the housing width.
const TUBE_COUNT = 9
const TUBE_MARGIN = 2
const tubeShapes: PathShape[] = Array.from({ length: TUBE_COUNT }, (_, i) => {
  const x = TUBE_MARGIN + (i * (WIDTH - 2 * TUBE_MARGIN)) / (TUBE_COUNT - 1)
  return { d: `M${x} 0 L${x} ${HEIGHT}`, strokeWidth: 1 }
})

/** One corner's stub: a horizontal line out to the port tip, capped by a short perpendicular tick — matches a connected pipe's own line width (2) where it meets the port. */
function stub(y: number, towardLeft: boolean): PathShape[] {
  const tipX = towardLeft ? -STUB_LENGTH : WIDTH + STUB_LENGTH
  const edgeX = towardLeft ? 0 : WIDTH
  return [
    { d: `M${edgeX} ${y} L${tipX} ${y}`, strokeWidth: 2 },
    { d: `M${tipX} ${y - CAP_HALF} L${tipX} ${y + CAP_HALF}`, strokeWidth: 2 },
  ]
}

registerIconComponentType({
  typeId: HEAT_EXCHANGER_TYPE,
  displayName: 'Heat exchanger (HX)',
  tagPrefix: 'HX',
  category: 'Equipment',
  indicatorShapes: [{ d: HOUSING_D }],
  outlineExtras: [...tubeShapes, { d: DIAGONAL1_D }, { d: DIAGONAL2_D }],
  pipeStubs: [
    ...stub(STUB_Y_TOP, true),
    ...stub(STUB_Y_BOTTOM, true),
    ...stub(STUB_Y_TOP, false),
    ...stub(STUB_Y_BOTTOM, false),
  ],
  localBodyCorners: [
    { x: -STUB_LENGTH, y: 0 },
    { x: WIDTH + STUB_LENGTH, y: 0 },
    { x: -STUB_LENGTH, y: HEIGHT },
    { x: WIDTH + STUB_LENGTH, y: HEIGHT },
  ],
  ports: [
    { portId: 'in1', x: -STUB_LENGTH, y: STUB_Y_TOP, exitAngleDeg: 180 },
    { portId: 'out1', x: -STUB_LENGTH, y: STUB_Y_BOTTOM, exitAngleDeg: 180 },
    { portId: 'in2', x: WIDTH + STUB_LENGTH, y: STUB_Y_TOP, exitAngleDeg: 0 },
    { portId: 'out2', x: WIDTH + STUB_LENGTH, y: STUB_Y_BOTTOM, exitAngleDeg: 0 },
  ],
  centerX: WIDTH / 2,
  // Body's bottom edge sits at y=HEIGHT=32, taller than the factory's
  // default label gap (24) assumes — without this the name label overlaps
  // the housing.
  labelStartY: HEIGHT + 0.5,
  defaultEnabled: { indicator: false, name: false },
})
