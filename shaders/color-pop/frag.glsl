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
