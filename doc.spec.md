# Internal Module Specifications (`doc.spec.md`)

Implementation specs for the five internal modules: Event System, DOMObserver, TexturePipeline, WebGLRenderer, and ShaderSystem. Each section is sufficient to implement or modify its module independently. For the public API surface, see `doc.overview.md`. For event payload shapes, see `doc.reference.md`.

---

# Part 0: Event System

## Overview

The Event System is a module-level pub/sub emitter defined at the top of the outer IIFE.
It requires no explicit `init()` call — its state variables are created at parse time and
are available to all subsystems via closure. `on` and `off` are attached to
`window.WebGLImageEnhancer` as public methods; `_emit` and `_listeners` are never exposed.

## State

```js
var _EVENTS = {
  SCROLL: 'scroll', ELEMENT_ENTER: 'elementEnter', ELEMENT_LEAVE: 'elementLeave',
  ELEMENT_UPDATE: 'elementUpdate', TILES_DISPATCHED: 'tilesDispatched',
  TILES_READY: 'tilesReady', TILES_ERROR: 'tilesError',
  TEXTURE_CREATED: 'textureCreated', TEXTURE_DESTROYED: 'textureDestroyed'
};
var _listeners = {};  // { eventName: [fn, fn, ...] }
```

## Functions

* `on(event, fn)` — validates `event` against `_EVENTS`, throws on unknown names, pushes `fn`.
* `off(event, fn)` — removes `fn` by reference from the listener array.
* `_emit(event, payload)` — calls all registered handlers in order; swallows handler errors.

## Lifecycle

`_listeners` is reset to `{}` inside `CoreAPI.destroy()`, clearing all handlers between
init/destroy cycles.

For full payload shapes, see `doc.reference.md`.

---

# Part 1: DOM Observer

## Overview

The DOM Observer module monitors the HTML document for target elements, tracks their visibility relative to the viewport, and detects layout shifts. It acts as the trigger mechanism for the JIT Texture Pipeline — ensuring WebGL operations occur only when and where needed, and that GPU memory is freed when elements leave the active zone.

## 1. The Scout (IntersectionObserver)

Monitors all elements matching `targetSelector`.

* **Configuration:** Initialized with a large `rootMargin` (e.g. `2000px`) on both axes, creating a safe zone larger than the viewport so tiles begin loading before an element is visible.
* **Enter:** Calls `element.getBoundingClientRect()`, resolves the image source and shader name, dispatches to `onElementEnter`. Also fires the `elementEnter` public event.
* **Exit:** Dispatches to `onElementLeave`, fires the `elementLeave` public event. Textures are deleted from VRAM and the element leaves the active queue.

## 2. Layout Resilience

### ResizeObserver

* Attached only to elements inside the active safe zone.
* On dimension change, re-calls `getBoundingClientRect()` and dispatches `onElementUpdate`, triggering TexturePipeline to regenerate tiles.
* Also fires the `elementUpdate` public event.

### MutationObserver

* Watches `document.body` for added and removed nodes.
* New elements matching `targetSelector` are handed to the IntersectionObserver automatically.
* Removed tracked elements trigger `onElementLeave` immediately to prevent VRAM leaks, and fire `elementLeave`.

## 3. Scroll Sync

A passive `scroll` listener on `window`. On each event, reads `window.scrollX` / `window.scrollY`, calls `onScroll(sx, sy)` (which forwards to the renderer as uniforms), and fires the `scroll` public event. Does not read the DOM or calculate rects.

## 4. Window Resize

A `resize` listener on `window`. The module maintains a `_zoneElements` set — a subset of `_trackedElements` containing only elements currently inside the active safe zone (i.e. those being observed by `ResizeObserver`). Elements are added to `_zoneElements` on IntersectionObserver enter and removed on exit or DOM removal.

On each `resize` event, schedules a 150 ms trailing debounce. When the timer fires, iterates `_zoneElements`, calls `getBoundingClientRect()` on each, and dispatches `onElementUpdate` + fires `elementUpdate`. This re-anchors tile `worldX`/`worldY` coordinates after any layout shift that moves elements without changing their dimensions — for example, a centred column whose horizontal margins change with viewport width.

The `ResizeObserver` callback is also debounced (150 ms per element, via `_elementResizeTimers`) for the same reason: both sources fire at high frequency during a resize drag, and each `onElementUpdate` triggers a worker dispatch. Without debouncing, a single resize gesture produces O(N) redundant worker jobs; with it, only one dispatch fires after the gesture settles.

The `ResizeObserver` handles dimension changes; this handler covers position-only shifts that `ResizeObserver` would otherwise miss.

## 5. Internal Dispatch Contract

Internal callbacks passed in at init time. These are synchronous handoffs to CoreAPI — distinct from the public events fired alongside them.

