// ==UserScript==
// @name         Pogo Route Planner
// @namespace    https://github.com/dakomi/pogo-route-planner
// @version      1.0.0
// @description  Plan optimised walking routes for Pokémon GO from pogomap.info
// @author       dakomi
// @match        https://www.pogomap.info/*
// @grant        GM_xmlhttpRequest
// @connect      router.project-osrm.org
// @connect      www.pogomap.info
// ==/UserScript==

/* global GM_xmlhttpRequest */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  /** pogomap.info data endpoint — update if the site changes it */
  const POGO_ENDPOINT = 'https://www.pogomap.info/query2.php';

  /** OSRM public demo server — foot profile */
  const OSRM_BASE = 'https://router.project-osrm.org';

  /** Earth radius in metres */
  const EARTH_RADIUS_M = 6_371_000;

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
      swLat: lat - latDelta,
      swLng: lng - lngDelta,
      neLat: lat + latDelta,
      neLng: lng + lngDelta,
    };
  }

  // -------------------------------------------------------------------------
  // GM_xmlhttpRequest wrapper returning a Promise
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
          // A 3xx redirect or an HTML body means pogomap.info rejected the request
          // (most likely because the user is not logged in).
          if (response.status === 301 || response.status === 302) {
            return reject(new Error(
              'Authentication required — please log in to pogomap.info and try again.'
            ));
          }
          if (response.status < 200 || response.status >= 300) {
            return reject(new Error(`HTTP ${response.status} from ${url}`));
          }
          // Guard against auth redirects that were transparently followed and
          // returned the homepage HTML instead of JSON.
          if (response.responseText.trimStart().startsWith('<!')) {
            return reject(new Error(
              'Authentication required — pogomap.info returned an HTML page instead of ' +
              'JSON data. Please log in to pogomap.info and try again.'
            ));
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

  // -------------------------------------------------------------------------
  // Attempt to read data already loaded by the page
  // -------------------------------------------------------------------------

  /**
   * Tries to extract POI data from the page's existing JavaScript globals.
   * pogomap.info uses Leaflet; markers are stored in layer groups.
   * Returns null if the data cannot be accessed this way.
   */
  function extractPageData() {
    try {
      // Common patterns used by Leaflet-based pogo maps
      const candidates = [
        window.pokestopLayer,
        window.gymLayer,
        window.stops,
        window.gyms,
        window.mapData,
        window.pogoData,
      ];

      const pois = [];

      for (const candidate of candidates) {
        if (!candidate) continue;

        // Leaflet LayerGroup
        if (typeof candidate.eachLayer === 'function') {
          candidate.eachLayer((layer) => {
            const ll = layer.getLatLng && layer.getLatLng();
            if (!ll) return;
            const opts    = layer.options || {};
            const feature = layer.feature && layer.feature.properties;
            const name    = (feature && feature.name) || opts.title || opts.name || 'Unknown';
            const type    = (feature && feature.type) ||
              (candidate === window.gymLayer ? 'gym' : 'pokestop');
            pois.push({ id: name, name, lat: ll.lat, lng: ll.lng, type });
          });
        }

        // Plain array
        if (Array.isArray(candidate)) {
          for (const item of candidate) {
            const lat  = item.lat  ?? item.latitude;
            const lng  = item.lng  ?? item.longitude;
            if (lat == null || lng == null) continue;
            pois.push({
              id:   item.id   ?? `poi_${lat}_${lng}`,
              name: item.name ?? item.stop_name ?? item.gym_name ?? 'Unknown',
              lat:  +lat,
              lng:  +lng,
              type: item.type ?? 'pokestop',
            });
          }
        }
      }

      return pois.length > 0 ? pois : null;
    } catch (_) {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Fetch POIs from pogomap.info (via GM_xmlhttpRequest)
  // -------------------------------------------------------------------------

  async function fetchPOIs(bbox, includeStops, includeGyms) {
    const params = new URLSearchParams({
      swLat:      bbox.swLat.toFixed(7),
      swLng:      bbox.swLng.toFixed(7),
      neLat:      bbox.neLat.toFixed(7),
      neLng:      bbox.neLng.toFixed(7),
      pokestops:  includeStops ? 'true' : 'false',
      gyms:       includeGyms  ? 'true' : 'false',
      timestamp:  Date.now().toString(),
    });

    const fullUrl = `${POGO_ENDPOINT}?${params}`;
    let data;
    try {
      data = await gmGet(fullUrl);
    } catch (err) {
      throw new Error(
        `Failed to fetch data from pogomap.info: ${err.message}\n` +
        `If the endpoint has changed, update POGO_ENDPOINT in the userscript and\n` +
        `consult docs/pogomap-api.md in the repository.`
      );
    }

    const pois = [];

    function normalise(raw, type) {
      const lat  = raw.lat  ?? raw.latitude;
      const lng  = raw.lng  ?? raw.longitude;
      const name = raw.name ?? raw.stop_name ?? raw.gym_name ?? `Unnamed ${type}`;
      if (lat == null || lng == null) return null;
      return { id: raw.id ?? `${type}_${lat}_${lng}`, name, lat: +lat, lng: +lng, type };
    }

    if (includeStops && Array.isArray(data.pokestops)) {
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
          <label class="prp-label">Include</label>
          <div class="prp-checks">
            <label><input id="prp-stops" type="checkbox" checked> PokéStops</label>
            <label><input id="prp-gyms"  type="checkbox" checked> Gyms</label>
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
    const latInput    = panel.querySelector('#prp-lat');
    const lngInput    = panel.querySelector('#prp-lng');
    const radiusInput = panel.querySelector('#prp-radius');
    const stopsCheck  = panel.querySelector('#prp-stops');
    const gymsCheck   = panel.querySelector('#prp-gyms');
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
        const lat    = parseFloat(latInput.value);
        const lng    = parseFloat(lngInput.value);
        const radius = parseInt(radiusInput.value, 10);
        const inclStops = stopsCheck.checked;
        const inclGyms  = gymsCheck.checked;

        if (isNaN(lat) || isNaN(lng)) {
          throw new Error('Please enter a valid latitude and longitude.');
        }
        if (isNaN(radius) || radius <= 0) {
          throw new Error('Please enter a valid radius in metres.');
        }
        if (!inclStops && !inclGyms) {
          throw new Error('Select at least one of PokéStops or Gyms.');
        }

        // 1. Try to read page data first, fall back to API
        setStatus('Reading map data…');
        let allPOIs = extractPageData();

        if (!allPOIs) {
          setStatus('Fetching data from pogomap.info…');
          const bbox = boundingBox(lat, lng, radius);
          allPOIs    = await fetchPOIs(bbox, inclStops, inclGyms);
        }

        // Filter by type if page data included both
        if (!inclStops) allPOIs = allPOIs.filter((p) => p.type !== 'pokestop');
        if (!inclGyms)  allPOIs = allPOIs.filter((p) => p.type !== 'gym');

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

        // 3. Nearest-neighbour TSP using OSRM distance matrix
        const startPoint = { lat, lng, name: 'Start', type: 'start' };
        const allPoints  = [startPoint, ...nearby];

        let order;
        if (allPoints.length <= 2) {
          order = allPoints.map((_, i) => i);
        } else {
          let matrix;
          try {
            matrix = await osrmTable(allPoints);
          } catch (_) {
            matrix = allPoints.map((a) =>
              allPoints.map((b) => haversine(a.lat, a.lng, b.lat, b.lng))
            );
          }
          order = nearestNeighbour(matrix);
        }

        const orderedAll   = order.map((i) => allPoints[i]);
        const orderedStops = orderedAll.filter((s) => s.type !== 'start');

        // 4. Get full route geometry
        setStatus('Fetching walking route from OSRM…');
        let routeInfo;
        try {
          routeInfo = await osrmRoute(orderedAll);
        } catch (_) {
          routeInfo = { distanceM: 0, durationS: 0, geometry: [] };
        }

        const distKm = (routeInfo.distanceM / 1000).toFixed(2);
        const durMin = Math.round(routeInfo.durationS / 60);

        // 5. Build URLs
        const googleUrl = googleMapsURL(orderedAll);
        const osmUrl    = openStreetMapURL(orderedAll);

        // 6. GPX blob download
        const gpxContent = buildGPX(orderedStops, routeInfo.geometry, routeInfo.distanceM);
        const gpxBlob    = new Blob([gpxContent], { type: 'application/gpx+xml' });
        const gpxUrl     = URL.createObjectURL(gpxBlob);

        // 7. Render results
        setStatus(`Done! ${nearby.length} stops · ${distKm} km · ~${durMin} min`);

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
            ${nearby.length} stops · ${distKm} km · ~${durMin} min
          </div>
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
