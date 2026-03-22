#!/usr/bin/env node
/**
 * Pokémon GO Route Planner — Termux / Node.js CLI
 * ================================================
 * Zero npm dependencies.  Requires Node.js >= 18 (built-in fetch) or
 * falls back to the `https` module on older versions.
 *
 * Usage (interactive):
 *   node route-planner.js
 *
 * Usage (non-interactive / scripted):
 *   node route-planner.js --lat 51.5074 --lng -0.1278 --radius 1500 --include both
 *
 * Outputs:
 *   - Terminal summary (stop count, ordered names, total distance)
 *   - route.gpx  saved in the current working directory
 *   - Google Maps URL
 *   - OpenStreetMap URL
 *
 * If pogomap.info changes its endpoint, update the ENDPOINT constant below
 * and consult docs/pogomap-api.md for guidance.
 */

'use strict';

const fs       = require('fs');
const readline = require('readline');
const https    = require('https');
const http     = require('http');
const url      = require('url');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** pogomap.info data endpoint — update here if the site changes it */
const ENDPOINT = 'https://www.pogomap.info/query2.php';

/** OSRM public demo server — foot profile */
const OSRM_BASE = 'https://router.project-osrm.org';

/** Earth radius in metres (WGS84 mean) */
const EARTH_RADIUS_M = 6_371_000;

// ---------------------------------------------------------------------------
// Haversine distance (no library)
// ---------------------------------------------------------------------------

/**
 * Returns the great-circle distance in metres between two WGS84 coordinates.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} distance in metres
 */
function haversine(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// Bounding-box helper
// ---------------------------------------------------------------------------

/**
 * Returns {swLat, swLng, neLat, neLng} for a circular region approximated
 * as a square bounding box.
 */
function boundingBox(lat, lng, radiusM) {
  const latDelta = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const lngDelta =
    (radiusM / (EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180))) *
    (180 / Math.PI);
  return {
    swLat: lat - latDelta,
    swLng: lng - lngDelta,
    neLat: lat + latDelta,
    neLng: lng + lngDelta,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper (works on Node 18+ with built-in fetch AND older Node)
// ---------------------------------------------------------------------------

/**
 * Performs a GET request and resolves with the parsed JSON body.
 * @param {string} rawUrl
 * @param {object} [headers]
 * @returns {Promise<any>}
 */
function getJSON(rawUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed   = url.parse(rawUrl);
    const module_  = parsed.protocol === 'https:' ? https : http;
    const options  = {
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.path,
      method:   'GET',
      headers:  {
        'User-Agent': 'PogoRoutePlanner/1.0 (Termux/NodeJS)',
        Referer:      'https://www.pogomap.info/',
        Accept:       'application/json',
        ...headers,
      },
    };

    const req = module_.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error(`HTTP ${res.statusCode} from ${rawUrl}`)
          );
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Invalid JSON from ${rawUrl}: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`Request timed out: ${rawUrl}`));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// pogomap.info data fetch
// ---------------------------------------------------------------------------

/**
 * Fetches PokéStop and/or Gym data from pogomap.info for the given bbox.
 * @param {object} bbox  {swLat, swLng, neLat, neLng}
 * @param {boolean} includePokestops
 * @param {boolean} includeGyms
 * @returns {Promise<Array<{id,name,lat,lng,type}>>}
 */
async function fetchPOIs(bbox, includePokestops, includeGyms) {
  const params = new URLSearchParams({
    swLat:      bbox.swLat.toFixed(7),
    swLng:      bbox.swLng.toFixed(7),
    neLat:      bbox.neLat.toFixed(7),
    neLng:      bbox.neLng.toFixed(7),
    pokestops:  includePokestops ? 'true' : 'false',
    gyms:       includeGyms      ? 'true' : 'false',
    timestamp:  Date.now().toString(),
  });

  const fullUrl = `${ENDPOINT}?${params}`;
  console.log(`\nFetching data from pogomap.info…`);
  console.log(`  ${fullUrl}`);

  let data;
  try {
    data = await getJSON(fullUrl);
  } catch (err) {
    throw new Error(
      `Failed to fetch data from pogomap.info: ${err.message}\n` +
      `If the endpoint has changed, update ENDPOINT in this script and\n` +
      `consult docs/pogomap-api.md for guidance.`
    );
  }

  const pois = [];

  /** Normalise a raw object from the API into a common shape */
  function normalise(raw, type) {
    // Accept both lat/lng and latitude/longitude field names
    const lat = raw.lat  ?? raw.latitude;
    const lng = raw.lng  ?? raw.longitude;
    const name = raw.name ?? raw.stop_name ?? raw.gym_name ?? `Unnamed ${type}`;
    if (lat == null || lng == null) return null;
    return { id: raw.id ?? `${type}_${lat}_${lng}`, name, lat: +lat, lng: +lng, type };
  }

  if (includePokestops && Array.isArray(data.pokestops)) {
    for (const s of data.pokestops) {
      const p = normalise(s, 'pokestop');
      if (p) pois.push(p);
    }
  }

  if (includeGyms && Array.isArray(data.gyms)) {
    for (const g of data.gyms) {
      const p = normalise(g, 'gym');
      if (p) pois.push(p);
    }
  }

  return pois;
}

