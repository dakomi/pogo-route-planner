# Pokémon GO Route Planner

A tool that fetches PokéStop and Gym data from [pogomap.info](https://www.pogomap.info), filters
locations within a user-defined walking radius, and computes an optimised
walking route using the [OSRM public demo server](https://router.project-osrm.org).

The tool ships in two forms:

| Delivery | File | Use case |
|----------|------|----------|
| **Node.js CLI** | `termux/route-planner.js` | Run in [Termux](https://termux.dev/) on Android or any Node.js environment |
| **Userscript** | `userscript/pogo-route-planner.user.js` | Inject into the pogomap.info page in a Tampermonkey/Violentmonkey-enabled browser |

---

## Features

- Fetches live PokéStop and Gym locations from pogomap.info
- Filters POIs within a configurable walking radius (Haversine formula, no library)
- Optimises visit order using a **nearest-neighbour TSP heuristic** seeded with real walking distances from OSRM
- Stitches the full street-following route using OSRM's `foot` profile
- Outputs:
  - Terminal summary (CLI) / inline results panel (userscript)
  - `route.gpx` file download
  - Google Maps URL with waypoints
  - OpenStreetMap URL

---

## Repository structure

```
pogo-route-planner/
├── README.md
├── docs/
│   └── pogomap-api.md        ← API findings for pogomap.info
├── termux/
│   └── route-planner.js      ← Node.js CLI (zero npm dependencies)
└── userscript/
    └── pogo-route-planner.user.js  ← Tampermonkey/Violentmonkey userscript
```

---

## Quick start — Termux (Android)

### 1. Install Node.js in Termux

```bash
pkg update && pkg install nodejs
```

### 2. Get the script

```bash
# Option A — clone the full repo
pkg install git
git clone https://github.com/dakomi/pogo-route-planner.git
cd pogo-route-planner/termux

# Option B — download the single file
curl -O https://raw.githubusercontent.com/dakomi/pogo-route-planner/main/termux/route-planner.js
```

### 3. Run interactively

```bash
node route-planner.js
```

You will be prompted for:
- Starting latitude and longitude
- Walking radius in metres (e.g. `1500`)
- Whether to include PokéStops, Gyms, or both

### 4. Run non-interactively (scripted / shortcuts)

```bash
node route-planner.js --lat 51.5074 --lng -0.1278 --radius 1500 --include both
# --include accepts: stops | gyms | both
```

### 5. Output

- A summary is printed to the terminal.
- `route.gpx` is saved to the current working directory.
- Google Maps and OpenStreetMap URLs are printed (open them in any browser).

---

## Quick start — Userscript (Tampermonkey / Violentmonkey)

### 1. Install a userscript manager

On Android (Firefox or Kiwi Browser):

- [Tampermonkey for Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
- [Violentmonkey for Firefox](https://addons.mozilla.org/en-US/firefox/addon/violentmonkey/)
- Kiwi Browser supports Chrome extensions — install from the Chrome Web Store

### 2. Install the script

Visit the raw file URL and your userscript manager will offer to install it:

```
https://raw.githubusercontent.com/dakomi/pogo-route-planner/main/userscript/pogo-route-planner.user.js
```

Or copy-paste the file contents into a new userscript in Tampermonkey/Violentmonkey.

### 3. Use the planner

1. Open [pogomap.info](https://www.pogomap.info) in your browser.
2. A floating **Pogo Route Planner** panel will appear in the bottom-right corner.
3. Tap **📍 Use my location** or enter coordinates manually.
4. Set a walking radius and choose PokéStops / Gyms.
5. Tap **⚡ Plan Route**.
6. The panel shows the ordered stop list, total distance, estimated walking time,
   links to Google Maps and OpenStreetMap, and a **Download GPX** button.

The panel is **draggable** (tap-and-hold the header) and collapses with the **−** button.

---

## Configuration

| Setting | Where | Default | Description |
|---------|-------|---------|-------------|
| `ENDPOINT` | `termux/route-planner.js` line ~20 | `https://www.pogomap.info/query2.php` | pogomap.info data URL |
| `POGO_ENDPOINT` | `userscript/pogo-route-planner.user.js` line ~20 | `https://www.pogomap.info/query2.php` | pogomap.info data URL |
| `OSRM_BASE` | both files | `https://router.project-osrm.org` | OSRM routing server |

---

## OSRM fair-use notes

Both the CLI script and the userscript use the **OSRM public demo server**
(`router.project-osrm.org`) operated as a free community service.

- **Do not** send automated or repeated requests in quick succession.
- Each "Plan Route" action makes two requests: one Table API call and one Route API call.
- For high-volume use, consider [self-hosting OSRM](https://github.com/Project-OSRM/osrm-backend)
  or using a commercial routing provider, and update `OSRM_BASE` accordingly.

---

## Troubleshooting

### No POIs returned from pogomap.info

The site does not publish an official API. If the endpoint changes:

1. Open [pogomap.info](https://www.pogomap.info) in a desktop browser.
2. Open DevTools → **Network** → filter by **Fetch/XHR**.
3. Pan the map to trigger a data request.
4. Find the request URL (likely `query2.php` or similar).
5. Update the `ENDPOINT` / `POGO_ENDPOINT` constant in the relevant file.
6. See [`docs/pogomap-api.md`](docs/pogomap-api.md) for full API documentation.

### OSRM errors

- The public OSRM demo server may be temporarily unavailable or rate-limiting.
- The CLI script falls back to Haversine-based ordering; the userscript does the same.
- Try again after a short wait.

---

## API documentation

Full findings from inspecting pogomap.info (endpoint, parameters, JSON schema,
auth notes, CORS notes): [`docs/pogomap-api.md`](docs/pogomap-api.md)

---

## License

MIT
