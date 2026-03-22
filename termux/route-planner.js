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
 *   node route-planner.js --address "Brisbane CBD" --radius 1500 --include stops --max-distance 5
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

/** Assumed walking speed: 4.5 km/h expressed as metres per minute */
const WALKING_SPEED_MPM = 4500 / 60;

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
    const parsed   = new URL(rawUrl);
    const module_  = parsed.protocol === 'https:' ? https : http;
    const options  = {
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.pathname + parsed.search,
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
    const parsed  = new URL(rawUrl);
    const module_ = parsed.protocol === 'https:' ? https : http;
    const buf     = Buffer.from(postBody, 'utf8');
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.pathname + parsed.search,
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
// OSRM — distance matrix (cluster-aware routing seed)
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
// Nearest-neighbour TSP heuristic (v1 — kept for comparison mode)
// ---------------------------------------------------------------------------

/**
 * Returns an ordered array of point indices (starting at 0) using the
 * classic nearest-neighbour greedy heuristic.  Retained so that
 * `--compare` mode can show v1 vs v2 side-by-side on the same data.
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
    const current  = order[order.length - 1];
    let   best     = -1;
    let   bestDist = Infinity;

    for (let j = 0; j < n; j++) {
      if (!visited[j] && matrix[current][j] < bestDist) {
        bestDist = matrix[current][j];
        best     = j;
      }
    }

    if (best === -1) break;
    visited[best] = true;
    order.push(best);
  }

  return order;
}

// ---------------------------------------------------------------------------
// Cluster-aware density-biased routing heuristic
// ---------------------------------------------------------------------------

/**
 * Counts unvisited POI neighbours within `radius` units of point `idx`.
 *
 * @param {number[][]} matrix   square duration/distance matrix
 * @param {number}     idx      candidate point index
 * @param {boolean[]}  visited  visited flags (index 0 = start point)
 * @param {number}     radius   distance threshold (same units as matrix)
 * @returns {number}  count of nearby unvisited POIs
 */
function localDensity(matrix, idx, visited, radius) {
  const n = matrix.length;
  let count = 0;
  for (let j = 1; j < n; j++) { // skip index 0 (start)
    if (!visited[j] && j !== idx && matrix[idx][j] <= radius) {
      count++;
    }
  }
  return count;
}

/**
 * Returns an ordered array of point indices (starting at 0) using a
 * cluster-aware, density-biased greedy heuristic.
 *
 * Each candidate POI is scored by  (density + 1) / distance  where
 * density is the number of still-unvisited POIs within `densityRadius`
 * of that candidate.  This causes the algorithm to prefer visiting dense
 * clusters first, maximising the number of POIs reachable within a
 * fixed walk-distance budget rather than just chaining the globally
 * nearest neighbour at each step.
 *
 * @param {number[][]} matrix          square duration/distance matrix
 * @param {number}     [densityRadius] neighbourhood radius for density
 *                                     scoring; defaults to the lower
 *                                     quartile of all pairwise distances
 * @returns {number[]}  ordered indices starting from 0
 */
function clusterAwareRoute(matrix, densityRadius) {
  const n = matrix.length;

  // Auto-compute density radius from the lower quartile of all pairwise
  // distances so the neighbourhood adapts to the actual POI spread.
  if (densityRadius == null) {
    const dists = [];
    for (let i = 1; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = matrix[i][j];
        if (isFinite(d) && d > 0) dists.push(d);
      }
    }
    dists.sort((a, b) => a - b);
    densityRadius = dists.length > 0
      ? dists[Math.floor(dists.length / 4)]
      : Infinity;
  }

  const visited = new Array(n).fill(false);
  const order   = [0];
  visited[0]    = true;

  for (let step = 1; step < n; step++) {
    const current   = order[order.length - 1];
    let   best      = -1;
    let   bestScore = -Infinity;

    for (let j = 1; j < n; j++) { // skip index 0 (start)
      if (visited[j]) continue;
      const dist = matrix[current][j];
      if (!isFinite(dist) || dist <= 0) continue;

      // Score: prefer POIs that are (a) close and (b) surrounded by
      // many other unvisited POIs within the density neighbourhood.
      const density = localDensity(matrix, j, visited, densityRadius);
      const score   = (density + 1) / dist;
      if (score > bestScore) {
        bestScore = score;
        best      = j;
      }
    }

    if (best === -1) break;
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
// Address geocoding (Nominatim / OpenStreetMap — no API key required)
// ---------------------------------------------------------------------------

/**
 * Resolves a free-form address string to {lat, lng} using the Nominatim API.
 * Nominatim usage policy: max 1 req/s, valid User-Agent required.
 *
 * @param {string} address
 * @returns {Promise<{lat:number, lng:number}>}
 */
async function geocodeAddress(address) {
  const nominatimUrl =
    `https://nominatim.openstreetmap.org/search` +
    `?q=${encodeURIComponent(address)}&format=json&limit=1&addressdetails=1`;

  console.log(`\nGeocoding address: "${address}"…`);
  let results;
  try {
    results = await getJSON(nominatimUrl, { 'Accept-Language': 'en' });
  } catch (err) {
    throw new Error(`Geocoding failed: ${err.message}`);
  }
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`No location found for "${address}". Try a more specific address.`);
  }
  const { lat, lon, display_name, address: addr } = results[0];
  console.log(`  → ${display_name}`);
  return {
    lat:    parseFloat(lat),
    lng:    parseFloat(lon),
    suburb: extractSuburb(addr),
  };
}

