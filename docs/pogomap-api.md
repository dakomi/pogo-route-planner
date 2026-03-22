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
| URL | `https://www.pogomap.info/includes/it150nmsq9.php` |
| HTTP method | `POST` |
| Content-Type | `application/x-www-form-urlencoded; charset=UTF-8` |
| Triggered by | Panning / zooming the map, or on page load |
| Coverage | **Worldwide** — the endpoint is not region-specific |

### Global coverage

The endpoint accepts any valid WGS84 bounding box and returns all PokéStops
and Gyms within that region.  Tested and confirmed working for:

| City | Approx. POIs in 1 km radius |
|------|-----------------------------|
| Brisbane, Australia (−27.468°, 153.028°) | ~149 |
| New York City, USA (40.785°, −73.968°) | ~354 |
| London, UK (51.508°, −0.128°) | ~387 |

There is nothing location-specific about the URL, the POST parameters, or
the coordinate decode formula — all values are pure arithmetic applied to
whatever bounding box is submitted.

### URL format

The site uses **commas as decimal separators** in location URLs:

```
https://www.pogomap.info/location/-27,467955/153,027856/15
```

Decoded: latitude `-27.467955`, longitude `153.027856`, zoom level `15`.

NYC example:

```
https://www.pogomap.info/location/40,785100/-73,968300/15
```

---

## 2. POST Body Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fromlat` | `float` | Yes | South boundary (lower latitude) of the bounding box |
| `tolat`   | `float` | Yes | North boundary (upper latitude) of the bounding box |
| `fromlng` | `float` | Yes | West boundary (lower longitude) of the bounding box |
| `tolng`   | `float` | Yes | East boundary (upper longitude) of the bounding box |
| `fpoke`   | `0`/`1` | Yes | Include PokéStops |
| `fgym`    | `0`/`1` | Yes | Include Gyms |
| `farm`    | `0`/`1` | Yes | Include nests / farm zones |
| `fpstop`  | `0`/`1` | Yes | Include sponsored PokéStops |
| `nests`   | `0`/`1` | Yes | Include nest data |
| `priv`    | `0`/`1` | Yes | Include private markers |
| `raids`   | `0`/`1` | Yes | Include raid info |
| `sponsor` | `0`/`1` | Yes | Include sponsored locations |
| `usermarks` | `0`/`1` | Yes | Include user-placed marks |
| `ftasks`  | `0`/`1` | Yes | Include field-research tasks |
| `viewdel` | `0`/`1` | Yes | Show deleted markers |
| `voteonly` | `0`/`1` | Yes | Show vote-only markers |
| `modonly`  | `0`/`1` | Yes | Show mod-only markers |
| `agedonly` | `0`/`1` | Yes | Show aged-only markers |
| `modnone`  | `0`/`1` | Yes | Omit moderated markers |
| `showonly` | `0`/`1` | Yes | Show only specific markers |
| `routesonly` | `0`/`1` | Yes | Show only route markers |

### Example POST body

```
fromlat=-27.4810907&tolat=-27.4548173&fromlng=153.0080509&tolng=153.0476618
&fpoke=1&fgym=1&farm=0&fpstop=1&nests=1&priv=0&raids=1&sponsor=0
&usermarks=0&ftasks=1&viewdel=0&voteonly=0&modonly=0&agedonly=0
&modnone=0&showonly=0&routesonly=0
```

---

## 3. JSON Response Structure

The endpoint returns a flat JSON **object** keyed by numeric POI ID (as a
string). Each value contains the POI's obfuscated data.

```json
{
  "90153331": {
    "nest_pokemon_id": "0",
    "poke_enabled": "2",
    "raid_status": 0,
    "lure_timer": 0,
    "z3iafj":  "LTAuMjYxMzcwNjU3MzkwNjI=",
    "f24sfvs": "Mi41NjYzNDEzNDAxNjQ2",
    "g74jsdg": "MA==",
    "xgxg35":  "Mg==",
    "y74hda":  "MQ==",
    "zfgs62":  "OTAxNTMzMzE=",
    "rgqaca":  "four-seasons-mosaic",
    "rfs21d":  "Four Seasons Mosaic",
    ...
  },
  ...
}
```

### Fields used by the route planner

| Field | Encoding | Description |
|-------|----------|-------------|
| `rfs21d` | Plain text | Display name of the POI |
| `rgqaca` | Plain text | URL slug of the POI |
| `zfgs62` | base64 → string | Numeric POI ID (e.g. `"90153331"`) |
| `z3iafj` | base64 → float string | Raw latitude value (requires transform, see §4) |
| `f24sfvs` | base64 → float string | Raw longitude value (requires transform, see §4) |
| `xgxg35` | base64 → `"1"` or `"2"` | POI type: `"1"` = PokéStop, `"2"` = Gym |
| `g74jsdg` | base64 → `"0"`–`"3"` | Gym controlling team: 0=Neutral, 1=Mystic, 2=Valor, 3=Instinct |

