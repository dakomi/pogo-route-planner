# pogomap.info API Findings

> **Note:** pogomap.info does not publish an official public API. All findings
> below were obtained by inspecting the site's network traffic in browser
> DevTools and by reviewing community discussion. The endpoint and field names
> may change at any time. If requests start failing, open DevTools → Network,
> reload pogomap.info, filter by XHR/Fetch, and look for the new endpoint
> pattern.

---

## 1. Data Endpoint

| Property | Value |
|----------|-------|
| URL | `https://www.pogomap.info/query2.php` |
| HTTP method | `GET` |
| Triggered by | Panning / zooming the map, or on page load |

---

## 2. Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `swLat` | `float` | Yes | South-west corner latitude of the bounding box |
| `swLng` | `float` | Yes | South-west corner longitude of the bounding box |
| `neLat` | `float` | Yes | North-east corner latitude of the bounding box |
| `neLng` | `float` | Yes | North-east corner longitude of the bounding box |
| `pokestops` | `true`/`false` | No (default `true`) | Include PokéStop results |
| `gyms` | `true`/`false` | No (default `true`) | Include Gym results |
| `timestamp` | `integer` (Unix ms) | No | Cache-busting timestamp |

### Example request URL

```
https://www.pogomap.info/query2.php?swLat=51.490&swLng=-0.130&neLat=51.520&neLng=-0.080&pokestops=true&gyms=true
```

---

## 3. POI / WMS Layer

No officially published WMS or tile service URL has been identified.  
The site renders its markers via Leaflet.js by fetching JSON from
`query2.php` and placing markers directly — no tile-based WMS layer is used
for POI data.

---

## 4. JSON Response Structure

The endpoint returns a single JSON object with two top-level arrays:

```json
{
  "pokestops": [ ... ],
  "gyms": [ ... ]
}
```

### PokéStop object

```json
{
  "id": "a1b2c3d4e5f6.16",
  "name": "Park Entrance Statue",
  "lat": 51.5074,
  "lng": -0.1278,
  "image": "https://lh3.googleusercontent.com/...",
  "sponsored": false,
  "lure": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique Niantic POI identifier |
| `name` | string | Display name of the PokéStop |
| `lat` | float | WGS84 latitude |
| `lng` | float | WGS84 longitude |
| `image` | string \| null | Cover photo URL (Niantic CDN) |
| `sponsored` | boolean | Whether the stop is a sponsored location |
| `lure` | string \| null | Active lure module type, or `null` |

### Gym object

```json
{
  "id": "b2c3d4e5f6a1.16",
  "name": "Central Park Fountain",
  "lat": 51.5080,
  "lng": -0.1290,
  "image": "https://lh3.googleusercontent.com/...",
  "team": 1,
  "slots_available": 3,
  "sponsored": false,
  "raid": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique Niantic POI identifier |
| `name` | string | Display name of the Gym |
| `lat` | float | WGS84 latitude |
| `lng` | float | WGS84 longitude |
| `image` | string \| null | Cover photo URL (Niantic CDN) |
| `team` | integer | Controlling team — `0` = uncontrolled, `1` = Mystic, `2` = Valor, `3` = Instinct |
| `slots_available` | integer | Number of open Pokémon slots |
| `sponsored` | boolean | Whether the gym is a sponsored location |
| `raid` | object \| null | Active raid info (`level`, `pokemon`, `end_time`), or `null` |

> **Coordinate field names:** The site uses `lat`/`lng` (not `latitude`/`longitude`).
> The CLI script and userscript both normalise to `lat`/`lng` internally and
> check for alternative field names (`latitude`/`longitude`) as a fallback.

---

## 5. Authentication & Session Requirements

- `query2.php` requires an **authenticated user session**. Unauthenticated
  requests are redirected (HTTP `302`) back to the homepage.
- **In the userscript** authentication is handled automatically: the script
  runs inside a pogomap.info browser tab so the user's existing session cookie
  is included in every `GM_xmlhttpRequest` call. If the user is not logged in
  the userscript shows a clear "please log in" message.
- **In the Node.js CLI** you must supply your session cookie manually:
  1. Log in at <https://www.pogomap.info> in any browser.
  2. Open DevTools → **Application** → **Cookies** → `www.pogomap.info`.
  3. Copy the value of the `PHPSESSID` cookie.
  4. Pass it to the CLI with:
     ```bash
     node route-planner.js --lat -27.46794 --lng 153.02809 --radius 2000 \
       --include both --cookie "PHPSESSID=<your_value>"
     ```
     or via the environment variable (useful in scripts / shortcuts):
     ```bash
     export POGOMAP_COOKIE="PHPSESSID=<your_value>"
     node route-planner.js --lat -27.46794 --lng 153.02809 --radius 2000 --include both
     ```

---

## 6. CORS

- `query2.php` does **not** include permissive `Access-Control-Allow-Origin`
  headers in its response.
- **In the userscript** this is worked around by using the
  `GM_xmlhttpRequest` API (granted via `@grant GM_xmlhttpRequest` and
  `@connect www.pogomap.info`), which bypasses same-origin restrictions.
- **In the Node.js CLI** CORS is not relevant — Node.js HTTP requests are not
  subject to browser CORS policy.

---

## 7. Rate Limiting

No officially documented rate limit. Community experience suggests:

- Keep bounding-box queries infrequent (one query per 2–5 seconds for
  sequential requests).
- Do not poll the endpoint on a timer.
- The OSRM public demo server (`router.project-osrm.org`) is similarly
  rate-limited — see the project README.

---

## 8. Troubleshooting

If the endpoint stops returning data:

1. Open **pogomap.info** in a desktop browser.
2. Open DevTools → **Network** tab → filter by **Fetch/XHR**.
3. Pan the map slightly to trigger a data request.
4. Look for a request whose URL matches `query2.php` or a similar pattern.
5. Note the full URL, query parameters, and any request headers (especially
   `Cookie` and `Referer`).
6. Update the `ENDPOINT` constant at the top of `termux/route-planner.js`
   and the `POGO_ENDPOINT` constant in `userscript/pogo-route-planner.user.js`
   accordingly.
