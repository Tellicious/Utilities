/* =========================================================
   Resistor CV — band detection pipeline (vanilla JS)

   Rewritten for robustness on real photos with a plain background.

   Pipeline stages:
     1. Estimate the background colour from a border ring of the image.
     2. Foreground = pixels that differ enough from the background. This
        captures the body AND every band (any hue) AND the leads — unlike
        a warm-tone-only mask, which dropped green/blue bands entirely.
     3. Largest connected component (8-connected, after a light dilation so
        thin diagonal leads stay attached) -> the resistor silhouette.
     4. PCA on that silhouette -> principal axis -> rotate to horizontal.
     5. Re-mask in the rotated frame, then separate the thick body from the
        thin leads using a per-column thickness profile.
     6. Build a per-column colour profile across the whole body (median over
        the central rows, so a specular highlight can't dominate).
     7. Segment bands as runs of columns whose colour differs from the body
        substrate colour; classify each against the 12 reference colours.
     8. Resolve reading direction (tolerance band heuristic) and decode.

   Always returns a debug canvas showing what was analysed.
   Per-band confidence lets the UI flag uncertain bands.
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
  { id: 'black', rgb: [35, 35, 35] },
  { id: 'brown', rgb: [110, 70, 40] },
  { id: 'red', rgb: [175, 55, 45] },
  { id: 'orange', rgb: [220, 105, 40] },
  { id: 'yellow', rgb: [225, 195, 70] },
  { id: 'green', rgb: [60, 135, 90] },
  { id: 'blue', rgb: [55, 95, 175] },
  { id: 'violet', rgb: [150, 85, 170] },
  { id: 'gray', rgb: [140, 140, 140] },
  { id: 'white', rgb: [235, 235, 235] },
  { id: 'gold', rgb: [195, 150, 80] },
  { id: 'silver', rgb: [175, 178, 182] },
];

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
// SMALL STATS HELPERS
// =========================================================

function rgbDistance(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[(n - 1) / 2];
}

function medianRgb(rgbs) {
  return [0, 1, 2].map(ch => median(rgbs.map(rgb => rgb[ch])));
}

// =========================================================
// BACKGROUND + FOREGROUND MASK
// =========================================================

/**
 * Estimate the background colour from a ring of border pixels. Photos taken
 * for this tool have a plain background, so the outer frame is dominated by it.
 */
function estimateBackground(imgData) {
  const { data, width: W, height: H } = imgData;
  const band = Math.max(2, Math.floor(Math.min(W, H) * 0.05));
  const rs = [], gs = [], bs = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x < band || x >= W - band || y < band || y >= H - band) {
        if (((x + y) & 3) === 0) {
          const i = (y * W + x) * 4;
          rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
        }
      }
    }
  }
  return [median(rs), median(gs), median(bs)];
}

/**
 * Otsu threshold on a value list (range 0..maxVal). Returns the split point.
 */
function otsuThreshold(values, maxVal) {
  const bins = 256;
  const hist = new Float64Array(bins);
  const scale = (bins - 1) / Math.max(1, maxVal);
  for (const v of values) hist[Math.min(bins - 1, Math.round(v * scale))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = i; }
  }
  return best / scale;
}

/**
 * Foreground mask: pixels that differ from the background colour. Captures the
 * body and every band (regardless of hue) plus the leads. The threshold is
 * chosen by Otsu on the distance-to-background distribution, clamped to a sane
 * range so a near-empty or very busy frame can't produce a degenerate mask.
 */
function computeForegroundMask(imgData, bgRgb) {
  const { data, width: W, height: H } = imgData;
  const n = W * H;
  const dist = new Float32Array(n);
  let maxD = 1;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const dr = data[i] - bgRgb[0], dg = data[i + 1] - bgRgb[1], db = data[i + 2] - bgRgb[2];
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    dist[p] = d;
    if (d > maxD) maxD = d;
  }
  const sample = [];
  for (let p = 0; p < n; p += 7) sample.push(dist[p]);
  let t = otsuThreshold(sample, maxD);
  t = Math.max(28, Math.min(t, 150));
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (dist[p] > t) mask[p] = 1;
  return { mask, threshold: t };
}

