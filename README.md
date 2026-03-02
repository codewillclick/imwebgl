# imwebgl

Alright here's a test project to familiarize myself with claude code and its tooling.  The purpose is specifically for local comic book readers without built-in color and lighting leveling.

The development method involved a great deal of ahead-of-time brainstorming, architecting, and documentation, followed by a series of refinements focused entirely on said documentation files.  The actual source wasn't touched until things looked air-tight from the surface.

From that point was a to-and-fro of builds, corrections, updates, and further design refinements, until achieving a version that checks all the initial boxes and is easy to build and apply to said targeted comic book readers.

...

A dependency-free, single-file JavaScript library that renders a transparent WebGL2 canvas over existing images on any webpage — applying GLSL fragment shaders to `<img>` elements and CSS `background-image` containers via a JIT tile pipeline running in a Web Worker.

**Key properties:**

- **Zero setup for the host page.** One `<script>` tag. No npm, no bundler, no modules.
- **Non-destructive overlay.** A `pointer-events:none` canvas sits above the DOM; original images are untouched.
- **JIT texture pipeline.** Images enter VRAM only when near the viewport (configurable `rootMargin`). Textures are freed the moment elements leave.
- **Tile grid for hardware safety.** Images are sliced into tiles ≤ `gl.MAX_TEXTURE_SIZE` (capped at 4096 px), so arbitrarily tall webtoon panels or large images never exceed GPU limits.
- **Web Worker decoding.** `fetch` + `createImageBitmap` runs off the main thread; tile bitmaps are transferred to the GL context zero-copy.
- **Custom shaders in one call.** `registerShader(name, glsl)` + `data-shader="name"` on any element.
- **ES5 throughout.** Safe for inline `<script>` injection into arbitrary legacy host pages.

---

## Getting Started

```bash
git clone <repo>
cd imwebgl
./build.sh
```

Then open `tests/index.html` in a browser. The page auto-generates from any images dropped into `tests/`.

To add test images, drop `.jpg`, `.png`, `.webp`, etc. into `tests/` and re-run `./build.sh`.

---

## Basic Usage

```html
<!-- 1. Load the library -->
<script src="imwebgl.js"></script>

<!-- 2. Mark elements for enhancement -->
<img class="webgl-enhance" src="panel.jpg" />
<img class="webgl-enhance" data-shader="grayscale" src="cover.jpg" />
<div class="webgl-enhance" style="background-image: url('hero.png')"></div>

<!-- 3. Init -->
<script>
  WebGLImageEnhancer.init({
    targetSelector: '.webgl-enhance',
    defaultShader:  'color-pop',
    maxConcurrency: 2,
    rootMargin:     '2000px'
  });
</script>
```

`data-shader` selects the shader per element. When absent, `defaultShader` from `init()` is used.

---

## Custom Shaders

```js
var fragSrc = `
  precision mediump float;
  uniform sampler2D u_image;
  uniform vec2      u_resolution;
  uniform float     u_time;
  uniform float     u_scrollX;
  uniform float     u_scrollY;
  varying vec2      v_texCoord;

  void main() {
    vec4 c = texture2D(u_image, v_texCoord);
    float gray = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    gl_FragColor = vec4(vec3(gray), c.a);
  }
`;

WebGLImageEnhancer.registerShader('grayscale', fragSrc);
```

All six standard uniforms must be declared even if unused. Beyond them, declare any additional uniforms you like — ShaderSystem discovers them automatically via GL reflection.

```js
// Push values into custom uniforms at any time (merged, not replaced):
WebGLImageEnhancer.setUniforms('color-pop', { u_saturation: 2.0 });
```

### Custom Uniform Types

| GLSL type | JS value |
|-----------|----------|
| `float`   | `Number` |
| `vec2`    | `[x, y]` |
| `vec3`    | `[r, g, b]` |
| `vec4`    | `[r, g, b, a]` |
| `int`     | `Number` (integer) |
| `bool`    | `0` or `1` |

---

## API Reference

| Method | Description |
|--------|-------------|
| `init(config)` | Inject canvas, start observers, begin JIT pipeline. |
| `registerShader(name, fragSrc)` | Compile and cache a GLSL fragment shader. |
| `setUniforms(name, values)` | Merge uniform values into a shader's per-frame store. |
| `updateTargets()` | Force re-scan of the DOM for matching elements. |
| `getDebugPanel()` | Returns a live debug overlay `<div>` (lazy singleton). |
| `getShaderPanel()` | Returns a shader controls `<div>` with uniform sliders (lazy singleton). |
| `on(event, fn)` / `off(event, fn)` | Subscribe to lifecycle events. |
| `destroy()` | Full teardown: disconnect observers, delete VRAM, remove canvas. |

### Events

`scroll`, `elementEnter`, `elementLeave`, `elementUpdate`, `tilesDispatched`, `tilesReady`, `tilesError`, `textureCreated`, `textureDestroyed`

```js
WebGLImageEnhancer.on('textureCreated', function(p) {
  console.log('GPU upload:', p.id, 'tile', p.tileIndex);
});
```

---

## Shader Modules

Shaders live in `shaders/<name>/` as two files:

- **`frag.glsl`** — GLSL fragment shader source, injected into `imwebgl.js` at build time.
- **`ui.js`** — IIFE that pushes default uniform values and registers a slider panel builder. Runs inside the engine IIFE with full closure access to internals.

The `color-pop` module (saturation + brightness boost via HSV) is the built-in reference. See `doc.shaders.md` for the full module contract and the complete `color-pop` source.

---

## Build Configuration

`config.json` at the project root is baked into `imwebgl.js` at build time:

| Key | Default | Runtime override? |
|-----|---------|-------------------|
| `targetSelector` | `".webgl-enhance"` | Yes, via `init()` |
| `defaultShader` | `"color-pop"` | Yes, via `init()` |
| `maxConcurrency` | `2` | Yes, via `init()` |
| `rootMargin` | `"2000px"` | Yes, via `init()` |
| `tileSize` | `4096` | No |
| `resizeDebounceMs` | `150` | No |
| `canvasZIndex` | `9999` | No |

---

## Documentation

| File | Covers |
|------|--------|
| `doc.overview.md` | Public API, architecture, design decisions |
| `doc.reference.md` | Event system — manifest, payload shapes, emitter implementation |
| `doc.spec.md` | Internal module specs — DOMObserver, TexturePipeline, WebGLRenderer, ShaderSystem |
| `doc.build.md` | `build.sh`, source layout, `tests/` harness, debug UI overlay |
| `doc.shaders.md` | Shader module format, custom uniforms, `color-pop` reference |
