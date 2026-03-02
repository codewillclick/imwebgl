# Shader Modules (`doc.shaders.md`)

This file specifies the shader module format, the source directory layout, and the `setUniforms` mechanism that feeds slider UI values into GLSL custom uniforms. For the internal ShaderSystem that compiles and caches programs, see `doc.spec.md` Part 4. For the public `registerShader` and `setUniforms` API methods, see `doc.overview.md`. For how `build.sh` incorporates shader modules into both output files, see `doc.build.md`.

---

# Part 1: Source Layout

```
src/
  imwebgl.core.js          ← hand-edited engine source (no built-in shader GLSL)

shaders/
  color-pop/
    frag.glsl              ← GLSL fragment shader source; injected into imwebgl.js
    ui.js                  ← panel builder for this shader; injected into imwebgl.js
  curves/
    frag.glsl
    ui.js

build.sh                   ← assembles both imwebgl.js and tests/index.html
imwebgl.js                 ← generated output; do not edit directly
tests/
  index.html               ← generated output; do not edit directly
  001.jpg  002.jpg  ...    ← image assets; not generated
```

`src/imwebgl.core.js` is the hand-edited engine. It contains no built-in shader GLSL strings — those are injected by `build.sh` from `shaders/*/frag.glsl` at build time.

Each subdirectory under `shaders/` is one self-contained shader module. Directory name = shader name as used in `data-shader` attributes and `registerShader` / `setUniforms` calls.

Both `frag.glsl` and `ui.js` are injected into `imwebgl.js` by `build.sh`, inside the engine IIFE. `ui.js` therefore has direct closure access to all internal library functions — it is not test-harness code but a first-party component of the library.

---

# Part 2: Shader Module Format

A shader module is a directory under `shaders/` containing exactly two files: `frag.glsl` and `ui.js`.

---

## `frag.glsl`

A plain GLSL fragment shader source file. Must satisfy the standard Uniform Contract (see `doc.spec.md` Part 4 § 1) and may additionally declare any number of **custom uniforms**.

### Standard Uniform Contract (required)

```glsl
precision mediump float;

uniform sampler2D u_image;     // current tile texture
uniform vec2      u_resolution; // canvas size in physical px
uniform float     u_time;      // seconds since init
uniform float     u_scrollX;   // scroll offset, physical px
uniform float     u_scrollY;
varying vec2      v_texCoord;  // interpolated from vertex shader
```

All six must be declared even if unused. The renderer sets them unconditionally every frame via cached locations; a program that doesn't declare them will link with null locations, which produces no-ops in the renderer but wastes the location-cache slot and may generate driver warnings.

### Custom Uniforms

Beyond the standard contract, a shader may declare additional uniforms of any supported GLSL scalar or vector type:

```glsl
uniform float u_saturation;
uniform float u_brightness;
uniform vec3  u_lift;
uniform vec3  u_gain;
```

The `ui.js` companion pushes values into these via `WebGLImageEnhancer.setUniforms(name, values)`. ShaderSystem discovers their locations automatically at compile time via GL reflection — the shader author does not need to register them separately.

### Supported Custom Uniform Types

| GLSL type | JS value format |
|---|---|
| `float` | `Number` |
| `vec2` | 2-element array `[x, y]` |
| `vec3` | 3-element array `[r, g, b]` |
| `vec4` | 4-element array `[r, g, b, a]` |
| `int` | `Number` (integer) |
| `bool` | `Number` (`0` or `1`) |

Custom uniforms whose GL type is not in this list are silently skipped during dispatch.

---

## `ui.js`

A self-contained IIFE injected into `imwebgl.js` inside the engine IIFE by `build.sh`. Its job is to:

1. Call `ShaderSystem.setUniforms(name, defaults)` at injection time to push initial uniform values so the shader has correct values from frame 1.
2. Call `_registerShaderUI(name, buildFn)` to register a panel-section builder for use by `getShaderPanel()`.

`buildFn(container)` receives a `<div>` and is responsible for appending slider rows into it. It is called by `getShaderPanel()` when constructing the expanded section for the active shader. `ui.js` does **not** manipulate `document.body` or create any top-level DOM itself.

### Contract

* Must not call `init()` — that has already run.
* Must not append to `document.body` or assume any external DOM structure.
* Must call `_registerShaderUI(name, buildFn)` — this is the only output.
* Must call `ShaderSystem.setUniforms(name, defaults)` to establish initial values.
* Has direct closure access to all internal library functions (`ShaderSystem`, `_registerShaderUI`, etc.) — no need to go through `window.WebGLImageEnhancer`.
* Must be written in ES5 (same constraint as the core library).

### Minimal skeleton