// =========================================================
// MORPHOLOGY (8-connected, so diagonal leads stay attached)
// =========================================================

function dilate8(mask, W, H, iterations = 1) {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (cur[p]) { next[p] = 1; continue; }
        let hit = false;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            if (cur[yy * W + xx]) { hit = true; break; }
          }
        }
        if (hit) next[p] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

function erode8(mask, W, H, iterations = 1) {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (!cur[p]) continue;
        let all = true;
        for (let dy = -1; dy <= 1 && all; dy++) {
          const yy = y + dy;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W || yy < 0 || yy >= H || !cur[yy * W + xx]) { all = false; break; }
          }
        }
        if (all) next[p] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

// Closing = dilate then erode (fills small gaps, e.g. between bands).
function close8(mask, W, H, iterations = 1) {
  return erode8(dilate8(mask, W, H, iterations), W, H, iterations);
}

/**
 * Largest connected component (8-connectivity).
 * Returns { mask, count, bounds, cx, cy } or null.
 */
function largestComponent8(mask, W, H) {
  const labels = new Int32Array(mask.length);
  const stack = [];
  let nextLabel = 1;
  let bestLabel = 0, bestCount = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!mask[p] || labels[p]) continue;
      labels[p] = nextLabel;
      stack.length = 0;
      stack.push(p);
      let count = 0;
      while (stack.length) {
        const q = stack.pop();
        count++;
        const qx = q % W;
        const qy = (q - qx) / W;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = qy + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = qx + dx;
            if (xx < 0 || xx >= W) continue;
            const nn = yy * W + xx;
            if (mask[nn] && !labels[nn]) { labels[nn] = nextLabel; stack.push(nn); }
          }
        }
      }
      if (count > bestCount) { bestCount = count; bestLabel = nextLabel; }
      nextLabel++;
    }
  }

  if (!bestLabel) return null;

  const outMask = new Uint8Array(mask.length);
  let minX = W, maxX = -1, minY = H, maxY = -1, sumX = 0, sumY = 0, count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (labels[p] === bestLabel) {
        outMask[p] = 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        sumX += x; sumY += y; count++;
      }
    }
  }
  return { mask: outMask, count, bounds: { minX, maxX, minY, maxY }, cx: sumX / count, cy: sumY / count };
}

// =========================================================
// ORIENTATION (PCA)
// =========================================================

function pcaAngle(mask, W, H, cx, cy) {
  let sxx = 0, syy = 0, sxy = 0, count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        const dx = x - cx, dy = y - cy;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy; count++;
      }
    }
  }
  if (count === 0) return 0;
  sxx /= count; syy /= count; sxy /= count;
  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const tmp = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const lambdaMax = trace / 2 + tmp;
  let vx, vy;
  if (Math.abs(sxy) > 1e-6) { vx = sxy; vy = lambdaMax - sxx; }
  else if (sxx >= syy) { vx = 1; vy = 0; }
  else { vx = 0; vy = 1; }
  return Math.atan2(vy, vx);
}

// =========================================================
// BODY ISOLATION (separate the thick body from thin leads)
// =========================================================

/**
 * Given a horizontalised foreground mask, find the resistor body by its column
 * thickness: the body is far thicker than the leads. Returns body bounds or null.
 */