> **Spam guard:** If the server rejects the request it returns
> `{"spam":1,"spamtype":2}` — wait a few seconds and retry.

---

## 4. Coordinate Decoding

Coordinates are obfuscated with a fixed arithmetic transform derived by
reverse-engineering `mapsys648.js` (the site's primary client script).

### Constants

| Name | Value | Description |
|------|-------|-------------|
| `EN`  | `10.62 / 12` ≈ `0.885` | Lat divisor |
| `TN`  | `1.5935` | Lng divisor |
| `H`   | `1.91`  | Lat scale factor |
| `Q`   | `1.952` | Lng scale factor |
| `JSZ` | `1.852` | `jqueryscrollzoom` — a page-level constant |

### Formula

```
pid = parseFloat(atob(zfgs62))     // numeric POI ID
z   = parseFloat(atob(z3iafj))     // raw lat value
f   = parseFloat(atob(f24sfvs))    // raw lng value

lat = (z / EN) * H * pid / JSZ / 1_000_000
lng = (f / TN) * Q * pid / JSZ / 1_000_000
```

### Python equivalent

```python
import base64

EN, TN, H, Q, JSZ = 10.62/12, 1.5935, 1.91, 1.952, 1.852

def decode_poi(item):
    pid = float(base64.b64decode(item['zfgs62']))
    z   = float(base64.b64decode(item['z3iafj']))
    f   = float(base64.b64decode(item['f24sfvs']))
    lat = (z / EN) * H * pid / JSZ / 1e6
    lng = (f / TN) * Q * pid / JSZ / 1e6
    return lat, lng
```

### Verification examples

**Brisbane CBD — "Four Seasons Mosaic" (Spring Hill, Australia)**

```
pid  = 90153331
z    = −0.26137…   (atob("LTAuMjYxMzcwNjU3MzkwNjI="))
f    = 2.56634…    (atob("Mi41NjYzNDEzNDAxNjQ2"))

lat  = (−0.26137 / 0.885) × 1.91 × 90153331 / 1.852 / 1e6  ≈  −27.459  ✓
lng  = ( 2.56634 / 1.5935) × 1.952 × 90153331 / 1.852 / 1e6 ≈ 153.032  ✓
```

**New York City — "The Majestic Historic Landmark Plaque" (Upper West Side)**

```
pid  = (decoded from zfgs62 for this POI)
z/f  = (decoded from z3iafj / f24sfvs)

lat  ≈  40.776  ✓  (matches known Upper West Side, Manhattan)
lng  ≈ −73.976  ✓
```

**London — "Sir John Soane's Museum" (Holborn)**

```
lat  ≈  51.517  ✓  (matches known Holborn location)
lng  ≈  −0.117  ✓
```

The formula produces correct WGS84 coordinates for all tested cities — it
is a fixed arithmetic transform with **no location-specific parameters**.

---

## 5. Authentication & Session Requirements

**No user account or login is required.** PokéStops and Gyms are visible to
all visitors — the site only needs a valid PHP session cookie.

- **In the userscript** the user's `PHPSESSID` cookie is automatically
  included in every `GM_xmlhttpRequest` call because the script runs inside
  a pogomap.info browser tab.
- **In the Node.js CLI** a fresh session is obtained automatically before
  the first data request:
  1. A `GET https://www.pogomap.info/` request is sent.
  2. The `PHPSESSID` value from the `Set-Cookie` response header is extracted.
  3. That cookie is attached to the subsequent POST request.

  No manual step is required unless you want to override the auto-acquired
  session (e.g. for debugging). In that case, set the environment variable:
  ```bash
  POGOMAP_COOKIE="PHPSESSID=<your_value>" node route-planner.js ...
  ```

---

## 6. CORS

- The data endpoint does **not** include permissive `Access-Control-Allow-Origin`
  headers.
- **In the userscript** this is worked around with `GM_xmlhttpRequest`
  (granted via `@grant GM_xmlhttpRequest` and `@connect www.pogomap.info`).
- **In the Node.js CLI** CORS is not relevant — Node.js HTTP requests are not
  subject to browser same-origin policy.

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
3. Pan the map to trigger a data request.
4. Find the `POST` request to `includes/it150nmsq9.php` (or whatever the
   new endpoint is).
5. Inspect the request payload and response headers.
6. Update the `ENDPOINT` constant in `termux/route-planner.js` and the
   `POGO_ENDPOINT` constant in `userscript/pogo-route-planner.user.js`.
7. If the coordinate decode formula has changed, re-derive it from
   the site's `mapsys*.js` file by searching for `jqueryscrollzoom`,
   `z3iafj`, and `f24sfvs`.
