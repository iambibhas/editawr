/**
 * GPU editing pipeline.
 *
 *   pass 1  point operations in linear light (WB, exposure, highlight recovery,
 *           shadows), then output-referred tone/colour (levels, contrast,
 *           vibrance, dehaze)
 *   pass 2  neighbourhood operations (denoise, clarity/texture, sharpening,
 *           vignette, grain) in display-referred space
 *
 * Source can be 8-bit sRGB (JPEG/PNG or embedded RAW preview) or 16-bit linear
 * uint (LibRaw output), both sampled through the same shader via a define-free
 * runtime branch.
 */

const VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG1 = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;

in vec2 vUv;
out vec4 outColor;

#ifdef USE_U16
uniform usampler2D uSrc16;
#else
uniform sampler2D uSrc8;
#endif
uniform vec2 uSrcSize;
uniform vec4 uMap;
uniform int uRot;

uniform float uTemp;
uniform float uTint;
uniform float uExposure;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uContrast;
uniform float uVibrance;
uniform float uSaturation;
uniform float uDehaze;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA_W); }

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow(max(c + 0.055, vec3(0.0)) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

#ifndef USE_U16
vec3 sampleSrc(vec2 uv) {
  return srgbToLinear(clamp(texture(uSrc8, uv).rgb, 0.0, 1.0));
}
#else
vec3 sampleSrc(vec2 uv) {
  vec2 p = uv * uSrcSize - 0.5;
  vec2 fl = floor(p);
  vec2 f = p - fl;
  ivec2 maxi = ivec2(uSrcSize) - ivec2(1);
  ivec2 i0 = clamp(ivec2(fl), ivec2(0), maxi);
  ivec2 i1 = clamp(ivec2(fl) + ivec2(1, 0), ivec2(0), maxi);
  ivec2 i2 = clamp(ivec2(fl) + ivec2(0, 1), ivec2(0), maxi);
  ivec2 i3 = clamp(ivec2(fl) + ivec2(1, 1), ivec2(0), maxi);
  vec3 a = vec3(texelFetch(uSrc16, i0, 0).rgb);
  vec3 b = vec3(texelFetch(uSrc16, i1, 0).rgb);
  vec3 c = vec3(texelFetch(uSrc16, i2, 0).rgb);
  vec3 d = vec3(texelFetch(uSrc16, i3, 0).rgb);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) / 65535.0;
}
#endif

vec2 rotateUv(vec2 r) {
  if (uRot == 1) return vec2(r.y, 1.0 - r.x);
  if (uRot == 2) return vec2(1.0 - r.x, 1.0 - r.y);
  if (uRot == 3) return vec2(1.0 - r.y, r.x);
  return r;
}