function isolateBody(mask, W, H) {
  const thickness = new Int32Array(W);
  let maxThick = 0;
  for (let x = 0; x < W; x++) {
    let t = 0;
    for (let y = 0; y < H; y++) if (mask[y * W + x]) t++;
    thickness[x] = t;
    if (t > maxThick) maxThick = t;
  }
  if (maxThick < 4) return null;

  const bodyT = Math.max(6, maxThick * 0.45);
  let bestStart = -1, bestLen = 0, curStart = -1, gap = 0;
  const maxGap = Math.max(2, Math.floor(W * 0.01));
  for (let x = 0; x < W; x++) {
    if (thickness[x] >= bodyT) {
      if (curStart < 0) curStart = x;
      gap = 0;
    } else if (curStart >= 0) {
      gap++;
      if (gap > maxGap) {
        const len = (x - gap) - curStart + 1;
        if (len > bestLen) { bestLen = len; bestStart = curStart; }
        curStart = -1; gap = 0;
      }
    }
  }
  if (curStart >= 0) {
    const len = (W - 1) - curStart + 1;
    if (len > bestLen) { bestLen = len; bestStart = curStart; }
  }
  if (bestStart < 0) return null;
  const bx0 = bestStart;
  const bx1 = bestStart + bestLen - 1;

  const tops = [], bots = [];
  for (let x = bx0; x <= bx1; x++) {
    let top = -1, bot = -1;
    for (let y = 0; y < H; y++) if (mask[y * W + x]) { if (top < 0) top = y; bot = y; }
    if (top >= 0) { tops.push(top); bots.push(bot); }
  }
  if (!tops.length) return null;
  return {
    minX: bx0, maxX: bx1,
    minY: Math.round(median(tops)),
    maxY: Math.round(median(bots)),
  };
}

// =========================================================
// BAND DETECTION
// =========================================================

/**
 * Per-column colour profile across the body. For each column take the median
 * colour over the central vertical region (robust to specular highlight and
 * to the rounded top/bottom edges). Returns { xs, rgbs }.
 */
function columnColorProfile(imgData, body) {
  const { data, width: W } = imgData;
  const { minX, maxX, minY, maxY } = body;
  const h = maxY - minY + 1;
  const yTop = minY + Math.floor(h * 0.22);
  const yBot = maxY - Math.floor(h * 0.22);
  const xs = [], rgbs = [];
  for (let x = minX; x <= maxX; x++) {
    const rr = [], gg = [], bb = [];
    for (let y = yTop; y <= yBot; y++) {
      const i = (y * W + x) * 4;
      rr.push(data[i]); gg.push(data[i + 1]); bb.push(data[i + 2]);
    }
    if (rr.length) { xs.push(x); rgbs.push([median(rr), median(gg), median(bb)]); }
  }
  return { xs, rgbs };
}

function smoothColors(rgbs, win = 3) {
  const n = rgbs.length;
  const out = new Array(n);
  const half = Math.floor(win / 2);
  for (let i = 0; i < n; i++) {
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    for (let j = lo; j < hi; j++) { sumR += rgbs[j][0]; sumG += rgbs[j][1]; sumB += rgbs[j][2]; count++; }
    out[i] = [sumR / count, sumG / count, sumB / count];
  }
  return out;
}

/**
 * Band signal that is invariant to brightness/shading: a chromatic difference
 * (hue + saturation) from the GLOBAL body colour. Hue/saturation barely change
 * with lighting, so no per-column baseline is needed and there is no
 * edge-extrapolation artifact. The tan/gold body and lighting gradients produce
 * ~0 here, so they never look like colour bands; black/gray bands register via
 * the large saturation difference from a saturated body.
 */
function chromaDarkDev(rgb, ref) {
  const [h, s] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  const [rh, rs] = rgbToHsv(ref[0], ref[1], ref[2]);
  const satGate = Math.min(1, s / 0.22);
  const hueTerm = hueDistance(h, rh) * 140 * satGate;
  // Saturation difference also captures black/gray bands (very desaturated vs a
  // saturated body) without a value term, which would be fragile to shading.
  const satTerm = Math.abs(s - rs) * 110;
  return hueTerm + satTerm;
}