```js
(function() {
  var SHADER   = 'color-pop';
  var defaults = { u_saturation: 1.5, u_brightness: 1.05 };

  // Push defaults immediately so the shader has values from frame 1
  ShaderSystem.setUniforms(SHADER, defaults);

  _registerShaderUI(SHADER, function(container) {
    var params = { u_saturation: defaults.u_saturation, u_brightness: defaults.u_brightness };

    function makeSlider(label, key, min, max, step, init) {
      var row = document.createElement('div');
      var lbl = document.createElement('span');
      lbl.style.cssText = 'display:inline-block;width:90px';
      lbl.textContent   = label + ': ' + init.toFixed(2);
      var s = document.createElement('input');
      s.type  = 'range';
      s.min   = min;  s.max = max;  s.step = step;
      s.value = init;
      s.style.cssText = 'width:100px;vertical-align:middle';
      s.addEventListener('input', function() {
        var v = parseFloat(s.value);
        lbl.textContent = label + ': ' + v.toFixed(2);
        params[key] = v;
        ShaderSystem.setUniforms(SHADER, params);
      });
      row.appendChild(lbl);
      row.appendChild(s);
      container.appendChild(row);
    }

    makeSlider('saturation', 'u_saturation', 0, 3,   0.01, params.u_saturation);
    makeSlider('brightness', 'u_brightness', 0, 2,   0.01, params.u_brightness);
  });
})();
```

---

# Part 3: The `color-pop` Reference Module

The `color-pop` shader is the built-in default. Its module files serve as the canonical reference for writing new modules.

## `shaders/color-pop/frag.glsl`

```glsl
precision mediump float;
uniform sampler2D u_image;
uniform vec2      u_resolution;
uniform float     u_time;
uniform float     u_scrollX;
uniform float     u_scrollY;
uniform float     u_saturation;
uniform float     u_brightness;
varying vec2 v_texCoord;

vec3 rgb2hsv(vec3 c) {
  float cMax  = max(c.r, max(c.g, c.b));
  float cMin  = min(c.r, min(c.g, c.b));
  float delta = cMax - cMin;
  float h = 0.0;
  if (delta > 0.0) {
    if      (cMax == c.r) h = mod((c.g - c.b) / delta, 6.0);
    else if (cMax == c.g) h = (c.b - c.r) / delta + 2.0;
    else                  h = (c.r - c.g) / delta + 4.0;
    h /= 6.0;
  }
  float s = (cMax > 0.0) ? (delta / cMax) : 0.0;
  return vec3(h, s, cMax);
}

vec3 hsv2rgb(vec3 c) {
  float h = c.x * 6.0, s = c.y, v = c.z;
  float i = floor(h), f = h - i;
  float p = v * (1.0 - s);
  float q = v * (1.0 - s * f);
  float t = v * (1.0 - s * (1.0 - f));
  int sector = int(mod(i, 6.0));
  if (sector == 0) return vec3(v, t, p);
  if (sector == 1) return vec3(q, v, p);
  if (sector == 2) return vec3(p, v, t);
  if (sector == 3) return vec3(p, q, v);
  if (sector == 4) return vec3(t, p, v);
                   return vec3(v, p, q);
}

void main() {
  vec4 color = texture2D(u_image, v_texCoord);
  if (color.a < 0.001) { gl_FragColor = color; return; }
  vec3 hsv = rgb2hsv(color.rgb);
  hsv.y = clamp(hsv.y * u_saturation, 0.0, 1.0);
  hsv.z = clamp(hsv.z * u_brightness, 0.0, 1.0);
  gl_FragColor = vec4(hsv2rgb(hsv), color.a);
}
```

The hardcoded multipliers `1.5` and `1.05` from the original inline shader are replaced by `u_saturation` and `u_brightness`. Default values (`1.5` and `1.05`) are pushed by `ui.js` on load, so the visual result is identical to the previous hardcoded version when the sliders are at their defaults.

## `shaders/color-pop/ui.js`

The skeleton from Part 2 above, with `u_saturation` defaulting to `1.5` and `u_brightness` defaulting to `1.05`, is the complete reference `ui.js` for this shader.

---

# Part 4: Build Integration

`build.sh` discovers shader modules by globbing `shaders/*/frag.glsl`. For each module found:

1. **`frag.glsl` into `imwebgl.js`:** The GLSL source is read and embedded as a JS string variable inside the engine IIFE, then passed to `ShaderSystem.register(name, src)`. The module directory name becomes the shader name.

2. **`ui.js` into `imwebgl.js`:** Immediately after the `ShaderSystem.register` call for each module, the corresponding `ui.js` is injected verbatim inside the same IIFE. At this point all internal library functions are defined and accessible via closure.

Both files are injected in the same pass, in filesystem order. `ui.js` is no longer appended to `tests/index.html` — it lives entirely inside `imwebgl.js`.

The first shader module found (in filesystem order) becomes the `defaultShader` passed to `init()`, unless overridden by a config constant at the top of `build.sh`.

See `doc.build.md` for the full build script specification and output file structure.