vec3 kelvinRGB(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
  vec3 c;
  if (t <= 66.0) c.r = 1.0;
  else c.r = clamp(1.292936186 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
  if (t <= 66.0) c.g = clamp(0.3900815788 * log(t) - 0.6318414438, 0.0, 1.0);
  else c.g = clamp(1.1298908609 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
  if (t >= 66.0) c.b = 1.0;
  else if (t <= 19.0) c.b = 0.0;
  else c.b = clamp(0.5432067891 * log(t - 10.0) - 1.1962540891, 0.0, 1.0);
  return c;
}

vec3 applyWb(vec3 c) {
  if (abs(uTemp) > 0.001 || abs(uTint) > 0.001) {
    float k = 6500.0 * pow(0.42, uTemp / 100.0);
    vec3 ref = kelvinRGB(6500.0);
    vec3 cur = max(kelvinRGB(k), vec3(0.02));
    vec3 gain = pow(cur / ref, vec3(2.2));
    gain /= max(gain.g, 0.0001);
    float tint = clamp(uTint / 100.0, -1.0, 1.0);
    gain.g *= 1.0 - tint * 0.16;
    gain.r *= 1.0 + tint * 0.045;
    gain.b *= 1.0 + tint * 0.045;
    c *= clamp(gain, vec3(0.2), vec3(5.0));
  }
  return c;
}

float highlightDelta(float L) {
  float hi = clamp(uHighlights / 100.0, -1.0, 1.0);
  if (abs(hi) < 0.001) return 0.0;
  float mask = smoothstep(0.32, 1.0, L);
  if (hi < 0.0) return -L * 0.68 * (-hi) * mask;
  return hi * 0.36 * mask;
}

float shadowDelta(float L) {
  float sh = clamp(uShadows / 100.0, -1.0, 1.0);
  if (abs(sh) < 0.001) return 0.0;
  float mask = 1.0 - smoothstep(0.0, 0.62, L);
  if (sh > 0.0) return sh * 0.30 * mask * (1.0 - L);
  return -L * 0.65 * (-sh) * mask;
}

vec3 applyDisplay(vec3 c) {
  // Highlights / shadows act on perceptual luminance over a wide tonal range,
  // which is what makes them usable on already-tone-mapped images (JPEG/HE*).
  float L0 = luma(c);
  float L1 = clamp(L0 + highlightDelta(L0) + shadowDelta(L0), 0.0, 1.0);
  c *= L1 / max(L0, 1e-4);
  c = clamp(c, 0.0, 1.0);

  // Whites / blacks (levels with Lightroom-ish signs).
  float wp = 1.0 - (uWhites / 100.0) * 0.22;
  float bp = (uBlacks / 100.0) * 0.14;
  c = (c - bp) / max(wp - bp, 0.25);

  // Contrast: S-curve for positive, flatten for negative.
  float k = clamp(uContrast / 100.0, -1.0, 1.0);
  c = clamp(c, 0.0, 1.0);
  if (k > 0.0) c = mix(c, smoothstep(0.0, 1.0, c), k * 0.85);
  else if (k < 0.0) c = mix(c, 0.5 + (c - 0.5) * 0.55, -k * 0.85);

  // Saturation then vibrance (less-saturated colours get more).
  float L = luma(c);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = mx - mn;
  float satAmt = clamp(uSaturation / 100.0, -1.0, 1.0);
  c = mix(vec3(L), c, 1.0 + satAmt);
  float vib = clamp(uVibrance / 100.0, -1.0, 1.0);
  c = mix(vec3(luma(c)), c, 1.0 + vib * (1.0 - smoothstep(0.04, 0.55, sat)) * 0.8);

  // Dehaze: mild global contrast + saturation lift.
  float dh = clamp(uDehaze / 100.0, -1.0, 1.0);
  if (abs(dh) > 0.001) {
    c = (c - dh * 0.07) / (1.0 - dh * 0.16);
    c = mix(vec3(luma(c)), c, 1.0 + dh * 0.28);
  }
  return clamp(c, 0.0, 1.0);
}

void main() {
  // vUv has its origin at the bottom-left (GL), while uMap/crop coordinates
  // are image coordinates with y going down. Flip once here so the sampled
  // image is upright; otherwise every photo appears vertically mirrored.
  vec2 outUv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 uvRot = uMap.xy + outUv * uMap.zw;
  vec2 uv = clamp(rotateUv(uvRot), vec2(0.0), vec2(1.0));
  vec3 c = sampleSrc(uv);

  c = applyWb(c);
  c *= exp2(uExposure);
  c = clamp(linearToSrgb(c), 0.0, 1.0);
  c = applyDisplay(c);
  // Dither the intermediate 8-bit target: pass 2 sharpens this buffer, and
  // quantisation steps in a heavily denoised gradient otherwise show up as
  // banded contours.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  outColor = vec4(clamp(c + n / 255.0, 0.0, 1.0), 1.0);
}`;

const FRAG2 = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uDpr;
uniform int uFast;
uniform float uDenoise;
uniform float uDenoiseDetail;
uniform float uColorNR;
uniform float uClarity;
uniform float uTexture;
uniform float uSharpen;
uniform float uSharpenRadius;
uniform float uSharpenDetail;
uniform float uSharpenMasking;
uniform float uVignette;
uniform float uGrain;

const vec2 K8[8] = vec2[8](
  vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0),
  vec2(0.7071, 0.7071), vec2(-0.7071, 0.7071), vec2(0.7071, -0.7071), vec2(-0.7071, -0.7071)
);

// Wider kernel for the wavelet scales: a single 8-tap ring is too sparse at
// large radii and leaves residual grain in the reconstructed low-pass.
const vec2 K16[16] = vec2[16](
  vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0),
  vec2(0.7071, 0.7071), vec2(-0.7071, 0.7071), vec2(0.7071, -0.7071), vec2(-0.7071, -0.7071),
  vec2(1.4142, 0.0), vec2(-1.4142, 0.0), vec2(0.0, 1.4142), vec2(0.0, -1.4142),
  vec2(1.0, 1.0), vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(-1.0, -1.0)
);

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 tap(vec2 uv) { return texture(uTex, uv).rgb; }
float tapLuma(vec2 uv) { return luma(tap(uv)); }

vec3 ycc(vec3 c) {
  return vec3(
    dot(c, vec3(0.25, 0.5, 0.25)),
    dot(c, vec3(0.5, 0.0, -0.5)),
    dot(c, vec3(-0.25, 0.5, -0.25))
  );
}
vec3 yccInv(vec3 v) {
  return vec3(v.x + v.y - v.z, v.x + v.z, v.x - v.y - v.z);
}

float blurLuma(vec2 uv, float radiusPx) {
  float s = tapLuma(uv);
  float ws = 1.0;
  for (int i = 0; i < 8; i++) {
    if (uFast == 1 && i >= 4) break;
    float w = (i % 2 == 0) ? 1.0 : 0.7;
    s += tapLuma(uv + K8[i] * radiusPx * uTexel) * w;
    ws += w;
  }
  return s / ws;
}

float blurLumaHQ(vec2 uv, float radiusPx) {
  float s = tapLuma(uv) * 1.4;
  float ws = 1.4;
  int taps = uFast == 1 ? 8 : 16;
  for (int i = 0; i < 16; i++) {
    if (i >= taps) break;
    float w = (i < 8) ? ((i % 2 == 0) ? 1.0 : 0.72) : 0.55;
    s += tapLuma(uv + K16[i] * radiusPx * uTexel) * w;
    ws += w;
  }
  return s / ws;
}

float bilateralLuma(vec2 uv, float radiusPx, float sigma, float guide) {
  float s = tapLuma(uv);
  float ws = 1.0;
  for (int i = 0; i < 8; i++) {
    if (uFast == 1 && i >= 4) break;
    float y = tapLuma(uv + K8[i] * radiusPx * uTexel);
    float w = exp(-abs(y - guide) / max(sigma, 0.004));
    s += y * w;
    ws += w;
  }
  return s / ws;
}

// Garrote-style wavelet coefficient shrinkage. Small coefficients (noise) are
// zeroed, large ones (edges/texture) survive almost untouched, and unlike a
// soft threshold there is no constant offset that would shift local tone.
float shrinkCoeff(float d, float t) {
  float ad = abs(d);
  if (ad <= t) return 0.0;
  return sign(d) * (ad - (t * t) / ad);
}

// Luma-guided chroma blur: smooths colour noise without bleeding across edges.
vec3 chromaBlur(vec2 uv, float radiusPx, float guide) {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (uFast == 1 && i >= 4) break;
    vec3 s = tap(uv + K8[i] * radiusPx * uTexel);
    float dy = abs(luma(s) - guide);
    float w = exp(-dy / 0.05);
    sum += s * w;
    wsum += w;
  }
  return wsum > 0.0 ? sum / wsum : tap(uv);
}

vec3 denoiseColor(vec3 c, vec2 uv) {
  float amt = clamp(uDenoise / 100.0, 0.0, 1.0);
  float camt = clamp(uColorNR / 100.0, 0.0, 1.0);
  if (amt < 0.002 && camt < 0.002) return c;

  float dpr = max(uDpr, 1.0);
  float Y0 = luma(c);
  float Y = Y0;
  float detail = clamp(uDenoiseDetail / 100.0, 0.0, 1.0);

  if (amt > 0.002) {
    // Two-scale a-trous denoise. Coarser detail bands are deliberately NOT
    // shrunk: zeroing them near a hard edge leaves the wide low-pass
    // un-cancelled, which shows up as a broad bright/dark halo (and as
    // posterised blobs on compressed previews). b3 is computed only as a
    // wide edge detector so the two working bands are protected there.
    float r1 = mix(1.0, 1.8, amt) * dpr;
    float b1 = blurLumaHQ(uv, r1);
    float b2 = blurLumaHQ(uv, r1 * 2.0);
    float b3 = blurLumaHQ(uv, r1 * 4.0);
    float d1 = Y0 - b1;
    float d2 = b1 - b2;

    float noiseGate = mix(0.020, 0.120, amt) * 1.2;
    float fineEdge = max(abs(d1) - noiseGate, 0.0);
    float coarseEdge = max(abs(b1 - b3) - noiseGate, 0.0);
    float structure = smoothstep(
      0.030, 0.180,
      abs(d2) + coarseEdge * 1.5 + fineEdge * 1.2
    );
    float preserve = mix(1.0, 0.035, structure * (0.55 + 0.45 * detail));

    float sigma = mix(0.012, 0.14, amt);
    float t1 = sigma * 1.15 * preserve * mix(1.0, 0.50, detail);
    float t2 = sigma * 0.85 * preserve * mix(1.0, 0.60, detail);

    float den = b2 + shrinkCoeff(d2, t2) + shrinkCoeff(d1, t1);
    // Clean up whatever survives the wavelet, but only in flat areas.
    float smoothLuma = bilateralLuma(uv, 1.15 * dpr, 0.020, den);
    den = mix(den, smoothLuma, amt * 0.45 * (1.0 - structure));
    Y = clamp(mix(Y0, den, smoothstep(0.0, 0.10, amt)), 0.0, 1.0);
  }

  vec3 outC = c * (Y / max(Y0, 1e-4));

  if (camt > 0.002) {
    float radius = mix(3.0, 10.0, max(amt, 0.35)) * dpr;
    vec3 bC1 = chromaBlur(uv, radius, Y);
    vec3 bC2 = chromaBlur(uv, radius * 2.2, Y);
    vec3 blurred = mix(bC1, bC2, 0.5);
    vec3 yccC = ycc(outC);
    vec3 yccB = ycc(blurred);
    float Co = mix(yccC.y, yccB.y, camt);
    float Cg = mix(yccC.z, yccB.z, camt);
    // Keep YCoCg's own luma component: mixing Rec.709 luma with YCoCg chroma
    // shifts brightness/colour when color noise reduction is applied.
    outC = yccInv(vec3(yccC.x, Co, Cg));
  }

  return clamp(outC, 0.0, 1.0);
}

vec3 applyDetail(vec3 c, vec2 uv) {
  float clarity = uClarity / 100.0;
  float textureAmt = uTexture / 100.0;
  if (abs(clarity) < 0.001 && abs(textureAmt) < 0.001) return c;

  float dpr = max(uDpr, 1.0);
  float y = luma(c);
  float y0 = y;
  if (abs(clarity) > 0.001) {
    float b = blurLuma(uv, 16.0 * dpr);
    y += (y - b) * clarity * 1.15;
  }
  if (abs(textureAmt) > 0.001) {
    float b = blurLuma(uv, 3.0 * dpr);
    y += (y - b) * textureAmt * 1.35;
  }
  y = clamp(y, 0.0, 1.0);
  return clamp(c * (y / max(y0, 0.0005)), 0.0, 1.0);
}

vec3 applySharpen(vec3 c, vec2 uv) {
  float amt = uSharpen / 100.0;
  if (amt < 0.001) return c;
  float dpr = max(uDpr, 1.0);
  float y = luma(c);
  float r = max(0.6, uSharpenRadius) * dpr;
  float bBase = blurLuma(uv, r);
  float bFine = blurLuma(uv, max(0.35, r * 0.5));
  float hpBase = y - bBase;
  float hpFine = y - bFine;
  float detailMix = clamp(uSharpenDetail / 100.0, 0.0, 1.0);
  float hp = mix(hpBase, hpFine, detailMix);
  float edge = smoothstep(0.004, 0.05, abs(hpFine));
  float masking = clamp(uSharpenMasking / 100.0, 0.0, 1.0);
  float mask = mix(1.0, edge, masking);
  // 40 => a subtle 0.4x high-pass; 150 => 1.5x. The old 2.2x multiplier made
  // the default look like heavy local contrast once denoise had smoothed it.
  float yOut = y + hp * amt * 1.0 * mask;
  // Halo suppression: never push a pixel outside its local tonal range.
  // This is what stops unsharp masking from outlining denoised/compressed areas.
  float yMin = y;
  float yMax = y;
  float rHalo = max(2.0, r * 3.0) * dpr;
  for (int i = 0; i < 8; i++) {
    if (uFast == 1 && i >= 4) break;
    float yn = tapLuma(uv + K8[i] * rHalo * uTexel);
    yMin = min(yMin, yn);
    yMax = max(yMax, yn);
  }
  yOut = clamp(yOut, yMin - 0.003, yMax + 0.003);
  yOut = clamp(yOut, 0.0, 1.0);
  return clamp(c * (yOut / max(y, 0.0005)), 0.0, 1.0);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 c = texture(uTex, vUv).rgb;
  c = denoiseColor(c, vUv);
  c = applyDetail(c, vUv);
  c = applySharpen(c, vUv);

  // Optical vignette.
  if (abs(uVignette) > 0.001) {
    vec2 d = vUv - 0.5;
    float r = length(d) * 1.41421356;
    float f = smoothstep(0.15, 1.02, r);
    c *= 1.0 + (uVignette / 100.0) * f * 0.85;
  }

  // Film-ish grain, strongest in the mid-tones.
  if (uGrain > 0.001) {
    float n = hash21(gl_FragCoord.xy) - 0.5;
    float strength = (uGrain / 100.0) * 0.16 * (1.0 - abs(luma(c) - 0.45) * 1.1);
    c += n * max(strength, 0.0);
  }

  // Ordered-ish dither to avoid banding in gradients.
  c += (hash21(gl_FragCoord.xy * 1.7) - 0.5) / 255.0;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function withDefine(src, define) {
  return src.replace('#version 300 es', `#version 300 es
#define ${define}`);
}

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`${label} shader compile failed: ${log}`);
  }
  return sh;
}

