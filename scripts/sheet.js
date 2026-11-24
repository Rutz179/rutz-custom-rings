/**
 * Spritesheet building and preview drawing; browser-only, no Foundry globals.
 * Sheet layout as the built-in rings: 4096x2048, left 2048x2048 frame "token-ring", right 2048x2048 frame "token-ring-bkg".
 */
export const FRAME_SIZE = 2048;

/** Foundry sizes the subject with 1 / (ringThickness + 2/3). */
export const SUBJECT_BASE = 2 / 3;

export const DEFAULTS = Object.freeze({
  ringThickness: 0.26,
  ringColor: "#ffffff",
  bandStart: 0.75,
  bandEnd: 1,
  bkgSize: 0.7,
  bkgColor: "#ffffff",
  shadow: 0.5
});

export function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Load an image for drawing on a canvas. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image: ${src}`));
    img.src = src;
  });
}

function clamp(value, min, max) {
  const n = Number(value);
  if ( !Number.isFinite(n) ) return min;
  return Math.min(max, Math.max(min, n));
}

function sourceSize(img) {
  const w = img.naturalWidth || img.videoWidth || img.width || 0;
  const h = img.naturalHeight || img.videoHeight || img.height || 0;
  return (w > 0 && h > 0) ? {w, h} : {w: 1, h: 1};
}

/** Draw an image centred in a square box, "contain" or "cover". */
function drawFitted(ctx, img, x, y, size, mode = "contain") {
  const {w, h} = sourceSize(img);
  const scale = (mode === "cover") ? Math.max(size / w, size / h) : Math.min(size / w, size / h);
  const dw = w * scale;
  const dh = h * scale;
  ctx.drawImage(img, x + ((size - dw) / 2), y + ((size - dh) / 2), dw, dh);
}

/** Multiply a canvas by a colour, keeping its alpha. */
function tintCanvas(canvas, color) {
  const ctx = canvas.getContext("2d");
  const mask = makeCanvas(canvas.width, canvas.height);
  mask.getContext("2d").drawImage(canvas, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

/** Ring frame: the ring image fitted into the square. */
export function drawRingFrame(ctx, ring, x, y, size) {
  if ( ring ) drawFitted(ctx, ring, x, y, size, "contain");
}

/**
 * Background frame: a disc of the texture or plain colour, optionally tinted; transparent when neither.
 * opts: bkg (texture), bkgColor (#rrggbb | null), bkgSize (disc diameter / frame).
 */
export function drawBackgroundFrame(ctx, x, y, size, {bkg = null, bkgColor = null, bkgSize = DEFAULTS.bkgSize} = {}) {
  if ( !bkg && !bkgColor ) return;
  const d = clamp(bkgSize, 0.05, 1) * size;
  const off = makeCanvas(size, size);
  const o = off.getContext("2d");
  o.save();
  o.beginPath();
  o.arc(size / 2, size / 2, d / 2, 0, Math.PI * 2);
  o.closePath();
  o.clip();
  if ( bkg ) drawFitted(o, bkg, (size - d) / 2, (size - d) / 2, d, "cover");
  else {
    o.fillStyle = "#ffffff";
    o.fillRect(0, 0, size, size);
  }
  o.restore();
  if ( bkgColor ) tintCanvas(off, bkgColor);
  ctx.drawImage(off, x, y);
}

/** Compose the full 4096x2048 sheet (or 2*frame x frame). */
export function composeSheet({ring, bkg = null, bkgColor = null, bkgSize = DEFAULTS.bkgSize,
  shadow = 0, ringThickness = DEFAULTS.ringThickness}, frame = FRAME_SIZE) {
  const canvas = makeCanvas(frame * 2, frame);
  const ctx = canvas.getContext("2d");
  if ( shadow > 0 ) ctx.drawImage(addInnerShadow(renderRingFrame(ring, frame), {strength: shadow, ringThickness}), 0, 0);
  else drawRingFrame(ctx, ring, 0, 0, frame);
  drawBackgroundFrame(ctx, frame, 0, frame, {bkg, bkgColor, bkgSize});
  return canvas;
}

/** One frame cut out of a sheet image (rect from rings.json). */
export function cropFrame(img, rect) {
  const canvas = makeCanvas(rect.w, rect.h);
  canvas.getContext("2d").drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return canvas;
}

/** A ring frame canvas from a ring image. */
export function renderRingFrame(ring, size = FRAME_SIZE) {
  const canvas = makeCanvas(size, size);
  drawRingFrame(canvas.getContext("2d"), ring, 0, 0, size);
  return canvas;
}

/** A background frame canvas (disc of texture or colour). */
export function renderBackgroundFrame(opts, size = FRAME_SIZE) {
  const canvas = makeCanvas(size, size);
  drawBackgroundFrame(canvas.getContext("2d"), 0, 0, size, opts);
  return canvas;
}

/** Sheet from two ready frames (left ring, right background); frames of another size are scaled. */
export function composeSheetFrom(ringFrame, bkgFrame, frame = FRAME_SIZE) {
  const canvas = makeCanvas(frame * 2, frame);
  const ctx = canvas.getContext("2d");
  if ( ringFrame ) ctx.drawImage(ringFrame, 0, 0, frame, frame);
  if ( bkgFrame ) ctx.drawImage(bkgFrame, frame, 0, frame, frame);
  return canvas;
}

/** The visible disc of a background frame: a square crop around the centre and its diameter as a fraction of the frame; null when the frame is empty. */
export function measureDisc(frameCanvas) {
  const {width: w, height: h} = frameCanvas;
  const data = frameCanvas.getContext("2d").getImageData(0, 0, w, h).data;
  const cx = w / 2;
  const cy = h / 2;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 512));
  let r2 = 0;
  for ( let y = 0; y < h; y += step ) {
    for ( let x = 0; x < w; x += step ) {
      if ( data[(((y * w) + x) * 4) + 3] <= 8 ) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      r2 = Math.max(r2, (dx * dx) + (dy * dy));
    }
  }
  if ( !r2 ) return null;
  const half = Math.min(w, h) / 2;
  const r = Math.min(half, Math.sqrt(r2) + step);
  const side = Math.max(1, Math.round(r * 2));
  const crop = makeCanvas(side, side);
  crop.getContext("2d").drawImage(frameCanvas, cx - r, cy - r, r * 2, r * 2, 0, 0, side, side);
  return {canvas: crop, size: r / half};
}

function round(n, digits = 4) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** rings.json in the same layout as the built-in rings. */
export function buildRingsJson({imageName, ringThickness = DEFAULTS.ringThickness, ringColor = DEFAULTS.ringColor,
  bandStart = DEFAULTS.bandStart, bandEnd = DEFAULTS.bandEnd}, frame = FRAME_SIZE) {
  let start = clamp(bandStart, 0, 1);
  let end = clamp(bandEnd, 0, 1);
  if ( start > end ) [start, end] = [end, start];
  const rect = x => ({x, y: 0, w: frame, h: frame});
  const common = () => ({
    rotated: false,
    trimmed: false,
    spriteSourceSize: {x: 0, y: 0, w: frame, h: frame},
    sourceSize: {w: frame, h: frame},
    anchor: {x: 0.5, y: 0.5}
  });
  return {
    config: {
      defaultRingColor: /^#[0-9a-f]{6}$/i.test(ringColor ?? "") ? ringColor : DEFAULTS.ringColor
    },
    frames: {
      "token-ring": {
        frame: rect(0),
        ...common(),
        ringThickness: round(clamp(ringThickness, 0, 1)),
        ringColor: null,
        colorBand: {startRadius: round(start), endRadius: round(end)}
      },
      "token-ring-bkg": {
        frame: rect(frame),
        ...common(),
        isBackground: true
      }
    },
    meta: {
      image: imageName,
      format: "RGBA8888",
      size: {w: frame * 2, h: frame},
      scale: "1"
    }
  };
}

/** Name of the ring frame in a rings.json ("token-ring" in all built-ins). */
export function ringFrameKey(json) {
  const keys = Object.keys(json?.frames ?? {});
  return keys.includes("token-ring") ? "token-ring" : (keys.find(k => !k.endsWith("-bkg")) ?? "token-ring");
}

/** A copy of an existing rings.json with a new image name and only the given changes (undefined = keep); `frame` gives the standard side-by-side layout of that size. */
export function patchRingsJson(base, {imageName, frame = null, ringThickness, ringColor, bandStart, bandEnd} = {}) {
  const json = JSON.parse(JSON.stringify(base ?? {}));
  json.frames ??= {};
  const ringKey = ringFrameKey(json);
  const bkgKey = `${ringKey}-bkg`;
  if ( frame ) {
    const layout = (key, x, extra) => {
      const f = json.frames[key] ??= {};
      Object.assign(f, {
        frame: {x, y: 0, w: frame, h: frame},
        spriteSourceSize: {x: 0, y: 0, w: frame, h: frame},
        sourceSize: {w: frame, h: frame}
      }, extra);
    };
    layout(ringKey, 0, {});
    layout(bkgKey, frame, {isBackground: true});
    json.meta = {...(json.meta ?? {}), size: {w: frame * 2, h: frame}};
  }
  json.meta = json.meta ? {...json.meta, image: imageName} : {image: imageName, format: "RGBA8888", scale: "1"};
  const ring = json.frames[ringKey] ??= {};
  if ( ringThickness !== undefined ) ring.ringThickness = round(clamp(ringThickness, 0, 1));
  if ( ringColor !== undefined ) json.config = {...(json.config ?? {}), defaultRingColor: ringColor};
  if ( (bandStart !== undefined) || (bandEnd !== undefined) ) {
    let start = clamp(bandStart ?? 0, 0, 1);
    let end = clamp(bandEnd ?? 1, 0, 1);
    if ( start > end ) [start, end] = [end, start];
    ring.colorBand = {startRadius: round(start), endRadius: round(end)};
  }
  return json;
}

/* Inner shadow */

/** Inner shadow shape, after Foundry's dynamic token template (a soft crescent along the inner bottom rim, here symmetric around straight down). Lengths are fractions of the half frame. */
export const SHADOW_SHAPE = Object.freeze({
  halfSpan: 60,      // degrees each side of straight down (90)
  taper: 25,         // degrees over which the ends fade out
  width: 0.07,       // how far the shadow reaches inward from the ring's inner edge
  overlap: 0.015,    // how far it runs under the ring (hidden by opaque ring pixels)
  blur: 0.012,       // softening
  falloff: 1,        // fade exponent from the edge inward (1 = linear)
  maxAlpha: 0.6,     // opacity at the edge for strength 1; 0.5 then matches the template (peak ~0.29)
  workSize: 512      // working resolution
});

/** Alpha at which a ring pixel counts as "mostly opaque" for edge detection. */
const EDGE_ALPHA = 128;

function alphaGrid(frameCanvas, n) {
  const work = makeCanvas(n, n);
  const ctx = work.getContext("2d", {willReadFrequently: true});
  ctx.drawImage(frameCanvas, 0, 0, n, n);
  const data = ctx.getImageData(0, 0, n, n).data;
  const alpha = new Uint8ClampedArray(n * n);
  for ( let i = 0; i < alpha.length; i++ ) alpha[i] = data[(i * 4) + 3];
  return alpha;
}

function circularSmooth(values, window, fn) {
  const n = values.length;
  const half = Math.floor(window / 2);
  const out = new Float64Array(n);
  const buf = [];
  for ( let i = 0; i < n; i++ ) {
    buf.length = 0;
    for ( let k = -half; k <= half; k++ ) buf.push(values[(i + k + n) % n]);
    out[i] = fn(buf);
  }
  return out;
}
const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

/**
 * The ring's inner edge per whole degree (0 = right, 90 = down) as a fraction of the half frame: the first mostly-opaque run scanning out from 0.3, smoothed; falls back to the ring thickness when there is no clear edge.
 * → { radii: Float64Array, detected }
 */
export function findInnerEdge(frameCanvas, {ringThickness = DEFAULTS.ringThickness} = {}) {
  const n = Math.min(SHADOW_SHAPE.workSize, frameCanvas.width, frameCanvas.height);
  const alpha = alphaGrid(frameCanvas, n);
  const h = n / 2;
  const run = Math.max(2, Math.round(0.015 * h));
  const at = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return ((xi < 0) || (yi < 0) || (xi >= n) || (yi >= n)) ? 0 : alpha[(yi * n) + xi];
  };
  const raw = new Float64Array(360).fill(NaN);
  for ( let deg = 0; deg < 360; deg++ ) {
    const profile = [];
    for ( let r = 0.3 * h; r <= 0.99 * h; r += 1 ) {
      let sum = 0;
      for ( const off of [-1, 0, 1] ) {
        const a = ((deg + off) * Math.PI) / 180;
        sum += at(h + (r * Math.cos(a)) - 0.5, h + (r * Math.sin(a)) - 0.5);
      }
      profile.push(sum / 3);
    }
    for ( let i = 0; i + run <= profile.length; i++ ) {
      let ok = true;
      for ( let k = 0; k < run; k++ ) if ( profile[i + k] < EDGE_ALPHA ) { ok = false; break; }
      if ( ok ) {
        raw[deg] = (0.3 * h + i) / h;
        break;
      }
    }
  }
  const fallback = Math.min(0.95, Math.max(0.35, SUBJECT_BASE * (Number(ringThickness) + SUBJECT_BASE)));
  const lo = 90 - SHADOW_SHAPE.halfSpan;
  const hi = 90 + SHADOW_SHAPE.halfSpan;
  let valid = 0;
  for ( let d = lo; d <= hi; d++ ) if ( Number.isFinite(raw[d]) ) valid++;
  if ( valid < 0.5 * (hi - lo + 1) ) return {radii: new Float64Array(360).fill(fallback), detected: false};
  // Fill gaps from the nearest detected neighbours, then median + mean smoothing.
  const filled = Float64Array.from(raw);
  for ( let d = 0; d < 360; d++ ) {
    if ( Number.isFinite(filled[d]) ) continue;
    let prev = null;
    let next = null;
    for ( let k = 1; k < 360 && (prev === null || next === null); k++ ) {
      if ( (prev === null) && Number.isFinite(raw[(d - k + 360) % 360]) ) prev = [k, raw[(d - k + 360) % 360]];
      if ( (next === null) && Number.isFinite(raw[(d + k) % 360]) ) next = [k, raw[(d + k) % 360]];
    }
    filled[d] = (prev && next) ? ((prev[1] * next[0]) + (next[1] * prev[0])) / (prev[0] + next[0]) : fallback;
  }
  const radii = circularSmooth(circularSmooth(filled, 15, median), 21, mean);
  for ( let d = 0; d < 360; d++ ) radii[d] = Math.min(0.98, Math.max(0.3, radii[d]));
  return {radii, detected: true};
}

/** Three box-blur passes (about a Gaussian) on a float alpha grid. */
function blurAlpha(src, n, radius) {
  if ( radius < 1 ) return src;
  let a = src;
  let b = new Float32Array(src.length);
  const pass = (from, to, horizontal) => {
    const win = (2 * radius) + 1;
    for ( let line = 0; line < n; line++ ) {
      let acc = 0;
      const idx = i => (horizontal ? ((line * n) + i) : ((i * n) + line));
      for ( let i = -radius; i <= radius; i++ ) acc += from[idx(Math.min(n - 1, Math.max(0, i)))];
      for ( let i = 0; i < n; i++ ) {
        to[idx(i)] = acc / win;
        acc += from[idx(Math.min(n - 1, i + radius + 1))] - from[idx(Math.max(0, i - radius))];
      }
    }
  };
  for ( let k = 0; k < 3; k++ ) {
    pass(a, b, true);
    pass(b, a === src ? (a = new Float32Array(src.length)) : a, false);
  }
  return a;
}

/**
 * The shadow alone: a black soft-alpha crescent the size of the ring frame; null when strength is 0.
 * opts: strength 0-1 (edge opacity = strength x maxAlpha), ringThickness (edge fallback).
 */
export function innerShadowLayer(ringFrame, {strength = 0, ringThickness = DEFAULTS.ringThickness, shape = SHADOW_SHAPE} = {}) {
  const s = clamp(strength, 0, 1);
  if ( s <= 0 ) return null;
  const size = ringFrame.width;
  const n = Math.min(SHADOW_SHAPE.workSize, size);
  const h = n / 2;
  const {radii, detected} = findInnerEdge(ringFrame, {ringThickness});
  const {halfSpan, taper, width, overlap, blur, falloff, maxAlpha} = {...SHADOW_SHAPE, ...shape};
  // With a clear edge the outer side hides under the ring; without one (see-through art) it fades out softly.
  const outer = detected ? overlap : 0.03;
  const grid = new Float32Array(n * n);
  for ( let y = Math.floor(h); y < n; y++ ) {
    const dy = (y + 0.5 - h) / h;
    for ( let x = 0; x < n; x++ ) {
      const dx = (x + 0.5 - h) / h;
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      const u = Math.abs(deg - 90);
      if ( u >= halfSpan ) continue;
      const ends = (u <= halfSpan - taper) ? 1 : (halfSpan - u) / taper;
      const t = ends * ends * (3 - (2 * ends));
      const d0 = Math.floor(deg);
      const f = deg - d0;
      const edge = (radii[(d0 + 360) % 360] * (1 - f)) + (radii[(d0 + 361) % 360] * f);
      const inside = edge - Math.sqrt((dx * dx) + (dy * dy));
      if ( (inside < -outer) || (inside > width) ) continue;
      const fade = (inside <= 0) ? (detected ? 1 : 1 + (inside / outer)) : (1 - (inside / width)) ** falloff;
      grid[(y * n) + x] = s * maxAlpha * t * fade;
    }
  }
  const soft = blurAlpha(grid, n, Math.max(1, Math.round(blur * h)));
  const small = makeCanvas(n, n);
  const sctx = small.getContext("2d");
  const img = sctx.createImageData(n, n);
  for ( let i = 0; i < soft.length; i++ ) img.data[(i * 4) + 3] = Math.round(Math.min(1, soft[i]) * 255);
  sctx.putImageData(img, 0, 0);
  if ( n === size ) return small;
  const layer = makeCanvas(size, size);
  const lctx = layer.getContext("2d");
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = "high";
  lctx.drawImage(small, 0, 0, size, size);
  return layer;
}

/** A copy of the ring frame with the inner shadow drawn under the ring art (destination-over), so opaque ring pixels stay as they were; strength 0 returns the frame. */
export function addInnerShadow(ringFrame, opts = {}) {
  const layer = innerShadowLayer(ringFrame, opts);
  if ( !layer ) return ringFrame;
  const out = makeCanvas(ringFrame.width, ringFrame.height);
  const ctx = out.getContext("2d");
  ctx.drawImage(ringFrame, 0, 0);
  ctx.globalCompositeOperation = "destination-over";
  ctx.drawImage(layer, 0, 0);
  return out;
}

function toBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), type, quality));
}

/** Encode as WebP, or PNG where the browser cannot write WebP. */
export async function encodeSheet(canvas, quality = 0.92) {
  const webp = await toBlob(canvas, "image/webp", quality);
  if ( webp && (webp.type === "image/webp") ) return {blob: webp, ext: "webp", type: "image/webp"};
  const png = await toBlob(canvas, "image/png");
  if ( !png ) throw new Error("Could not encode the spritesheet.");
  return {blob: png, ext: "png", type: "image/png"};
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if ( !m ) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Zero-width colour band: Foundry leaves the ring art's own colours alone. */
export const NO_TINT_BAND = Object.freeze({startRadius: 0.99, endRadius: 0.99});

/** Rec.709 luminance weights. */
const LUMA = [0.2126, 0.7152, 0.0722];

/** Foundry-style colour band (radius 0 = centre, 1 = edge, hard edges): inside it the ring texel becomes luminance x ring colour (white turns grey); alpha unchanged; zero width changes nothing. */
export function tintBand(canvas, color, start, end) {
  const rgb = hexToRgb(color) ?? [255, 255, 255];
  let a = clamp(start, 0, 1);
  let b = clamp(end, 0, 1);
  if ( a > b ) [a, b] = [b, a];
  if ( b - a < 1e-6 ) return;
  const ctx = canvas.getContext("2d");
  const {width: w, height: h} = canvas;
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const cx = w / 2;
  const cy = h / 2;
  const half = Math.min(w, h) / 2;
  for ( let y = 0; y < h; y++ ) {
    const dy = (y + 0.5 - cy) / half;
    for ( let x = 0; x < w; x++ ) {
      const dx = (x + 0.5 - cx) / half;
      const r = Math.sqrt((dx * dx) + (dy * dy));
      if ( (r < a) || (r > b) ) continue;
      const i = ((y * w) + x) * 4;
      const lum = (LUMA[0] * px[i]) + (LUMA[1] * px[i + 1]) + (LUMA[2] * px[i + 2]);
      px[i] = (lum * rgb[0]) / 255;
      px[i + 1] = (lum * rgb[1]) / 255;
      px[i + 2] = (lum * rgb[2]) / 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Approximate in-game look: background, token lower half, ring with inner shadow (band tinted), token upper half on top. ringFrame / bkgFrame replace images.
 * The token box is (ringThickness + 2/3) of the frame, like Foundry's subject scale.
 */
export function drawPreview(canvas, {ring = null, ringFrame = null, bkg = null, bkgFrame = null, subject = null, bkgColor = null,
  bkgSize = DEFAULTS.bkgSize, ringThickness = DEFAULTS.ringThickness, ringColor = DEFAULTS.ringColor,
  bandStart = DEFAULTS.bandStart, bandEnd = DEFAULTS.bandEnd, shadow = 0} = {}) {
  const size = Math.min(canvas.width, canvas.height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if ( bkgFrame ) ctx.drawImage(bkgFrame, 0, 0, size, size);
  else drawBackgroundFrame(ctx, 0, 0, size, {bkg, bkgColor, bkgSize});
  const box = clamp(Number(ringThickness) + SUBJECT_BASE, 0.1, 2) * size;
  // The token: under the ring in the lower half, over it in the upper half.
  const drawSubject = lower => {
    if ( !subject ) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, lower ? size / 2 : 0, size, size / 2);
    ctx.clip();
    drawFitted(ctx, subject, (size - box) / 2, (size - box) / 2, box, "contain");
    ctx.restore();
  };
  drawSubject(true);
  if ( ring || ringFrame ) {
    let ringCanvas = makeCanvas(size, size);
    if ( ringFrame ) ringCanvas.getContext("2d").drawImage(ringFrame, 0, 0, size, size);
    else drawRingFrame(ringCanvas.getContext("2d"), ring, 0, 0, size);
    ringCanvas = addInnerShadow(ringCanvas, {strength: shadow, ringThickness});
    tintBand(ringCanvas, ringColor, bandStart, bandEnd);
    ctx.drawImage(ringCanvas, 0, 0);
  }
  drawSubject(false);
}

/** Put an image in the middle 2/3 of a transparent square, like ring-ready token art. */
export function makeSampleSubject(img, size = 512) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const inner = size * SUBJECT_BASE;
  if ( img ) drawFitted(ctx, img, (size - inner) / 2, (size - inner) / 2, inner, "contain");
  else {
    ctx.fillStyle = "#6b7a8f";
    ctx.beginPath();
    ctx.arc(size / 2, size * 0.4, inner * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(size / 2, size * 0.78, inner * 0.38, inner * 0.3, 0, Math.PI, 0);
    ctx.fill();
  }
  return canvas;
}

/** A plain ring frame for a token tool that draws frames into the token picture (Tokenizer): the ring frame scaled to `size`, band tinted in the default ring colour; `fallbackBand` when the frame has no colorBand. */
export function flatRingFrame(img, json, {size = 1024, fallbackBand = null} = {}) {
  const key = ringFrameKey(json);
  const data = json?.frames?.[key];
  if ( !data?.frame ) throw new Error("No ring frame in the spritesheet.");
  const frame = cropFrame(img, data.frame);
  const out = makeCanvas(size, size);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(frame, 0, 0, size, size);
  const band = data.colorBand ?? fallbackBand;
  if ( band ) tintBand(out, json?.config?.defaultRingColor ?? DEFAULTS.ringColor, band.startRadius, band.endRadius);
  return out;
}