function findBands(imgData, body) {
  const w = body.maxX - body.minX + 1;
  // Light end trim: chromatic detection does not false-fire on shoulders, so a
  // small trim suffices and avoids clipping a digit band that sits near an end.
  const trim = Math.floor(w * 0.04);
  const trimmedBody = { ...body, minX: body.minX + trim, maxX: body.maxX - trim };

  const profile = columnColorProfile(imgData, trimmedBody);
  const nCols = profile.xs.length;
  if (nCols < 8) return { bands: [], substrate: [200, 180, 140] };

  const smooth = smoothColors(profile.rgbs, 5);
  const substrate = medianRgb(smooth);

  // Band signal vs the global body colour (shading-invariant). No per-column
  // baseline, so there is no edge-extrapolation artifact when bands cluster at
  // one end (the normal digits-grouped layout).
  const dev = smooth.map(c => chromaDarkDev(c, substrate));

  // Noise floor from the lower portion of the signal (body columns). Use a low
  // percentile so wide/numerous bands don't pull it onto band columns.
  const sortedDev = [...dev].sort((a, b) => a - b);
  const noiseMed = sortedDev[Math.floor(dev.length * 0.1)] || 0;
  const lowHalf = dev.filter(d => d <= (sortedDev[Math.floor(dev.length * 0.5)] || 0));
  const noiseMad = Math.max(1.5, median(lowHalf.map(d => Math.abs(d - noiseMed))));
  const threshold = Math.max(16, noiseMed + 2.5 * noiseMad);

  const minBandW = Math.max(2, Math.floor(nCols * 0.02));
  const maxBandW = Math.max(minBandW + 2, Math.floor(nCols * 0.32));
  const maxGap = Math.max(1, Math.floor(nCols * 0.02));

  function mergedRuns(pred) {
    const raw = [];
    let i = 0;
    while (i < dev.length) {
      if (pred(i)) { const s = i; while (i < dev.length && pred(i)) i++; raw.push([s, i]); }
      else i++;
    }
    const out = [];
    for (const r of raw) {
      const prev = out[out.length - 1];
      if (prev && r[0] - prev[1] <= maxGap) prev[1] = r[1];
      else out.push([r[0], r[1]]);
    }
    return out;
  }

  function bandFromRun(start, end) {
    const pad = Math.floor((end - start) * 0.2);
    const cs = start + pad, ce = Math.max(cs + 1, end - pad);
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let j = cs; j < ce; j++) { sr += smooth[j][0]; sg += smooth[j][1]; sb += smooth[j][2]; n++; }
    const bandRgb = [sr / n, sg / n, sb / n];
    return {
      ci_start: start, ci_end: end,
      x_start: profile.xs[start],
      x_end: profile.xs[Math.min(profile.xs.length - 1, end - 1)],
      y_start: body.minY, y_end: body.maxY,
      rgb: bandRgb,
      separation: median(dev.slice(start, end)),
      ...classifyBand(bandRgb, substrate),
    };
  }

  // Colour/dark bands (the reliable ones). Gold/silver and shading do not
  // normally appear on a tan body; on a light body a genuine gold/silver band
  // can be detected — keep those separately as a trustworthy tolerance cue.
  const detected = [];
  for (const [s, e] of mergedRuns(i => dev[i] > threshold)) {
    const wc = e - s;
    if (wc < minBandW || wc > maxBandW) continue;
    const band = bandFromRun(s, e);
    // Reject a narrow, low-confidence blip touching the extreme edge — typically
    // shading in the empty tolerance gap, not a real band.
    const touchesEnd = (s <= 0) || (e >= dev.length - 1);
    if (touchesEnd && wc < 2 * minBandW && band.confidence < 0.62) continue;
    detected.push(band);
  }
  detected.sort((a, b) => a.x_start - b.x_start);
  const colored = detected.filter(b => b.id !== 'gold' && b.id !== 'silver');
  const metals = detected.filter(b => b.id === 'gold' || b.id === 'silver');

  // Tolerance % hint: inspect the body colour just beyond the colour bands at
  // each end and decide gold (±5%) vs silver (±10%). Used only for the
  // displayed tolerance, never for the value or direction.
  function endMetal(zs, ze) {
    if (ze - zs < 2) return null;
    const reg = smooth.slice(Math.max(0, zs), Math.min(smooth.length, ze));
    if (reg.length < 2) return null;
    const col = medianRgb(reg);
    const [, s, v] = rgbToHsv(col[0], col[1], col[2]);
    if (s < 0.18 && v > 0.45) return 'silver';
    return 'gold';
  }
  let tolHint = { left: null, right: null };
  if (colored.length) {
    const m = Math.max(2, Math.floor(nCols * 0.02));
    tolHint.left = endMetal(0, colored[0].ci_start - m);
    tolHint.right = endMetal(colored[colored.length - 1].ci_end + m, nCols);
  }

  return { colored, metals, nCols, substrate, tolHint, allBands: detected };
}

