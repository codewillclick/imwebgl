# imwebgl Overview (`doc.overview.md`)

This file covers the public API contract, the system architecture, and the rationale behind key design decisions. It is the starting point for anyone integrating or evaluating the library.

For the event payload reference, see `doc.reference.md`. For internal module implementation specs, see `doc.spec.md`. For the build and test harness, see `doc.build.md`.

---

# Part 1: Public API

## Initialization: `init(config)`

The primary entry point. Calling this method injects the global WebGL canvas, attaches the necessary DOM observers, and begins the Just-In-Time (JIT) texture pipeline.

### Configuration Object Properties:

* `targetSelector` *(String)*: CSS selector for elements to enhance. Supports `<img>` tags and elements with `background-image`. Default: `'.webgl-enhance'`.
* `maxConcurrency` *(Number)*: Maximum tile jobs the worker processes simultaneously. Default: `2`.
* `defaultShader` *(String)*: Shader applied when an element has no `data-shader` attribute. Default: `'color-pop'`.
* `rootMargin` *(String)*: IntersectionObserver margin — triggers the JIT pipeline before elements enter the viewport. Default: `'2000px'`.

These four values are also present in `config.json` and serve as the baked-in defaults that `init()` falls back to when no runtime value is supplied. The runtime call always wins over the baked value.

Three additional knobs exist only in `config.json` and cannot be overridden at runtime:

* `tileSize` *(Number)*: Max tile dimension in CSS pixels (clamped to `gl.MAX_TEXTURE_SIZE` at runtime). Default: `4096`.
* `resizeDebounceMs` *(Number)*: Debounce delay in milliseconds for element and window resize events. Default: `150`.
* `canvasZIndex` *(Number)*: `z-index` of the WebGL overlay canvas. Default: `9999`.

See `doc.build.md` for the full `config.json` reference.

### Example:

```html
<script src="imwebgl.js"></script>
<script>
  WebGLImageEnhancer.init({
    targetSelector: '.boost-colors, .hero-bg',
    maxConcurrency: 3,
    rootMargin: '1500px',
    defaultShader: 'saturation-boost'
  });
</script>
```

## Public Methods

### `registerShader(name, fragmentShaderSource)`

Registers a custom GLSL fragment shader. Elements reference it via `data-shader="name"`.

* **`name`** *(String)*: Unique identifier for the shader.
* **`fragmentShaderSource`** *(String)*: Raw GLSL. Must conform to the Uniform Contract in `doc.spec.md`.

### `setUniforms(name, values)`

Pushes custom uniform values into a named shader's per-frame value store. The renderer applies these values on every subsequent frame the shader is active.

* **`name`** *(String)*: The shader name as registered via `registerShader` or defined in a shader module directory.
* **`values`** *(Object)*: A plain object mapping GLSL uniform names to JS values. The call **merges** into the existing store — only the keys present in `values` are updated; all other stored values are left unchanged. May be called with a single changed key.

```js
WebGLImageEnhancer.setUniforms('color-pop', { u_saturation: 2.0 });
WebGLImageEnhancer.setUniforms('color-pop', { u_saturation: 1.5, u_brightness: 1.1 });
```

Values are applied to every element using that shader, globally. There is no per-element uniform override. `setUniforms` may be called before or after `init()` — values stored before compilation are applied when the shader first becomes active.

Supported JS value types and their GLSL correspondence: `Number` → `float` or `int`/`bool`; 2-element array → `vec2`; 3-element array → `vec3`; 4-element array → `vec4`. See `doc.shaders.md` Part 2 for the full type table.

### `getShaderPanel()`

Returns a `<div>` containing one collapsible bar per registered shader. The active shader (the `defaultShader` set in `init()`) is shown expanded with its live uniform controls; all other registered shaders appear as collapsed name-only bars. Switching the active shader at runtime is not yet supported.

The element is a lazy singleton — created on first call, the same reference returned on every subsequent call. The caller is responsible for placement. Safe to insert into any container.

### `getDebugPanel()`

Returns a `<div>` containing the live debug overlay: viewport scroll range, tracked element list, and a scrolling event log. All sections are wired to the public event system via `on()` — subscriptions are registered once on first call and never duplicated.

The element is a lazy singleton. On `destroy()`, the cached reference is nulled and all subscriptions are cleared along with `_listeners`; the next `getDebugPanel()` call after a fresh `init()` builds a new panel and re-registers subscriptions. See `doc.build.md` Part 2 for the full panel layout specification.

