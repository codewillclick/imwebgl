/**
 * imwebgl.js  (assembled by build.sh from src/imwebgl.core.js + shaders/*)
 * Transparent WebGL overlay for existing images on a webpage.
 * Exposes window.WebGLImageEnhancer
 *
 * Usage:
 *   <script src="imwebgl.js"><\/script>
 *   <script>WebGLImageEnhancer.init({ targetSelector: '.webgl-enhance' });<\/script>
 */
(function(global) {
  'use strict';

  // @@CONFIG_INJECT@@

  // ============================================================
  // 1. UTILITIES
  // ============================================================

  var _idCounter = 0;
  var _elementIdMap = new WeakMap();

  function _getElementId(el) {
    if (!_elementIdMap.has(el)) _elementIdMap.set(el, 'wge-' + (++_idCounter));
    return _elementIdMap.get(el);
  }

  function _parseBgImageUrl(el) {
    var bg = global.getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') return null;
    var m = bg.match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : null;
  }

  function _getImageSrc(el) {
    return el.tagName === 'IMG'
      ? (el.src || el.currentSrc || null)
      : _parseBgImageUrl(el);
  }

  // ============================================================
  // 2. EVENT SYSTEM
  // ============================================================

  var _EVENTS = {
    SCROLL:            'scroll',
    ELEMENT_ENTER:     'elementEnter',
    ELEMENT_LEAVE:     'elementLeave',
    ELEMENT_UPDATE:    'elementUpdate',
    TILES_DISPATCHED:  'tilesDispatched',
    TILES_READY:       'tilesReady',
    TILES_ERROR:       'tilesError',
    TEXTURE_CREATED:   'textureCreated',
    TEXTURE_DESTROYED: 'textureDestroyed'
  };

  var _listeners = {};

  function on(event, fn) {
    var known = false;
    for (var k in _EVENTS) { if (_EVENTS[k] === event) { known = true; break; } }
    if (!known) throw new Error('imwebgl: unknown event "' + event + '"');
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
  }

  function off(event, fn) {
    if (!_listeners[event]) return;
    _listeners[event] = _listeners[event].filter(function(f) { return f !== fn; });
  }

  function _emit(event, payload) {
    var fns = _listeners[event];
    if (!fns) return;
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](payload); } catch(e) { /* handler errors must not break the render loop */ }
    }
  }

  // ============================================================
  // 3. VERTEX SHADER
  // ============================================================

  var _VERTEX_SHADER_SRC = [
    'attribute vec2 a_position;',
    'attribute vec2 a_texCoord;',
    'uniform vec2 u_resolution;',
    'uniform float u_scrollX;',
    'uniform float u_scrollY;',
    'varying vec2 v_texCoord;',
    'void main() {',
    '  vec2 viewportPos = a_position - vec2(u_scrollX, u_scrollY);',
    '  vec2 clipSpace = (viewportPos / u_resolution) * 2.0 - 1.0;',
    '  gl_Position = vec4(clipSpace.x, -clipSpace.y, 0.0, 1.0);',
    '  v_texCoord = a_texCoord;',
    '}'
  ].join('\n');

  // ============================================================
  // 4. WORKER BLOB
  // ============================================================

  var _workerSourceCode = '(' + function() {
    'use strict';
    self.onmessage = function(e) {
      var msg = e.data;
      if (msg.type !== 'PROCESS_TILES') return;
      fetch(msg.url)
        .then(function(res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.blob();
        })
        .then(function(blob) {
          return createImageBitmap(blob, { resizeWidth: msg.displayWidth, resizeHeight: msg.displayHeight })
            .then(function(scaled) {
              return Promise.all(msg.tiles.map(function(tile) {
                return createImageBitmap(scaled, tile.sourceX, tile.sourceY, tile.width, tile.height)
                  .then(function(bitmap) {
                    return { tileIndex: tile.tileIndex, bitmap: bitmap };
                  });
              })).then(function(results) {
                scaled.close();
                return results;
              });
            });
        })
        .then(function(results) {
          var bitmaps = results.map(function(r) { return r.bitmap; });
          self.postMessage({ type: 'TILES_READY', jobId: msg.jobId, results: results }, bitmaps);
        })
        .catch(function(err) {
          self.postMessage({ type: 'TILES_ERROR', jobId: msg.jobId, error: err.message });
        });
    };
  }.toString() + ')()';

  var _workerBlobUrl = URL.createObjectURL(
    new Blob([_workerSourceCode], { type: 'application/javascript' })
  );

  // ============================================================
  // 5. ShaderSystem
  // ============================================================

  var ShaderSystem = (function() {
    var _gl           = null;
    var _programs     = {};
    var _uniformValues = {};   // { shaderName: { uniformName: value } }
    var _pendingShaders = [];  // { name, fragSrc } registered before GL was available
    var _defaultName  = 'color-pop';

    var _standardNames = {
      u_image: true, u_resolution: true, u_time: true,
      u_scrollX: true, u_scrollY: true
    };

    function _compileShader(type, src) {
      var shader = _gl.createShader(type);
      _gl.shaderSource(shader, src);
      _gl.compileShader(shader);
      if (!_gl.getShaderParameter(shader, _gl.COMPILE_STATUS)) {
        var log = _gl.getShaderInfoLog(shader);
        _gl.deleteShader(shader);
        throw new Error(log);
      }
      return shader;
    }

    function _buildProgram(vertSrc, fragSrc) {
      var vert = _compileShader(_gl.VERTEX_SHADER,   vertSrc);
      var frag = _compileShader(_gl.FRAGMENT_SHADER, fragSrc);
      var prog = _gl.createProgram();
      _gl.attachShader(prog, vert);
      _gl.attachShader(prog, frag);
      _gl.linkProgram(prog);
      _gl.deleteShader(vert);
      _gl.deleteShader(frag);
      if (!_gl.getProgramParameter(prog, _gl.LINK_STATUS)) {
        var log = _gl.getProgramInfoLog(prog);
        _gl.deleteProgram(prog);
        throw new Error(log);
      }
      return prog;
    }

    function _cacheLocs(prog) {
      return {
        a_position:   _gl.getAttribLocation(prog,  'a_position'),
        a_texCoord:   _gl.getAttribLocation(prog,  'a_texCoord'),
        u_resolution: _gl.getUniformLocation(prog, 'u_resolution'),
        u_scrollX:    _gl.getUniformLocation(prog, 'u_scrollX'),
        u_scrollY:    _gl.getUniformLocation(prog, 'u_scrollY'),
        u_image:      _gl.getUniformLocation(prog, 'u_image'),
        u_time:       _gl.getUniformLocation(prog, 'u_time')
      };
    }

    function _discoverExtraLocs(prog) {
      var extraLocs = {};
      var count = _gl.getProgramParameter(prog, _gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < count; i++) {
        var info = _gl.getActiveUniform(prog, i);
        if (!info || _standardNames[info.name]) continue;
        extraLocs[info.name] = {
          loc:  _gl.getUniformLocation(prog, info.name),
          type: info.type
        };
      }
      return extraLocs;
    }

    return {
      init: function(gl) {
        _gl = gl;
        // Compile any shaders registered before GL was available
        var pending = _pendingShaders.splice(0);
        for (var i = 0; i < pending.length; i++) {
          this.register(pending[i].name, pending[i].fragSrc);
        }
      },

      setDefault: function(name) {
        _defaultName = name || 'color-pop';
      },

      getDefault: function() {
        return _defaultName;
      },

      register: function(name, fragSrc) {
        if (!_gl) {
          _pendingShaders.push({ name: name, fragSrc: fragSrc });
          return;
        }
        try {
          var prog = _buildProgram(_VERTEX_SHADER_SRC, fragSrc);
          _programs[name] = {
            program:   prog,
            locs:      _cacheLocs(prog),
            extraLocs: _discoverExtraLocs(prog)
          };
        } catch (e) {
          console.warn('[imwebgl] Shader "' + name + '" failed to compile: ' + e.message);
        }
      },

      getProgram: function(name) {
        return _programs[name] || _programs[_defaultName] || null;
      },

      setUniforms: function(name, values) {
        if (!_uniformValues[name]) _uniformValues[name] = {};
        for (var k in values) {
          if (values.hasOwnProperty(k)) _uniformValues[name][k] = values[k];
        }
      },

      // Called by WebGLRenderer once per program-switch, while the program is bound
      applyUniforms: function(name) {
        if (!_gl || !_programs[name] || !_uniformValues[name]) return;
        var extraLocs = _programs[name].extraLocs;
        var vals      = _uniformValues[name];
        for (var k in extraLocs) {
          if (!extraLocs.hasOwnProperty(k) || !vals.hasOwnProperty(k)) continue;
          var entry = extraLocs[k];
          var v     = vals[k];
          switch (entry.type) {
            case _gl.FLOAT:      _gl.uniform1f(entry.loc, v);          break;
            case _gl.FLOAT_VEC2: _gl.uniform2fv(entry.loc, v);         break;
            case _gl.FLOAT_VEC3: _gl.uniform3fv(entry.loc, v);         break;
            case _gl.FLOAT_VEC4: _gl.uniform4fv(entry.loc, v);         break;
            case _gl.INT:        _gl.uniform1i(entry.loc, v);          break;
            case _gl.BOOL:       _gl.uniform1i(entry.loc, v ? 1 : 0);  break;
          }
        }
      },

      destroy: function() {
        if (!_gl) return;
        for (var k in _programs) {
          if (_programs.hasOwnProperty(k)) _gl.deleteProgram(_programs[k].program);
        }
        _programs       = {};
        _uniformValues  = {};
        _pendingShaders = [];
        _gl             = null;
      }
    };
  })();

  // ============================================================
  // 6. WebGLRenderer
  // ============================================================

  var WebGLRenderer = (function() {
    var _canvas = null;
    var _gl = null;
    var _activeElements = null;
    var _rafId = null;
    var _startTime = Date.now();
    var _posBuffer = null;
    var _texBuffer = null;
    var _currentProgram = null;
    var _scrollX = 0;
    var _scrollY = 0;

    function _resize() {
      var dpr = global.devicePixelRatio || 1;
      _canvas.width  = Math.round(global.innerWidth  * dpr);
      _canvas.height = Math.round(global.innerHeight * dpr);
      if (_gl) _gl.viewport(0, 0, _canvas.width, _canvas.height);
    }

    function _createBuffers() {
      _posBuffer = _gl.createBuffer();

      _texBuffer = _gl.createBuffer();
      var uvs = new Float32Array([0,0, 1,0, 0,1,  0,1, 1,0, 1,1]);
      _gl.bindBuffer(_gl.ARRAY_BUFFER, _texBuffer);
      _gl.bufferData(_gl.ARRAY_BUFFER, uvs, _gl.STATIC_DRAW);
    }

    function _drawFrame() {
      _rafId = requestAnimationFrame(_drawFrame);
      if (!_gl || !_activeElements) return;

      var dpr = global.devicePixelRatio || 1;
      var w = _canvas.width;
      var h = _canvas.height;
      var now = (Date.now() - _startTime) / 1000;

      _gl.clearColor(0, 0, 0, 0);
      _gl.clear(_gl.COLOR_BUFFER_BIT);

      _currentProgram = null;

      _activeElements.forEach(function(info) {
        if (!info.tiles || !info.tiles.length) return;

        var progObj = ShaderSystem.getProgram(info.shaderName);
        if (!progObj) return;

        if (progObj.program !== _currentProgram) {
          _currentProgram = progObj.program;
          _gl.useProgram(_currentProgram);

          // Set up the tex-coord buffer once per program switch
          _gl.bindBuffer(_gl.ARRAY_BUFFER, _texBuffer);
          _gl.enableVertexAttribArray(progObj.locs.a_texCoord);
          _gl.vertexAttribPointer(progObj.locs.a_texCoord, 2, _gl.FLOAT, false, 0, 0);

          // Standard uniforms
          _gl.uniform2f(progObj.locs.u_resolution, w, h);
          _gl.uniform1f(progObj.locs.u_scrollX, _scrollX * dpr);
          _gl.uniform1f(progObj.locs.u_scrollY, _scrollY * dpr);
          _gl.uniform1f(progObj.locs.u_time, now);
          _gl.uniform1i(progObj.locs.u_image, 0);

          // Custom uniforms — applied once per program switch
          ShaderSystem.applyUniforms(info.shaderName);
        }

        info.tiles.forEach(function(tile) {
          if (!tile.texture) return;

          // worldX/worldY are already in physical pixels (set by TexturePipeline.processElement).
          // No dpr multiplication here.
          var x1 = tile.worldX;
          var y1 = tile.worldY;
          var x2 = tile.worldX + tile.width;
          var y2 = tile.worldY + tile.height;
          var pos = new Float32Array([x1,y1, x2,y1, x1,y2,  x1,y2, x2,y1, x2,y2]);

          _gl.bindBuffer(_gl.ARRAY_BUFFER, _posBuffer);
          _gl.bufferData(_gl.ARRAY_BUFFER, pos, _gl.DYNAMIC_DRAW);
          _gl.enableVertexAttribArray(progObj.locs.a_position);
          _gl.vertexAttribPointer(progObj.locs.a_position, 2, _gl.FLOAT, false, 0, 0);

          _gl.activeTexture(_gl.TEXTURE0);
          _gl.bindTexture(_gl.TEXTURE_2D, tile.texture);
          _gl.drawArrays(_gl.TRIANGLES, 0, 6);
        });
      });
    }

    return {
      init: function(activeElements) {
        _activeElements = activeElements;

        _canvas = document.createElement('canvas');
        _canvas.style.cssText =
          'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
          'pointer-events:none;z-index:' + _CFG.canvasZIndex + ';';
        document.body.appendChild(_canvas);

        _resize();
        global.addEventListener('resize', _resize, false);

        var ctx = _canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false })
               || _canvas.getContext('webgl',  { alpha: true, premultipliedAlpha: false });
        if (!ctx) {
          console.error('[imwebgl] WebGL not supported in this browser.');
          return;
        }
        _gl = ctx;
        _gl.enable(_gl.BLEND);
        _gl.blendFunc(_gl.SRC_ALPHA, _gl.ONE_MINUS_SRC_ALPHA);
        _gl.viewport(0, 0, _canvas.width, _canvas.height);

        _createBuffers();
        _startTime = Date.now();
        _drawFrame();
      },

      getGL: function() { return _gl; },

      updateScroll: function(sx, sy) {
        _scrollX = sx;
        _scrollY = sy;
      },

      destroy: function() {
        if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
        global.removeEventListener('resize', _resize, false);
        if (_gl) {
          if (_posBuffer) _gl.deleteBuffer(_posBuffer);
          if (_texBuffer) _gl.deleteBuffer(_texBuffer);
        }
        if (_canvas && _canvas.parentNode) _canvas.parentNode.removeChild(_canvas);
        _canvas         = null;
        _gl             = null;
        _activeElements = null;
        _currentProgram = null;
        _posBuffer      = null;
        _texBuffer      = null;
      }
    };
  })();

  // ============================================================
  // 7. TexturePipeline
  // ============================================================

  var TexturePipeline = (function() {
    var _gl = null;
    var _worker = null;
    var _TILE_SIZE = _CFG.tileSize;
    var _maxConcurrency = _CFG.maxConcurrency;
    var _activeJobs = 0;
    var _queue = [];
    var _elementState = {};  // id -> { jobId, aborted, tiles }
    var _jobToElement = {};  // jobId -> elementId
    var _vramRegistry = {};  // id -> [WebGLTexture]

    function _uploadTile(tile, bitmap) {
      var tex = _gl.createTexture();
      _gl.bindTexture(_gl.TEXTURE_2D, tex);
      _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, _gl.RGBA, _gl.UNSIGNED_BYTE, bitmap);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_S, _gl.CLAMP_TO_EDGE);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_T, _gl.CLAMP_TO_EDGE);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MIN_FILTER, _gl.LINEAR);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MAG_FILTER, _gl.LINEAR);
      bitmap.close();  // free CPU copy; VRAM copy is independent
      tile.texture = tex;
      return tex;
    }

    function _dispatch(job) {
      _activeJobs++;
      _emit('tilesDispatched', {
        id:        job.elementId,
        tileCount: job.tiles.length,
        tiles:     job.tiles.map(function(t) {
          return {
            tileIndex: t.tileIndex,
            sourceX:   t.sourceX,
            sourceY:   t.sourceY,
            width:     t.width,
            height:    t.height,
            worldX:    t.worldX,
            worldY:    t.worldY
          };
        })
      });
      _worker.postMessage({
        type:          'PROCESS_TILES',
        jobId:         job.jobId,
        url:           job.url,
        displayWidth:  job.displayWidth,
        displayHeight: job.displayHeight,
        tiles: job.tiles.map(function(t) {
          return {
            tileIndex: t.tileIndex,
            sourceX:   t.sourceX,
            sourceY:   t.sourceY,
            width:     t.width,
            height:    t.height
          };
        })
      });
    }

    function _drainQueue() {
      while (_activeJobs < _maxConcurrency && _queue.length) {
        var next = _queue.shift();
        var state = _elementState[next.elementId];
        if (!state || state.aborted) continue;
        _dispatch(next);
      }
    }

    function _removeElementInternal(id) {
      if (_elementState[id]) {
        _elementState[id].aborted = true;
      }
      _queue = _queue.filter(function(j) { return j.elementId !== id; });
      if (_vramRegistry[id] && _gl) {
        var tileCount = _vramRegistry[id].length;
        _vramRegistry[id].forEach(function(tex) { _gl.deleteTexture(tex); });
        if (tileCount > 0) _emit('textureDestroyed', { id: id, tileCount: tileCount });
      }
      delete _vramRegistry[id];
      delete _elementState[id];
    }

    function _onWorkerMessage(e) {
      var msg = e.data;

      if (msg.type === 'TILES_READY') {
        _activeJobs--;
        var elementId = _jobToElement[msg.jobId];
        var state = elementId ? _elementState[elementId] : null;

        if (!state || state.jobId !== msg.jobId || state.aborted) {
          msg.results.forEach(function(r) {
            try { r.bitmap.close(); } catch (x) { /* already closed */ }
          });
          delete _jobToElement[msg.jobId];
          _drainQueue();
          return;
        }

        _emit('tilesReady', { id: elementId, tileCount: msg.results.length });
        msg.results.forEach(function(r) {
          var tile = state.tiles[r.tileIndex];
          if (!tile) return;
          var tex = _uploadTile(tile, r.bitmap);
          if (!_vramRegistry[elementId]) _vramRegistry[elementId] = [];
          _vramRegistry[elementId].push(tex);
          _emit('textureCreated', {
            id:        elementId,
            tileIndex: tile.tileIndex,
            worldX:    tile.worldX,
            worldY:    tile.worldY,
            width:     tile.width,
            height:    tile.height
          });
        });

        delete _jobToElement[msg.jobId];
        _drainQueue();

      } else if (msg.type === 'TILES_ERROR') {
        _activeJobs--;
        var eid = _jobToElement[msg.jobId];
        console.warn('[imwebgl] Tile fetch failed for element "' + eid + '": ' + msg.error);
        _emit('tilesError', { id: eid, error: msg.error });
        delete _jobToElement[msg.jobId];
        _drainQueue();
      }
    }

    return {
      init: function(gl, maxConcurrency) {
        _gl = gl;
        _maxConcurrency = maxConcurrency || 2;
        var limit = _gl.getParameter(_gl.MAX_TEXTURE_SIZE);
        _TILE_SIZE = Math.min(limit, _CFG.tileSize);

        _worker = new Worker(_workerBlobUrl);
        _worker.onmessage = _onWorkerMessage;
        _worker.onerror = function(e) {
          console.error('[imwebgl] Worker error:', e.message);
        };
      },

      processElement: function(el, rect, src, shaderName, activeElements) {
        if (rect.width < 1 || rect.height < 1) {
          console.warn('[imwebgl] Element has zero dimensions, skipping.');
          return;
        }

        var id = _getElementId(el);

        if (_elementState[id]) {
          _removeElementInternal(id);
        }

        var scrollX = global.pageXOffset || global.scrollX || 0;
        var scrollY = global.pageYOffset || global.scrollY || 0;
        var dpr = global.devicePixelRatio || 1;

        // getBoundingClientRect() returns CSS px values that can be fractional on
        // high-DPR or fractional-DPR displays (e.g. Windows at 125 % or 150 % scaling).
        // Computing tile dimensions in CSS px space and then multiplying by dpr introduces
        // a double-rounding error: the rendered quad ends up a physical pixel narrower or
        // shorter than the actual element, producing a faint transparent fringe on the
        // edges (the "tightened inward" appearance).
        //
        // Fix: snap the element's four edges to integer physical pixels first, then derive
        // all tile geometry from those values. This guarantees that vertex positions land
        // on exact physical pixel boundaries and that displayWidth/displayHeight match the
        // physical area the texture must cover (no LINEAR upscaling blur).
        var physLeft   = Math.round(rect.left   * dpr);
        var physTop    = Math.round(rect.top    * dpr);
        var physRight  = Math.round((rect.left  + rect.width)  * dpr);
        var physBottom = Math.round((rect.top   + rect.height) * dpr);
        var physWidth  = physRight  - physLeft;
        var physHeight = physBottom - physTop;

        var physScrollX = Math.round(scrollX * dpr);
        var physScrollY = Math.round(scrollY * dpr);

        var TILE = _TILE_SIZE;
        var cols = Math.ceil(physWidth  / TILE) || 1;
        var rows = Math.ceil(physHeight / TILE) || 1;

        var tiles = [];
        var tileIndex = 0;
        for (var row = 0; row < rows; row++) {
          for (var col = 0; col < cols; col++) {
            var sx = col * TILE;
            var sy = row * TILE;
            var tw = Math.min(TILE, physWidth  - sx);
            var th = Math.min(TILE, physHeight - sy);
            tiles.push({
              tileIndex: tileIndex++,
              sourceX:   sx,
              sourceY:   sy,
              width:     tw,
              height:    th,
              // worldX/worldY are page-absolute physical pixel coordinates.
              // The renderer uses them directly as vertex positions with no further dpr scaling.
              worldX:    physLeft + physScrollX + sx,
              worldY:    physTop  + physScrollY + sy,
              texture:   null
            });
          }
        }

        var jobId = id + '-' + Date.now();
        _elementState[id] = { jobId: jobId, aborted: false, tiles: tiles };
        _jobToElement[jobId] = id;
        _vramRegistry[id] = [];

        activeElements.set(el, {
          id:         id,
          shaderName: shaderName,
          tiles:      tiles,
          rect:       rect
        });

        // displayWidth/Height are physical pixels — the worker creates bitmaps at the
        // exact resolution the GPU will render at, so LINEAR filtering does 1:1 pixel
        // mapping with no upscaling blur.
        var job = { elementId: id, jobId: jobId, url: src, tiles: tiles,
                    displayWidth: physWidth, displayHeight: physHeight };
        if (_activeJobs < _maxConcurrency) {
          _dispatch(job);
        } else {
          _queue.push(job);
        }
      },

      removeElement: function(id) {
        _removeElementInternal(id);
      },

      destroy: function() {
        if (_worker) { _worker.terminate(); _worker = null; }
        for (var id in _vramRegistry) {
          if (_vramRegistry.hasOwnProperty(id) && _gl) {
            _vramRegistry[id].forEach(function(tex) { _gl.deleteTexture(tex); });
          }
        }
        _vramRegistry  = {};
        _elementState  = {};
        _jobToElement  = {};
        _queue         = [];
        _activeJobs    = 0;
        _gl            = null;
      }
    };
  })();

  // ============================================================
  // 8. DOMObserver
  // ============================================================

  var DOMObserver = (function() {
    var _config      = null;
    var _callbacks   = null;
    var _intersectionObs = null;
    var _resizeObs       = null;
    var _mutationObs     = null;
    var _trackedElements = new Set();
    var _zoneElements    = new Set();

    function _shaderFor(el) {
      return el.getAttribute('data-shader') || _config.defaultShader;
    }

    var _elementResizeTimers = {};
    function _onIntersect(entries) {
      entries.forEach(function(entry) {
        var el = entry.target;
        if (entry.isIntersecting) {
          _zoneElements.add(el);
          _resizeObs.observe(el);
          var rect   = el.getBoundingClientRect();
          var src    = _getImageSrc(el);
          var shader = _shaderFor(el);
          var eid    = _getElementId(el);
          var sy     = global.scrollY || global.pageYOffset || 0;
          _callbacks.onElementEnter(el, rect, src, shader);
          _emit(_EVENTS.ELEMENT_ENTER, {
            id:     eid,
            src:    src,
            shader: shader,
            rect: {
              top:    rect.top,
              left:   rect.left,
              width:  rect.width,
              height: rect.height
            },
            worldY: rect.top + sy
          });
        } else {
          _zoneElements.delete(el);
          _resizeObs.unobserve(el);
          var lid = _getElementId(el);
          if (_elementResizeTimers[lid]) {
            clearTimeout(_elementResizeTimers[lid]);
            delete _elementResizeTimers[lid];
          }
          _callbacks.onElementLeave(lid, el);
          _emit(_EVENTS.ELEMENT_LEAVE, { id: lid });
        }
      });
    }

    function _onResize(entries) {
      entries.forEach(function(entry) {
        var el  = entry.target;
        var eid = _getElementId(el);
        if (_elementResizeTimers[eid]) clearTimeout(_elementResizeTimers[eid]);
        _elementResizeTimers[eid] = setTimeout(function() {
          delete _elementResizeTimers[eid];
          var rect = el.getBoundingClientRect();
          var sy   = global.scrollY || global.pageYOffset || 0;
          _callbacks.onElementUpdate(el, rect);
          _emit(_EVENTS.ELEMENT_UPDATE, {
            id: eid,
            rect: {
              top:    rect.top,
              left:   rect.left,
              width:  rect.width,
              height: rect.height
            },
            worldY: rect.top + sy
          });
        }, _CFG.resizeDebounceMs);
      });
    }

    function _onMutate(mutations) {
      mutations.forEach(function(mut) {
        mut.addedNodes.forEach(function(node) {
          if (node.nodeType !== 1) return;
          if (node.matches && node.matches(_config.targetSelector)) {
            if (!_trackedElements.has(node)) {
              _intersectionObs.observe(node);
              _trackedElements.add(node);
            }
          }
          if (node.querySelectorAll) {
            node.querySelectorAll(_config.targetSelector).forEach(function(child) {
              if (!_trackedElements.has(child)) {
                _intersectionObs.observe(child);
                _trackedElements.add(child);
              }
            });
          }
        });

        mut.removedNodes.forEach(function(node) {
          if (!_trackedElements.has(node)) return;
          _trackedElements.delete(node);
          _zoneElements.delete(node);
          _intersectionObs.unobserve(node);
          _resizeObs.unobserve(node);
          var removedId = _getElementId(node);
          _callbacks.onElementLeave(removedId, node);
          _emit(_EVENTS.ELEMENT_LEAVE, { id: removedId });
        });
      });
    }

    function _onScroll() {
      var sx = global.scrollX || global.pageXOffset || 0;
      var sy = global.scrollY || global.pageYOffset || 0;
      _callbacks.onScroll(sx, sy);
      _emit(_EVENTS.SCROLL, {
        scrollX:        sx,
        scrollY:        sy,
        viewportTop:    sy,
        viewportBottom: sy + global.innerHeight
      });
    }

    var _windowResizeTimer = null;
    function _onWindowResize() {
      if (_windowResizeTimer !== null) clearTimeout(_windowResizeTimer);
      _windowResizeTimer = setTimeout(function() {
        _windowResizeTimer = null;
        _zoneElements.forEach(function(el) {
          var rect = el.getBoundingClientRect();
          var sy   = global.scrollY || global.pageYOffset || 0;
          _callbacks.onElementUpdate(el, rect);
          _emit(_EVENTS.ELEMENT_UPDATE, {
            id: _getElementId(el),
            rect: {
              top:    rect.top,
              left:   rect.left,
              width:  rect.width,
              height: rect.height
            },
            worldY: rect.top + sy
          });
        });
      }, _CFG.resizeDebounceMs);
    }

    return {
      init: function(config, callbacks) {
        _config    = config;
        _callbacks = callbacks;

        _intersectionObs = new IntersectionObserver(_onIntersect, {
          rootMargin: config.rootMargin
        });
        _resizeObs   = new ResizeObserver(_onResize);
        _mutationObs = new MutationObserver(_onMutate);
        _mutationObs.observe(document.body, { childList: true, subtree: true });

        global.addEventListener('scroll', _onScroll, { passive: true });
        global.addEventListener('resize', _onWindowResize, false);
        this.rescan();
      },

      rescan: function() {
        document.querySelectorAll(_config.targetSelector).forEach(function(el) {
          if (!_trackedElements.has(el)) {
            _intersectionObs.observe(el);
            _trackedElements.add(el);
          }
        });
      },

      destroy: function() {
        if (_intersectionObs) { _intersectionObs.disconnect(); _intersectionObs = null; }
        if (_resizeObs)       { _resizeObs.disconnect();       _resizeObs       = null; }
        if (_mutationObs)     { _mutationObs.disconnect();     _mutationObs     = null; }
        global.removeEventListener('scroll', _onScroll);
        global.removeEventListener('resize', _onWindowResize);
        if (_windowResizeTimer !== null) { clearTimeout(_windowResizeTimer); _windowResizeTimer = null; }
        for (var tid in _elementResizeTimers) {
          if (_elementResizeTimers.hasOwnProperty(tid)) clearTimeout(_elementResizeTimers[tid]);
        }
        _elementResizeTimers = {};
        _trackedElements = new Set();
        _zoneElements    = new Set();
        _config    = null;
        _callbacks = null;
      }
    };
  })();

  // ============================================================
  // 9. PANEL SYSTEM
  // ============================================================

  // Registry populated by ui.js IIFEs (injected by build.sh)
  var _shaderUIs = {};

  function _registerShaderUI(name, buildFn) {
    _shaderUIs[name] = buildFn;
  }

  // ── Debug Panel ──────────────────────────────────────────────

  var _debugPanel = null;

  function getDebugPanel() {
    if (_debugPanel) return _debugPanel;

    var panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed', 'top:10px', 'right:10px', 'width:280px',
      'background:rgba(0,0,0,0.82)', 'color:#cfc',
      'font-family:monospace', 'font-size:11px', 'line-height:1.5',
      'z-index:10001', 'pointer-events:none',
      'border:1px solid rgba(255,255,255,0.15)',
      'border-radius:4px', 'overflow:hidden'
    ].join(';');

    // ── Controls row ──
    var controls = document.createElement('div');
    controls.style.cssText =
      'padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.12);pointer-events:auto';

    var glBtn = document.createElement('button');
    glBtn.textContent = 'hide GL';
    glBtn.style.cssText =
      'font-family:monospace;font-size:11px;cursor:pointer;' +
      'background:#333;color:#cfc;border:1px solid #555;padding:1px 6px;';
    var _glCanvas = null;
    glBtn.addEventListener('click', function() {
      if (!_glCanvas) {
        var canvases = document.querySelectorAll('canvas');
        for (var i = 0; i < canvases.length; i++) {
          if (canvases[i].style.zIndex === String(_CFG.canvasZIndex)) { _glCanvas = canvases[i]; break; }
        }
      }
      if (!_glCanvas) return;
      if (_glCanvas.style.display === 'none') {
        _glCanvas.style.display = '';
        glBtn.textContent = 'hide GL';
      } else {
        _glCanvas.style.display = 'none';
        glBtn.textContent = 'show GL';
      }
    });
    controls.appendChild(glBtn);
    panel.appendChild(controls);

    // ── Viewport section ──
    var vpSection = document.createElement('div');
    vpSection.style.cssText =
      'padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.12)';
    var vpTitle = document.createElement('div');
    vpTitle.style.cssText = 'color:#8cf;font-weight:bold';
    vpTitle.textContent = 'VIEWPORT';
    var vpTop = document.createElement('div');
    var vpBot = document.createElement('div');
    var _sy0 = global.scrollY || global.pageYOffset || 0;
    vpTop.textContent = 'top:    ' + _sy0 + 'px';
    vpBot.textContent = 'bottom: ' + (_sy0 + global.innerHeight) + 'px';
    vpSection.appendChild(vpTitle);
    vpSection.appendChild(vpTop);
    vpSection.appendChild(vpBot);
    panel.appendChild(vpSection);

    on(_EVENTS.SCROLL, function(p) {
      vpTop.textContent = 'top:    ' + p.viewportTop    + 'px';
      vpBot.textContent = 'bottom: ' + p.viewportBottom + 'px';
    });

    // ── Elements section ──
    var elSection = document.createElement('div');
    elSection.style.cssText =
      'padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.12);max-height:120px;overflow-y:auto';
    var elTitle = document.createElement('div');
    elTitle.style.cssText = 'color:#8cf;font-weight:bold';
    elTitle.textContent = 'ELEMENTS';
    var elList = document.createElement('div');
    elSection.appendChild(elTitle);
    elSection.appendChild(elList);
    panel.appendChild(elSection);

    var _elEntries = {};

    on(_EVENTS.ELEMENT_ENTER, function(p) {
      var filename = p.src ? p.src.split('/').pop() : '?';
      if (!_elEntries[p.id]) {
        var row = document.createElement('div');
        _elEntries[p.id] = row;
        elList.appendChild(row);
      }
      _elEntries[p.id].textContent = '\u25cf ' + p.id + '  ' + filename;
    });

    on(_EVENTS.ELEMENT_LEAVE, function(p) {
      if (_elEntries[p.id]) {
        _elEntries[p.id].textContent =
          '\u25cb' + _elEntries[p.id].textContent.slice(1);
      }
    });

    // ── Log section ──
    var logSection = document.createElement('div');
    logSection.style.cssText =
      'padding:4px 8px;max-height:300px;overflow-y:auto;pointer-events:auto';
    var logTitle = document.createElement('div');
    logTitle.style.cssText = 'color:#8cf;font-weight:bold';
    logTitle.textContent = 'LOG';
    var logList = document.createElement('div');
    logSection.appendChild(logTitle);
    logSection.appendChild(logList);
    panel.appendChild(logSection);

    var MAX_LOG = 100;
    function _addLog(line) {
      var row = document.createElement('div');
      row.textContent = line;
      logList.insertBefore(row, logList.firstChild);
      while (logList.children.length > MAX_LOG) logList.removeChild(logList.lastChild);
    }

    on(_EVENTS.TILES_DISPATCHED,  function(p) { _addLog('[worker \u2192] ' + p.id + '  ' + p.tileCount + ' tiles'); });
    on(_EVENTS.TILES_READY,       function(p) { _addLog('[worker \u2190] ' + p.id + '  ' + p.tileCount + ' tiles'); });
    on(_EVENTS.TILES_ERROR,       function(p) { _addLog('[error]    ' + p.id + '  ' + p.error); });
    on(_EVENTS.TEXTURE_CREATED,   function(p) { _addLog('[vram +]   ' + p.id + '  tile ' + p.tileIndex); });
    on(_EVENTS.TEXTURE_DESTROYED, function(p) { _addLog('[vram -]   ' + p.id + '  x' + p.tileCount); });

    _debugPanel = panel;
    return _debugPanel;
  }

  // ── Shader Panel ─────────────────────────────────────────────

  var _shaderPanel = null;

  function getShaderPanel() {
    if (_shaderPanel) return _shaderPanel;

    var panel = document.createElement('div');
    panel.style.cssText = [
      'font-family:monospace', 'font-size:11px', 'line-height:1.5',
      'color:#cfc', 'pointer-events:auto'
    ].join(';');

    var activeName = ShaderSystem.getDefault();

    for (var name in _shaderUIs) {
      if (!_shaderUIs.hasOwnProperty(name)) continue;

      var isActive = (name === activeName);

      var bar = document.createElement('div');
      bar.style.cssText =
        'padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.1)';

      var label = document.createElement('div');
      label.style.cssText = 'font-weight:bold;color:' + (isActive ? '#8cf' : '#666');
      label.textContent = (isActive ? '\u25cf ' : '\u25cb ') + name;
      bar.appendChild(label);

      if (isActive) {
        var container = document.createElement('div');
        container.style.cssText = 'padding:2px 0';
        _shaderUIs[name](container);
        bar.appendChild(container);
      }

      panel.appendChild(bar);
    }

    _shaderPanel = panel;
    return _shaderPanel;
  }

  // ============================================================
  // 10. CoreAPI
  // ============================================================

  var CoreAPI = (function() {
    var _initialized    = false;
    var _activeElements = new Map();
    var _config         = {};

    var _defaults = {
      targetSelector: _CFG.targetSelector,
      maxConcurrency: _CFG.maxConcurrency,
      defaultShader:  _CFG.defaultShader,
      rootMargin:     _CFG.rootMargin
    };

    var _callbacks = {
      onElementEnter: function(el, rect, src, shaderName) {
        if (!src) {
          console.warn('[imwebgl] No image source found for element:', el);
          return;
        }
        TexturePipeline.processElement(el, rect, src, shaderName, _activeElements);
      },

      onElementUpdate: function(el, newRect) {
        var info = _activeElements.get(el);
        if (!info) return;
        var src = _getImageSrc(el);
        if (!src) return;
        TexturePipeline.processElement(el, newRect, src, info.shaderName, _activeElements);
      },

      onElementLeave: function(id, el) {
        TexturePipeline.removeElement(id);
        if (el) _activeElements.delete(el);
      },

      onScroll: function(sx, sy) {
        WebGLRenderer.updateScroll(sx, sy);
      }
    };

    return {
      init: function(userConfig) {
        if (_initialized) {
          console.warn('[imwebgl] Already initialized. Call destroy() first.');
          return;
        }

        _config = {};
        for (var k in _defaults) {
          if (_defaults.hasOwnProperty(k)) _config[k] = _defaults[k];
        }
        if (userConfig) {
          for (var k2 in userConfig) {
            if (userConfig.hasOwnProperty(k2)) _config[k2] = userConfig[k2];
          }
        }

        WebGLRenderer.init(_activeElements);
        var gl = WebGLRenderer.getGL();
        if (!gl) {
          console.error('[imwebgl] Failed to acquire WebGL context. Aborting init.');
          return;
        }

        ShaderSystem.init(gl);
        ShaderSystem.setDefault(_config.defaultShader);

        TexturePipeline.init(gl, _config.maxConcurrency);
        DOMObserver.init(_config, _callbacks);

        _initialized = true;
      },

      registerShader: function(name, fragmentShaderSource) {
        ShaderSystem.register(name, fragmentShaderSource);
      },

      setUniforms: function(name, values) {
        ShaderSystem.setUniforms(name, values);
      },

      updateTargets: function() {
        DOMObserver.rescan();
      },

      getDebugPanel:  getDebugPanel,
      getShaderPanel: getShaderPanel,

      destroy: function() {
        if (!_initialized) return;
        DOMObserver.destroy();
        TexturePipeline.destroy();
        WebGLRenderer.destroy();
        ShaderSystem.destroy();
        _activeElements.clear();
        _listeners    = {};
        _debugPanel   = null;
        _shaderPanel  = null;
        _initialized  = false;
      }
    };
  })();

  // @@SHADER_INJECT@@

  // ============================================================
  // 11. EXPORT
  // ============================================================

  CoreAPI.on  = on;
  CoreAPI.off = off;
  global.WebGLImageEnhancer = CoreAPI;

})(window);