// =========================================================
// CLASSIFICATION
// =========================================================

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d) / 180;
}

/**
 * Classify a band using hue, saturation and value. Returns { id, distance,
 * confidence (0..1) }.
 */
function classifyBand(rgb, bodyRgb = null) {
  const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  let bestRef = null, bestDist = Infinity, secondDist = Infinity;

  for (const ref of BAND_REFS) {
    const [rh, rs, rv] = rgbToHsv(ref.rgb[0], ref.rgb[1], ref.rgb[2]);
    let d;
    if (['black', 'gray', 'white', 'silver'].includes(ref.id)) {
      d = Math.abs(v - rv) * 1.15 + Math.abs(s - rs) * 0.85;
      if (s > 0.45) d += (s - 0.45) * 1.2;
    } else if (ref.id === 'gold') {
      d = hueDistance(h, rh) * 1.15 + Math.abs(s - rs) * 0.45 + Math.abs(v - rv) * 0.30;
    } else {
      d = hueDistance(h, rh) * 1.45 + Math.abs(s - rs) * 0.35 + Math.abs(v - rv) * 0.45;
    }
    if (bodyRgb && rgbDistance(rgb, bodyRgb) < 20 && !['black', 'white', 'gray', 'silver'].includes(ref.id)) d += 0.22;
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

function computeReading(picks, mode) {
  return (window.ResistorEngine && window.ResistorEngine.computeOhmsFromPicks)
    ? window.ResistorEngine.computeOhmsFromPicks(picks, mode)
    : null;
}

function formatCandidate(picks, mode) {
  const c = computeReading(picks, mode);
  return { picks, mode, ohms: c ? c.ohms : null, tol: c ? c.tol : null };
}

// =========================================================
// DEBUG VISUALIZATION
// =========================================================

function buildDebugCanvas(imgData, body, bands, note = '') {
  const { minX, maxX, minY, maxY } = body;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;

  const margin = Math.floor(Math.min(w, h) * 0.6) + 12;
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

  ctx.strokeStyle = 'rgba(0, 220, 90, 0.98)';
  ctx.lineWidth = 3;
  ctx.strokeRect(minX - cx0, minY - cy0, w, h);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(Math.max(0, minX - cx0), Math.max(0, minY - cy0 - 22), 150, 20);
  ctx.fillStyle = '#fff';
  ctx.font = '13px system-ui, -apple-system, sans-serif';
  ctx.fillText(`body ${w}x${h}`, Math.max(4, minX - cx0 + 4), Math.max(14, minY - cy0 - 7));

  for (const b of bands) {
    const isLow = b.confidence < 0.40;
    ctx.strokeStyle = isLow ? 'rgba(255, 200, 0, 0.98)' : 'rgba(255, 0, 0, 0.98)';
    ctx.lineWidth = 2;
    const rx = b.x_start - cx0;
    const ry = minY - cy0;
    const rw = Math.max(2, b.x_end - b.x_start + 1);
    ctx.strokeRect(rx, ry, rw, h);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
    ctx.fillRect(rx, Math.max(0, ry - 18), 46, 16);
    ctx.fillStyle = '#fff';
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    ctx.fillText(b.id, rx + 2, Math.max(11, ry - 6));
  }

  if (note) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.70)';
    ctx.fillRect(0, ch - 24, Math.min(cw, note.length * 7 + 14), 24);
    ctx.fillStyle = '#fff';
    ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.fillText(note, 7, ch - 8);
  }

  return debug;
}

// =========================================================
// MAIN ENTRY POINT
// =========================================================

