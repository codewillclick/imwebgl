# Build & Test Harness (`doc.build.md`)

This file covers the build script, the test directory structure, and the debug UI overlay provided by `imwebgl.js`. For the event system that powers the debug UI, see `doc.reference.md`.

---

# Part 1: Build System

## Overview

The project has no compilation step in the traditional sense. The output is a single flat JS file (`imwebgl.js`) that is inlined directly into a test HTML page. The build script assembles that page from whatever image assets are present in the `tests/` directory.

## Source Layout

```
src/
  imwebgl.core.js          ← hand-edited engine source (no shader GLSL)
shaders/
  color-pop/
    frag.glsl              ← GLSL fragment shader source; injected into imwebgl.js
    ui.js                  ← panel builder for this shader; injected into imwebgl.js
  curves/
    frag.glsl
    ui.js
config.json                ← optional; baked into imwebgl.js at build time (see below)
build.sh                   ← assembles both output files
imwebgl.js                 ← generated; do not edit directly
tests/
  index.html               ← generated; do not edit directly
  001.jpg  002.jpg  ...    ← image assets; not generated
```

## `config.json`

An optional JSON file at the project root. When present, its values are baked into `imwebgl.js` as a `_CFG` object during the build step, replacing the compiled-in defaults. When absent, `build.sh` emits the same default values inline so the output is always valid.

### Knobs

| Key | Default | Affects |
|---|---|---|
| `targetSelector` | `".webgl-enhance"` | CSS selector passed as `init()` default |
| `defaultShader` | `"color-pop"` | Shader applied when element has no `data-shader` |
| `maxConcurrency` | `2` | Worker job concurrency ceiling |
| `rootMargin` | `"2000px"` | IntersectionObserver pre-load margin |
| `tileSize` | `4096` | Max tile dimension (CSS px); clamped to `gl.MAX_TEXTURE_SIZE` at runtime |
| `resizeDebounceMs` | `150` | Debounce delay on element resize and window resize events |
| `canvasZIndex` | `9999` | `z-index` of the WebGL overlay canvas |

The first four (`targetSelector`, `defaultShader`, `maxConcurrency`, `rootMargin`) can also be overridden at runtime by the caller via `WebGLImageEnhancer.init(config)`. The last three (`tileSize`, `resizeDebounceMs`, `canvasZIndex`) are build-time-only.

See `doc.shaders.md` for the shader module format.

## Output Files

| File | Source | Edit directly? |
|---|---|---|
| `imwebgl.js` | Assembled from `src/imwebgl.core.js` + `shaders/*/frag.glsl` + `shaders/*/ui.js` | No — generated |
| `tests/index.html` | Assembled from `imwebgl.js` + image scan | No — generated |
| `src/imwebgl.core.js` | Hand-edited engine | Yes |
| `shaders/*/frag.glsl` | Hand-edited GLSL per module | Yes |
| `shaders/*/ui.js` | Hand-edited panel builder per module | Yes |
| `tests/*.jpg` etc. | Test image assets | Drop files in, no editing |

## `build.sh`

A bash script at the project root producing both output files. Running it:

**Step 1 — Assemble `imwebgl.js`:**

1. Start with the contents of `src/imwebgl.core.js`.
2. Replace the sentinel `// @@CONFIG_INJECT@@` with a `var _CFG = {...}` declaration sourced from `config.json` (or built-in defaults if the file is absent). This must appear before any subsystem code that references `_CFG`.
3. Glob `shaders/*/frag.glsl` in filesystem order.
4. For each shader module found:
   a. Read the GLSL source and emit it as a JS string variable inside the engine IIFE, then call `ShaderSystem.register(name, src)` with the directory name as `name`.
   b. Immediately after, inject the contents of the corresponding `ui.js` verbatim inside the same IIFE. At this injection point all internal library functions are defined and accessible via closure.
5. The first shader module found becomes the `defaultShader` passed to `init()` (unless a `DEFAULT_SHADER` override constant is set at the top of `build.sh`).
6. Write the assembled output to `imwebgl.js`.

**Step 2 — Assemble `tests/index.html`:**

