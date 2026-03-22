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
 *   node route-planner.js --lat -27.467955 --lng 153.027856 --radius 2000 --include both
 *
 * No login is required — pogomap.info shows PokéStops and Gyms to all visitors.
 * A session cookie is obtained automatically on first use.
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
const ENDPOINT = 'https://www.pogomap.info/includes/it150nmsq9.php';

/** pogomap.info homepage — used to obtain a session cookie automatically */
const POGO_HOME = 'https://www.pogomap.info/';

/** OSRM public demo server — foot profile */
const OSRM_BASE = 'https://router.project-osrm.org';

/** Earth radius in metres (WGS84 mean) */
const EARTH_RADIUS_M = 6_371_000;

// ---------------------------------------------------------------------------
// pogomap.info coordinate-decode constants
// (reverse-engineered from mapsys648.js — see docs/pogomap-api.md)
// These values are literal constants embedded in the site's client JS:
//   en = 10.62/12  and  tn = 1.5935  are divisors applied before the ID mult.
//   H = 1.91  and  Q = 1.952  are scale factors for lat and lng respectively.
//   jqueryscrollzoom = 1.852  is a page-level zoom constant.
// ---------------------------------------------------------------------------

const POGO_EN  = 10.62 / 12;  // lat raw-value divisor  (from: en=10.62/12 in mapsys648.js)
const POGO_TN  = 1.5935;      // lng raw-value divisor  (from: tn=1.5935 in mapsys648.js)
const POGO_H   = 1.91;        // lat scale factor       (from: H=1.91 in mapsys648.js)
const POGO_Q   = 1.952;       // lng scale factor       (from: Q=1.952 in mapsys648.js)
const POGO_JSZ = 1.852;       // jqueryscrollzoom       (from: jqueryscrollzoom=1.852 in mapsys648.js)

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
    fromlat: lat - latDelta,
    fromlng: lng - lngDelta,
    tolat:   lat + latDelta,
    tolng:   lng + lngDelta,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
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

/**
 * Performs a POST request with an application/x-www-form-urlencoded body and
 * resolves with the parsed JSON body.
 * @param {string} rawUrl
 * @param {string} postBody  URL-encoded POST body
 * @param {object} [headers]
 * @returns {Promise<any>}
 */