// ---------------------------------------------------------------------------
// OSRM — distance matrix (nearest-neighbour TSP seed)
// ---------------------------------------------------------------------------

/**
 * Calls the OSRM Table API to get a walking-distance matrix.
 * Coordinates must be passed as [{lat, lng}] — the function converts to
 * the OSRM-expected lng,lat order.
 *
 * @param {Array<{lat:number,lng:number}>} points  includes start at index 0
 * @returns {Promise<number[][]>}  durations matrix in seconds
 */
async function osrmTable(points) {
  // OSRM expects "lng,lat" pairs joined by ";"
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const osrmUrl = `${OSRM_BASE}/table/v1/foot/${coords}?annotations=duration`;

  console.log(`\nFetching OSRM distance matrix (${points.length} points)…`);
  let result;
  try {
    result = await getJSON(osrmUrl);
  } catch (err) {
    throw new Error(`OSRM table request failed: ${err.message}`);
  }

  if (result.code !== 'Ok') {
    throw new Error(`OSRM table error: ${result.message ?? result.code}`);
  }

  return result.durations; // square matrix
}

// ---------------------------------------------------------------------------
// Nearest-neighbour TSP heuristic
// ---------------------------------------------------------------------------

/**
 * Returns an ordered array of point indices (starting at 0) using the
 * nearest-neighbour heuristic.
 *
 * @param {number[][]} matrix  square duration/distance matrix
 * @returns {number[]}  ordered indices starting from 0
 */
function nearestNeighbour(matrix) {
  const n       = matrix.length;
  const visited = new Array(n).fill(false);
  const order   = [0];
  visited[0]    = true;

  for (let step = 1; step < n; step++) {
    const current = order[order.length - 1];
    let   best    = -1;
    let   bestDist = Infinity;

    for (let j = 0; j < n; j++) {
      if (!visited[j] && matrix[current][j] < bestDist) {
        bestDist = matrix[current][j];
        best     = j;
      }
    }

    if (best === -1) break; // should not happen
    visited[best] = true;
    order.push(best);
  }

  return order;
}

// ---------------------------------------------------------------------------
// OSRM — route (full street-following geometry)
// ---------------------------------------------------------------------------

/**
 * Stitches the full walking route through the ordered waypoints.
 * Returns {distanceM, durationS, geometry} where geometry is a GeoJSON
 * LineString coordinate array [[lng,lat],…].
 *
 * @param {Array<{lat:number,lng:number}>} waypoints  ordered list
 * @returns {Promise<{distanceM:number, durationS:number, geometry:Array}>}
 */
async function osrmRoute(waypoints) {
  const coords   = waypoints.map((p) => `${p.lng},${p.lat}`).join(';');
  const osrmUrl  = `${OSRM_BASE}/route/v1/foot/${coords}?overview=full&geometries=geojson`;

  console.log(`\nFetching full walking route from OSRM…`);
  let result;
  try {
    result = await getJSON(osrmUrl);
  } catch (err) {
    throw new Error(`OSRM route request failed: ${err.message}`);
  }

  if (result.code !== 'Ok' || !result.routes || result.routes.length === 0) {
    throw new Error(`OSRM route error: ${result.message ?? result.code}`);
  }

  const route = result.routes[0];
  return {
    distanceM: route.distance,
    durationS: route.duration,
    geometry:  route.geometry.coordinates, // [[lng,lat],…]
  };
}

// ---------------------------------------------------------------------------
// GPX builder
// ---------------------------------------------------------------------------

