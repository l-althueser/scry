import { registerIconComponentType } from './iconComponentFactory'

export const GAS_CYLINDER_TYPE = 'gas-cylinder'

/**
 * Upright by default (unlike the other, horizontal inline devices) — a gas
 * cylinder physically stands on its base with a rounded valve cap at the
 * top, so that's how it should look before any manual rotation. One
 * continuous silhouette (body -> tapered shoulder -> neck -> rounded cap)
 * rather than separate rectangles, matching the familiar cylinder outline. A
 * source, not an inline pass-through, so there's a single port — coming off
 * the side of the neck, where the regulator connects in practice.
 */
const OUTLINE_D = 'M6 0 A4 4 0 0 1 14 0 L14 8 L20 14 L20 50 L0 50 L0 14 L6 8 Z'
const STUB_D = 'M6 4 L-4 4'
/** A wide-bottomed flask the cylinder's lower half appears to stand in — optional per instance, off by default. */
const DEWAR_D = 'M-6 26 L-6 48 A6 6 0 0 0 0 54 L20 54 A6 6 0 0 0 26 48 L26 26 Z'

registerIconComponentType({
  typeId: GAS_CYLINDER_TYPE,
  displayName: 'Gas cylinder',
  tagPrefix: 'GC',
  category: 'Equipment',
  indicatorShapes: [{ d: OUTLINE_D }],
  outlineExtras: [{ d: STUB_D }],
  // Wide enough to also cover the optional dewar shape (x: -6..26, y up to
  // 54) even though most instances won't have it enabled — a little extra
  // padding in the export viewBox/auto-route obstacle box for those that
  // don't beats clipping the dewar for those that do.
  localBodyCorners: [
    { x: -6, y: -4 },
    { x: 26, y: -4 },
    { x: -6, y: 54 },
    { x: 26, y: 54 },
  ],
  ports: [{ portId: 'out', x: -4, y: 4, exitAngleDeg: 180 }],
  centerX: 10,
  labelStartY: 58,
  defaultEnabled: { name: true, value: true },
  // The port sits on the left of the neck by default (matching the outline
  // above); mirroring flips both the drawn body and the port to the right.
  mirrorable: true,
  // Solid black by default (previously just an outline) — user-recolorable
  // per instance, independent of the live "_indicator" status color.
  colorable: true,
  defaultFillColor: '#000000',
  optionalExtras: [{ propertyKey: 'dewar', label: 'Standing in a dewar', shapes: [{ d: DEWAR_D }] }],
})
