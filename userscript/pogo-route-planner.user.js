// ==UserScript==
// @name         Pogo Route Planner
// @namespace    https://github.com/dakomi/pogo-route-planner
// @version      1.1.0
// @description  Plan optimised walking routes for Pokémon GO from pogomap.info
// @author       dakomi
// @match        https://www.pogomap.info/*
// @grant        GM_xmlhttpRequest
// @connect      router.project-osrm.org
// @connect      www.pogomap.info
// @connect      nominatim.openstreetmap.org
// ==/UserScript==

/* global GM_xmlhttpRequest */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  /** pogomap.info data endpoint — update if the site changes it */
  const POGO_ENDPOINT = 'https://www.pogomap.info/includes/it150nmsq9.php';

  /** OSRM public demo server — foot profile */
  const OSRM_BASE = 'https://router.project-osrm.org';

  /** Earth radius in metres */
  const EARTH_RADIUS_M = 6_371_000;

  // Coordinate-decode constants (reverse-engineered from mapsys648.js)
  // See docs/pogomap-api.md §4 for the full formula and derivation.
  //   POGO_EN  = en   (10.62/12) — lat raw-value divisor
  //   POGO_TN  = tn   (1.5935)   — lng raw-value divisor
  //   POGO_H   = H    (1.91)     — lat scale factor
  //   POGO_Q   = Q    (1.952)    — lng scale factor
  //   POGO_JSZ = jqueryscrollzoom (1.852) — page-level zoom constant
  const POGO_EN  = 10.62 / 12;
  const POGO_TN  = 1.5935;
  const POGO_H   = 1.91;
  const POGO_Q   = 1.952;
  const POGO_JSZ = 1.852;

  // -------------------------------------------------------------------------
  // Haversine distance (no library)
  // -------------------------------------------------------------------------

  function haversine(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat  = toRad(lat2 - lat1);
    const dLng  = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
  }

  // -------------------------------------------------------------------------
  // Bounding box
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // GM_xmlhttpRequest wrappers returning Promises
  // -------------------------------------------------------------------------

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'GET',
        url,
        headers: {
          'User-Agent': 'PogoRoutePlanner/1.0 (Userscript)',
          Referer:      'https://www.pogomap.info/',
          Accept:       'application/json',
        },
        timeout: 30000,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            return reject(new Error(`HTTP ${response.status} from ${url}`));
          }
          try {
            resolve(JSON.parse(response.responseText));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        },
        onerror()   { reject(new Error(`Network error fetching ${url}`)); },
        ontimeout() { reject(new Error(`Timeout fetching ${url}`));        },
      });
    });
  }

  function gmPost(url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'POST',
        url,
        headers: {
          'User-Agent':       'PogoRoutePlanner/1.0 (Userscript)',
          Referer:            'https://www.pogomap.info/',
          Accept:             'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
        },
        data:    body,
        timeout: 30000,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            return reject(new Error(`HTTP ${response.status} from ${url}`));
          }
          if (response.responseText.trimStart().startsWith('<!')) {
            return reject(new Error(
              'pogomap.info returned HTML instead of JSON. ' +
              'Please wait a moment and try again.'
            ));
          }
          try {
            resolve(JSON.parse(response.responseText));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        },
        onerror()   { reject(new Error(`Network error posting to ${url}`)); },
        ontimeout() { reject(new Error(`Timeout posting to ${url}`));        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // pogomap.info coordinate decoder
  // -------------------------------------------------------------------------

  /**
   * Decodes one raw item from the it150nmsq9.php response into a normalised POI.
   * @param {string} id    The JSON key (numeric POI id as string)
   * @param {object} item  Raw response object for that id
   * @returns {{id,name,lat,lng,type}|null}
   */
  function decodePOI(id, item) {
    try {
      const pid  = parseFloat(atob(item.zfgs62));
      const z    = parseFloat(atob(item.z3iafj));
      const f    = parseFloat(atob(item.f24sfvs));
      const type = atob(item.xgxg35).trim();
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

  // -------------------------------------------------------------------------
  // Fetch POIs from pogomap.info (via GM_xmlhttpRequest POST)
  // -------------------------------------------------------------------------

  async function fetchPOIs(bbox, includeStops, includeGyms) {
    const body = new URLSearchParams({
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

    let data;
    try {
      data = await gmPost(POGO_ENDPOINT, body);
    } catch (err) {
      throw new Error(
        `Failed to fetch data from pogomap.info: ${err.message}\n` +
        `If the endpoint has changed, update POGO_ENDPOINT in the userscript and\n` +
        `consult docs/pogomap-api.md in the repository.`
      );
    }

    if (data && data.spam) {
      throw new Error(
        'pogomap.info returned a rate-limit response. Please wait a moment and try again.'
      );
    }

    const pois = [];
    for (const [id, item] of Object.entries(data)) {
      const poi = decodePOI(id, item);
      if (!poi) continue;
      if (!includeStops && poi.type === 'pokestop') continue;
      if (!includeGyms  && poi.type === 'gym')      continue;
      pois.push(poi);
    }
    return pois;
  }

  // -------------------------------------------------------------------------
  // OSRM helpers
  // -------------------------------------------------------------------------

  async function osrmTable(points) {
    const coords  = points.map((p) => `${p.lng},${p.lat}`).join(';');
    const osrmUrl = `${OSRM_BASE}/table/v1/foot/${coords}?annotations=duration`;
    const result  = await gmGet(osrmUrl);
    if (result.code !== 'Ok') {
      throw new Error(`OSRM table error: ${result.message ?? result.code}`);
    }
    return result.durations;
  }

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

  function clusterAwareRoute(matrix, densityRadius) {
    const n = matrix.length;

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

  async function osrmRoute(waypoints) {
    const coords  = waypoints.map((p) => `${p.lng},${p.lat}`).join(';');
    const osrmUrl = `${OSRM_BASE}/route/v1/foot/${coords}?overview=full&geometries=geojson`;
    const result  = await gmGet(osrmUrl);
    if (result.code !== 'Ok' || !result.routes || result.routes.length === 0) {
      throw new Error(`OSRM route error: ${result.message ?? result.code}`);
    }
    const route = result.routes[0];
    return {
      distanceM: route.distance,
      durationS: route.duration,
      geometry:  route.geometry.coordinates,
    };
  }

  // -------------------------------------------------------------------------
  // GPX builder
  // -------------------------------------------------------------------------

  function buildGPX(orderedStops, geometry, distanceM) {
    const now    = new Date().toISOString();
    const escape = (s) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

  // -------------------------------------------------------------------------
  // URL builders
  // -------------------------------------------------------------------------

  function googleMapsURL(orderedStops) {
    if (!orderedStops.length) return null;
    const first = orderedStops[0];
    const last  = orderedStops[orderedStops.length - 1];
    const mid   = orderedStops.slice(1, -1).slice(0, 8);
    const origin      = `${first.lat},${first.lng}`;
    const destination = `${last.lat},${last.lng}`;
    const waypoints   = mid.map((s) => `${s.lat},${s.lng}`).join('|');
    let u = `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${origin}&destination=${destination}`;
    if (waypoints) u += `&waypoints=${encodeURIComponent(waypoints)}`;
    return u;
  }

  function openStreetMapURL(orderedStops) {
    if (!orderedStops.length) return null;
    const first = orderedStops[0];
    const last  = orderedStops[orderedStops.length - 1];
    return (
      `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot` +
      `&route=${first.lat},${first.lng};${last.lat},${last.lng}`
    );
  }

  // -------------------------------------------------------------------------
  // Address geocoding (Nominatim / OpenStreetMap)
  // -------------------------------------------------------------------------

  async function geocodeAddress(address) {
    const nominatimUrl =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(address)}&format=json&limit=1`;
    let results;
    try {
      results = await gmGet(nominatimUrl);
    } catch (err) {
      throw new Error(`Geocoding failed: ${err.message}`);
    }
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error(`No location found for "${address}". Try a more specific address.`);
    }
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  }

  // -------------------------------------------------------------------------
  // Route truncation by maximum distance
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // UI styles
  // -------------------------------------------------------------------------

  const STYLES = `
    #prp-panel {
      position: fixed;
      bottom: 16px;
      right: 16px;
      width: 320px;
      max-height: 90vh;
      background: #1a1a2e;
      color: #eaeaea;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      touch-action: none;
      user-select: none;
    }
    #prp-header {
      background: #e3350d;
      padding: 12px 16px;
      font-weight: 700;
      font-size: 15px;
      cursor: grab;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
    }
    #prp-header:active { cursor: grabbing; }
    #prp-toggle {
      background: none;
      border: none;
      color: white;
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    #prp-body {
      padding: 14px;
      overflow-y: auto;
      flex: 1;
    }
    .prp-row {
      margin-bottom: 10px;
    }
    .prp-label {
      display: block;
      font-size: 12px;
      color: #aaa;
      margin-bottom: 4px;
    }
    .prp-input {
      width: 100%;
      box-sizing: border-box;
      background: #16213e;
      border: 1px solid #444;
      border-radius: 6px;
      color: #eaeaea;
      padding: 8px 10px;
      font-size: 14px;
    }
    .prp-input:focus { outline: 1px solid #e3350d; }
    .prp-checks {
      display: flex;
      gap: 16px;
      align-items: center;
      margin-top: 2px;
    }
    .prp-checks label {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    .prp-btn {
      width: 100%;
      padding: 12px;
      background: #e3350d;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 6px;
    }
    .prp-btn:hover  { background: #c12b0b; }
    .prp-btn:active { background: #a02309; }
    .prp-btn-sec {
      background: #0f3460;
    }
    .prp-btn-sec:hover  { background: #0c2a50; }
    .prp-btn-sec:active { background: #091f3b; }
    #prp-status {
      margin-top: 10px;
      font-size: 12px;
      color: #aaa;
      min-height: 18px;
    }
    #prp-results {
      margin-top: 10px;
    }
    .prp-result-item {
      padding: 6px 0;
      border-bottom: 1px solid #2a2a4a;
      font-size: 13px;
      display: flex;
      gap: 8px;
      align-items: flex-start;
    }
    .prp-badge {
      font-size: 10px;
      padding: 2px 5px;
      border-radius: 4px;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .prp-badge-stop { background: #1976d2; }
    .prp-badge-gym  { background: #7b1fa2; }
    .prp-link {
      color: #64b5f6;
      text-decoration: none;
      display: block;
      margin-top: 6px;
      word-break: break-all;
    }
    .prp-link:hover { text-decoration: underline; }
    @media (max-width: 380px) {
      #prp-panel { width: calc(100vw - 24px); right: 12px; }
    }
  `;

  // -------------------------------------------------------------------------
  // UI creation
  // -------------------------------------------------------------------------

  function injectUI() {
    // Inject styles
    const style  = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);

    // Panel skeleton
    const panel = document.createElement('div');
    panel.id    = 'prp-panel';
    panel.innerHTML = `
      <div id="prp-header">
        🗺 Pogo Route Planner
        <button id="prp-toggle" title="Collapse/Expand">−</button>
      </div>
      <div id="prp-body">
        <div class="prp-row">
          <label class="prp-label">Address (or use lat/lng below)</label>
          <input id="prp-address" class="prp-input" type="text" placeholder="e.g. Central Park, New York">
        </div>
        <div class="prp-row">
          <button id="prp-geoloc" class="prp-btn prp-btn-sec">📍 Use my location</button>
        </div>
        <div class="prp-row">
          <label class="prp-label">Latitude</label>
          <input id="prp-lat" class="prp-input" type="number" step="any" placeholder="e.g. 51.5074">
        </div>
        <div class="prp-row">
          <label class="prp-label">Longitude</label>
          <input id="prp-lng" class="prp-input" type="number" step="any" placeholder="e.g. -0.1278">
        </div>
        <div class="prp-row">
          <label class="prp-label">Walking radius (metres)</label>
          <input id="prp-radius" class="prp-input" type="number" min="100" max="10000" value="1500">
        </div>
        <div class="prp-row">
          <label class="prp-label">Max route distance (km, 0 = no limit)</label>
          <input id="prp-maxdist" class="prp-input" type="number" min="0" max="200" step="0.5" value="10">
        </div>
        <div class="prp-row">
          <label class="prp-label">Include</label>
          <div class="prp-checks">
            <label><input id="prp-stops" type="checkbox" checked> PokéStops</label>
            <label><input id="prp-gyms"  type="checkbox" checked> Gyms</label>
          </div>
        </div>
        <div class="prp-row">
          <div class="prp-checks">
            <label><input id="prp-compare" type="checkbox"> Compare v1 vs v2</label>
          </div>
        </div>
        <button id="prp-plan" class="prp-btn">⚡ Plan Route</button>
        <div id="prp-status"></div>
        <div id="prp-results"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // --- element references ---
    const header      = panel.querySelector('#prp-header');
    const toggleBtn   = panel.querySelector('#prp-toggle');
    const body        = panel.querySelector('#prp-body');
    const geolocBtn   = panel.querySelector('#prp-geoloc');
    const addressInput = panel.querySelector('#prp-address');
    const latInput    = panel.querySelector('#prp-lat');
    const lngInput    = panel.querySelector('#prp-lng');
    const radiusInput = panel.querySelector('#prp-radius');
    const maxDistInput = panel.querySelector('#prp-maxdist');
    const stopsCheck   = panel.querySelector('#prp-stops');
    const gymsCheck    = panel.querySelector('#prp-gyms');
    const compareCheck = panel.querySelector('#prp-compare');
    const planBtn     = panel.querySelector('#prp-plan');
    const statusEl    = panel.querySelector('#prp-status');
    const resultsEl   = panel.querySelector('#prp-results');

    // --- collapse / expand ---
    let collapsed = false;
    toggleBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      body.style.display  = collapsed ? 'none' : '';
      toggleBtn.textContent = collapsed ? '+' : '−';
    });

    // --- dragging ---
    let dragging = false;
    let dragOffX = 0;
    let dragOffY = 0;

    header.addEventListener('pointerdown', (e) => {
      if (e.target === toggleBtn) return;
      dragging  = true;
      dragOffX  = e.clientX - panel.getBoundingClientRect().left;
      dragOffY  = e.clientY - panel.getBoundingClientRect().top;
      header.setPointerCapture(e.pointerId);
    });

    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const x = e.clientX - dragOffX;
      const y = e.clientY - dragOffY;
      panel.style.left   = `${x}px`;
      panel.style.top    = `${y}px`;
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
    });

    header.addEventListener('pointerup', () => { dragging = false; });

    // --- geolocation ---
    geolocBtn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        setStatus('Geolocation not supported in this browser.', true);
        return;
      }
      setStatus('Getting location…');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          latInput.value = pos.coords.latitude.toFixed(7);
          lngInput.value = pos.coords.longitude.toFixed(7);
          setStatus('Location set ✓');
        },
        (err) => setStatus(`Geolocation error: ${err.message}`, true)
      );
    });

    // --- plan route ---
    planBtn.addEventListener('click', () => planRoute());

    // --- helpers ---
    function setStatus(msg, isError = false) {
      statusEl.textContent  = msg;
      statusEl.style.color  = isError ? '#ef5350' : '#aaa';
    }

    function setResults(html) {
      resultsEl.innerHTML = html;
    }

    // --- main planner ---
    async function planRoute() {
      resultsEl.innerHTML = '';
      planBtn.disabled    = true;
      planBtn.textContent = '⏳ Planning…';

      try {
        // 0. Geocode address if provided
        const addressVal = addressInput.value.trim();
        if (addressVal) {
          setStatus('Geocoding address…');
          const coords = await geocodeAddress(addressVal);
          latInput.value = coords.lat.toFixed(7);
          lngInput.value = coords.lng.toFixed(7);
        }

        const lat       = parseFloat(latInput.value);
        const lng       = parseFloat(lngInput.value);
        const radius    = parseInt(radiusInput.value, 10);
        const maxDistKm = parseFloat(maxDistInput.value) || 0;
        const inclStops = stopsCheck.checked;
        const inclGyms  = gymsCheck.checked;
        const doCompare = compareCheck.checked;

        if (isNaN(lat) || isNaN(lng)) {
          throw new Error('Please enter a valid latitude and longitude (or a searchable address).');
        }
        if (isNaN(radius) || radius <= 0) {
          throw new Error('Please enter a valid radius in metres.');
        }
        if (maxDistKm < 0) {
          throw new Error('Max route distance must be 0 (no limit) or a positive number.');
        }
        if (!inclStops && !inclGyms) {
          throw new Error('Select at least one of PokéStops or Gyms.');
        }

        // 1. Fetch POIs from pogomap.info
        setStatus('Fetching data from pogomap.info…');
        const bbox    = boundingBox(lat, lng, radius);
        const allPOIs = await fetchPOIs(bbox, inclStops, inclGyms);

        // 2. Filter to radius
        const nearby = allPOIs.filter(
          (p) => haversine(lat, lng, p.lat, p.lng) <= radius
        );

        if (nearby.length === 0) {
          setStatus('No POIs found within the specified radius.', true);
          planBtn.disabled    = false;
          planBtn.textContent = '⚡ Plan Route';
          return;
        }

        setStatus(`Found ${nearby.length} POIs. Optimising route…`);

        // 3. Build distance matrix
        const startPoint = { lat, lng, name: 'Start', type: 'start' };
        const allPoints  = [startPoint, ...nearby];
        const maxDistM   = maxDistKm * 1000;

        let matrix = null;
        if (allPoints.length > 2) {
          try {
            matrix = await osrmTable(allPoints);
          } catch (_) {
            matrix = allPoints.map((a) =>
              allPoints.map((b) => haversine(a.lat, a.lng, b.lat, b.lng))
            );
          }
        }

        // ---------------------------------------------------------------
        // Compare mode: show v1 (nearest-neighbour) vs v2 (cluster-aware)
        // ---------------------------------------------------------------
        if (doCompare) {
          setStatus('Comparing algorithms…');

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

          const namesV1  = new Set(poisV1.map((s) => s.name));
          const namesV2  = new Set(poisV2.map((s) => s.name));
          const onlyInV1 = poisV1.filter((s) => !namesV2.has(s.name));
          const onlyInV2 = poisV2.filter((s) => !namesV1.has(s.name));
          const delta    = poisV2.length - poisV1.length;

          const makeList = (stops) => stops
            .filter((s) => s.type !== 'start')
            .map((s, i) => {
              const badgeCls = s.type === 'gym' ? 'prp-badge-gym' : 'prp-badge-stop';
              const label    = s.type === 'gym' ? 'GYM' : 'STOP';
              return `<div class="prp-result-item">
                <span class="prp-badge ${badgeCls}">${label}</span>
                <span>${i + 1}. ${s.name}</span>
              </div>`;
            })
            .join('');

          const diffMsg = delta > 0
            ? `<span style="color:#66bb6a;">v2 covers ${delta} more stop(s)</span>`
            : delta < 0
              ? `<span style="color:#ef5350;">v1 covers ${-delta} more stop(s)</span>`
              : '<span>Both cover the same number of stops.</span>';

          const onlyV1Html = onlyInV1.length > 0
            ? `<div style="margin-top:6px;font-size:12px;color:#ffb300;">Only in v1: ${onlyInV1.map((s) => s.name).join(', ')}</div>`
            : '';
          const onlyV2Html = onlyInV2.length > 0
            ? `<div style="margin-top:4px;font-size:12px;color:#66bb6a;">Only in v2: ${onlyInV2.map((s) => s.name).join(', ')}</div>`
            : '';

          setStatus(`Comparison done · v1: ${poisV1.length} stops · v2: ${poisV2.length} stops`);
          setResults(`
            <div style="font-weight:700;margin-bottom:8px;">Algorithm Comparison</div>
            <div style="margin-bottom:8px;font-size:13px;">${diffMsg}${onlyV1Html}${onlyV2Html}</div>
            <div style="font-weight:600;margin-bottom:4px;color:#aaa;">v1 · Nearest-Neighbour · ${poisV1.length} stops</div>
            ${makeList(stopsV1)}
            <div style="font-weight:600;margin:8px 0 4px;color:#aaa;">v2 · Cluster-Aware · ${poisV2.length} stops</div>
            ${makeList(stopsV2)}
          `);

          return;
        }

        // ---------------------------------------------------------------
        // Normal mode: cluster-aware route only
        // ---------------------------------------------------------------

        // 4. Apply cluster-aware route order
        const order = matrix ? clusterAwareRoute(matrix) : allPoints.map((_, i) => i);
        let orderedAll = order.map((i) => allPoints[i]);

        // 5. Apply max-distance constraint (truncate route if needed)
        const poisBeforeTrunc = nearby.length;
        if (maxDistM > 0) {
          orderedAll = truncateByMaxDistance(orderedAll, maxDistM);
        }

        const orderedStops = orderedAll.filter((s) => s.type !== 'start');
        const omittedCount = poisBeforeTrunc - orderedStops.length;

        // 6. Get full route geometry
        setStatus('Fetching walking route from OSRM…');
        let routeInfo;
        try {
          routeInfo = await osrmRoute(orderedAll);
        } catch (_) {
          routeInfo = { distanceM: 0, durationS: 0, geometry: [] };
        }

        const distKm = (routeInfo.distanceM / 1000).toFixed(2);
        const durMin = Math.round(routeInfo.durationS / 60);

        // 7. Build URLs
        const googleUrl = googleMapsURL(orderedAll);
        const osmUrl    = openStreetMapURL(orderedAll);

        // 8. GPX blob download
        const gpxContent = buildGPX(orderedStops, routeInfo.geometry, routeInfo.distanceM);
        const gpxBlob    = new Blob([gpxContent], { type: 'application/gpx+xml' });
        const gpxUrl     = URL.createObjectURL(gpxBlob);

        // 9. Render results
        const truncated = omittedCount > 0;
        setStatus(`Done! ${orderedStops.length} stops · ${distKm} km · ~${durMin} min${truncated ? ' (truncated to fit max distance)' : ''}`);

        const listItems = orderedStops
          .map((s, i) => {
            const badgeCls = s.type === 'gym' ? 'prp-badge-gym' : 'prp-badge-stop';
            const label    = s.type === 'gym' ? 'GYM' : 'STOP';
            return `<div class="prp-result-item">
              <span class="prp-badge ${badgeCls}">${label}</span>
              <span>${i + 1}. ${s.name}</span>
            </div>`;
          })
          .join('');

        setResults(`
          <div style="font-weight:700;margin-bottom:8px;">
            ${orderedStops.length} stops · ${distKm} km · ~${durMin} min
          </div>
          ${truncated ? `<div style="font-size:12px;color:#ffb300;margin-bottom:8px;">Route truncated: ${omittedCount} stop(s) omitted to stay within ${maxDistKm} km limit.</div>` : ''}
          ${listItems}
          ${googleUrl ? `<a class="prp-link" href="${googleUrl}" target="_blank" rel="noopener">🗺 Open in Google Maps</a>` : ''}
          ${osmUrl    ? `<a class="prp-link" href="${osmUrl}"    target="_blank" rel="noopener">🗺 Open in OpenStreetMap</a>` : ''}
          <a class="prp-link" href="${gpxUrl}" download="route.gpx">⬇ Download GPX</a>
        `);

      } catch (err) {
        setStatus(`Error: ${err.message}`, true);
      } finally {
        planBtn.disabled    = false;
        planBtn.textContent = '⚡ Plan Route';
      }
    }
  }

  // -------------------------------------------------------------------------
  // Entry point — wait for DOM
  // -------------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectUI);
  } else {
    injectUI();
  }

})();
