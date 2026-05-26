/* =========================================================
   Resistor CV — band detection pipeline (vanilla JS)
   
   Pipeline stages:
     1. Detect body via warm-tone + dark-pixel mask
     2. Largest connected component → resistor body
     3. PCA for principal axis → rotate to horizontal
     4. Re-detect body in rotated frame
     5. If still taller than wide, rotate another 90°
     6. Sample top & bottom strips (skip central specular highlight)
     7. MAD-thresholded band detection (columns far from body color)
     8. Classify each band by nearest reference color (RGB Euclidean)
   
   Always returns a debug canvas showing what was analyzed.
   Per-band confidence allows the UI to highlight uncertain ones.
   ========================================================= */

// -------- Color helpers --------

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return [h, s, v];
}

// Reference band colors (12 standard). Tuned for real photographs:
// these are typical RGB values for printed bands under normal lighting.
const BAND_REFS = [
  { id: 'black', rgb: [30, 30, 30] },
  { id: 'brown', rgb: [110, 70, 35] },
  { id: 'red', rgb: [200, 40, 30] },
  { id: 'orange', rgb: [235, 110, 30] },
  { id: 'yellow', rgb: [245, 215, 60] },
  { id: 'green', rgb: [60, 150, 80] },
  { id: 'blue', rgb: [50, 100, 200] },
  { id: 'violet', rgb: [170, 80, 180] },
  { id: 'gray', rgb: [140, 140, 140] },
  { id: 'white', rgb: [240, 240, 240] },
  { id: 'gold', rgb: [200, 145, 70] },
  { id: 'silver', rgb: [180, 180, 185] },
];

// Tolerance-capable colors (band 4 of a 4-band, band 5 of a 5-band).
const TOL_COLORS = new Set([
  'brown', 'red', 'green', 'blue', 'violet', 'gray', 'gold', 'silver',
]);

// =========================================================
// IMAGE HELPERS
// =========================================================

function imageDataToCanvas(imgData) {
  const c = document.createElement('canvas');
  c.width = imgData.width;
  c.height = imgData.height;
  c.getContext('2d').putImageData(imgData, 0, 0);
  return c;
}

function canvasToImageData(canvas) {
  const ctx = canvas.getContext('2d');
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function downscaleIfNeeded(imgData, maxDim) {
  const { width: W, height: H } = imgData;
  const m = Math.max(W, H);
  if (m <= maxDim) return imgData;
  const scale = maxDim / m;
  const newW = Math.round(W * scale);
  const newH = Math.round(H * scale);
  const src = imageDataToCanvas(imgData);
  const dst = document.createElement('canvas');
  dst.width = newW; dst.height = newH;
  dst.getContext('2d').drawImage(src, 0, 0, newW, newH);
  return canvasToImageData(dst);
}

// Rotate an ImageData by angleDeg (clockwise = positive in screen coords).
// Background color fills new pixels.
function rotateImageData(imgData, angleDeg, bgRgb) {
  const src = imageDataToCanvas(imgData);
  const W = src.width, H = src.height;
  const rad = angleDeg * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const newW = Math.ceil(W * cos + H * sin);
  const newH = Math.ceil(W * sin + H * cos);

  const dst = document.createElement('canvas');
  dst.width = newW; dst.height = newH;
  const ctx = dst.getContext('2d');
  ctx.fillStyle = `rgb(${bgRgb[0]},${bgRgb[1]},${bgRgb[2]})`;
  ctx.fillRect(0, 0, newW, newH);
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.drawImage(src, -W / 2, -H / 2);
  return canvasToImageData(dst);
}

// =========================================================
// BODY MASK
// =========================================================

/**
 * Detect resistor body: warm-tone saturated pixels OR very dark pixels (bands).
 * Returns Uint8Array of length W*H with 1 where body, 0 elsewhere.
 */
function computeBodyMask(imgData) {
  const { data, width: W, height: H } = imgData;
  const mask = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const [h, s, v] = rgbToHsv(r, g, b);
    const warm = ((h < 70) || (h > 320)) && s > 0.08 && v > 0.20 && v < 0.97;
    const dark = v < 0.25;
    if (warm || dark) mask[p] = 1;
  }
  return mask;
}