function analyzeHorizontalImage(rotated, bgRgb, note = '') {
  const W = rotated.width, H = rotated.height;
  let { mask } = computeForegroundMask(rotated, bgRgb);
  mask = close8(mask, W, H, 2);
  const cc = largestComponent8(mask, W, H);
  if (!cc) {
    return { success: false, reason: 'Detection failed after rotation.', debugImage: imageDataToCanvas(rotated) };
  }

  let body = isolateBody(cc.mask, W, H) || cc.bounds;

  if ((body.maxY - body.minY) > (body.maxX - body.minX)) {
    const rot = rotateImageData(rotated, 90, bgRgb);
    let m2 = computeForegroundMask(rot, bgRgb).mask;
    m2 = close8(m2, rot.width, rot.height, 2);
    const cc2 = largestComponent8(m2, rot.width, rot.height);
    if (cc2) {
      const body2 = isolateBody(cc2.mask, rot.width, rot.height) || cc2.bounds;
      const r = findBands(rot, body2);
      return { success: true, rotated: rot, body: body2, detect: r, debugImage: buildDebugCanvas(rot, body2, r.allBands, note) };
    }
  }

  const r = findBands(rotated, body);
  return { success: true, rotated, body, detect: r, debugImage: buildDebugCanvas(rotated, body, r.allBands, note) };
}

/**
 * Assemble a reading from the detected colour bands. Gold/silver tolerance
 * bands are intentionally NOT detected as colour bands (they are unreliable on
 * tan bodies); instead the reading direction comes from gap structure — the
 * colour bands cluster toward the digits end, leaving the larger gap on the
 * tolerance end. The resistance depends only on the colour bands, so this is
 * robust even when the tolerance band is invisible. Returns a result or null.
 */
function assembleReading(detect) {
  const { colored, metals, nCols, tolHint } = detect;
  const c = colored.length;
  if (c < 3 || c > 5) return null;

  // Gaps from the outermost colour bands to the body ends.
  const leftGap = colored[0].ci_start;
  const rightGap = (nCols - 1) - colored[c - 1].ci_end;

  // A genuinely-detected gold/silver band (e.g. on a light body) is the most
  // reliable tolerance cue: use the metal band that sits beyond the colour
  // bands to fix the side directly.
  let metalSide = null, metalId = null;
  if (metals && metals.length) {
    const m = metals[0].ci_start < colored[0].ci_start ? metals[0]
      : metals[metals.length - 1].ci_end > colored[c - 1].ci_end ? metals[metals.length - 1] : null;
    if (m) { metalSide = m.ci_start < colored[0].ci_start ? 'left' : 'right'; metalId = m.id; }
  }

  // Internal band pitch (median spacing between adjacent colour bands).
  const centers = colored.map(b => (b.ci_start + b.ci_end) / 2);
  const pitches = [];
  for (let i = 1; i < centers.length; i++) pitches.push(centers[i] - centers[i - 1]);
  const pitch = pitches.length ? median(pitches) : nCols;

  // Is there a hidden (gold/silver) tolerance band? It would sit at the end
  // with a gap clearly larger than the band pitch.
  const hiddenLeft = leftGap > pitch * 0.9;
  const hiddenRight = rightGap > pitch * 0.9;

  let mode, appendTol, tolSide, ambiguous = false;
  if (c === 3) {
    // 4-band: 3 colour bands + a (usually gold/silver) tolerance.
    mode = 4; appendTol = true;
    tolSide = metalSide || (rightGap >= leftGap ? 'right' : 'left');
    ambiguous = !metalSide && Math.max(leftGap, rightGap) / Math.max(1, Math.min(leftGap, rightGap)) < 1.25;
  } else if (c === 5) {
    mode = 5; appendTol = false;
    tolSide = metalSide || (rightGap >= leftGap ? 'right' : 'left');
  } else { // c === 4: 4-band (colour tolerance) OR 5-band (hidden/visible tolerance)
    if (metalSide) {
      mode = 5; appendTol = true; tolSide = metalSide;
    } else if (hiddenRight !== hiddenLeft) {
      mode = 5; appendTol = true; tolSide = hiddenRight ? 'right' : 'left';
    } else {
      mode = 4; appendTol = false;
      tolSide = rightGap >= leftGap ? 'right' : 'left';
    }
  }

  // Colour bands ordered digits-first: from the end opposite the tolerance.
  const ordered = (tolSide === 'right') ? colored.slice() : colored.slice().reverse();
  const picks = ordered.map(b => b.id);
  let tolId = null;
  if (appendTol) {
    tolId = metalId || (tolSide === 'right' ? tolHint.right : tolHint.left) || 'gold';
    picks.push(tolId);
  }

  const cand = formatCandidate(picks, mode);
  if (!cand || cand.ohms == null) {
    // Fallback: try the other direction.
    const rev = formatCandidate(ordered.slice().reverse().map(b => b.id).concat(appendTol ? [tolId] : []), mode);
    if (rev && rev.ohms != null) return finalize(rev, ordered.slice().reverse(), appendTol, tolId, 'right', false, []);
    return null;
  }

  let alternatives = [];
  if (ambiguous) {
    const rev = formatCandidate(picks.slice().reverse(), mode);
    if (rev && rev.ohms != null) alternatives = [cand, rev];
  }
  const reasoning = appendTol
    ? `${c} colour bands detected; tolerance band is faint, inferred on the ${tolSide} from band spacing (assumed ${tolId === 'silver' ? '±10% silver' : '±5% gold'}).`
    : `${c} bands detected; tolerance band on the ${tolSide}.`;

  return finalize(cand, ordered, appendTol, tolId, tolSide, false, alternatives, reasoning);

  function finalize(candX, orderedX, appendTolX, tolIdX, tolSideX, amb, alts, reason) {
    const bandsOut = orderedX.map(b => ({ colorId: b.id, confidence: b.confidence, rgb: b.rgb }));
    if (appendTolX) bandsOut.push({ colorId: tolIdX || 'gold', confidence: 0.3, rgb: tolIdX === 'silver' ? [180, 183, 187] : [200, 160, 90] });
    return {
      success: true, mode: candX.mode, picks: candX.picks, bands: bandsOut,
      ohms: candX.ohms, tol: candX.tol, alternatives: alts,
      reasoning: reason || `Tolerance on the ${tolSideX}.`,
    };
  }
}