* `onElementEnter(element, domRect, src, shaderName)`
* `onElementUpdate(element, newDomRect)`
* `onElementLeave(elementId, element)`
* `onScroll(scrollX, scrollY)`

---

# Part 2: Texture Pipeline

## Overview

The Texture Pipeline receives `DOMRect` dimensions and image URLs from DOMObserver, calculates the 2D tile grid needed to respect GPU hardware limits, and asynchronously decodes image chunks into WebGL textures via a web worker. It owns all VRAM memory management.

## 1. Hardware Interrogation

On startup, queries `gl.getParameter(gl.MAX_TEXTURE_SIZE)`. Caps the result at `Math.min(glLimit, 4096)` for mid-tier mobile stability. This value becomes `TILE_SIZE` for the session.

## 2. The 2D Grid Math (The Slicer)

On `onElementEnter`:

1. Snap the element's four edges to integer physical pixels: `physLeft = Math.round(rect.left * dpr)`, etc. Derive `physWidth = physRight - physLeft`, `physHeight = physBottom - physTop`.
2. `cols = Math.ceil(physWidth  / TILE_SIZE)`
3. `rows = Math.ceil(physHeight / TILE_SIZE)`
4. Nested loop over rows × cols produces a `tiles[]` array.

Snapping edges before computing tile dimensions eliminates double-rounding error. On fractional-DPR displays (e.g. Windows at 125 % or 150 % scaling), computing dimensions in CSS px space and multiplying by dpr afterwards can produce a quad 1 physical pixel narrower than the element, visible as a transparent fringe on the edges.

**Tile Object fields:**

* `tileIndex`: Sequential index within the element's array.
* `sourceX`, `sourceY`: Pixel offset to extract from the scaled source image, in physical pixels.
* `width`, `height`: Tile dimensions in physical pixels (edge tiles may be smaller than `TILE_SIZE`).
* `worldX`, `worldY`: Absolute page coordinates in **physical pixels** (`physLeft + physScrollX + sourceX`, `physTop + physScrollY + sourceY`). Used directly as vertex buffer values with no further `* dpr` scaling.
* `texture`: Starts `null`; filled in-place after worker returns a decoded bitmap.

## 3. The Asynchronous Factory (Web Worker)

All image fetching and bitmap decoding is delegated to a worker loaded from a Blob URL. A concurrency queue limits simultaneous jobs to `maxConcurrency`. When a slot frees on `TILES_READY` or `TILES_ERROR`, the next queued job dispatches.

Once `ImageBitmap` objects arrive, the pipeline calls `gl.createTexture()`, uploads via `gl.texImage2D()`, applies `CLAMP_TO_EDGE` + `LINEAR` filtering, then calls `bitmap.close()` to free the CPU copy.

## 4. VRAM Memory Management (The Annihilator)

* **Registry:** `elementId → [WebGLTexture]`.
* **Cleanup:** On `onElementLeave`, all textures for the element are deleted via `gl.deleteTexture()` and removed from the registry. Fires `textureDestroyed`.
* **Queue Cancellation:** If an element exits before its job resolves, the job is marked `aborted`. Arriving bitmaps are `close()`d with no GPU upload.
* **Stale Job Detection:** Each job gets a unique `jobId` (`elementId + '-' + timestamp`). Responses with a mismatched `jobId` are discarded.

## 5. Worker Message Protocol

### Main → Worker: `PROCESS_TILES`

```js
{
  type:          'PROCESS_TILES',
  jobId:         String,
  url:           String,
  displayWidth:  Number,  // element's display width in physical pixels (physWidth)
  displayHeight: Number,  // element's display height in physical pixels (physHeight)
  tiles: [
    { tileIndex: Number, sourceX: Number, sourceY: Number,
      width: Number, height: Number }
  ]
}
```

`displayWidth` and `displayHeight` are the element's physical pixel dimensions (CSS dimensions × `devicePixelRatio`, snapped to integers), not CSS pixels and not the image's natural/intrinsic dimensions. Tile `sourceX`, `sourceY`, `width`, and `height` are all in this same physical-pixel coordinate space.

The worker fetches the URL as a Blob, then **first** resizes the full image to `displayWidth × displayHeight` physical pixels via `createImageBitmap(blob, { resizeWidth, resizeHeight })`. Tiles are then cropped from that scaled bitmap using the physical-pixel coordinates. This ensures the correct region of the image is sampled regardless of the image's natural size, and that the resulting bitmaps are at the correct resolution for 1:1 GPU rendering with no upscaling blur. The scaled full bitmap is closed after all tile crops complete.

### Worker → Main: `TILES_READY`