/**
 * Binary morphology: dilate the mask by 1 pixel using a 4-connected kernel.
 */
function dilate(mask, W, H, iterations = 1) {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (cur[p]) { next[p] = 1; continue; }
        // Check 4-neighbors
        if (x > 0 && cur[p - 1]) { next[p] = 1; continue; }
        if (x < W - 1 && cur[p + 1]) { next[p] = 1; continue; }
        if (y > 0 && cur[p - W]) { next[p] = 1; continue; }
        if (y < H - 1 && cur[p + W]) { next[p] = 1; continue; }
      }
    }
    cur = next;
  }
  return cur;
}

function erode(mask, W, H, iterations = 1) {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (!cur[p]) continue;
        if (x === 0 || !cur[p - 1]) continue;
        if (x === W - 1 || !cur[p + 1]) continue;
        if (y === 0 || !cur[p - W]) continue;
        if (y === H - 1 || !cur[p + W]) continue;
        next[p] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

// Closing = dilate then erode (fills small gaps)
function close(mask, W, H, iterations = 1) {
  return erode(dilate(mask, W, H, iterations), W, H, iterations);
}

/**
 * Find the largest connected component (4-connectivity).
 * Returns { mask: Uint8Array, count: number, bounds: {minX, maxX, minY, maxY},
 *           cx, cy } or null.
 */
function largestComponent(mask, W, H) {
  const labels = new Int32Array(mask.length);
  const sizes = [0]; // index 0 = unused
  let nextLabel = 1;
  const stack = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!mask[p] || labels[p]) continue;
      // BFS flood fill
      labels[p] = nextLabel;
      stack.length = 0;
      stack.push(p);
      let count = 0;
      while (stack.length) {
        const q = stack.pop();
        count++;
        const qx = q % W;
        const qy = (q - qx) / W;
        const neighbors = [];
        if (qx > 0) neighbors.push(q - 1);
        if (qx < W - 1) neighbors.push(q + 1);
        if (qy > 0) neighbors.push(q - W);
        if (qy < H - 1) neighbors.push(q + W);
        for (const n of neighbors) {
          if (mask[n] && !labels[n]) {
            labels[n] = nextLabel;
            stack.push(n);
          }
        }
      }
      sizes.push(count);
      nextLabel++;
    }
  }

  if (sizes.length < 2) return null;

  let bestLabel = 1;
  for (let i = 2; i < sizes.length; i++) {
    if (sizes[i] > sizes[bestLabel]) bestLabel = i;
  }

  const outMask = new Uint8Array(mask.length);
  let minX = W, maxX = -1, minY = H, maxY = -1;
  let sumX = 0, sumY = 0, count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (labels[p] === bestLabel) {
        outMask[p] = 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }
  return {
    mask: outMask,
    count,
    bounds: { minX, maxX, minY, maxY },
    cx: sumX / count,
    cy: sumY / count,
  };
}

// =========================================================
// ORIENTATION (PCA)
// =========================================================

/**
 * Compute the principal axis angle from a binary mask via PCA on its pixels.
 * Returns angle in radians (math convention).
 */
function pcaAngle(mask, W, H, cx, cy) {
  let sxx = 0, syy = 0, sxy = 0, count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        const dx = x - cx;
        const dy = y - cy;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
        count++;
      }
    }
  }
  if (count === 0) return 0;
  sxx /= count;
  syy /= count;
  sxy /= count;
  // Largest eigenvalue direction of 2x2 symmetric matrix [[sxx, sxy], [sxy, syy]]
  // Eigenvalues: lambda = (sxx + syy) / 2 ± sqrt(((sxx-syy)/2)^2 + sxy^2)
  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const tmp = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const lambdaMax = trace / 2 + tmp;
  // Eigenvector for lambdaMax: ([sxy, lambdaMax - sxx]) or ([lambdaMax - syy, sxy])
  let vx, vy;
  if (Math.abs(sxy) > 1e-6) {
    vx = sxy;
    vy = lambdaMax - sxx;
  } else if (sxx >= syy) {
    vx = 1; vy = 0;
  } else {
    vx = 0; vy = 1;
  }
  return Math.atan2(vy, vx);
}