### `updateTargets()`

Forces an immediate re-scan of the DOM for elements matching `targetSelector`. The internal MutationObserver handles most dynamic insertions automatically; this method exists for manual overrides and complex SPA state changes.

### `destroy()`

Complete teardown:

* Disconnects all IntersectionObserver, ResizeObserver, and MutationObserver instances.
* Deletes all active VRAM textures via `gl.deleteTexture()`.
* Removes the `<canvas>` from the DOM.
* Clears all registered event handlers.
* Nulls the cached `_debugPanel` and `_shaderPanel` references so subsequent `getDebugPanel()` / `getShaderPanel()` calls after a fresh `init()` rebuild cleanly.

### `on(event, fn)` / `off(event, fn)`

Registers or removes a handler for a named lifecycle event. Throws on unknown event names. All handlers are cleared automatically on `destroy()`. See `doc.reference.md` for the full event manifest and payload shapes.

## Internal State (non-public)

* `activeElements`: A `Map` of DOM node → `{ id, shaderName, tiles, rect }`. The `tiles` array is shared by reference with TexturePipeline — texture handles are filled in-place as they resolve.
* `vramRegistry`: Lives inside TexturePipeline. Maps `elementId → [WebGLTexture]` for safe GPU memory cleanup.

---

# Part 2: Architecture

## Module Map

```
window.WebGLImageEnhancer  (CoreAPI)
        │
        ├── on() / off()        ← Event System (Section 2: _EVENTS, _listeners, _emit)
        │                          All modules fire events via _emit() closure.
        │                          DOMObserver and TexturePipeline are the primary emitters.
        ├── init()
        │     │
        │     ├── WebGLRenderer.init()    → creates <canvas>, acquires GL context
        │     ├── ShaderSystem.init()     → receives GL, compiles built-in shaders
        │     ├── TexturePipeline.init()  → receives GL, spawns web worker
        │     └── DOMObserver.init()      → attaches observers, begins scanning
        │
        ├── registerShader()    → ShaderSystem.register()
        ├── setUniforms()       → ShaderSystem.setUniforms()
        ├── updateTargets()     → DOMObserver.rescan()
        └── destroy()           → tears down in reverse init order; resets _listeners = {}
```

## Boot Order

The Event System (`_EVENTS`, `_listeners`, `on`, `off`, `_emit`) is initialized at
library parse time as module-level variables. It requires no explicit init call and is
available to all subsystems immediately via closure.

| Step | Module | Action |
|---|---|---|
| 1 | WebGLRenderer | Creates `<canvas>`, acquires WebGL2 context, starts RAF loop |
| 2 | ShaderSystem | Receives GL context, compiles `color-pop` built-in |
| 3 | TexturePipeline | Receives GL context, queries `MAX_TEXTURE_SIZE`, spawns worker |
| 4 | DOMObserver | Attaches observers and scroll listener; triggers initial DOM scan |

Teardown runs in reverse: DOMObserver → TexturePipeline → WebGLRenderer → ShaderSystem.
`destroy()` also resets `_listeners = {}`, clearing all registered event handlers.

## Data Flow

```
DOMObserver
    │  onElementEnter(el, rect, src, shader)
    │  onElementUpdate(el, rect)
    │  onElementLeave(id, el)
    │  onScroll(scrollX, scrollY)
    ▼
CoreAPI (_callbacks)
    │
    ├── onElementEnter ──► TexturePipeline.processElement()
    │                             │
    │                             ├── grid math → tile[]
    │                             ├── activeElements.set(el, { tiles, ... })
    │                             └── dispatch job → Worker
    │                                       │
    │                                   TILES_READY
    │                                       │
    │                                       └── _uploadTile() → tile.texture = WebGLTexture
    │
    ├── onElementUpdate ─► TexturePipeline.processElement()  (replaces prior job)
    │
    ├── onElementLeave ──► TexturePipeline.removeElement()   (deletes VRAM, aborts queue)
    │                  ──► activeElements.delete(el)
    │
    └── onScroll ────────► WebGLRenderer.updateScroll(sx, sy)
                                  │
                               u_scrollX / u_scrollY uniforms updated each RAF frame
```

## Rendering Data Path

```
tile.worldX / tile.worldY  (physical px, page-absolute, set once at processElement time)
        │
        │  (no further scaling — already physical pixels)
        ▼
vertex buffer (a_position)
        │
        │  − u_scrollX, u_scrollY  (physical px scroll, updated each RAF frame)
        ▼
clip space → gl_Position
```

