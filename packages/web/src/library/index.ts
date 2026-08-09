// Importing these runs their registerComponentType(...) side effect.
// Everything else in the app should import the registry through this barrel
// (not registry.ts directly) so the built-in types are always registered.
import './valveComponent'
import './indicatorComponent'
import './pneumaticValveComponent'
import './compressorComponent'
import './gasCylinderComponent'
import './flowMeterComponent'
import './burstDiskComponent'
import './reliefValveComponent'
import './equipmentBoxComponent'
// Runs after the built-ins above so custom types are registered last (moot in
// practice — typeIds are prefixed to never collide — but keeps load order sane).
import './customTypes'

export * from './registry'
export * from './componentUtils'
export * from './preview'
export * from './iconComponentFactory'
export * from './shapePrimitives'
export * from './customTypes'
export { SCREW_DOWN_VALVE_TYPE } from './valveComponent'
export { PROCESS_INDICATOR_TYPE } from './indicatorComponent'
export { PNEUMATIC_VALVE_TYPE } from './pneumaticValveComponent'
export { COMPRESSOR_TYPE } from './compressorComponent'
export { GAS_CYLINDER_TYPE } from './gasCylinderComponent'
export { FLOW_METER_TYPE } from './flowMeterComponent'
export { BURST_DISK_TYPE } from './burstDiskComponent'
export { RELIEF_VALVE_TYPE } from './reliefValveComponent'
export { EQUIPMENT_BOX_TYPE } from './equipmentBoxComponent'