// =========================================================
// BAND DETECTION
// =========================================================

/**
 * Sample columns inside the body, averaging pixels in a y-strip.
 * Returns { xs: Int32Array, rgb: Float32Array (n*3) }.
 */
function sampleStrip(imgData, bodyMask, y0, y1, x0, x1) {
  const { data, width: W } = imgData;
  const colWidth = x1 - x0 + 1;
  const xs = [];
  const rgbs = [];

  for (let x = x0; x <= x1; x++) {
    let sumR = 0, sumG = 0, sumB = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      if (bodyMask[y * W + x]) {
        const i = (y * W + x) * 4;
        sumR += data[i];
        sumG += data[i + 1];
        sumB += data[i + 2];
        n++;
      }
    }
    if (n > 0) {
      xs.push(x);
      rgbs.push([sumR / n, sumG / n, sumB / n]);
    }
  }
  return { xs, rgbs };
}

/**
 * Smooth a list of [r,g,b] colors with a centered moving average of given window size.
 */
function smoothColors(rgbs, win = 3) {
  const n = rgbs.length;
  const out = new Array(n);
  const half = Math.floor(win / 2);
  for (let i = 0; i < n; i++) {
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    for (let j = lo; j < hi; j++) {
      sumR += rgbs[j][0];
      sumG += rgbs[j][1];
      sumB += rgbs[j][2];
      count++;
    }
    out[i] = [sumR / count, sumG / count, sumB / count];
  }
  return out;
}

function rgbDistance(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[(n - 1) / 2];
}

function medianRgb(rgbs) {
  return [0, 1, 2].map(ch => median(rgbs.map(rgb => rgb[ch])));
}

/**
 * Detect bands as columns that are far from the body color.
 * Returns array of band regions { start, end, rgb, name, distance, confidence }.
 */
