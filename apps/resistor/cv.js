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
 * Separation score between a column colour and the body substrate. Combines
 * raw RGB distance with a chroma/value term, so strongly coloured bands
 * (green, blue, red) separate cleanly while darker/metallic bands still count.
 */
function bandSeparation(rgb, substrate) {
  const base = rgbDistance(rgb, substrate);
  const [, s1, v1] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  const [, s2, v2] = rgbToHsv(substrate[0], substrate[1], substrate[2]);
  const chroma = Math.abs(s1 - s2) * 120 + Math.abs(v1 - v2) * 60;
  return Math.max(base, base * 0.6 + chroma * 0.7);
}

/**
 * Detect bands as runs of columns whose colour departs from the body
 * substrate. Strong (clearly coloured) bands are found with a robust
 * threshold. A low-contrast gold/silver tolerance band — which on a tan
 * carbon-film body barely differs from the substrate — is then rescued, but
 * only at the body ENDS and outside the strong-band span, so mid-body
 * highlights are never mistaken for a band.
 * Returns { bands (sorted left-to-right), substrate }.
 */
function findBands(imgData, body) {
  const w = body.maxX - body.minX + 1;
  const trim = Math.floor(w * 0.03);
  const trimmedBody = { ...body, minX: body.minX + trim, maxX: body.maxX - trim };

  const profile = columnColorProfile(imgData, trimmedBody);
  const nCols = profile.xs.length;
  if (nCols < 8) return { bands: [], substrate: [200, 180, 140] };

  const smooth = smoothColors(profile.rgbs, 5);
  const substrate = medianRgb(smooth);

  const seps = smooth.map(c => bandSeparation(c, substrate));
  const medS = median(seps);
  const madS = median(seps.map(d => Math.abs(d - medS)));
  // Strong threshold: clearly above gold/highlight level, below colour bands.
  const strongThreshold = Math.max(34, medS + 2.2 * madS);

  const minBandW = Math.max(2, Math.floor(nCols * 0.015));
  const maxBandW = Math.max(minBandW + 2, Math.floor(nCols * 0.30));
  const maxGap = Math.max(1, Math.floor(nCols * 0.02));

  // ---- helper: turn a column predicate into merged runs ----
  function runsWhere(pred) {
    const raw = [];
    let i = 0;
    while (i < seps.length) {
      if (pred(i)) {
        const start = i;
        while (i < seps.length && pred(i)) i++;
        raw.push([start, i]);
      } else i++;
    }
    const merged = [];
    for (const r of raw) {
      const prev = merged[merged.length - 1];
      if (prev && r[0] - prev[1] <= maxGap) prev[1] = r[1];
      else merged.push([r[0], r[1]]);
    }
    return merged;
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
      y_start: body.minY,
      y_end: body.maxY,
      rgb: bandRgb,
      separation: median(seps.slice(start, end)),
      ...classifyBand(bandRgb, substrate),
    };
  }

  // ---- strong colour bands ----
  const strong = [];
  for (const [s, e] of runsWhere(i => seps[i] > strongThreshold)) {
    const wc = e - s;
    if (wc < minBandW || wc > maxBandW) continue;
    strong.push(bandFromRun(s, e));
  }

  // ---- end-zone gold/silver rescue ----
  // Only search the body ends, outside the span covered by strong bands, so a
  // mid-body specular highlight can never be mistaken for a tolerance band.
  const rescued = [];
  if (strong.length) {
    const spanMin = strong[0].ci_start;
    const spanMax = strong[strong.length - 1].ci_end;
    const margin = Math.max(2, Math.floor(nCols * 0.03));
    const goldThreshold = Math.max(26, strongThreshold * 0.5);
    const endZones = [
      [0, spanMin - margin],
      [spanMax + margin, seps.length],
    ];
    for (const [zs, ze] of endZones) {
      if (ze - zs < minBandW) continue;
      for (const [s, e] of runsWhere(i => i >= zs && i < ze && seps[i] > goldThreshold)) {
        const wc = e - s;
        if (wc < minBandW || wc > maxBandW) continue;
        const cand = bandFromRun(s, e);
        if (cand.id === 'gold' || cand.id === 'silver') rescued.push(cand);
      }
    }
  }

  const bands = strong.concat(rescued).sort((a, b) => a.x_start - b.x_start);
  return { bands, substrate };
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
      return { success: true, rotated: rot, body: body2, bands: r.bands, debugImage: buildDebugCanvas(rot, body2, r.bands, note) };
    }
  }

  const r = findBands(rotated, body);
  return { success: true, rotated, body, bands: r.bands, debugImage: buildDebugCanvas(rotated, body, r.bands, note) };
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

  if (pass.bands.length >= 4 && ['gold', 'silver'].includes(pass.bands[0].id)) {
    rotated = rotateImageData(pass.rotated, 180, bg);
    pass = analyzeHorizontalImage(rotated, bg, 'flipped 180deg (tolerance band was first)');
    if (!pass.success) return pass;
  }

  const bands = pass.bands;
  const debugImage = pass.debugImage;

  if (bands.length !== 4 && bands.length !== 5) {
    return {
      success: false,
      reason: `Detected ${bands.length} band${bands.length === 1 ? '' : 's'}. Need exactly 4 or 5. Try a sharper photo, a plainer background, and make sure all bands are visible.`,
      debugImage,
      bands: bands.map(b => ({ colorId: b.id, confidence: b.confidence, rgb: b.rgb })),
    };
  }

  const mode = bands.length;
  const forwardBands = bands.slice(0, mode);
  const forwardPicks = forwardBands.map(b => b.id);
  const forward = formatCandidate(forwardPicks, mode);

  const last = forwardBands[forwardBands.length - 1];
  let alternatives = [];
  let reasoning = 'Read left-to-right; the tolerance band is on the right.';

  if (!['gold', 'silver'].includes(last.id)) {
    const reverse = formatCandidate([...forwardBands].reverse().map(b => b.id), mode);
    alternatives = [forward, reverse];
    reasoning = 'No clear gold/silver tolerance band, so both reading directions are shown.';
  }

  return {
    success: true,
    mode,
    picks: forward.picks,
    bands: forwardBands.map(b => ({ colorId: b.id, confidence: b.confidence, rgb: b.rgb })),
    ohms: forward.ohms,
    tol: forward.tol,
    alternatives,
    reasoning,
    debugImage,
  };
}

// Public API
window.ResistorCV = {
  detectResistor,
};
