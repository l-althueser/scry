import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { SvgCanvas, type Point } from './SvgCanvas'
import { useProjectStore } from '../state/projectStore'

export interface CanvasViewHandle {
  /** Forwards to the underlying SvgCanvas's clearEnteredGroup — see App.tsx's Escape handler. */
  clearEnteredGroup: () => void
  /** Forwards to SvgCanvas.focusOnWorldPoint — see tag search's "jump to result". */
  focusOnWorldPoint: (point: Point) => void
}

export const CanvasView = forwardRef<CanvasViewHandle>(function CanvasView(_props, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<SvgCanvas | null>(null)

  useImperativeHandle(ref, () => ({
    clearEnteredGroup: () => canvasRef.current?.clearEnteredGroup(),
    focusOnWorldPoint: (point) => canvasRef.current?.focusOnWorldPoint(point),
  }))

  const instances = useProjectStore((s) => s.instances)
  const pipes = useProjectStore((s) => s.pipes)
  const freeShapes = useProjectStore((s) => s.freeShapes)
  const leaderLines = useProjectStore((s) => s.leaderLines)
  const layers = useProjectStore((s) => s.layers)
  const groups = useProjectStore((s) => s.groups)
  const tool = useProjectStore((s) => s.tool)
  const placingType = useProjectStore((s) => s.placingType)
  const drawingShapeKind = useProjectStore((s) => s.drawingShapeKind)
  const connectionPointTargetLayerId = useProjectStore((s) => s.connectionPointTargetLayerId)
  const connectionPointTargetShapeId = useProjectStore((s) => s.connectionPointTargetShapeId)
  const selectedConnectionPoint = useProjectStore((s) => s.selectedConnectionPoint)
  const pickTransparentColorTargetLayerId = useProjectStore((s) => s.pickTransparentColorTargetLayerId)
  const gridSize = useProjectStore((s) => s.gridSize)
  const gridVisible = useProjectStore((s) => s.gridVisible)
  const selectedInstanceIds = useProjectStore((s) => s.selectedInstanceIds)
  const selectedRole = useProjectStore((s) => s.selectedRole)
  const selectedPipeIds = useProjectStore((s) => s.selectedPipeIds)
  const selectedWaypoint = useProjectStore((s) => s.selectedWaypoint)
  const selectedEndpoint = useProjectStore((s) => s.selectedEndpoint)
  const selectedShapeIds = useProjectStore((s) => s.selectedShapeIds)
  const selectedLeaderLineIds = useProjectStore((s) => s.selectedLeaderLineIds)
  const selectedLayerIds = useProjectStore((s) => s.selectedLayerIds)
  const imageAspectLocked = useProjectStore((s) => s.imageAspectLocked)
  const addInstance = useProjectStore((s) => s.addInstance)
  const moveInstance = useProjectStore((s) => s.moveInstance)
  const resizeInstance = useProjectStore((s) => s.resizeInstance)
  const moveRole = useProjectStore((s) => s.moveRole)
  const selectInstances = useProjectStore((s) => s.selectInstances)
  const selectRole = useProjectStore((s) => s.selectRole)
  const beginGroupDrag = useProjectStore((s) => s.beginGroupDrag)
  const applyGroupDrag = useProjectStore((s) => s.applyGroupDrag)
  const endGroupDrag = useProjectStore((s) => s.endGroupDrag)
  const addPipe = useProjectStore((s) => s.addPipe)
  const selectPipes = useProjectStore((s) => s.selectPipes)
  const movePipeWaypoint = useProjectStore((s) => s.movePipeWaypoint)
  const insertPipeWaypoint = useProjectStore((s) => s.insertPipeWaypoint)
  const movePipeEndpoint = useProjectStore((s) => s.movePipeEndpoint)
  const finalizePipeEndpointDrag = useProjectStore((s) => s.finalizePipeEndpointDrag)
  const selectWaypoint = useProjectStore((s) => s.selectWaypoint)
  const selectEndpoint = useProjectStore((s) => s.selectEndpoint)
  const checkpointHistory = useProjectStore((s) => s.checkpointHistory)
  const addFreeShape = useProjectStore((s) => s.addFreeShape)
  const moveShape = useProjectStore((s) => s.moveShape)
  const selectShapes = useProjectStore((s) => s.selectShapes)
  const addLeaderLine = useProjectStore((s) => s.addLeaderLine)
  const selectLeaderLines = useProjectStore((s) => s.selectLeaderLines)
  const moveLeaderLinePoint = useProjectStore((s) => s.moveLeaderLinePoint)
  const moveLeaderLineFrom = useProjectStore((s) => s.moveLeaderLineFrom)
  const selectLayers = useProjectStore((s) => s.selectLayers)
  const moveImageLayer = useProjectStore((s) => s.moveImageLayer)
  const resizeImageLayer = useProjectStore((s) => s.resizeImageLayer)
  const addConnectionPoint = useProjectStore((s) => s.addConnectionPoint)
  const addShapeConnectionPoint = useProjectStore((s) => s.addShapeConnectionPoint)
  const selectConnectionPoint = useProjectStore((s) => s.selectConnectionPoint)
  const moveConnectionPoint = useProjectStore((s) => s.moveConnectionPoint)
  const pickTransparentColorAt = useProjectStore((s) => s.pickTransparentColorAt)
  const selectMixed = useProjectStore((s) => s.selectMixed)
  const selectGroup = useProjectStore((s) => s.selectGroup)

  useEffect(() => {
    if (!containerRef.current) return

    const canvas = new SvgCanvas(containerRef.current, gridSize, {
      onInstanceAdded: (typeId, pt, keepPlacing) => addInstance(typeId, pt, keepPlacing),
      onInstanceMoved: (instanceId, pt) => moveInstance(instanceId, pt),
      onInstanceResized: (instanceId, rect) => resizeInstance(instanceId, rect),
      onRoleMoved: (instanceId, role, offset) => moveRole(instanceId, role, offset),
      onDragCheckpoint: () => checkpointHistory(),
      onSelectionChanged: (instanceIds) => selectInstances(instanceIds),
      onMixedSelectionChanged: (selection) => selectMixed(selection),
      onGroupSelected: (groupId) => selectGroup(groupId),
      onRoleSelected: (selection) => selectRole(selection),
      onGroupDragStart: (instanceIds, pipePoints) => beginGroupDrag(instanceIds, pipePoints),
      onGroupDragMove: (delta) => applyGroupDrag(delta),
      onGroupDragEnd: () => endGroupDrag(),
      onPipeAdded: (fromPort, toPort, waypoints, keepDrawing) =>
        addPipe(fromPort, toPort, waypoints, keepDrawing),
      onPipeSelectionChanged: (pipeIds) => selectPipes(pipeIds),
      onWaypointMoved: (pipeId, index, pt) => movePipeWaypoint(pipeId, index, pt),
      onWaypointAdded: (pipeId, index, pt) => insertPipeWaypoint(pipeId, index, pt),
      onWaypointSelected: (selection) => selectWaypoint(selection),
      onEndpointSelected: (selection) => selectEndpoint(selection),
      onPipeEndpointMoved: (pipeId, side, ref) => movePipeEndpoint(pipeId, side, ref),
      onPipeEndpointDragEnd: (pipeId) => finalizePipeEndpointDrag(pipeId),
      onShapeAdded: (kind, points, keepDrawing) => addFreeShape(kind, points, keepDrawing),
      onShapeMoved: (shapeId, points) => moveShape(shapeId, points),
      onShapeSelectionChanged: (shapeIds) => selectShapes(shapeIds),
      onLeaderLineAdded: (from, waypoints, to) => addLeaderLine(from, waypoints, to),
      onLeaderLineSelectionChanged: (leaderLineIds) => selectLeaderLines(leaderLineIds),
      onLeaderLinePointMoved: (leaderLineId, point, pt) => moveLeaderLinePoint(leaderLineId, point, pt),
      onLeaderLineFromMoved: (leaderLineId, from) => moveLeaderLineFrom(leaderLineId, from),
      onLayerSelectionChanged: (layerIds) => selectLayers(layerIds),
      onLayerMoved: (layerId, x, y) => moveImageLayer(layerId, x, y),
      onLayerResized: (layerId, rect) => resizeImageLayer(layerId, rect),
      onConnectionPointAdded: (layerId, relX, relY, keepPlacing) =>
        addConnectionPoint(layerId, relX, relY, keepPlacing),
      onShapeConnectionPointAdded: (shapeId, relX, relY, keepPlacing) =>
        addShapeConnectionPoint(shapeId, relX, relY, keepPlacing),
      onConnectionPointSelected: (selection) => selectConnectionPoint(selection),
      onConnectionPointMoved: (ownerKind, ownerId, pointId, relX, relY) =>
        moveConnectionPoint(ownerKind, ownerId, pointId, relX, relY),
      onTransparentColorPicked: (layerId, relX, relY) => void pickTransparentColorAt(layerId, relX, relY),
    })
    canvasRef.current = canvas

    return () => canvas.destroy()
    // Store actions are stable references from zustand; only mount/unmount once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    canvasRef.current?.syncInstances(instances)
    canvasRef.current?.syncPipes(pipes, instances)
    // Leader-line endpoints can now anchor to a pipe's or shape's border
    // (not just a role label), so this must also re-run whenever pipes or
    // freeShapes change, not just leaderLines/instances.
    canvasRef.current?.syncLeaderLines(leaderLines, instances, pipes, freeShapes)
  }, [instances, pipes, leaderLines, freeShapes])

  // Declared before syncFreeShapes below so that when `layers` changes, this
  // effect's syncLayers call (which refreshes SvgCanvas's internal
  // this.latestLayers) always runs first in the same commit — syncFreeShapes
  // reads this.latestLayers to decide each shape's own-layer locked state
  // (see renderShapeInto), and effects run in declaration order.
  useEffect(() => {
    canvasRef.current?.syncLayers(layers)
  }, [layers])

  useEffect(() => {
    // Also re-run on `layers` changes, not just `freeShapes` — a shape's
    // hit-testing (pointer-events) and cursor depend on its own layer's
    // locked state (see renderShapeInto), so locking/unlocking a layer must
    // immediately update every shape on it, not wait for unrelated shape data to change.
    canvasRef.current?.syncFreeShapes(freeShapes)
  }, [freeShapes, layers])

  useEffect(() => {
    canvasRef.current?.syncGroups(groups)
  }, [groups])

  useEffect(() => {
    let subKind = placingType
    if (tool === 'draw-shape') subKind = drawingShapeKind
    else if (tool === 'place-connection-point') subKind = connectionPointTargetLayerId
    else if (tool === 'place-connection-point-shape') subKind = connectionPointTargetShapeId
    else if (tool === 'pick-transparent-color') subKind = pickTransparentColorTargetLayerId
    canvasRef.current?.setTool(tool, subKind)
  }, [
    tool,
    placingType,
    drawingShapeKind,
    connectionPointTargetLayerId,
    connectionPointTargetShapeId,
    pickTransparentColorTargetLayerId,
  ])

  useEffect(() => {
    canvasRef.current?.setSelection(selectedInstanceIds)
  }, [selectedInstanceIds])

  useEffect(() => {
    canvasRef.current?.setRoleSelection(selectedRole)
  }, [selectedRole])

  useEffect(() => {
    canvasRef.current?.setPipeSelection(selectedPipeIds)
  }, [selectedPipeIds])

  useEffect(() => {
    canvasRef.current?.setWaypointSelection(selectedWaypoint)
  }, [selectedWaypoint])

  useEffect(() => {
    canvasRef.current?.setEndpointSelection(selectedEndpoint)
  }, [selectedEndpoint])

  useEffect(() => {
    canvasRef.current?.setShapeSelection(selectedShapeIds)
  }, [selectedShapeIds])

  useEffect(() => {
    canvasRef.current?.setLeaderLineSelection(selectedLeaderLineIds)
  }, [selectedLeaderLineIds])

  useEffect(() => {
    canvasRef.current?.setLayerSelection(selectedLayerIds)
  }, [selectedLayerIds])

  useEffect(() => {
    canvasRef.current?.setConnectionPointSelection(selectedConnectionPoint)
  }, [selectedConnectionPoint])

  useEffect(() => {
    canvasRef.current?.setAspectLocked(imageAspectLocked)
  }, [imageAspectLocked])

  useEffect(() => {
    canvasRef.current?.setGridSize(gridSize)
  }, [gridSize])

  useEffect(() => {
    canvasRef.current?.setGridVisible(gridVisible)
  }, [gridVisible])

  return <div ref={containerRef} className="canvas-container" />
})