function findBands(imgData, bodyMask, bbox) {
  const { minX, maxX, minY, maxY } = bbox;
  const w = maxX - minX;
  const h = maxY - minY;

  // Top and bottom strips, avoiding the specular highlight in the middle
  const yT0 = minY + Math.floor(h * 0.20);
  const yT1 = minY + Math.floor(h * 0.40);
  const yB0 = minY + Math.floor(h * 0.60);
  const yB1 = minY + Math.floor(h * 0.80);

  // Skip outermost ~8% of body width (where shoulders/end caps live)
  const trim = Math.floor(w * 0.08);
  const bx0 = minX + trim;
  const bx1 = maxX - trim;

  const top = sampleStrip(imgData, bodyMask, yT0, yT1, bx0, bx1);
  const bot = sampleStrip(imgData, bodyMask, yB0, yB1, bx0, bx1);

  if (top.xs.length === 0 || bot.xs.length === 0) return [];

  // Intersect x-arrays so we have both top and bottom samples
  const botIdx = new Map();
  for (let i = 0; i < bot.xs.length; i++) botIdx.set(bot.xs[i], i);

  const combinedXs = [];
  const combinedRgb = [];
  for (let i = 0; i < top.xs.length; i++) {
    const x = top.xs[i];
    const j = botIdx.get(x);
    if (j !== undefined) {
      combinedXs.push(x);
      combinedRgb.push([
        (top.rgbs[i][0] + bot.rgbs[j][0]) / 2,
        (top.rgbs[i][1] + bot.rgbs[j][1]) / 2,
        (top.rgbs[i][2] + bot.rgbs[j][2]) / 2,
      ]);
    }
  }

  const smooth = smoothColors(combinedRgb, 3);
  const bodyColor = medianRgb(smooth);

  // Distance per column from body color
  const dists = smooth.map(c => rgbDistance(c, bodyColor));
  const medD = median(dists);
  const mad = median(dists.map(d => Math.abs(d - medD)));
  // Adaptive threshold: use both body contrast and chroma changes. The lower
  // secondary threshold lets pale yellow / gray / white bands survive, while
  // the MAD term still rejects breadboard holes and texture.
  const threshold = Math.max(15, medD + 1.55 * mad);

  const minBandWidth = Math.max(2, Math.floor(w * 0.012));
  const maxGap = Math.max(1, Math.floor(w * 0.010));
  const rawRuns = [];
  let i = 0;
  while (i < dists.length) {
    if (dists[i] > threshold) {
      const start = i;
      while (i < dists.length && dists[i] > threshold) i++;
      const end = i;
      if (end - start >= minBandWidth) rawRuns.push([start, end]);
    } else i++;
  }

  // Merge split bands caused by narrow glossy highlights.
  const runs = [];
  for (const r of rawRuns) {
    const prev = runs[runs.length - 1];
    if (prev && r[0] - prev[1] <= maxGap) prev[1] = r[1];
    else runs.push(r);
  }

  const bands = [];
  for (const [start, end] of runs) {
    let sumR = 0, sumG = 0, sumB = 0;
    for (let j = start; j < end; j++) { sumR += smooth[j][0]; sumG += smooth[j][1]; sumB += smooth[j][2]; }
    const n = end - start;
    const bandRgb = [sumR / n, sumG / n, sumB / n];
    const classified = classifyBand(bandRgb, bodyColor);
    bands.push({ x_start: combinedXs[start], x_end: combinedXs[end - 1], rgb: bandRgb, ...classified });
  }

  // If there are many candidates, keep the 6 strongest, preserving order.
  return bands
    .map(b => ({ ...b, strength: rgbDistance(b.rgb, bodyColor) * Math.max(0.35, b.confidence) }))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 6)
    .sort((a, b) => a.x_start - b.x_start);
}

/**
 * Classify a band's RGB against the 12 standard colors.
 * Returns { id, distance, confidence (0..1, higher = more confident) }.
 */
function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d) / 180;
}

/**
 * Classify a band using hue, saturation and value rather than raw RGB only.
 * This is more stable with phone auto white-balance and with blue/green bodies.
 */
function classifyBand(rgb, bodyRgb = null) {
  const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  let bestRef = null;
  let bestDist = Infinity;
  let secondDist = Infinity;

  for (const ref of BAND_REFS) {
    const [rh, rs, rv] = rgbToHsv(ref.rgb[0], ref.rgb[1], ref.rgb[2]);
    let d;
    // Black/white/gray/silver need luminance handling; colored bands need hue.
    if (['black', 'gray', 'white', 'silver'].includes(ref.id)) {
      d = Math.abs(v - rv) * 1.15 + Math.abs(s - rs) * 0.85;
    } else if (ref.id === 'gold') {
      d = hueDistance(h, rh) * 1.25 + Math.abs(s - rs) * 0.35 + Math.abs(v - rv) * 0.25;
    } else {
      d = hueDistance(h, rh) * 1.45 + Math.abs(s - rs) * 0.35 + Math.abs(v - rv) * 0.20;
    }
    // Penalize colors too similar to the resistor body, reducing false body texture bands.
    if (bodyRgb && rgbDistance(rgb, bodyRgb) < 22 && !['black', 'white', 'gray', 'silver'].includes(ref.id)) d += 0.22;
    if (d < bestDist) { secondDist = bestDist; bestDist = d; bestRef = ref; }
    else if (d < secondDist) secondDist = d;
  }

  const distScore = Math.max(0, Math.min(1, (0.92 - bestDist) / 0.92));
  const gapScore = Math.max(0, Math.min(1, (secondDist - bestDist) / 0.30));
  const confidence = 0.62 * distScore + 0.38 * gapScore;
  return { id: bestRef.id, distance: bestDist, confidence };
}

