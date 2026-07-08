# Eval Results: maplibre-tile-sources

These results show the skill's effect on model responses. Each test was run twice:
once without the skill injected (baseline) and once with it.

Eval config: [`evals/prompts/maplibre-tile-sources.yaml`](../prompts/maplibre-tile-sources.yaml)

## Summary

| Test                                               | Type         | Baseline | With skill |
| -------------------------------------------------- | ------------ | -------- | ---------- |
| GeoJSON vs tiles decision for a real scenario      | Explicit     | 0.50     | 1.00       |
| Custom style layers invisible against hosted tiles | Implicit     | 0.00     | 1.00       |
| addLayer covering basemap labels                   | Anti-pattern | 0.00     | 1.00       |
| No text labels in custom style                     | Implicit     | 0.00     | 1.00       |
| Small dataset, no tile server needed               | Negative     | 1.00     | 1.00       |

---

## Test 1 — Explicit: GeoJSON vs tiles decision for a real scenario

**Question:**

> I have about 8,000 hiking trail segments stored as GeoJSON, and users need to click
> a trail to see its name and distance. I also need a basemap showing terrain and roads.
> How should I set up the data sources in MapLibre — do I need vector tiles, or can I
> use GeoJSON?

**What the skill teaches:** 8,000 features is a gray zone — not a clean yes/no. The
right answer depends on reasoning through the tradeoffs: GeoJSON downloads the full
dataset on load (parse time grows with feature count) but gives full client-side
attribute access without a server round-trip, which benefits click interactions. The
recommended pattern is a hosted basemap style URL for terrain/roads and a separate
GeoJSON source for the trails — no tile pipeline needed at this scale with optimization.

<details>
<summary>Baseline response (score: 0.50 — FAIL)</summary>

> You have a few good options for displaying 8,000 hiking trail segments in MapLibre GL
> JS, and the best choice depends on **performance**, **interactivity**, and
> **scalability**. Let's break it down:
>
> ### Can you use GeoJSON directly?
>
> **Yes — but with caveats.**
>
> #### Pros of using raw GeoJSON:
>
> - Simple to set up.
> - No need to generate vector tiles.
> - Easy to update or modify data.
> - Supports interactivity (click to get name/distance).
>
> #### Cons:
>
> - **Performance issues** with 8,000 features:
>   - Large GeoJSON files (~several MB) can be slow to load and parse.
>   - Rendering many line features can lag on lower-end devices.
>   - Interactivity (e.g., hover/click) may feel sluggish.
> - No level-of-detail (LOD) — all trails render at all zoom levels unless you manually
>   filter.
>
> ### Better Option: Use Vector Tiles
>
> For 8,000 trail segments, **vector tiles are strongly recommended**.
>
> #### How to set it up:
>
> 1. **Convert GeoJSON to vector tiles** using `tippecanoe`:
>    ```bash
>    tippecanoe -o trails.mbtiles -l trails trails.geojson
>    ```
>    Host tiles via a static server (e.g., S3 + CloudFront) or a tile server
>    (e.g., `tileserver-gl`).
> 2. **Add vector tile source in MapLibre**:
>    ```js
>    map.addSource('trails', {
>      type: 'vector',
>      url: 'https://your-tiles.com/trails.json'
>    });
>    ```
>
> ### Recommendation Summary
>
> | Requirement                  | Recommendation                                    |
> | ---------------------------- | ------------------------------------------------- |
> | 8,000 trail segments         | **Use vector tiles** (via `tippecanoe`)           |
> | Click to show name/distance  | Supported in both, but faster with vector tiles   |
> | Basemap with terrain & roads | Use a vector basemap like Thunderforest or Stadia |

Judge note: The model lists GeoJSON tradeoffs as a formality before jumping to
"vector tiles are strongly recommended." It never explains why GeoJSON is a defensible
choice here — specifically that click interactions benefit from full client-side attribute
access and that geometry optimization can keep load time acceptable. It also doesn't
describe the combination pattern (hosted basemap style URL + GeoJSON overlay) as the
primary approach. Score 0.50 reflects partial credit for identifying some tradeoffs.

</details>

<details>
<summary>With-skill response (score: 1.00 — PASS)</summary>

