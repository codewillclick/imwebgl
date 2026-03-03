# Event System Reference (`doc.reference.md`)

This file is the lookup reference for the imwebgl event system. It covers the emitter implementation, the known event manifest, and the full payload shape for every event. For the public API surface (`on`, `off`), see `doc.overview.md`. For the modules that fire each event, see `doc.spec.md`.

---

## 1. Known Events Manifest

A constant object enumerates every valid event name. This is the single source of truth for the event surface. `on()` validates against it and throws on unknown names, so typos produce immediate explicit errors rather than silent no-ops.

```js
var _EVENTS = {
  SCROLL:             'scroll',
  ELEMENT_ENTER:      'elementEnter',
  ELEMENT_LEAVE:      'elementLeave',
  ELEMENT_UPDATE:     'elementUpdate',
  TILES_DISPATCHED:   'tilesDispatched',
  TILES_READY:        'tilesReady',
  TILES_ERROR:        'tilesError',
  TEXTURE_CREATED:    'textureCreated',
  TEXTURE_DESTROYED:  'textureDestroyed'
};
```

---

## 2. Internal Data Structure

```js
var _listeners = {};
// Shape at runtime: { 'scroll': [fn, fn], 'textureCreated': [fn], ... }
```

Keys are event name strings. Values are arrays of registered handler functions. The object starts empty and is populated on demand by `on()`.

---

## 3. Core Functions

### `on(event, fn)`

Registers a handler for the named event. Validates against `_EVENTS`. Throws a descriptive error on unknown names. Pushes `fn` onto the listener array for that event, creating the array if it does not yet exist.

```js
function on(event, fn) {
  var known = false;
  for (var k in _EVENTS) { if (_EVENTS[k] === event) { known = true; break; } }
  if (!known) throw new Error('imwebgl: unknown event "' + event + '"');
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(fn);
}
```

### `off(event, fn)`

Removes a specific handler. Requires a reference to the original function — anonymous functions registered inline cannot be removed.

```js
function off(event, fn) {
  if (!_listeners[event]) return;
  _listeners[event] = _listeners[event].filter(function(f) { return f !== fn; });
}
```

### `_emit(event, payload)` (internal only)

Fires all registered handlers in registration order. Never exposed publicly. Handler errors are caught and swallowed — a broken handler must never crash the render loop.

```js
function _emit(event, payload) {
  var fns = _listeners[event];
  if (!fns) return;
  for (var i = 0; i < fns.length; i++) {
    try { fns[i](payload); } catch(e) { /* must not break the render loop */ }
  }
}
```

---

## 4. Lifecycle: `destroy()`

`destroy()` resets `_listeners` to an empty object, removing all registered handlers. Repeated `init()` / `destroy()` cycles do not accumulate stale handlers.

```js
// inside destroy():
_listeners = {};
```

---

## 5. Public Exposure

`on` and `off` are attached to `window.WebGLImageEnhancer`. `_emit` and `_listeners` are never exposed.

```js
// CoreAPI IIFE returns { init, registerShader, updateTargets, destroy }
CoreAPI.on  = on;
CoreAPI.off = off;
global.WebGLImageEnhancer = CoreAPI;
```

---

## 6. Event Reference

All payloads are plain objects containing only serializable primitives. No payload ever holds a DOM node or WebGL object.

---

### `scroll`

**Fired by:** DOMObserver — passive `scroll` listener on `window`.

**When:** Every scroll event.

```js
{
  scrollX:        Number,  // window.scrollX
  scrollY:        Number,  // window.scrollY
  viewportTop:    Number,  // scrollY
  viewportBottom: Number   // scrollY + window.innerHeight
}
```

---

### `elementEnter`

**Fired by:** DOMObserver — IntersectionObserver enter callback, after `getBoundingClientRect()`.

**When:** A target element intersects the expanded rootMargin bounding box.

```js
{
  id:     String,  // internal element id, e.g. 'wge-3'
  src:    String,  // resolved image URL
  shader: String,  // shader name that will be applied
  rect: {
    top: Number, left: Number, width: Number, height: Number
  },
  worldY: Number   // rect.top + scrollY — absolute page position
}
```

---

### `elementLeave`

**Fired by:** DOMObserver — IntersectionObserver exit callback or MutationObserver removal.

**When:** A target element leaves the rootMargin bounding box or is removed from the DOM.

```js
{
  id: String
}
```

---

### `elementUpdate`

**Fired by:** DOMObserver — ResizeObserver callback for active elements.

**When:** An active element's dimensions change and its rect is recalculated.

```js
{
  id:     String,
  rect: { top: Number, left: Number, width: Number, height: Number },
  worldY: Number
}
```

---

### `tilesDispatched`

**Fired by:** TexturePipeline — immediately before a job is posted to the worker.

```js
{
  id:        String,
  tileCount: Number,
  tiles: [
    { tileIndex: Number, sourceX: Number, sourceY: Number,
      width: Number, height: Number, worldX: Number, worldY: Number }
    // All coordinates are in physical pixels.
  ]
}
```

---

### `tilesReady`

**Fired by:** TexturePipeline — on `TILES_READY` from worker, before texture upload begins.

```js
{
  id:        String,
  tileCount: Number
}
```

---

### `tilesError`

**Fired by:** TexturePipeline — on `TILES_ERROR` from worker.

```js
{
  id:    String,
  error: String  // message string, not an Error object
}
```

---

### `textureCreated`

**Fired by:** TexturePipeline — after `gl.texImage2D()` completes for one tile.

```js
{
  id:        String,
  tileIndex: Number,
  worldX:    Number,  // physical pixels, page-absolute
  worldY:    Number,  // physical pixels, page-absolute
  width:     Number,  // physical pixels
  height:    Number   // physical pixels
}
```

---

### `textureDestroyed`

**Fired by:** TexturePipeline — after all textures for an element are deleted from VRAM.

```js
{
  id:        String,
  tileCount: Number  // how many textures were deleted
}
```

---

## 7. Usage Example

```js
WebGLImageEnhancer.on('elementEnter', function(p) {
  console.log('in range:', p.id, p.src);
});

WebGLImageEnhancer.on('textureCreated', function(p) {
  console.log('gpu upload:', p.id, 'tile', p.tileIndex);
});

WebGLImageEnhancer.on('textureDestroyed', function(p) {
  console.log('gpu freed:', p.id, 'x' + p.tileCount);
});
```