// =========================================================
// READING DIRECTION + VALUE COMPUTATION
// =========================================================

/**
 * Decide which end has the tolerance band.
 * Heuristic: the band closest to a body edge AND a tolerance-capable color
 * is the tolerance band. If both ends are ambiguous, try both readings and
 * prefer one that gives a sensible value.
 */
function pickReadingDirection(bands, mode) {
  if (bands.length < mode) {
    // Not enough bands — just return as-is
    return {
      picks: bands.map(b => b.id),
      bandsWithConf: bands,
      reason: 'Too few bands detected',
    };
  }

  const truncated = bands.slice(0, mode);
  const reversed = [...truncated].reverse();

  const lastForward = truncated[truncated.length - 1];
  const lastReverse = reversed[reversed.length - 1];

  const forwardTolOk = TOL_COLORS.has(lastForward.id);
  const reverseTolOk = TOL_COLORS.has(lastReverse.id);

  let chosen, dir;
  if (forwardTolOk && !reverseTolOk) {
    chosen = truncated;
    dir = 'forward';
  } else if (reverseTolOk && !forwardTolOk) {
    chosen = reversed;
    dir = 'reverse';
  } else {
    // Both or neither — prefer forward
    chosen = truncated;
    dir = 'both candidates';
  }

  return {
    picks: chosen.map(b => b.id),
    bandsWithConf: chosen,
    reason: `Reading direction: ${dir}`,
  };
}

// =========================================================
// DEBUG VISUALIZATION
// =========================================================

/**
 * Build a debug canvas showing the rotated image cropped to the body,
 * with detected bands outlined in red. Uncertain bands get a yellow outline.
 */
function buildDebugCanvas(imgData, bodyMask, bbox, bands) {
  const { minX, maxX, minY, maxY } = bbox;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;

  // Crop to body bbox with small margin
  const margin = Math.floor(Math.min(w, h) * 0.15);
  const cx0 = Math.max(0, minX - margin);
  const cy0 = Math.max(0, minY - margin);
  const cx1 = Math.min(imgData.width - 1, maxX + margin);
  const cy1 = Math.min(imgData.height - 1, maxY + margin);
  const cw = cx1 - cx0 + 1;
  const ch = cy1 - cy0 + 1;

  const src = imageDataToCanvas(imgData);
  const debug = document.createElement('canvas');
  debug.width = cw;
  debug.height = ch;
  const ctx = debug.getContext('2d');
  ctx.drawImage(src, cx0, cy0, cw, ch, 0, 0, cw, ch);

  // Overlay band rectangles
  for (const b of bands) {
    const isLow = b.confidence < 0.40;
    ctx.strokeStyle = isLow ? 'rgba(255, 200, 0, 0.95)' : 'rgba(255, 0, 0, 0.95)';
    ctx.lineWidth = 2;
    const rx = b.x_start - cx0;
    const ry = minY - cy0;
    const rw = b.x_end - b.x_start;
    const rh = maxY - minY;
    ctx.strokeRect(rx, ry, rw, rh);
  }

  return debug;
}

// =========================================================
// MAIN ENTRY POINT
// =========================================================

/**
 * Process an image (ImageData) and return detection result.
 * Returns:
 *   { success: true, mode, picks, bands, ohms, tol, debugImage }
 *   or { success: false, reason, debugImage }
 */