1. Scan `tests/` for image files with extensions: `jpg`, `jpeg`, `png`, `gif`, `webp`, `avif`.
2. For each image found, generate an `<img class="webgl-enhance">` element with a label.
3. Inline the assembled `imwebgl.js` inside a `<script>` tag.
4. Append a `<script>` block that calls `WebGLImageEnhancer.init()`.
5. Append a `<script>` block that places the panels — the shader panel is appended into the debug panel so they appear as one combined widget:
   ```js
   var _dbg = WebGLImageEnhancer.getDebugPanel();
   _dbg.appendChild(WebGLImageEnhancer.getShaderPanel());
   document.body.appendChild(_dbg);
   ```
6. Write the assembled output to `tests/index.html`.

**Usage:**

```bash
./build.sh
```

Then open `tests/index.html` in a browser.

## `tests/index.html` Structure

The generated page contains, in order:

* A sticky header identifying the page as a build render.
* A vertical gallery of all images found in `tests/`, each tagged with `class="webgl-enhance"`.
* The full inlined `imwebgl.js` source.
* `WebGLImageEnhancer.init()`.
* A script block placing `getDebugPanel()` and `getShaderPanel()` into the page.

## Adding Test Images

Drop any supported image file into `tests/` and re-run `build.sh`. The image will appear in the gallery automatically. Tall images simulating webtoon panels are the primary use case.

---

# Part 2: Debug UI Overlay

## Overview

`WebGLImageEnhancer.getDebugPanel()` returns a persistent debug UI panel that visualises the library's internal lifecycle in real time. Its purpose is to make invisible activity visible: when tiles are dispatched, which images are in the active zone, what the GPU memory state is, and where the viewport sits. It is wired entirely through the public event system (`on()`) and has no direct access to library internals beyond what the events expose.

The panel is a lazy singleton built inside `imwebgl.js`. The caller places it wherever is convenient — in `tests/index.html` it is appended to `document.body`, but it can be inserted into any container. See `doc.overview.md` for the `getDebugPanel()` API contract and `destroy()` interaction.

## Panel Layout

Fixed-position overlay anchored to the right side of the viewport. A controls row at the top, then three sections stacked vertically.

```
┌─────────────────────────────┐
│  [hide GL]                  │
├─────────────────────────────┤
│  VIEWPORT                   │
│  top:    1240px             │
│  bottom: 1920px             │
├─────────────────────────────┤
│  ELEMENTS                   │
│  ● wge-1  hero.jpg          │
│  ○ wge-2  panel2.jpg        │
│  ● wge-3  panel3.jpg        │
├─────────────────────────────┤
│  LOG                        │
│  [worker →] wge-3  4 tiles  │
│  [worker ←] wge-3  4 tiles  │
│  [vram +]   wge-3  tile 0   │
│  [vram +]   wge-3  tile 1   │
│  [vram -]   wge-2  x2       │
└─────────────────────────────┘
```

The LOG view should keep to the bottom of its scrollview, and for that matter be long enough to reach the bottom of the viewport.

Clicking anywhere in the VIEWPORT section collapses the panel to a small blank square, hiding all content from view. Clicking the square again expands it back to full layout. This lets the user tuck the panel out of the way without losing it entirely.

Collapsed state:

```
┌──┐
└──┘
```