function makeProgram(gl, fragSource, label) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT, `${label} vertex`);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSource, `${label} fragment`);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`${label} program link failed: ${log}`);
  }
  return prog;
}

export class GLPipeline {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
      desynchronized: false,
    });
    if (!this.gl) throw new Error('WebGL 2 is not available on this system');
    this.dead = false;
    this.source = null;
    this._targetW = 0;
    this._targetH = 0;
    this._init();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.dead = true;
      this.onContextLost?.();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.dead = false;
      this._init();
      this.onContextRestored?.();
    });
  }

  _locMap(program) {
    const gl = this.gl;
    const map = {};
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(program, i);
      if (info) map[info.name] = gl.getUniformLocation(program, info.name);
    }
    return map;
  }

  _init() {
    const gl = this.gl;
    this.prog1 = makeProgram(gl, FRAG1, 'point');
    this.prog1u16 = makeProgram(gl, withDefine(FRAG1, 'USE_U16'), 'point u16');
    this.prog2 = makeProgram(gl, FRAG2, 'neighbourhood');

    this.loc1 = this._locMap(this.prog1);
    this.loc1u16 = this._locMap(this.prog1u16);
    this.loc2 = this._locMap(this.prog2);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.texA = null;
    this.fboA = null;
    this._targetW = 0;
    this._targetH = 0;
    this.source = null;
  }

  get maxSize() {
    return this.gl ? this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) : 4096;
  }

  _deleteTarget() {
    const gl = this.gl;
    if (this.fboA) gl.deleteFramebuffer(this.fboA);
    if (this.texA) gl.deleteTexture(this.texA);
    this.fboA = null;
    this.texA = null;
    this._targetW = 0;
    this._targetH = 0;
  }

  _ensureTarget(w, h) {
    if (this._targetW === w && this._targetH === h && this.fboA) return;
    const gl = this.gl;
    this._deleteTarget();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      throw new Error(`Framebuffer incomplete (0x${status.toString(16)}) at ${w}x${h}`);
    }
    this.texA = tex;
    this.fboA = fbo;
    this._targetW = w;
    this._targetH = h;
  }

  _deleteSource() {
    if (this.source?.texture) this.gl.deleteTexture(this.source.texture);
    this.source = null;
  }

  setBitmap(bitmap) {
    const gl = this.gl;
    this._deleteSource();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Downsampling for a fit-to-screen view is much cleaner with mipmaps.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.source = { kind: 'u8', texture: tex, width: bitmap.width, height: bitmap.height, name: 'sRGB 8-bit' };
    return this.source;
  }

  setLinear16(data, width, height) {
    const gl = this.gl;
    this._deleteSource();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    let kind = 'u16';
    let err = 0;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16UI, width, height, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, data);
    err = gl.getError();
    if (err !== gl.NO_ERROR) {
      // Fallback: expand to RGBA (more memory but universally supported).
      const rgba = new Uint16Array(width * height * 4);
      for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
        rgba[j] = data[i];
        rgba[j + 1] = data[i + 1];
        rgba[j + 2] = data[i + 2];
        rgba[j + 3] = 65535;
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, width, height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, rgba);
      kind = 'u16rgba';
      console.warn('[gl] RGB16UI unsupported, using RGBA16UI fallback');
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.source = { kind, texture: tex, width, height, name: 'linear 16-bit RAW' };
    return this.source;
  }

  clearSource() {
    this._deleteSource();
  }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this._ensureTarget(w, h);
  }

  render({ edits, map, rotation = 0, dpr = 1, fast = false }) {
    const gl = this.gl;
    if (!gl || this.dead || !this.source) return false;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return false;
    this._ensureTarget(w, h);

    const rot = ((Math.round(rotation / 90) % 4) + 4) % 4;

    // ---- pass 1 -------------------------------------------------------
    const isU16 = this.source.kind !== 'u8';
    const prog1 = isU16 ? this.prog1u16 : this.prog1;
    const loc1 = isU16 ? this.loc1u16 : this.loc1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog1);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.source.texture);
    gl.uniform1i(isU16 ? loc1.uSrc16 : loc1.uSrc8, 0);
    gl.uniform2f(loc1.uSrcSize, this.source.width, this.source.height);
    gl.uniform4f(loc1.uMap, map.x, map.y, map.w, map.h);
    gl.uniform1i(loc1.uRot, rot);

    const e = edits;
    gl.uniform1f(loc1.uTemp, e.temp);
    gl.uniform1f(loc1.uTint, e.tint);
    gl.uniform1f(loc1.uExposure, e.exposure);
    gl.uniform1f(loc1.uHighlights, e.highlights);
    gl.uniform1f(loc1.uShadows, e.shadows);
    gl.uniform1f(loc1.uWhites, e.whites);
    gl.uniform1f(loc1.uBlacks, e.blacks);
    gl.uniform1f(loc1.uContrast, e.contrast);
    gl.uniform1f(loc1.uVibrance, e.vibrance);
    gl.uniform1f(loc1.uSaturation, e.saturation);
    gl.uniform1f(loc1.uDehaze, e.dehaze);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- pass 2 -------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog2);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.uniform1i(this.loc2.uTex, 0);
    gl.uniform2f(this.loc2.uTexel, 1 / w, 1 / h);
    gl.uniform1f(this.loc2.uDpr, dpr);
    gl.uniform1i(this.loc2.uFast, fast ? 1 : 0);
    gl.uniform1f(this.loc2.uDenoise, e.denoise);
    gl.uniform1f(this.loc2.uDenoiseDetail, e.denoiseDetail);
    gl.uniform1f(this.loc2.uColorNR, e.colorNR);
    gl.uniform1f(this.loc2.uClarity, e.clarity);
    gl.uniform1f(this.loc2.uTexture, e.texture);
    gl.uniform1f(this.loc2.uSharpen, e.sharpenAmount);
    gl.uniform1f(this.loc2.uSharpenRadius, e.sharpenRadius);
    gl.uniform1f(this.loc2.uSharpenDetail, e.sharpenDetail);
    gl.uniform1f(this.loc2.uSharpenMasking, e.sharpenMasking);
    gl.uniform1f(this.loc2.uVignette, e.vignette);
    gl.uniform1f(this.loc2.uGrain, e.grain);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  toBlob(type = 'image/jpeg', quality = 0.95) {
    // Call from a user gesture / after a render; canvas has preserveDrawingBuffer.
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))), type, quality);
    });
  }

  dispose() {
    this._deleteTarget();
    this._deleteSource();
    if (this.vao) this.gl?.deleteVertexArray(this.vao);
    this.vao = null;
  }
}