function postJSON(rawUrl, postBody, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(rawUrl);
    const module_ = parsed.protocol === 'https:' ? https : http;
    const buf     = Buffer.from(postBody, 'utf8');
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.path,
      method:   'POST',
      headers:  {
        'User-Agent':    'PogoRoutePlanner/1.0 (Termux/NodeJS)',
        Referer:         'https://www.pogomap.info/',
        Accept:          'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type':  'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': buf.length,
        ...headers,
      },
    };

    const req = module_.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} from ${rawUrl}`));
        }
        const body = Buffer.concat(chunks).toString('utf8');
        if (body.trimStart().startsWith('<!')) {
          return reject(new Error(
            `pogomap.info returned HTML instead of JSON. ` +
            `Try again in a moment — the session may have expired.`
          ));
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
    req.write(buf);
    req.end();
  });
}

/**
 * Visits the pogomap.info homepage and returns the PHPSESSID cookie value.
 * No login is required — the site issues a session to any visitor.
 * @returns {Promise<string>}  Cookie header value, e.g. "PHPSESSID=abc123"
 */
function getSession() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.pogomap.info',
      path:     '/',
      method:   'GET',
      headers:  {
        'User-Agent': 'PogoRoutePlanner/1.0 (Termux/NodeJS)',
        Accept:       'text/html',
      },
    };

    const req = https.request(options, (res) => {
      // Drain the body so the socket is freed
      res.resume();
      res.on('end', () => {
        const setCookies = res.headers['set-cookie'] || [];
        const phpsessid  = setCookies
          .map((c) => c.split(';')[0])
          .find((c) => c.startsWith('PHPSESSID='));

        if (phpsessid) {
          resolve(phpsessid);
        } else {
          // Session may not have been set by the homepage (e.g. server reused an
          // existing session for this IP) — proceed anyway since the POST will
          // still work with whatever session state the server maintains.
          resolve('');
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Session request timed out')));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// pogomap.info coordinate decoder
// ---------------------------------------------------------------------------

/**
 * Decodes one raw item from the it150nmsq9.php response into a normalised POI.
 * The server obfuscates coordinates with base-64 encoding and a fixed arithmetic
 * transform.  See docs/pogomap-api.md for the derivation.
 *
 * @param {string} id    The JSON key (numeric POI id as string)
 * @param {object} item  Raw response object for that id
 * @returns {{id,name,lat,lng,type}|null}
 */
function decodePOI(id, item) {
  try {
    const pid  = parseFloat(Buffer.from(item.zfgs62,  'base64').toString('utf8'));
    const z    = parseFloat(Buffer.from(item.z3iafj,  'base64').toString('utf8'));
    const f    = parseFloat(Buffer.from(item.f24sfvs, 'base64').toString('utf8'));
    const type = Buffer.from(item.xgxg35, 'base64').toString('utf8').trim();
    const name = item.rfs21d || `POI_${id}`;

    if (!isFinite(pid) || !isFinite(z) || !isFinite(f)) return null;

    const lat = (z / POGO_EN) * POGO_H * pid / POGO_JSZ / 1e6;
    const lng = (f / POGO_TN) * POGO_Q * pid / POGO_JSZ / 1e6;

    return {
      id:   String(id),
      name,
      lat,
      lng,
      type: type === '2' ? 'gym' : 'pokestop',
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// pogomap.info data fetch
// ---------------------------------------------------------------------------

/**
 * Fetches PokéStop and/or Gym data from pogomap.info for the given bbox.
 * A session cookie is acquired automatically if none is provided.
 *
 * @param {object}      bbox            {fromlat, fromlng, tolat, tolng}
 * @param {boolean}     includePokestops
 * @param {boolean}     includeGyms
 * @param {string|null} cookie          Optional PHPSESSID override
 * @returns {Promise<Array<{id,name,lat,lng,type}>>}
 */
async function fetchPOIs(bbox, includePokestops, includeGyms, cookie = null) {
  // Obtain a session cookie if none was supplied
  if (!cookie) {
    console.log('\nObtaining session from pogomap.info…');
    try {
      cookie = await getSession();
    } catch (err) {
      console.warn(`  Warning: could not obtain session cookie (${err.message}). Proceeding anyway.`);
    }
  }

  const postBody = new URLSearchParams({
    fromlat:    bbox.fromlat.toFixed(7),
    tolat:      bbox.tolat.toFixed(7),
    fromlng:    bbox.fromlng.toFixed(7),
    tolng:      bbox.tolng.toFixed(7),
    fpoke:      '1',
    fgym:       '1',
    farm:       '0',
    fpstop:     '1',
    nests:      '1',
    priv:       '0',
    raids:      '1',
    sponsor:    '0',
    usermarks:  '0',
    ftasks:     '1',
    viewdel:    '0',
    voteonly:   '0',
    modonly:    '0',
    agedonly:   '0',
    modnone:    '0',
    showonly:   '0',
    routesonly: '0',
  }).toString();

  console.log(`\nFetching data from pogomap.info…`);

  const extraHeaders = cookie ? { Cookie: cookie } : {};

  let data;
  try {
    data = await postJSON(ENDPOINT, postBody, extraHeaders);
  } catch (err) {
    throw err;
  }

  // API returns {"spam":1} when rate-limited or session is invalid
  if (data && data.spam) {
    throw new Error(
      `pogomap.info returned a rate-limit/spam response. ` +
      `Please wait a moment and try again.`
    );
  }

  const pois = [];

  for (const [id, item] of Object.entries(data)) {
    const poi = decodePOI(id, item);
    if (!poi) continue;
    if (!includePokestops && poi.type === 'pokestop') continue;
    if (!includeGyms      && poi.type === 'gym')      continue;
    pois.push(poi);
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
      lat:          parseFloat(latArg),
      lng:          parseFloat(lngArg),
      radius:       parseInt(radiusArg, 10),
      includeStops: includeArg !== 'gyms',
      includeGyms:  includeArg !== 'stops',
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== Pokémon GO Route Planner (Termux) ===\n');

  const latStr  = await prompt(rl, 'Starting latitude  : ');
  const lngStr  = await prompt(rl, 'Starting longitude : ');
  const radStr  = await prompt(rl, 'Walking radius (m) : ');
  const inclStr = await prompt(rl, 'Include [s]tops / [g]yms / [b]oth? [b]: ');

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