A 93×93 px square (one third of the panel's 280 px width), transparent background — only the border is visible.

---

# Part 3: Shader Panel

## Overview

`WebGLImageEnhancer.getShaderPanel()` returns a `<div>` containing one bar per registered shader. It is a lazy singleton — built once on first call, same reference returned thereafter. The caller places it wherever convenient; in `tests/index.html` it is appended to `document.body` alongside the debug panel.

## Panel Layout

```
┌─────────────────────────────┐
│  ● color-pop                │
│    saturation: 1.50 [──●──] │
│    brightness: 1.05 [─●───] │
├─────────────────────────────┤
│  ○ grayscale                │
└─────────────────────────────┘
```

One bar per registered shader, in registration order. The active shader (equal to `defaultShader` from `init()` config) has a filled dot and is shown expanded with its uniform controls populated by its `ui.js` `buildFn`. All other shaders have a hollow dot and show only their name — no controls, no switching UI yet.

## Implementation Notes

* Built inside `imwebgl.js` as a lazy singleton (`_shaderPanel`). Built once on first `getShaderPanel()` call.
* Iterates `_shaderUIs` (the registry populated by `_registerShaderUI` calls from each `ui.js`) to know which shaders have panel builders.
* For the active shader, creates a container `<div>` and passes it to the registered `buildFn(container)`. The `buildFn` appends slider rows into it.
* For inactive shaders, renders a name bar only.
* Has no positioning of its own — it is a plain block element. In `tests/index.html` it is appended as a child of the debug panel (which is already fixed-positioned), so it appears as a natural continuation at the bottom of that panel.
* `pointer-events:auto` throughout — inherits from wherever the caller places it.
* Nulled by `destroy()` alongside `_debugPanel` — next call after `init()` rebuilds cleanly.


## Controls Row

A single row at the top of the panel containing interactive buttons. Because the panel itself has `pointer-events:none`, the controls row overrides this with `pointer-events:auto`.

### GL toggle button

A button labelled `hide GL` / `show GL` that toggles `display:none` on the library's WebGL canvas. Useful for comparing the raw image against the shader output without reloading.

* On click: find the library canvas (the `<canvas>` with `z-index:9999` appended to `body`). Toggle its `display` between `''` and `'none'`. Update button label to reflect the new state.
* The canvas reference is resolved lazily on first click, not at init time, to avoid a race with the library's own setup.

## Viewport Section

Displays current scroll position and visible range.

* `top` — `viewportTop` from the `scroll` event payload
* `bottom` — `viewportBottom` from the `scroll` event payload

Wired to: `scroll`. Also reads `window.scrollY` on page load to populate before the first scroll event.

**Click to collapse:** the entire viewport section is a click target (`pointer-events:auto; cursor:pointer`). Clicking it while the panel is expanded collapses the panel to a 93×93 px square (one third of its full width) and hides all sections. Clicking the square re-expands to the full layout. The collapse toggle has no effect on internal state — event subscriptions remain active while collapsed.

## Elements Section

A persistent list of all elements the library has ever seen, with a live active indicator.

* On `elementEnter`: add the element's `id` and filename of `src` to the list with a filled dot.
* On `elementLeave`: switch that entry to a hollow dot.
* Entries are never removed — they persist to show historical activity.

Wired to: `elementEnter`, `elementLeave`.

## Log Section

A scrolling log of worker and VRAM activity. New entries appear at the top. Capped at ~100 entries.

| Event | Log line |
|---|---|
| `tilesDispatched` | `[worker →] {id}  {tileCount} tiles` |
| `tilesReady` | `[worker ←] {id}  {tileCount} tiles` |
| `tilesError` | `[error]    {id}  {error}` |
| `textureCreated` | `[vram +]   {id}  tile {tileIndex}` |
| `textureDestroyed` | `[vram -]   {id}  x{tileCount}` |

Wired to: `tilesDispatched`, `tilesReady`, `tilesError`, `textureCreated`, `textureDestroyed`.

## Implementation Notes

* Implemented inside `imwebgl.js` as a lazy singleton (`_debugPanel`). Built once on first `getDebugPanel()` call; the same element reference returned on all subsequent calls.
* Creates its own DOM elements. Does not append itself to `document.body` — the caller places it.
* Uses `on(event, fn)` via closure for all subscriptions. Subscriptions are registered exactly once at build time. No direct access to internal state beyond event payloads.
* Style: `position:fixed; top:10px; right:10px; width:280px; border-radius:4px; overflow:hidden`. Content-height — no explicit height or flex layout on the outer panel.
* The LOG section has `max-height:300px; overflow-y:auto` so it scrolls independently without forcing the panel to full viewport height.
* **Collapse state:** local variables `_collapsed`, `_stashedChildren`, and `_expandedWidth` track state. `_expandedWidth` is captured from `panel.style.width` immediately after the panel is created, before any mutation. On collapse, all children are removed into `_stashedChildren` — including any externally-appended children like the shader panel — and `panel.style.width` is cleared so the panel has no explicit width; with no content it falls to the `min-width:93px` floor. `background:transparent` makes it invisible except for the border. On expand, children are re-appended in original order, `panel.style.width` is restored to `_expandedWidth`, and the background is restored. `vpSection` click triggers collapse with `e.stopPropagation()`; the panel's own click listener expands when collapsed.
* The ELEMENTS section has `max-height:120px; overflow-y:auto` for the same reason.
* `z-index` must exceed the library canvas (`9999`) — use `10001` or higher.
* `pointer-events:none` on the outer panel; the controls row and log section override with `pointer-events:auto`.