async function detectResistor(imageData) {
  const work = downscaleIfNeeded(imageData, 820);
  const W = work.width, H = work.height;

  const bg = estimateBackground(work);

  let { mask } = computeForegroundMask(work, bg);
  mask = close8(mask, W, H, 2);
  const linked = dilate8(mask, W, H, 1);
  const cc = largestComponent8(linked, W, H);

  if (!cc || cc.count < Math.max(150, W * H * 0.0008)) {
    return {
      success: false,
      reason: "Couldn't find the resistor against the background. Use a plain, contrasting background and fill the guide box.",
      debugImage: imageDataToCanvas(work),
    };
  }

  const angleRad = pcaAngle(cc.mask, W, H, cc.cx, cc.cy);
  const angleDeg = angleRad * 180 / Math.PI;
  // Rotate by the negative of the principal-axis angle to bring it horizontal.
  let rotated = rotateImageData(work, -angleDeg, bg);

  let pass = analyzeHorizontalImage(rotated, bg, 'straightened');
  if (!pass.success) return pass;

  const detect = pass.detect;
  const debugImage = pass.debugImage;
  const nColored = detect.colored.length;

  const result = assembleReading(detect);
  if (!result) {
    return {
      success: false,
      reason: `Detected ${nColored} clear colour band${nColored === 1 ? '' : 's'}. Need 3–5. Try a sharper, evenly-lit photo of the resistor on a plain, contrasting background, filling the guide box.`,
      debugImage,
      bands: detect.allBands.map(b => ({ colorId: b.id, confidence: b.confidence, rgb: b.rgb })),
    };
  }

  result.debugImage = debugImage;
  return result;
}

// Public API
window.ResistorCV = {
  detectResistor,
};
