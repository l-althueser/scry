# Scry: SVG HMI Editor

Scry is a browser-based editor for building process-and-instrumentation
(P&ID) style diagrams: valves, pipes, compressors, gas cylinders, gauges,
indicators, and similar equipment for gas and fluid systems. You lay the
diagram out once, visually, and export it as a single self-contained SVG.

What makes the export special is that it's *alive*. Every value, label, and
status indicator you place is tagged with a predictable element ID, so an
external dashboard or monitoring system can find those elements and update
them with live process data (text values, setpoints, and color-coded status)
without ever having to touch the SVG file itself again. Build the diagram
once, then *scry* the running system through it.

## Features

- **Component library**: valves, pipes, compressors, cylinders, flow
  meters, burst disks, gauges/indicators, and generic equipment boxes, each
  with defined connection ports.
- **Auto-routed pipes** with draggable waypoints/knots, port snapping, and
  free/disconnected ends.
- **Free-form shapes** (rectangles, lines, polygons, text) for annotation
  and diagram framing.
- **Leader lines**: freeform annotation lines that can dock to a
  component's label or a shape's border.
- **Image layers**: trace over a background image (e.g. a floor plan or
  scanned drawing) or embed reference imagery in the final export.
- **Project storage with history**: named projects persisted server-side,
  versioned, with undo/redo.
- **Tag-based live export**: every taggable element is exported using a
  simple, predictable `<Name>_<suffix>` ID convention (`_value`, `_name`,
  `_setpoint`, `_indicator`, `pipe`), so any downstream system that can address SVG
  elements by ID and set their text/fill can drive the diagram live.

  ```js
  // Update a measured value and its setpoint
  svg.querySelector('#PT101_value > text').textContent = '4.2 bar'
  svg.querySelector('#PT101_setpoint > text').textContent = '4.0 bar'

  // Drive a status indicator (color on the group, never on child paths)
  svg.querySelector('#PT101_indicator').style.fill = 'LawnGreen'
  ```

## Setup (local)

Requires Node.js 20 LTS.

```sh
npm install
npm run dev          # starts both the Vite dev server (5173) and the Express API/backend (3000)
```

The frontend proxies `/api/*` to the backend, so both must be running.
`npm run dev` does this for you; to run them in separate terminals instead,
use `npm run dev:web` and `npm run dev:server`.

## Build & typecheck

```sh
npm run typecheck
npm run build         # builds packages/web/dist
```

## Docker (build locally)

Requires Docker Desktop (including Compose).

```sh
docker compose up --build
```

The container listens on port 3000 and stores projects, libraries, and
exported SVGs under `./data/{projects,libraries,export}` (see
`docker-compose.yml`).

## Docker (prebuilt image)

Pull the image published by CI instead of building it locally:

```yaml
services:
  scry:
    image: ghcr.io/l-althueser/scry:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data/projects:/data/projects
      - ./data/libraries:/data/libraries
      - ./data/export:/data/export
    environment:
      - PORT=3000
      # - BASE_PATH=/scry # See below
      # - BASIC_AUTH_USER=admin # See below
      # - BASIC_AUTH_PASSWORD_HASH=$2y$05$UHkNuabejLMfoO...
    restart: unless-stopped
    healthcheck:
      # Make sure the port matches the one in the `PORT` env var above
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

```sh
docker compose up -d
```

## Reverse-proxy subpath hosting

Set `BASE_PATH` (e.g. `BASE_PATH=/scry`) when this container is reverse-proxied
under a subpath instead of the site root. It's read at container startup, not
build time, so the same prebuilt image works at any subpath without a
rebuild — the server rewrites the asset references in the built `index.html`
and injects `window.__BASE_PATH__`, which the frontend uses for its API calls.

Example with Traefik (labels on the service, using a `PathPrefix` route with
a strip-prefix middleware so the container always sees unprefixed paths):

```yaml
services:
  scry:
    image: ghcr.io/l-althueser/scry:latest
    environment:
      - BASE_PATH=/scry
    labels:
      - traefik.http.routers.scry.rule=PathPrefix(`/scry`)
      - traefik.http.middlewares.scry-strip.stripprefix.prefixes=/scry
      - traefik.http.routers.scry.middlewares=scry-strip
```

Leave `BASE_PATH` unset for a root-mounted deployment (the default, unchanged
behavior).

## Basic authentication

Off by default. Set **both** `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD_HASH`
to gate the whole app (frontend + API, but not the `/api/health` endpoint
docker-compose's own healthcheck uses) behind a single HTTP Basic Auth
username/password. `BASIC_AUTH_PASSWORD_HASH` is a **bcrypt hash**, never the
plaintext password — generate one with whichever of these you have on hand:

```sh
# Plain Linux tool (apache2-utils on Debian/Ubuntu, httpd-tools on RHEL/Fedora) — no Node needed
htpasswd -nbB anyuser 'your-password-here' | cut -d: -f2
```

```sh
# Local Node
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" 'your-password-here'
```

```sh
# No local Node — use the built image itself
docker run --rm ghcr.io/l-althueser/scry:latest node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" 'your-password-here'
```

(`htpasswd -B` emits a `$2y$...` hash; the server's `bcryptjs` verifies
`$2y$`/`$2a$`/`$2b$` interchangeably, so this is fully compatible.)

**Put the resulting hash in a `.env` file next to `docker-compose.yml`, not
inline in the YAML.** Compose interpolates `$VAR`/`${VAR}` inside
`docker-compose.yml` itself, and a bcrypt hash is full of `$`-prefixed
segments that look exactly like variable references — pasted directly into
the YAML, something like `$2y$05$UHkNuabej...` gets silently mangled (the
`$UHkNuabej...` part looks like a variable name, so Compose swaps it for an
empty string, usually with an easy-to-miss "variable is not set" warning),
truncating the hash so every login just fails with no clear error. `.env`
values aren't re-interpolated this way, so this is the safe default:

```
# .env
BASIC_AUTH_PASSWORD_HASH=$2y$05$UHkNuabejLMfoO...
```

If you really want it inline in `docker-compose.yml` anyway, double every `$`
(`$$`) to escape it:
```yaml
- BASIC_AUTH_PASSWORD_HASH=$$2y$$05$$UHkNuabejLMfoO...
```

```
# .env
BASIC_AUTH_USER=admin
BASIC_AUTH_PASSWORD_HASH=$2y$05$UHkNuabejLMfoO...
```

## Project structure

```
packages/
  shared/   # shared data model (Project, ComponentInstance, PipeInstance, LeaderLine, ...)
  web/      # Vite + React + TS editor frontend
  server/   # Express server (project/library storage, serves the built frontend)
```

## License

BSD 3-Clause, see [LICENSE](LICENSE).

## Acknowledgements

This project was realized with the help of AI tools. The results were
manually reviewed and edited to ensure correctness and quality.
