import type { ComponentInstance, PipeInstance, Project, RoleInstance, Suffix } from '@svg-editor/shared'

// Mirrors the default label layouts from packages/web/src/library/{valve,indicator}Component.ts.
// Duplicated here (not imported) because the server intentionally has no
// dependency on the web package — this is just static seed data.
const VALVE_CENTER_X = 17.01
const LABEL_START_Y = 32
const LABEL_ROW_HEIGHT = 20

interface ValveRoleOptions {
  indicator?: boolean
  name?: boolean
  value?: boolean
  setpoint?: boolean
}

function valveRoles(opts: ValveRoleOptions): RoleInstance[] {
  const defaults: Record<Suffix, boolean> = { indicator: true, name: true, value: false, setpoint: false }
  const enabled: Record<Suffix, boolean> = { ...defaults, ...opts }
  return [
    { role: 'indicator', enabled: enabled.indicator, offset: { x: 0, y: 0 } },
    { role: 'name', enabled: enabled.name, offset: { x: VALVE_CENTER_X, y: LABEL_START_Y } },
    { role: 'value', enabled: enabled.value, offset: { x: VALVE_CENTER_X, y: LABEL_START_Y + LABEL_ROW_HEIGHT } },
    {
      role: 'setpoint',
      enabled: enabled.setpoint,
      offset: { x: VALVE_CENTER_X, y: LABEL_START_Y + LABEL_ROW_HEIGHT * 2 },
    },
  ]
}

function valve(
  instanceId: string,
  tag: string,
  x: number,
  y: number,
  rotationDeg: number,
  roleOpts: ValveRoleOptions,
): ComponentInstance {
  return {
    instanceId,
    tag,
    componentTypeId: 'screw-down-valve',
    libraryPackage: 'prototype',
    transform: { x, y, rotationDeg },
    propertyValues: {},
    layerId: 'default',
    roles: valveRoles(roleOpts),
  }
}

interface IndicatorRoleOptions {
  name?: boolean
  value?: boolean
  setpoint?: boolean
}

function indicatorRoles(opts: IndicatorRoleOptions): RoleInstance[] {
  const enabled = { name: true, value: true, setpoint: false, ...opts }
  return [
    { role: 'name', enabled: enabled.name, offset: { x: 0, y: 0 } },
    { role: 'value', enabled: enabled.value, offset: { x: 0, y: 20 } },
    { role: 'setpoint', enabled: enabled.setpoint, offset: { x: 0, y: 40 } },
  ]
}

/** A bare instrument tag (no valve icon) — see packages/web/src/library/indicatorComponent.ts. */
function processIndicator(
  instanceId: string,
  tag: string,
  x: number,
  y: number,
  roleOpts: IndicatorRoleOptions,
): ComponentInstance {
  return {
    instanceId,
    tag,
    componentTypeId: 'process-indicator',
    libraryPackage: 'prototype',
    transform: { x, y, rotationDeg: 0 },
    propertyValues: {},
    layerId: 'default',
    roles: indicatorRoles(roleOpts),
  }
}

function pipe(
  instanceId: string,
  tag: string,
  fromInstanceId: string,
  fromPortId: string,
  toInstanceId: string,
  toPortId: string,
  indicatorEnabled = false,
): PipeInstance {
  return {
    instanceId,
    tag,
    fromPort: { instanceId: fromInstanceId, portId: fromPortId },
    toPort: { instanceId: toInstanceId, portId: toPortId },
    routingMode: 'straight',
    waypoints: [],
    indicatorEnabled,
    hopOverrides: {},
  }
}

const now = new Date().toISOString()

/**
 * A fictional small gas supply line, used to seed a loadable example project
 * so the editor isn't blank on first use. The valves (MV1, HV201, PR1,
 * HV202, HV203, BV1) all use the one valve component type with different
 * roles enabled — PR1 stands in for a regulator by also showing
 * value/setpoint. PI101 is a genuine instrument tag using the
 * process-indicator type (just name+value, no valve icon). The main line
 * (MV1 -> HV201 -> PR1 -> HV202 -> HV203) is connected with pipes; MV1's
 * outgoing pipe has its indicator enabled to show a clickable/colorable run.
 */
export const EXAMPLE_GAS_SYSTEM_PROJECT: Project = {
  meta: {
    id: 'gas-system-demo',
    name: 'Gas System Demo',
    canvasWidth: 900,
    canvasHeight: 400,
    gridSize: 20,
    schemaVersion: 1,
    createdAt: now,
    modifiedAt: now,
  },
  libraryRefs: [{ package: 'prototype', version: '0.0.1' }],
  layers: [{ layerId: 'default', name: 'Default', visible: true, locked: false, kind: 'vector' }],
  instances: [
    valve('demo-mv1', 'MV1', 40, 40, 0, {}),
    valve('demo-hv201', 'HV201', 200, 40, 0, {}),
    valve('demo-pr1', 'PR1', 360, 40, 0, { value: true, setpoint: true }),
    valve('demo-hv202', 'HV202', 580, 40, 0, {}),
    valve('demo-hv203', 'HV203', 740, 40, 0, {}),
    valve('demo-bv1', 'BV1', 360, 180, 90, {}),
    processIndicator('demo-pi101', 'PI101', 580, 180, {}),
  ],
  pipes: [
    pipe('demo-p1', 'L1', 'demo-mv1', 'out', 'demo-hv201', 'in', true),
    pipe('demo-p2', 'L2', 'demo-hv201', 'out', 'demo-pr1', 'in'),
    pipe('demo-p3', 'L3', 'demo-pr1', 'out', 'demo-hv202', 'in'),
    pipe('demo-p4', 'L4', 'demo-hv202', 'out', 'demo-hv203', 'in'),
  ],
  leaderLines: [],
  freeShapes: [],
}