> For your use case with **8,000 hiking trail segments** and **interactive
> click-to-inspect functionality**, you can **safely use GeoJSON** as your data source
> in MapLibre — no vector tiles are needed.
>
> ### You Can Use GeoJSON (Recommended)
>
> Your dataset is **within the practical limits** of GeoJSON in MapLibre:
>
> - **8,000 features** is in the **"lag zone"** but **manageable** with optimization.
> - You need **click interaction** to show trail name and distance — GeoJSON makes this
>   easy because features are fully accessible client-side.
> - You don't need zoom-dependent generalization or dynamic tile generation.
>
> With some optimizations (see below), GeoJSON will load in **1–3 seconds** on most
> devices and support smooth interaction.
>
> ### Optimization Tips for 8,000 GeoJSON Features
>
> 1. **Simplify geometries** — use Mapshaper with a 1–5 meter tolerance; can cut file
>    size 50–80% with minimal visual impact.
> 2. **Reduce coordinate precision** — round to 5–6 decimal places (≈1–10 cm).
> 3. **Compress** — serve as `.geojson.gz` or Brotli; typically reduces size 75–90%.
> 4. **Load asynchronously** — let the basemap load first, then add the trails.
>
> ### Basemap: Use a Hosted Vector Tile Service
>
> For terrain and roads, use a **hosted vector tile basemap**:
>
> - **[OpenFreeMap](https://openfreemap.org/)** (free, no key required):
>   ```js
>   map.setStyle('https://tiles.openfreemap.org/styles/liberty');
>   ```
>
> ### Setup Example
>
> ```js
> map.on('load', () => {
>   map.addSource('trails', {
>     type: 'geojson',
>     data: '/path/to/trails-optimized.geojson',
>     generateId: true
>   });
>
>   map.addLayer({ id: 'trails', type: 'line', source: 'trails', paint: { 'line-color': '#1f78b4', 'line-width': 3 } });
>
>   map.on('click', 'trails', (e) => {
>     const feature = e.features[0];
>     new maplibregl.Popup()
>       .setLngLat(e.lngLat)
>       .setHTML(
>         `<strong>${feature.properties.name}</strong><br>
>                 ${feature.properties.distance_m / 1000} km`
>       )
>       .addTo(map);
>   });
> });
> ```
>
> ### When You'd Need Vector Tiles
>
> Only if the GeoJSON file exceeds ~5 MB after optimization, you need zoom-dependent
> generalization, or you expect 10× more data in the future.

</details>

---

## Test 2 — Implicit: Custom style layers invisible against hosted tiles

**Question:**

> I'm using a hosted tile provider's style URL and everything looks great. But when I
> try to write my own custom style against the same tile source, none of my layers
> show up.

**What the skill teaches:** The issue is `source-layer` name mismatch. Every layer in a
custom style must reference `source-layer` names exactly as they appear in the tile
source's schema. The TileJSON `vector_layers` field is the authoritative list. The
provider's pre-built style already has these matched; building a custom style means
you need to know the schema.

<details>
<summary>Baseline response (score: 0.00 — FAIL)</summary>

> This is a common issue when working with custom map styles. Here are the most likely
> causes and solutions:
>
> ## 1. Source Configuration Issues
>
> Make sure your source is properly defined in your custom style:
>
> ```json
> {
>   "sources": {
>     "your-source": {
>       "type": "raster",
>       "tiles": ["https://your-tile-provider/{z}/{x}/{y}.png"],
>       "tileSize": 256
>     }
>   }
> }
> ```
>
> ## 2. Layer Configuration Problems
>
> Your layers need to reference the correct source. Check:
>
> - `source` name matches exactly what you defined
> - `type` is `"raster"` for raster tiles (not `"vector"`)
> - Layer is not filtered by zoom levels that exclude your current view
>
> ## 3. URL Template Issues
>
> Verify the tile URL pattern — test the URL directly in your browser.
>
> ## 4. CORS and Access Issues
>
> The tile provider might block requests from your domain.
>
> ## Debugging Steps:
>
> 1. Check browser developer tools for network errors
> 2. Compare with working style — inspect the hosted style JSON
> 3. Start simple — create minimal style with just one layer

Judge note: The response focuses entirely on raster tile configuration, URL formats, and
CORS — none of which are the cause. It never mentions `source-layer`, `vector_layers`,
or the schema mismatch problem that is the actual root cause for vector tiles.

</details>

<details>
<summary>With-skill response (score: 1.00 — PASS)</summary>

> You're encountering a very common issue when transitioning from using a **hosted style
> URL** to writing a **custom style** against the same tile source. The problem is almost
> certainly that **your layer definitions don't match the tile schema** — specifically,
> the `source-layer` names expected by the tiles.
>
> ### Why Your Layers Don't Show Up
>
> When you use a hosted style URL (e.g., `https://tiles.openfreemap.org/styles/liberty`),
> that JSON file already contains:
>
> - Correct `source-layer` names that exactly match what's in the vector tiles
> - Proper `minzoom`/`maxzoom`, filtering, and styling
>
> When you write your own style, you must **manually replicate** this schema alignment.
> If your `source-layer` name is even slightly off (e.g., `roads` vs `transportation`),
> MapLibre won't find any data — and your layer will appear blank.
>
> ### Step 1: Check the TileJSON `vector_layers`
>
> Most providers expose a TileJSON endpoint that includes a `vector_layers` array listing
> every available `source-layer` name:
>
> ```json
> "vector_layers": [
>   { "id": "landuse", "fields": { "class": "String" } },
>   { "id": "transportation", "fields": { "class": "String" } },
>   { "id": "building", "fields": {} }
> ]
> ```
>
> Use these exact `id` values as your `source-layer` in your style layers.
>
> ### Step 2: Match `source-layer` Exactly
>
> ```json
> // Wrong:
> { "source-layer": "roads" }    // ← not a real layer in OpenMapTiles
>
> // Correct:
> { "source-layer": "transportation" }
> ```
>
> ### Step 3: Confirm the Schema
>
> Different providers use different schemas — OpenFreeMap/MapTiler use OpenMapTiles,
> Protomaps uses its own schema, Shortbread is a third option. Check documentation or
> TileJSON to confirm which schema your tiles use.

</details>

---

## Test 3 — Anti-pattern: addLayer covering basemap labels

**Question:**

> I added my GeoJSON data layer with map.addLayer() and it shows up, but it's drawn on
> top of all the street names and labels. How do I fix the layer order?

**What the skill teaches:** `map.addLayer()` without a second argument appends the layer
above everything, including labels. The correct fix is programmatic: find the first layer
with `type === 'symbol'` in the style and pass its ID as the second argument to
`addLayer()`. This works across any basemap style; hardcoded label layer IDs like
`'road-label'` are provider-specific and break when you switch styles.

<details>
<summary>Baseline response (score: 0.00 — FAIL)</summary>

> The issue depends on which mapping library you're using. Here are solutions for the
> most popular ones:
>
> ## Mapbox GL JS
>
> Use the `before` parameter in `addLayer()`:
>
> ```javascript
> map.addLayer(
>   {
>     id: 'your-geojson-layer',
>     type: 'fill',
>     source: 'your-geojson-source'
>   },
>   'road-label'
> ); // This places it before road labels
>
> // Common layer IDs to target:
> // 'road-label', 'water-label', 'settlement-label', 'poi-label'
> ```
>
> ## Leaflet
>
> Layer order is determined by the order you add layers and their zIndex.
>
> ## General Tips
>
> For Mapbox: the most reliable approach is to insert your layer before the first label
> layer — look for layers with "label" in the ID.

Judge note: The response treats this as a multi-library question (Mapbox, Leaflet,
Google Maps) and leads with hardcoded label layer IDs like `'road-label'` as the primary
answer. It never explains that `map.addLayer()` appends above everything by default, and
never shows the programmatic `find(l => l.type === 'symbol')` pattern that works across
any style.

</details>

<details>
<summary>With-skill response (score: 1.00 — PASS)</summary>

> This is a very common issue when adding custom data layers to a MapLibre map. By
> default, `map.addLayer()` adds your layer **on top of everything else**, which means
> it covers up labels like street names and place names.
>
> ### Solution: Insert Your Layer Before the First Symbol Layer
>
> ```javascript
> map.on('load', () => {
>   map.addSource('my-data', {
>     type: 'geojson',
>     data: '/path/to/your-data.geojson'
>   });
>
>   // Find the ID of the first symbol layer (labels)
>   const firstSymbolId = map.getStyle().layers.find((layer) => {
>     return layer.type === 'symbol';
>   })?.id;
>
>   // Insert your layer before the first symbol layer
>   map.addLayer(
>     {
>       id: 'my-data-layer',
>       type: 'circle',
>       source: 'my-data',
>       paint: { 'circle-color': '#f00', 'circle-radius': 6 }
>     },
>     firstSymbolId
>   ); // ← second argument controls insertion point
> });
> ```
>
> ### How It Works
>
> - `map.addLayer(layer, beforeId)` inserts your layer just before `beforeId` in draw
>   order.
> - Basemap styles draw layers bottom-to-top: background → land/water → roads → symbol
>   layers (labels).
> - By finding the first `symbol` layer, your data appears above roads and polygons but
>   below all text labels — readable on any basemap style.
>
> ### Why Not Hardcode a Label Layer ID?
>
> IDs like `'road-label'` are specific to one provider's style. The programmatic
> approach works across OpenFreeMap, MapTiler, your own custom style, or any other
> basemap.

</details>

---

## Test 4 — Implicit: No text labels in custom style

**Question:**

> I set up a custom MapLibre style that points to my self-hosted tile server. The map
> loads and the tiles are rendering correctly, but there are no text labels anywhere on
> the map. What am I missing?

**What the skill teaches:** Missing labels when tiles render correctly is almost always
a missing `glyphs` property at the **root** of the style JSON. MapLibre does not include
fonts; text rendering requires an SDF font endpoint at `{fontstack}/{range}.pbf`.
CORS and tile loading are not the cause — the user has confirmed tiles work.

<details>
<summary>Baseline response (score: 0.00 — FAIL)</summary>

> If your custom MapLibre map is loading tiles but missing text labels, here are the
> most common causes and solutions:
>
> ## 1. Check Your Style JSON Configuration
>
> The most likely issue is that your style JSON isn't properly defining the text layers:
>
> ```json
> {
>   "layers": [
>     {
>       "id": "place-label",
>       "type": "symbol",
>       "source": "your-tiles",
>       "source-layer": "places",
>       "layout": { "text-field": ["get", "name"], "text-size": 12 }
>     }
>   ]
> }
> ```
>
> ## 2. Verify Source Layer Names
>
> The `source-layer` property must exactly match the layer names in your vector tiles.
>
> ## 3. Check Tile Server Configuration
>
> Ensure text data (names, labels) is included in the tiles, the `name` field exists,
> and you're not filtering out label layers.
>
> ## 4. Font Configuration
>
> MapLibre needs fonts to render text:
>
> ```javascript
> // Or ensure your style includes font references
> "glyphs": "https://your-server.com/fonts/{fontstack}/{range}.pbf"
> ```
>
> The most common issue is mismatched `source-layer` names. Double-check what layers
> your tile server is actually producing.

Judge note: Glyphs appear as a buried item in section 4, after layer definitions and
tile server configuration. The response never explains that `glyphs` must be a
**root-level** property in the style, or that its absence is the primary cause when
tiles are already rendering correctly. The model concludes with `source-layer` mismatch
as the most likely cause — the opposite of what the scenario calls for.

</details>

<details>
<summary>With-skill response (score: 1.00 — PASS)</summary>

> The fact that your tiles are rendering but **text labels are missing** is a classic
> symptom of a missing or misconfigured **glyphs** resource in your MapLibre style.
>
> ### You Need to Configure Glyphs
>
> MapLibre does **not** include fonts by default. Text labels require SDF (Signed
> Distance Field) font stacks served via a `glyphs` URL. Even if your vector tiles
> contain text data (`name`, `ref`, etc.), MapLibre **cannot render labels** without
> access to the corresponding glyphs.
>
> Add a `glyphs` property at the **root** of your style JSON:
>
> ```json
> {
>   "version": 8,
>   "sources": {
>     "my-tiles": {
>       "type": "vector",
>       "url": "http://localhost:3000/tiles.json"
>     }
>   },
>   "glyphs": "https://your-server.com/fonts/{fontstack}/{range}.pbf",
>   "layers": [ ... ]
> }
> ```
>
> ### Where to Get Glyphs
>
> You can reuse a public glyph set rather than hosting your own:
>
> - **OpenMapTiles fonts** (free, ODbL-compatible):
>   ```
>   "glyphs": "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf"
>   ```
> - **Protomaps fonts** (free, MIT):
>   ```
>   "glyphs": "https://cdn.protomaps.com/fonts/{fontstack}/{range}.pbf"
>   ```
>
> Or generate your own with `fontnik`, `gulper`, or `fontserver`.
>
> ### Check if You Also Need Sprites
>
> If your style uses icon symbols (airports, parks, POIs), you also need a `sprite`
> property at the root of the style pointing to a spritesheet JSON + PNG pair.

</details>

---

## Test 5 — Negative: Small dataset, no tile server needed

**Question:**

> I'm building a store locator for about 50 locations across the US. Do I need to set
> up a vector tile server for this?

This is a negative test — 50 locations is well within GeoJSON's practical limits and a
tile server is unnecessary infrastructure. An over-eager skill would incorrectly push
vector tile advice.

Both runs: **PASS 1.00** — the skill does not over-apply. Both baseline and with-skill
responses correctly say no tile server is needed and recommend GeoJSON directly.