Tile coordinates are never recomputed on scroll. Only the scroll uniforms change.

## Shared State

The `tiles` array is created by TexturePipeline and stored into `activeElements` by reference. TexturePipeline writes `tile.texture` in-place after GPU upload. WebGLRenderer reads `tile.texture` from the same objects. No copying occurs between modules.

## Event System

`_emit`, `_listeners`, `on`, and `off` are defined at the top of the outer IIFE, accessible to all subsystems via closure. DOMObserver and TexturePipeline call `_emit()` directly. See `doc.reference.md` for the full event reference.

## File Reference

| Doc | Covers |
|---|---|
| `doc.overview.md` | Public API, architecture, design decisions (this file) |
| `doc.reference.md` | Event system — manifest, payloads, emitter implementation |
| `doc.spec.md` | Internal module specs — DOMObserver, TexturePipeline, WebGLRenderer, ShaderSystem |
| `doc.build.md` | build.sh, source layout, tests/ harness, debug UI overlay |
| `doc.shaders.md` | Shader module format, custom uniforms, `setUniforms`, `color-pop` reference |

---

# Part 3: Design Decisions

## Event System: Why a Classic Emitter

Three approaches were evaluated:

**Proposal 1 — Classic Event Emitter:** Multi-listener arrays per event. `on(event, fn)` pushes to the array; `off(event, fn)` removes by reference. Familiar Node.js/DOM EventTarget pattern.

**Proposal 2 — Single-Slot Hooks:** One function per event name. `on(event, fn)` replaces the previous value. Zero memory leak risk, self-documenting manifest. But silently clobbers existing handlers — dangerous for a public API where multiple consumers may coexist.

**Proposal 3 — Middleware Pipeline:** Each handler receives `(payload, next)` and must call `next()` to pass control. A forgotten `next()` silently breaks the chain — a significant footgun. The signature is also foreign to the ES5/plaintext-injection audience.

**Decision: Proposal 1, with two hardening moves from Proposal 2:**
1. Validate event names against `_EVENTS` in `on()`, throwing immediately on unknown names.
2. Clear `_listeners = {}` inside `destroy()`, eliminating accumulation across cycles.

## WebGL2 Over WebGL1

WebGL2 is requested first (`getContext('webgl2', ...)`), with a fallback to WebGL1. WebGL2 is widely available and offers better texture format support. Current shaders use no WebGL2-specific features, so the fallback path is fully safe.

## ES5 Style Throughout

Written in ES5 (`var`, `function`, no classes, no arrow functions) because the library is intended for inline `<script>` injection into arbitrary host pages, including legacy environments with no transpilation step.

## Tile Coordinates: Physical Pixels, Snapped at Capture Time

All tile positions (`worldX`, `worldY`, `width`, `height`) are stored in **physical pixels**. At `processElement` time, `getBoundingClientRect()` values are multiplied by `devicePixelRatio` and the element's four edges are `Math.round()`-ed to integer physical pixel boundaries before any tile geometry is derived. Vertex positions in the GPU buffer are taken directly from these values without further scaling.

This approach fixes a sub-pixel edge bleeding bug: on fractional-DPR displays (e.g. Windows at 125 % or 150 % scaling), computing tile dimensions in CSS px and multiplying by dpr afterwards introduces a double-rounding error — the rendered quad can end up 1 physical pixel narrower or shorter than the actual element, producing a faint transparent fringe on the edges that makes the overlay appear slightly smaller than the underlying image. Snapping to integer physical pixels at capture time eliminates this.

A secondary benefit: `displayWidth` / `displayHeight` sent to the worker are also physical pixel dimensions, so bitmaps are decoded at the exact resolution the GPU renders at. LINEAR filtering then maps 1:1 with no upscaling blur.

## Worker via Blob URL

The worker source is a function in the main file, serialized via `.toString()`, and loaded via `URL.createObjectURL`. This keeps the library as a single deliverable file with no separate `worker.js` asset. The Blob URL is created once at library parse time.

## Tiles Shared by Reference

The `tiles` array is created by TexturePipeline and stored directly into the `activeElements` Map entry. WebGLRenderer reads `tile.texture` from the same objects; TexturePipeline writes it in-place after GPU upload. No copying or inter-module messaging for this data — the shared reference is intentional.