```js
{
  type:    'TILES_READY',
  jobId:   String,
  results: [ { tileIndex: Number, bitmap: ImageBitmap } ]
}
```

Sent with a transfer list of all `ImageBitmap` objects (zero-copy). Main thread uploads each, then calls `bitmap.close()`.

### Worker → Main: `TILES_ERROR`

```js
{
  type:  'TILES_ERROR',
  jobId: String,
  error: String
}
```

Fetch or decode failed. Main thread logs, fires `tilesError`, frees the job slot.

## 6. Events Fired

See `doc.reference.md` for full payload shapes.

* `tilesDispatched` — before job is posted to worker
* `tilesReady` — on `TILES_READY`, before texture upload
* `tilesError` — on `TILES_ERROR`
* `textureCreated` — after each tile uploads to GPU
* `textureDestroyed` — after all textures for an element are deleted

---

# Part 3: WebGL Renderer

## Overview

The WebGL Renderer is the display engine. It operates independently of the DOM, relying on DOMObserver (scroll position) and TexturePipeline (textures and coordinates). It manages a single full-screen transparent canvas, runs the sequential draw loop, and applies vertex math to keep GPU quads synchronized with the scroll position.

## 1. The Transparent Stage (Canvas Setup)

* **Element:** A single `<canvas>` appended to `document.body`.
* **CSS:** `position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 9999;`
* **Context:** Requests WebGL2 (`webgl2`) first, falls back to WebGL1 (`webgl`). Both initialized with `{ alpha: true, premultipliedAlpha: false }`.
* **Resolution Sync:** On `window` resize, sets `canvas.width = Math.round(innerWidth * devicePixelRatio)` and updates `gl.viewport()`. Element position re-measurement on resize is handled by DOMObserver (see Part 1 § 4).

## 2. The Render Loop

A continuous `requestAnimationFrame` loop. Every frame:

1. `gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);`
2. Iterate `activeElements` Map.
3. Per element: call `ShaderSystem.getProgram(shaderName)`. Call `gl.useProgram()` if the program changed since the last tile.
4. Set standard uniforms: `u_resolution`, `u_scrollX * dpr`, `u_scrollY * dpr`, `u_time`, `u_image`.
5. Call `ShaderSystem.applyUniforms(shaderName)` to dispatch any custom uniform values stored for this shader.
6. Per tile: if `tile.texture` is non-null, write the quad to the position buffer using `tile.worldX`, `tile.worldY`, `tile.width`, `tile.height` directly (already physical pixels) and call `gl.drawArrays(gl.TRIANGLES, 0, 6)`.

Sequential texture swapping keeps usage within `MAX_TEXTURE_IMAGE_UNITS` on all devices.

## 3. Vertex Shader & Scroll Synchronization

Tile positions are computed once at upload time and never recalculated on scroll. The GPU shifts quads each frame via uniforms:

```glsl
vec2 viewportPos = a_position - vec2(u_scrollX, u_scrollY);
vec2 clipSpace   = (viewportPos / u_resolution) * 2.0 - 1.0;
gl_Position      = vec4(clipSpace.x, -clipSpace.y, 0.0, 1.0);
```

## 4. Shader Program Management

The Renderer does not compile or cache shaders — that belongs to ShaderSystem (Part 4 of this document). The Renderer calls `ShaderSystem.getProgram(name)` to retrieve a pre-compiled `{ program, locs }` object, then calls `gl.useProgram()` and binds uniforms from the cached `locs`. If `getProgram` returns null, the element is skipped for that frame.

---

# Part 4: Shader System

## Overview

ShaderSystem compiles and caches `WebGLProgram` instances, and defines the Uniform Contract that all fragment shaders must satisfy. It is the only module that calls `gl.createProgram()` or `gl.compileShader()`.

## 1. The Uniform Contract

Every custom fragment shader registered with the library must declare the following variables:

```glsl
// The current 2D grid tile texture
uniform sampler2D u_image;

// Canvas dimensions in physical pixels (width, height)
uniform vec2 u_resolution;

// Continuous time in seconds since init (optional — for animated effects)
uniform float u_time;

// Current scroll offset in physical pixels (optional — for scroll-relative effects)
uniform float u_scrollX;
uniform float u_scrollY;

// Interpolated texture coordinate from the vertex shader
varying vec2 v_texCoord;
```

`u_scrollX` and `u_scrollY` are set by the renderer's RAF loop each frame and available to both the vertex and fragment stages, though not typically needed in fragment shaders.

## 2. Built-in Shader: `color-pop`

The default shader. Boosts saturation and brightness via HSV conversion.

