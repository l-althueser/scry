# Scry — SVG HMI Editor

Scry is a browser-based editor for building process-and-instrumentation
(P&ID) style diagrams — valves, pipes, compressors, gas cylinders, gauges,
indicators, and similar equipment — for gas and fluid systems. You lay the
diagram out once, visually, and export it as a single self-contained SVG.

What makes the export special is that it's *alive*: every value, label, and
status indicator you place is tagged with a predictable element ID, so an
external dashboard or monitoring system can find those elements and update
them with live process data — text values, setpoints, and color-coded status
— without ever having to touch the SVG file itself again. Build the diagram
once, then *scry* the running system through it.

## Features

- **Component library** — valves, pipes, compressors, cylinders, flow
  meters, burst disks, gauges/indicators, and generic equipment boxes, each
  with defined connection ports.
- **Auto-routed pipes** with draggable waypoints/knots, port snapping, and
  free/disconnected ends.
- **Free-form shapes** (rectangles, lines, polygons, text) for annotation
  and diagram framing.
- **Leader lines** — freeform annotation lines that can dock to a
  component's label or a shape's border.
- **Image layers** — trace over a background image (e.g. a floor plan or
  scanned drawing) or embed reference imagery in the final export.
- **Project storage with history** — named projects persisted server-side,
  versioned, with undo/redo.
- **Tag-based live export** — every taggable element is exported using a
  simple, predictable `<Name>_<suffix>` ID convention (`_value`, `_name`,
  `_setpoint`, `_indicator`), so any downstream system that can address SVG
  elements by ID and set their text/fill can drive the diagram live.

## Setup (local)

Requires Node.js 20 LTS.

```sh
npm install
npm run dev          # starts both the Vite dev server (5173) and the Express API/backend (3000)
```

The frontend proxies `/api/*` to the backend, so both must be running —
`npm run dev` does this for you; to run them in separate terminals instead,
use `npm run dev:web` and `npm run dev:server`.

## Build & typecheck

```sh
npm run typecheck
npm run build         # builds packages/web/dist
```

## Docker

Requires Docker Desktop (including Compose).

```sh
docker compose up --build
```

The container listens on port 3000 and stores projects, libraries, and
exported SVGs under `./data/{projects,libraries,export}` (see
`docker-compose.yml`).

## Project structure

```
packages/
  shared/   # shared data model (Project, ComponentInstance, PipeInstance, LeaderLine, ...)
  web/      # Vite + React + TS editor frontend
  server/   # Express server (project/library storage, serves the built frontend)
```

## License

BSD 3-Clause — see [LICENSE](LICENSE).

## Acknowledgements

This project was realized with the help of AI tools. The results were
manually reviewed and edited to ensure correctness and quality.