/**
 * Builds a GPX XML string for the route.
 *
 * @param {Array<{name:string,lat:number,lng:number,type:string}>} orderedStops
 * @param {Array<[number,number]>} geometry  [[lng,lat],…] street-level track
 * @param {number} distanceM
 * @returns {string}
 */
function buildGPX(orderedStops, geometry, distanceM) {
  const now    = new Date().toISOString();
  const escape = (s) =>
    s.replace(/&/g, '&amp;')
     .replace(/</g, '&lt;')
     .replace(/>/g, '&gt;')
     .replace(/"/g, '&quot;');

  const waypoints = orderedStops
    .map(
      (s) =>
        `  <wpt lat="${s.lat}" lon="${s.lng}">\n` +
        `    <name>${escape(s.name)}</name>\n` +
        `    <type>${escape(s.type)}</type>\n` +
        `  </wpt>`
    )
    .join('\n');

  const trackPoints = geometry
    .map(([lng, lat]) => `    <trkpt lat="${lat}" lon="${lng}"/>`)
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="PogoRoutePlanner"\n` +
    `     xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata>\n` +
    `    <name>Pokémon GO Route</name>\n` +
    `    <time>${now}</time>\n` +
    `    <desc>Total distance: ${(distanceM / 1000).toFixed(2)} km</desc>\n` +
    `  </metadata>\n` +
    `${waypoints}\n` +
    `  <trk>\n` +
    `    <name>Walking Route</name>\n` +
    `    <trkseg>\n` +
    `${trackPoints}\n` +
    `    </trkseg>\n` +
    `  </trk>\n` +
    `</gpx>\n`
  );
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

/**
 * Google Maps URL with up to 9 intermediate waypoints (Maps API limit is 10
 * total including origin and destination).
 */
function googleMapsURL(orderedStops) {
  if (orderedStops.length === 0) return null;
  const first = orderedStops[0];
  const last  = orderedStops[orderedStops.length - 1];
  const mid   = orderedStops.slice(1, -1).slice(0, 8); // max 8 waypoints

  const origin      = `${first.lat},${first.lng}`;
  const destination = `${last.lat},${last.lng}`;
  const waypoints   = mid.map((s) => `${s.lat},${s.lng}`).join('|');

  let u = `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${origin}&destination=${destination}`;
  if (waypoints) u += `&waypoints=${encodeURIComponent(waypoints)}`;
  return u;
}

/**
 * OpenStreetMap URL using the routing engine with waypoints encoded in the
 * fragment so no server-side request is needed.
 */
function openStreetMapURL(orderedStops) {
  if (orderedStops.length === 0) return null;
  // OSM doesn't support waypoints in a single URL the way Google does, so we
  // link to the first and last points with a note about using OSRM.
  const first = orderedStops[0];
  const last  = orderedStops[orderedStops.length - 1];
  return (
    `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot` +
    `&route=${first.lat},${first.lng};${last.lat},${last.lng}`
  );
}

// ---------------------------------------------------------------------------
// CLI prompts
// ---------------------------------------------------------------------------

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function parseArgs() {
  const args = process.argv.slice(2);
  const get  = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const latArg     = get('--lat');
  const lngArg     = get('--lng');
  const radiusArg  = get('--radius');
  const includeArg = get('--include'); // 'stops', 'gyms', 'both'

  if (latArg && lngArg && radiusArg && includeArg) {
    return {
      lat:     parseFloat(latArg),
      lng:     parseFloat(lngArg),
      radius:  parseInt(radiusArg, 10),
      includeStops: includeArg !== 'gyms',
      includeGyms:  includeArg !== 'stops',
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== Pokémon GO Route Planner (Termux) ===\n');

  const latStr    = await prompt(rl, 'Starting latitude  : ');
  const lngStr    = await prompt(rl, 'Starting longitude : ');
  const radStr    = await prompt(rl, 'Walking radius (m) : ');
  const inclStr   = await prompt(rl, 'Include [s]tops / [g]yms / [b]oth? [b]: ');

  rl.close();

  const lat    = parseFloat(latStr);
  const lng    = parseFloat(lngStr);
  const radius = parseInt(radStr, 10);
  const inc    = inclStr.trim().toLowerCase() || 'b';

  if (isNaN(lat) || isNaN(lng)) {
    throw new Error('Invalid latitude or longitude entered.');
  }
  if (isNaN(radius) || radius <= 0) {
    throw new Error('Invalid radius entered.');
  }

  return {
    lat,
    lng,
    radius,
    includeStops: inc === 's' || inc === 'b' || inc === 'both' || inc === 'stops',
    includeGyms:  inc === 'g' || inc === 'b' || inc === 'both' || inc === 'gyms',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Get user inputs
  let opts;
  try {
    opts = await parseArgs();
  } catch (err) {
    console.error(`\nInput error: ${err.message}`);
    process.exit(1);
  }

  const { lat, lng, radius, includeStops, includeGyms } = opts;

  console.log(`\nStarting point : ${lat}, ${lng}`);
  console.log(`Radius         : ${radius} m`);
  console.log(`Include stops  : ${includeStops}`);
  console.log(`Include gyms   : ${includeGyms}`);

  if (!includeStops && !includeGyms) {
    console.error('Nothing to include — select stops and/or gyms.');
    process.exit(1);
  }

  // 2. Fetch data from pogomap.info
  const bbox = boundingBox(lat, lng, radius);
  let allPOIs;
  try {
    allPOIs = await fetchPOIs(bbox, includeStops, includeGyms);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }

  console.log(`\nReceived ${allPOIs.length} POIs from pogomap.info`);

  // 3. Filter to strict radius using Haversine
  const nearby = allPOIs.filter(
    (p) => haversine(lat, lng, p.lat, p.lng) <= radius
  );
  console.log(`After radius filter: ${nearby.length} POIs within ${radius} m`);

  if (nearby.length === 0) {
    console.log('\nNo POIs found within the specified radius. Try increasing the radius or moving the starting point.');
    process.exit(0);
  }

  // 4. Build waypoint list: start point + all nearby POIs
  const startPoint = { lat, lng, name: 'Start', type: 'start' };
  const allPoints  = [startPoint, ...nearby]; // index 0 = start

  // 5. Compute distance matrix and nearest-neighbour TSP order
  let order;
  if (allPoints.length <= 2) {
    // Nothing to optimise with only one stop
    order = allPoints.map((_, i) => i);
  } else {
    let matrix;
    try {
      matrix = await osrmTable(allPoints);
    } catch (err) {
      console.warn(`\nWarning: OSRM table failed (${err.message}). Falling back to Haversine ordering.`);
      // Build a simple Haversine-based matrix as fallback
      matrix = allPoints.map((a) =>
        allPoints.map((b) => haversine(a.lat, a.lng, b.lat, b.lng))
      );
    }
    order = nearestNeighbour(matrix);
  }

  const orderedStops = order.map((i) => allPoints[i]);

  // 6. Stitch full route via OSRM
  let routeInfo;
  try {
    routeInfo = await osrmRoute(orderedStops);
  } catch (err) {
    console.warn(`\nWarning: OSRM route failed (${err.message}). GPX will contain waypoints only (no track).`);
    routeInfo = { distanceM: 0, durationS: 0, geometry: [] };
  }

  const distKm  = (routeInfo.distanceM / 1000).toFixed(2);
  const durMin  = Math.round(routeInfo.durationS / 60);

  // 7. Print terminal summary
  console.log('\n========================================');
  console.log(' Route Summary');
  console.log('========================================');
  console.log(`Total distance : ${distKm} km`);
  console.log(`Est. walk time : ${durMin} min`);
  console.log(`Stops visited  : ${nearby.length}`);
  console.log('\nOrdered waypoints:');
  orderedStops.forEach((s, i) => {
    const tag = s.type === 'gym' ? '[GYM]' : s.type === 'start' ? '[START]' : '[STOP]';
    console.log(`  ${String(i).padStart(2)}. ${tag} ${s.name}`);
  });

  // 8. Save GPX file
  const gpxPath = 'route.gpx';
  const gpxContent = buildGPX(
    orderedStops.filter((s) => s.type !== 'start'),
    routeInfo.geometry,
    routeInfo.distanceM
  );
  try {
    fs.writeFileSync(gpxPath, gpxContent, 'utf8');
    console.log(`\nGPX saved to: ${gpxPath}`);
  } catch (err) {
    console.error(`\nFailed to write GPX file: ${err.message}`);
  }

  // 9. Output URLs
  const googleUrl = googleMapsURL(orderedStops);
  const osmUrl    = openStreetMapURL(orderedStops);

  console.log('\n--- Open in browser ---');
  if (googleUrl) console.log(`Google Maps : ${googleUrl}`);
  if (osmUrl)    console.log(`OpenStreetMap : ${osmUrl}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\nFatal error: ${err.message}`);
  process.exit(1);
});