```glsl
precision mediump float;
uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_scrollX;
uniform float u_scrollY;
varying vec2 v_texCoord;

// rgb2hsv / hsv2rgb helpers

void main() {
    vec4 color = texture2D(u_image, v_texCoord);
    if (color.a < 0.001) { gl_FragColor = color; return; }

    vec3 hsv = rgb2hsv(color.rgb);
    hsv.y = clamp(hsv.y * 1.5,  0.0, 1.0);  // saturation boost
    hsv.z = clamp(hsv.z * 1.05, 0.0, 1.0);  // brightness lift

    gl_FragColor = vec4(hsv2rgb(hsv), color.a);
}
```

## 3. Per-Shader Uniform Store

ShaderSystem maintains a separate value store alongside `_programs`:

```js
var _uniformValues = {};
// Shape at runtime: { 'color-pop': { u_saturation: 1.5, u_brightness: 1.05 }, ... }
```

### `setUniforms(name, values)`

Merges `values` into `_uniformValues[name]`, creating the entry if absent:

```js
if (!_uniformValues[name]) _uniformValues[name] = {};
for (var k in values) {
  if (values.hasOwnProperty(k)) _uniformValues[name][k] = values[k];
}
```

This is a merge, not a replace. Callers may push a single key without disturbing others. May be called before the shader is compiled — the values are stored immediately and will be applied once the shader becomes active.

### `applyUniforms(name)` (called by WebGLRenderer)

Reads `_programs[name].extraLocs` and `_uniformValues[name]`, then dispatches each stored value to the GPU via the appropriate `gl.uniform*` call. This function is called by WebGLRenderer once per program-switch in the draw loop (step 5), while the shader program is already bound.

If `_uniformValues[name]` has no entry for a given uniform in `extraLocs`, that uniform is skipped (its previous GPU value persists — typically whatever the GLSL default is, i.e. zero).

**GL type dispatch table:**

| `gl.getActiveUniform` type constant | `gl.uniform*` call |
|---|---|
| `gl.FLOAT` | `gl.uniform1f(loc, val)` |
| `gl.FLOAT_VEC2` | `gl.uniform2fv(loc, val)` |
| `gl.FLOAT_VEC3` | `gl.uniform3fv(loc, val)` |
| `gl.FLOAT_VEC4` | `gl.uniform4fv(loc, val)` |
| `gl.INT` | `gl.uniform1i(loc, val)` |
| `gl.BOOL` | `gl.uniform1i(loc, val ? 1 : 0)` |

Types not in this table are silently skipped. The dispatch switch uses the integer type constants returned by `gl.getActiveUniform`, not string names.

## 4. Custom Uniform Location Discovery (`extraLocs`)

When a shader program is compiled and linked, ShaderSystem interrogates all active uniforms via GL reflection to discover custom uniforms — those beyond the standard Uniform Contract set. This avoids requiring callers to re-declare uniform names separately.

```js
var standardNames = {
  u_image: true, u_resolution: true, u_time: true,
  u_scrollX: true, u_scrollY: true
};

var extraLocs = {};
var count = _gl.getProgramParameter(prog, _gl.ACTIVE_UNIFORMS);
for (var i = 0; i < count; i++) {
  var info = _gl.getActiveUniform(prog, i);
  if (!info || standardNames[info.name]) continue;
  extraLocs[info.name] = {
    loc:  _gl.getUniformLocation(prog, info.name),
    type: info.type
  };
}
```

The resulting `extraLocs` object is stored on the program entry: `_programs[name].extraLocs = extraLocs`. `applyUniforms` reads from this map each frame to know which `gl.uniform*` call to use for each custom uniform.

## 5. DOM to Shader Mapping

The library reads `data-shader` directly from DOM elements. If absent, `defaultShader` from the config is used.

```html
<img class="webgl-enhance" src="image.jpg" />  <!-- uses defaultShader -->
<img class="webgl-enhance" data-shader="grayscale" src="image.jpg" />
<div class="webgl-enhance" data-shader="color-pop"
     style="background-image: url('hero.png')"></div>
```

## 6. Custom Shader Registration

```js
WebGLImageEnhancer.registerShader('grayscale', fragSrc);
```

**Internal flow:**

1. CoreAPI delegates to `ShaderSystem.register(name, fragSrc)`.
2. ShaderSystem compiles `fragSrc` against the standard vertex shader via `gl.createProgram()`.
3. On failure: warning logged, shader not cached. Affected elements fall back to `defaultShader`.
4. On success: compiled `WebGLProgram`, cached standard attribute/uniform locations, and discovered `extraLocs` (§ 4) stored under `name`.
5. During the draw loop, WebGLRenderer calls `ShaderSystem.getProgram(name)` and binds the result; then calls `ShaderSystem.applyUniforms(name)` to push custom values.

ShaderSystem owns compilation, caching, and custom uniform dispatch. WebGLRenderer owns program binding and draw calls.
