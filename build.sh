#!/usr/bin/env bash
# build.sh — assembles imwebgl.js and tests/index.html
# Hand-edit src/imwebgl.core.js and shaders/*/frag.glsl + ui.js, then run this.
set -e
cd "$(dirname "$0")"

# Set to force a specific default shader; empty = first module found in filesystem order
DEFAULT_SHADER=""

SRC_CORE="src/imwebgl.core.js"
CONFIG_FILE="config.json"
SHADERS_DIR="shaders"
OUT_JS="imwebgl.js"
TESTS_DIR="tests"
OUT_HTML="$TESTS_DIR/index.html"

# Emit a _CFG var declaration from config.json, or fall back to hard-coded defaults.
inject_config() {
  if [ -f "$CONFIG_FILE" ]; then
    python3 -c "
import json, sys
cfg = json.load(open('$CONFIG_FILE'))
pairs = ', '.join(str(k) + ': ' + json.dumps(cfg[k]) for k in cfg)
print('  var _CFG = {' + pairs + '};')
"
  else
    echo '  var _CFG = { targetSelector: ".webgl-enhance", defaultShader: "color-pop", maxConcurrency: 2, rootMargin: "2000px", tileSize: 4096, resizeDebounceMs: 150, canvasZIndex: 9999 };'
  fi
}

# ── Step 1: Assemble imwebgl.js ──────────────────────────────────────────────
# Reads src/imwebgl.core.js line by line.
# When the sentinel "// @@SHADER_INJECT@@" is encountered, replaces it with:
#   - One block per shader module (frag.glsl as a JS string + register call + ui.js)
# All other lines are passed through unchanged.

{
  FIRST_SHADER=""

  while IFS= read -r line; do
    case "$line" in
      *'// @@CONFIG_INJECT@@'*)
        inject_config
        ;;
      *'// @@SHADER_INJECT@@'*)
        for FRAG in "$SHADERS_DIR"/*/frag.glsl; do
          [ -f "$FRAG" ] || continue
          NAME="$(basename "$(dirname "$FRAG")")"
          [ -z "$FIRST_SHADER" ] && FIRST_SHADER="$NAME"
          VARNAME="_$(printf '%s' "$NAME" | tr 'a-z-' 'A-Z_')_FRAG_SRC"

          echo "  // ── shader module: $NAME ──"
          printf '  var %s = ' "$VARNAME"
          python3 -c \
            "import json,sys; sys.stdout.write(json.dumps(open(sys.argv[1]).read()))" \
            "$FRAG"
          echo ";"
          echo "  ShaderSystem.register('$NAME', $VARNAME);"

          UI="$SHADERS_DIR/$NAME/ui.js"
          if [ -f "$UI" ]; then
            echo ""
            cat "$UI"
            echo ""
          fi
        done

        if [ -n "$DEFAULT_SHADER" ]; then
          echo "  ShaderSystem.setDefault('$DEFAULT_SHADER');"
        fi
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done < "$SRC_CORE"
} > "$OUT_JS"

echo "Built: $OUT_JS"

# ── Step 2: Assemble tests/index.html ────────────────────────────────────────
# A minimal example page: image gallery + inlined imwebgl.js + init + panels.

mkdir -p "$TESTS_DIR"

{
  cat <<'HTMLHEAD'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>imwebgl test render</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: #1a1a2e; font-family: sans-serif; color: #eee; }
    .header {
      position: sticky; top: 0; z-index: 20000;
      background: rgba(255,255,255,0.05); color: #cfc;
      font-family: monospace; font-size: 12px;
      padding: 6px 10px; border-bottom: 1px solid #333;
    }
    .gallery {
      display: flex; flex-direction: column; align-items: center;
      gap: 0; padding: 40px 0;
    }
    .gallery .label {
      font-size: 0.75rem; opacity: 0.5; padding: 4px 8px;
      background: rgba(0,0,0,0.4); align-self: flex-start;
      margin-left: calc(50% - 300px);
    }
    .gallery img { display: block; width: 600px; max-width: 100%; }
  </style>
</head>
<body>
<div class="header">imwebgl — build render</div>
<div class="gallery">
HTMLHEAD

  for IMG in "$TESTS_DIR"/*.jpg "$TESTS_DIR"/*.jpeg "$TESTS_DIR"/*.png \
             "$TESTS_DIR"/*.gif "$TESTS_DIR"/*.webp "$TESTS_DIR"/*.avif; do
    [ -f "$IMG" ] || continue
    BASENAME="$(basename "$IMG")"
    printf '  <div class="label">%s</div>\n  <img class="webgl-enhance" src="%s" alt="%s">\n' \
      "$BASENAME" "$BASENAME" "$BASENAME"
  done

  cat <<'HTMLMID'
</div>

<script>
HTMLMID

  cat "$OUT_JS"

  cat <<'HTMLFOOT'
</script>

<script>
WebGLImageEnhancer.init({ targetSelector: '.webgl-enhance' });
</script>

<script>
var _dbg = WebGLImageEnhancer.getDebugPanel();
_dbg.appendChild(WebGLImageEnhancer.getShaderPanel());
document.body.appendChild(_dbg);
</script>

</body>
</html>
HTMLFOOT
} > "$OUT_HTML"

echo "Built: $OUT_HTML"