async function detectResistor(imageData) {
  // 1) Downscale large images
  const work = downscaleIfNeeded(imageData, 800);
  const W = work.width, H = work.height;

  // 2) Body mask + morphology + largest component
  let mask = computeBodyMask(work);
  mask = close(mask, W, H, 4);
  mask = dilate(mask, W, H, 1);
  const cc = largestComponent(mask, W, H);

  if (!cc || cc.count < 200) {
    return {
      success: false,
      reason: "Couldn't find the resistor. Move closer and centre it in the frame.",
      debugImage: imageDataToCanvas(work),
    };
  }

  // 3) PCA for orientation
  const angleRad = pcaAngle(cc.mask, W, H, cc.cx, cc.cy);
  const angleDeg = angleRad * 180 / Math.PI;

  // 4) Rotate (cv2/scipy rotate uses CCW positive, our canvas uses CW positive,
  //    so use angleDeg directly since our coordinate is screen-y-down)
  const bgRgb = [255, 255, 255];
  let rotated = rotateImageData(work, angleDeg, bgRgb);

  // 5) Re-find body in rotated frame
  let mask2 = computeBodyMask(rotated);
  mask2 = close(mask2, rotated.width, rotated.height, 4);
  mask2 = dilate(mask2, rotated.width, rotated.height, 1);
  let cc2 = largestComponent(mask2, rotated.width, rotated.height);

  if (!cc2) {
    return {
      success: false,
      reason: "Detection failed after rotation.",
      debugImage: imageDataToCanvas(rotated),
    };
  }

  // 6) Orientation check: if taller than wide, rotate another 90°
  const bw = cc2.bounds.maxX - cc2.bounds.minX + 1;
  const bh = cc2.bounds.maxY - cc2.bounds.minY + 1;
  if (bh > bw) {
    rotated = rotateImageData(rotated, 90, bgRgb);
    mask2 = computeBodyMask(rotated);
    mask2 = close(mask2, rotated.width, rotated.height, 4);
    mask2 = dilate(mask2, rotated.width, rotated.height, 1);
    cc2 = largestComponent(mask2, rotated.width, rotated.height);
    if (!cc2) {
      return {
        success: false,
        reason: "Detection failed after re-rotation.",
        debugImage: imageDataToCanvas(rotated),
      };
    }
  }

  // 7) Detect bands
  const bands = findBands(rotated, cc2.mask, cc2.bounds);

  // 8) Always build debug visualization
  const debugImage = buildDebugCanvas(rotated, cc2.mask, cc2.bounds, bands);

  // 9) Validation
  if (bands.length < 3) {
    return {
      success: false,
      reason: `Only ${bands.length} band${bands.length === 1 ? '' : 's'} detected. Try better lighting, closer framing, or a plain background.`,
      debugImage,
      bands,
    };
  }
  if (bands.length > 6) {
    return {
      success: false,
      reason: `Detected ${bands.length} bands — that's too many. There may be reflections or background clutter being mistaken for bands.`,
      debugImage,
      bands,
    };
  }

  // 10) Decide mode (4 or 5 bands)
  // If we found exactly 5, it's a 5-band. If exactly 3 or 4, treat as 4-band.
  // If 6, drop the last (temp coefficient) and treat as 5-band.
  let mode;
  let bandsToUse;
  if (bands.length <= 4) {
    mode = 4;
    bandsToUse = bands.slice(0, 4);
  } else if (bands.length === 5) {
    mode = 5;
    bandsToUse = bands.slice(0, 5);
  } else {
    mode = 5;
    bandsToUse = bands.slice(0, 5);
  }

  // 11) Pick reading direction
  const decision = pickReadingDirection(bandsToUse, mode);

  // 12) Compute ohms/tolerance using the engine
  const computation = (window.ResistorEngine && window.ResistorEngine.computeOhmsFromPicks)
    ? window.ResistorEngine.computeOhmsFromPicks(decision.picks, mode)
    : null;

  return {
    success: true,
    mode,
    picks: decision.picks,
    bands: decision.bandsWithConf.map(b => ({
      colorId: b.id,
      confidence: b.confidence,
      rgb: b.rgb,
    })),
    ohms: computation ? computation.ohms : null,
    tol: computation ? computation.tol : null,
    reasoning: decision.reason,
    debugImage,
  };
}

// Public API
window.ResistorCV = {
  detectResistor,
};