/**
 * Reverse-geocodes a coordinate pair to obtain the suburb name.
 * Returns null if the request fails or no suburb can be determined.
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<string|null>}
 */
async function reverseGeocode(lat, lng) {
  const url =
    `https://nominatim.openstreetmap.org/reverse` +
    `?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
  try {
    const result = await getJSON(url, { 'Accept-Language': 'en' });
    return extractSuburb(result.address);
  } catch (_) {
    return null;
  }
}

/**
 * Extracts the most specific locality name from a Nominatim address object.
 * @param {object|undefined} addr  Nominatim address component object
 * @returns {string|null}
 */
function extractSuburb(addr) {
  if (!addr) return null;
  return (
    addr.suburb        ||
    addr.neighbourhood ||
    addr.city_district ||
    addr.quarter       ||
    addr.town          ||
    addr.village       ||
    addr.city          ||
    addr.county        ||
    null
  );
}

/**
 * Builds a descriptive GPX filename from route metadata.
 * Special characters that are unsafe in filenames are replaced with hyphens.
 * @param {string|null} suburb
 * @param {string}      distKm   e.g. "8.50"
 * @param {number}      stopCount
 * @returns {string}  e.g. "West End Route 8.50km 42 stops.gpx"
 */
function makeGpxFilename(suburb, distKm, stopCount) {
  const safe = (s) => s.replace(/[/\\?%*:|"<>]/g, '-').trim();
  const prefix = suburb ? safe(suburb) : 'Route';
  return `${prefix} Route ${distKm}km ${stopCount} stops.gpx`;
}

/**
 * Returns a filename that does not collide with any existing file.
 * If `name` already exists, appends " (2)", " (3)", … before the extension.
 * @param {string} name  Desired filename (may include path components)
 * @returns {string}
 */
function uniqueFilename(name) {
  if (!fs.existsSync(name)) return name;
  const lastDot = name.lastIndexOf('.');
  const base    = lastDot !== -1 ? name.slice(0, lastDot) : name;
  const ext     = lastDot !== -1 ? name.slice(lastDot)    : '';
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Route truncation by maximum distance
// ---------------------------------------------------------------------------

/**
 * Truncates an ordered list of points so that the estimated walking distance
 * stays within maxDistM.  Uses Haversine with a 1.4× urban-path detour factor
 * as a conservative estimate of actual walking distance.
 *
 * @param {Array<{lat:number,lng:number}>} orderedPoints  includes start at index 0
 * @param {number} maxDistM  maximum distance in metres (0 = no limit)
 * @returns {Array<{lat:number,lng:number}>}
 */
function truncateByMaxDistance(orderedPoints, maxDistM) {
  if (maxDistM <= 0 || orderedPoints.length <= 2) return orderedPoints;
  const result = [orderedPoints[0]];
  let cumDist = 0;
  for (let i = 1; i < orderedPoints.length; i++) {
    const prev   = orderedPoints[i - 1];
    const curr   = orderedPoints[i];
    const segEst = haversine(prev.lat, prev.lng, curr.lat, curr.lng) * 1.4;
    if (cumDist + segEst > maxDistM) break;
    result.push(curr);
    cumDist += segEst;
  }
  return result;
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

  const latArg        = get('--lat');
  const lngArg        = get('--lng');
  const addressArg    = get('--address');
  const radiusArg     = get('--radius');
  const includeArg    = get('--include'); // 'stops', 'gyms', 'both'
  const maxDistArg    = get('--max-distance');
  const compareFlag   = args.includes('--compare');
  const exportArg     = get('--export');  // 'v1' or 'v2' (used with --compare)

  if ((latArg || addressArg) && radiusArg && includeArg) {
    return {
      lat:           latArg ? parseFloat(latArg) : null,
      lng:           lngArg ? parseFloat(lngArg) : null,
      address:       addressArg || null,
      radius:        parseInt(radiusArg, 10),
      includeStops:  includeArg !== 'gyms',
      includeGyms:   includeArg !== 'stops',
      maxDistKm:     maxDistArg ? parseFloat(maxDistArg) : 0,
      compare:       compareFlag,
      exportVersion: exportArg === 'v1' ? 'v1' : exportArg === 'v2' ? 'v2' : null,
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== Pokémon GO Route Planner (Termux) ===\n');

  const addressStr = await prompt(rl, 'Starting address (leave blank to enter lat/lng) : ');
  let latStr = '';
  let lngStr = '';
  if (!addressStr.trim()) {
    latStr = await prompt(rl, 'Starting latitude  : ');
    lngStr = await prompt(rl, 'Starting longitude : ');
  }
  const radStr     = await prompt(rl, 'Walking radius (m) : ');
  const maxDistStr = await prompt(rl, 'Max route distance in km (0 = no limit) [0] : ');
  const inclStr    = await prompt(rl, 'Include [s]tops / [g]yms / [b]oth? [b]: ');
  const cmpStr     = await prompt(rl, 'Compare v1 (nearest-neighbour) vs v2 (cluster-aware)? [y/N]: ');

  rl.close();

  const radius   = parseInt(radStr, 10);
  const maxDistKm = parseFloat(maxDistStr) || 0;
  const inc      = inclStr.trim().toLowerCase() || 'b';
  const compare  = cmpStr.trim().toLowerCase() === 'y';

  if (isNaN(radius) || radius <= 0) {
    throw new Error('Invalid radius entered.');
  }
  if (maxDistKm < 0) {
    throw new Error('Max route distance must be 0 (no limit) or a positive number.');
  }

  if (addressStr.trim()) {
    return {
      lat:           null,
      lng:           null,
      address:       addressStr.trim(),
      radius,
      includeStops:  inc === 's' || inc === 'b' || inc === 'both' || inc === 'stops',
      includeGyms:   inc === 'g' || inc === 'b' || inc === 'both' || inc === 'gyms',
      maxDistKm,
      compare,
      exportVersion: null,
    };
  }

  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);
  if (isNaN(lat) || isNaN(lng)) {
    throw new Error('Invalid latitude or longitude entered.');
  }

  return {
    lat,
    lng,
    address:       null,
    radius,
    includeStops:  inc === 's' || inc === 'b' || inc === 'both' || inc === 'stops',
    includeGyms:   inc === 'g' || inc === 'b' || inc === 'both' || inc === 'gyms',
    maxDistKm,
    compare,
    exportVersion: null,
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

  let { lat, lng, address, radius, includeStops, includeGyms, maxDistKm, compare, exportVersion } = opts;

  // 2. Geocode address if provided instead of lat/lng; capture suburb for filename
  let suburb = null;
  if (address) {
    try {
      const coords = await geocodeAddress(address);
      lat    = coords.lat;
      lng    = coords.lng;
      suburb = coords.suburb;
    } catch (err) {
      console.error(`\nGeocoding error: ${err.message}`);
      process.exit(1);
    }
  } else {
    // Reverse-geocode lat/lng to get a suburb label (best-effort; non-fatal)
    suburb = await reverseGeocode(lat, lng);
  }

  console.log(`\nStarting point : ${lat}, ${lng}${address ? ` (${address})` : ''}`);
  console.log(`Radius         : ${radius} m`);
  console.log(`Max distance   : ${maxDistKm > 0 ? `${maxDistKm} km` : 'no limit'}`);
  console.log(`Include stops  : ${includeStops}`);
  console.log(`Include gyms   : ${includeGyms}`);
  if (compare) console.log('Mode           : algorithm comparison (v1 vs v2)');

  if (!includeStops && !includeGyms) {
    console.error('Nothing to include — select stops and/or gyms.');
    process.exit(1);
  }

  // 3. Fetch data from pogomap.info
  const bbox = boundingBox(lat, lng, radius);
  let allPOIs;
  try {
    allPOIs = await fetchPOIs(bbox, includeStops, includeGyms);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }

  console.log(`\nReceived ${allPOIs.length} POIs from pogomap.info`);

  // 4. Filter to strict radius using Haversine
  const nearby = allPOIs.filter(
    (p) => haversine(lat, lng, p.lat, p.lng) <= radius
  );
  console.log(`After radius filter: ${nearby.length} POIs within ${radius} m`);

  if (nearby.length === 0) {
    console.log('\nNo POIs found within the specified radius. Try increasing the radius or moving the starting point.');
    process.exit(0);
  }

  // 5. Build waypoint list: start point + all nearby POIs
  const startPoint = { lat, lng, name: 'Start', type: 'start' };
  const allPoints  = [startPoint, ...nearby]; // index 0 = start

  // 6. Compute distance matrix
  let matrix;
  if (allPoints.length <= 2) {
    // Nothing to optimise with only one stop — identity matrix isn't needed
    matrix = null;
  } else {
    try {
      matrix = await osrmTable(allPoints);
    } catch (err) {
      console.warn(`\nWarning: OSRM table failed (${err.message}). Falling back to Haversine ordering.`);
      // Build a simple Haversine-based matrix as fallback
      matrix = allPoints.map((a) =>
        allPoints.map((b) => haversine(a.lat, a.lng, b.lat, b.lng))
      );
    }
  }

  const maxDistM = maxDistKm * 1000;

  // -------------------------------------------------------------------------
  // Compare mode: run both algorithms and print a side-by-side summary
  // -------------------------------------------------------------------------
  if (compare) {
    const orderV1 = matrix ? nearestNeighbour(matrix) : allPoints.map((_, i) => i);
    const orderV2 = matrix ? clusterAwareRoute(matrix) : allPoints.map((_, i) => i);

    let stopsV1 = orderV1.map((i) => allPoints[i]);
    let stopsV2 = orderV2.map((i) => allPoints[i]);

    if (maxDistM > 0) {
      stopsV1 = truncateByMaxDistance(stopsV1, maxDistM);
      stopsV2 = truncateByMaxDistance(stopsV2, maxDistM);
    }

    const poisV1 = stopsV1.filter((s) => s.type !== 'start');
    const poisV2 = stopsV2.filter((s) => s.type !== 'start');

    const namesV1 = new Set(poisV1.map((s) => s.name));
    const namesV2 = new Set(poisV2.map((s) => s.name));

    const onlyInV1 = poisV1.filter((s) => !namesV2.has(s.name));
    const onlyInV2 = poisV2.filter((s) => !namesV1.has(s.name));

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log(' Algorithm Comparison');
    console.log('╚══════════════════════════════════════════════════════════════╝');

    console.log('\n┌─ v1: Nearest-Neighbour (previous) ──────────────────────────');
    console.log(`│  Stops visited : ${poisV1.length}`);
    console.log('│  Ordered waypoints:');
    stopsV1.forEach((s, i) => {
      const tag = s.type === 'gym' ? '[GYM]' : s.type === 'start' ? '[START]' : '[STOP]';
      console.log(`│    ${String(i).padStart(2)}. ${tag} ${s.name}`);
    });

    console.log('\n├─ v2: Cluster-Aware (this version) ──────────────────────────');
    console.log(`│  Stops visited : ${poisV2.length}`);
    console.log('│  Ordered waypoints:');
    stopsV2.forEach((s, i) => {
      const tag = s.type === 'gym' ? '[GYM]' : s.type === 'start' ? '[START]' : '[STOP]';
      console.log(`│    ${String(i).padStart(2)}. ${tag} ${s.name}`);
    });

    console.log('\n├─ Difference ────────────────────────────────────────────────');
    const delta = poisV2.length - poisV1.length;
    if (delta > 0) {
      console.log(`│  v2 covers ${delta} more stop(s) within the walk budget.`);
    } else if (delta < 0) {
      console.log(`│  v1 covers ${-delta} more stop(s) within the walk budget.`);
    } else {
      console.log('│  Both versions cover the same number of stops.');
    }
    if (onlyInV1.length > 0) {
      console.log('│  Only in v1 (nearest-neighbour):');
      onlyInV1.forEach((s) => console.log(`│    - ${s.name}`));
    }
    if (onlyInV2.length > 0) {
      console.log('│  Only in v2 (cluster-aware):');
      onlyInV2.forEach((s) => console.log(`│    - ${s.name}`));
    }
    console.log('└─────────────────────────────────────────────────────────────');
    console.log('');

    // ── Export: determine which version the user wants ───────────────────────
    // Non-interactive: honour --export v1/v2 flag.
    // Interactive (stdin is a TTY): prompt the user.
    let chosenStops = null;
    let chosenLabel = '';

    if (exportVersion === 'v1') {
      chosenStops = stopsV1;
      chosenLabel = 'v1';
    } else if (exportVersion === 'v2') {
      chosenStops = stopsV2;
      chosenLabel = 'v2';
    } else if (process.stdin.isTTY) {
      const rlExport = readline.createInterface({ input: process.stdin, output: process.stdout });
      const choice   = await prompt(rlExport, 'Export GPX? [1=v1, 2=v2, n=skip] : ');
      rlExport.close();
      if (choice.trim() === '1') { chosenStops = stopsV1; chosenLabel = 'v1'; }
      else if (choice.trim() === '2') { chosenStops = stopsV2; chosenLabel = 'v2'; }
    }

    if (chosenStops) {
      const chosenPOIs = chosenStops.filter((s) => s.type !== 'start');
      let routeInfo;
      try {
        routeInfo = await osrmRoute(chosenStops);
      } catch (err) {
        console.warn(`\nWarning: OSRM route failed (${err.message}). GPX will contain waypoints only.`);
        routeInfo = { distanceM: 0, durationS: 0, geometry: [] };
      }
      const distKm     = (routeInfo.distanceM / 1000).toFixed(2);
      const gpxContent = buildGPX(chosenPOIs, routeInfo.geometry, routeInfo.distanceM);
      const gpxPath    = uniqueFilename(makeGpxFilename(suburb, distKm, chosenPOIs.length));
      try {
        fs.writeFileSync(gpxPath, gpxContent, 'utf8');
        console.log(`GPX (${chosenLabel}) saved to: ${gpxPath}`);
      } catch (err) {
        console.error(`\nFailed to write GPX file: ${err.message}`);
      }
    }

    return;
  }

  // -------------------------------------------------------------------------
  // Normal (non-compare) mode
  // -------------------------------------------------------------------------

  // 7. Apply cluster-aware route order
  let order;
  if (matrix === null) {
    order = allPoints.map((_, i) => i);
  } else {
    order = clusterAwareRoute(matrix);
  }

  let orderedStops = order.map((i) => allPoints[i]);

  // 8. Apply max-distance constraint (truncate route if needed)
  if (maxDistM > 0) {
    orderedStops = truncateByMaxDistance(orderedStops, maxDistM);
    // nearby.length = POI count before truncation; orderedStops includes start,
    // so subtract 1 to get the POI count after truncation.
    const omitted = nearby.length - (orderedStops.length - 1);
    if (omitted > 0) {
      console.log(`\nMax distance limit applied: ${omitted} stop(s) omitted to stay within ${maxDistKm} km.`);
    }
  }

  // 9. Stitch full route via OSRM
  let routeInfo;
  try {
    routeInfo = await osrmRoute(orderedStops);
  } catch (err) {
    console.warn(`\nWarning: OSRM route failed (${err.message}). GPX will contain waypoints only (no track).`);
    routeInfo = { distanceM: 0, durationS: 0, geometry: [] };
  }

  const distKm  = (routeInfo.distanceM / 1000).toFixed(2);
  const durMin  = Math.round(routeInfo.distanceM / WALKING_SPEED_MPM);

  const orderedPOIs = orderedStops.filter((s) => s.type !== 'start');

  // 10. Print terminal summary
  console.log('\n========================================');
  console.log(' Route Summary');
  console.log('========================================');
  console.log(`Total distance : ${distKm} km`);
  console.log(`Est. walk time : ${durMin} min`);
  console.log(`Stops visited  : ${orderedPOIs.length}`);
  console.log('\nOrdered waypoints:');
  orderedStops.forEach((s, i) => {
    const tag = s.type === 'gym' ? '[GYM]' : s.type === 'start' ? '[START]' : '[STOP]';
    console.log(`  ${String(i).padStart(2)}. ${tag} ${s.name}`);
  });

  // 11. Save GPX file
  const gpxPath = uniqueFilename(makeGpxFilename(suburb, distKm, orderedPOIs.length));
  const gpxContent = buildGPX(
    orderedPOIs,
    routeInfo.geometry,
    routeInfo.distanceM
  );
  try {
    fs.writeFileSync(gpxPath, gpxContent, 'utf8');
    console.log(`\nGPX saved to: ${gpxPath}`);
  } catch (err) {
    console.error(`\nFailed to write GPX file: ${err.message}`);
  }

  // 12. Output URLs
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
