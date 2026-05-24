/* =========================================================
   Resistor CV — band detection pipeline (vanilla JS)
   No external libraries. Designed for one resistor in frame,
   roughly horizontal-ish (we'll auto-rotate), plain background.
   ========================================================= */

// -------- Color space helpers --------

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

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

// -------- Reference band colors (HSV) --------
// Tuned a bit from the canonical palette since real photos differ from screen RGB.
const BAND_REFS = [
  { id: 'black',  rgb: [25,25,25] },
  { id: 'brown',  rgb: [120,70,40] },
  { id: 'red',    rgb: [200,40,40] },
  { id: 'orange', rgb: [230,130,50] },
  { id: 'yellow', rgb: [240,220,80] },
  { id: 'green',  rgb: [70,170,80] },
  { id: 'blue',   rgb: [60,90,200] },
  { id: 'violet', rgb: [170,100,200] },
  { id: 'gray',   rgb: [150,150,150] },
  { id: 'white',  rgb: [240,240,240] },
  { id: 'gold',   rgb: [200,150,70] },
  { id: 'silver', rgb: [190,190,190] },
];
BAND_REFS.forEach(r => r.hsv = rgbToHsv(...r.rgb));

// -------- Body color refs (used for body type classification only) --------
const BODY_REFS = [
  { id: 'beige', rgb: [230,210,160] }, // carbon film
  { id: 'blue',  rgb: [170,215,235] }, // metal film
];
BODY_REFS.forEach(r => r.hsv = rgbToHsv(...r.rgb));

// =========================================================
// BACKGROUND ESTIMATION + RESISTOR MASK
// =========================================================

/**
 * Estimate background color from image corners.
 * Returns { rgb: [r,g,b] }.
 */
function estimateBackground(imgData) {
  const { data, width: W, height: H } = imgData;
  const sz = Math.max(15, Math.min(W, H) >> 5); // ~3% of smaller dim
  const samples = [];
  const corners = [[0,0], [W-sz,0], [0,H-sz], [W-sz,H-sz]];
  for (const [x0, y0] of corners) {
    for (let y = y0; y < y0 + sz; y++) {
      for (let x = x0; x < x0 + sz; x++) {
        const i = (y * W + x) * 4;
        samples.push([data[i], data[i+1], data[i+2]]);
      }
    }
  }
  // Median per channel
  const med = [0,1,2].map(ch => {
    const sorted = samples.map(s => s[ch]).sort((a,b) => a - b);
    return sorted[sorted.length >> 1];
  });
  return { rgb: med };
}

/**
 * Mask of pixels that differ from the background by more than a threshold.
 * Threshold is the sum of absolute RGB differences (max 765 = pure inverse).
 */
function computeResistorMask(imgData, bg, threshold = 60) {
  const { data, width, height } = imgData;
  const mask = new Uint8Array(width * height);
  const [br, bg_, bb] = bg.rgb;
  let count = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const d = Math.abs(data[i] - br) + Math.abs(data[i+1] - bg_) + Math.abs(data[i+2] - bb);
    if (d > threshold) { mask[p] = 1; count++; }
  }
  return { mask, coverage: count / (width * height) };
}

/**
 * (Legacy) Color-based body mask. Used only for classifying carbon-film vs metal-film body.
 */
function computeBodyColorMask(imgData) {
  const { data, width, height } = imgData;
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const [h, s, v] = rgbToHsv(data[i], data[i+1], data[i+2]);
    const isBeige = (h >= 25 && h <= 55 && s >= 0.12 && s <= 0.60 && v >= 0.5 && v <= 0.98);
    const isBlue  = (h >= 175 && h <= 225 && s >= 0.08 && s <= 0.50 && v >= 0.6 && v <= 0.99);
    if (isBeige || isBlue) { mask[p] = 1; count++; }
  }
  return { mask, coverage: count / (width * height) };
}

// =========================================================
// PIPELINE
// =========================================================

/**
 * Main entry: process an ImageData and return a detection result.
 *
 * Returns:
 *   {
 *     success: bool,
 *     mode: 4|5,
 *     picks: [colorId, ...],   // including tolerance
 *     bands: [{ colorId, confidence: 0..1 }, ...],
 *     ohms, tol,
 *     bodyType: 'beige'|'blue',
 *     debug: { ... },
 *     reason?: string          // why it failed if !success
 *   }
 */
async function detectResistor(imageData) {
  // 1) Downscale for speed if very large
  const work = downscaleIfNeeded(imageData, 800);

  // 2) Estimate background and build resistor mask (anything sufficiently
  //    different from background = part of the resistor or its leads).
  //    Try a couple of thresholds; metal-film resistors on light surfaces can
  //    be only ~50 RGB-units apart from the background.
  const bg = estimateBackground(work);
  let mask = computeResistorMask(work, bg, 50);
  if (mask.coverage < 0.01) {
    mask = computeResistorMask(work, bg, 30);
  }
  if (mask.coverage < 0.005) {
    return { success: false, reason: "Can't separate the resistor from the background. Try a plainer surface with more contrast." };
  }
  if (mask.coverage > 0.7) {
    return { success: false, reason: "Background looks cluttered. Try a plainer, lighter surface." };
  }

  // 3) Largest connected component
  const cc = largestComponent(mask.mask, work.width, work.height);
  if (!cc || cc.count < 400) {
    return { success: false, reason: "Resistor area too small. Move the camera closer." };
  }

  // 4) PCA on component pixels for orientation
  cc.pixels.width = work.width;
  const orient = pcaOrientation(cc.pixels);

  // 5) Rotate so the principal axis is horizontal. Fill new pixels
  //    with the background colour so the post-rotation mask works.
  const rotated = rotateImageData(work, -orient.angle, bg.rgb);

  // 6) Re-find the resistor in the rotated image
  let bg2 = estimateBackground(rotated);
  let mask2 = computeResistorMask(rotated, bg2, 50);
  if (mask2.coverage < 0.01) mask2 = computeResistorMask(rotated, bg2, 30);
  let cc2 = largestComponent(mask2.mask, rotated.width, rotated.height);
  if (!cc2) {
    return { success: false, reason: "Detection failed after rotation." };
  }

  // 6b) Sanity check: the resistor should be wider than tall after rotation.
  //     If not, rotate another 90° (PCA can pick either the major axis or
  //     the line perpendicular to it, depending on sign conventions).
  let workRotated = rotated;
  const bw = cc2.bounds.maxX - cc2.bounds.minX + 1;
  const bh = cc2.bounds.maxY - cc2.bounds.minY + 1;
  if (bh > bw) {
    workRotated = rotateImageData(rotated, Math.PI / 2, bg.rgb);
    bg2 = estimateBackground(workRotated);
    mask2 = computeResistorMask(workRotated, bg2, 50);
    if (mask2.coverage < 0.01) mask2 = computeResistorMask(workRotated, bg2, 30);
    cc2 = largestComponent(mask2.mask, workRotated.width, workRotated.height);
    if (!cc2) {
      return { success: false, reason: "Detection failed after re-rotation." };
    }
  }

  // 7) Body type (carbon-film beige vs metal-film blue) from colour-based mask
  const bodyType = classifyBodyType(workRotated);

  // 8) Crop to body bounds. Trim heavily on X to drop the lead wires and
  //    rounded shoulders; trim moderately on Y to skip curved edges.
  const crop = cropToBoundingBox(workRotated, cc2.bounds, 0.22, 0.22);
  if (!crop || crop.width < 30 || crop.height < 8) {
    return { success: false, reason: "Body too small after rotation." };
  }

  // 9) Sample a 1D color signal along the central strip
  const strip = sampleCentralStrip(crop, 0.45);

  // 10) Smooth signal
  const smooth = smoothStrip(strip, 3);

  // 11) Detect band columns vs body columns
  const bandRegions = findBandRegions(smooth, bodyType);

  if (bandRegions.length < 4 || bandRegions.length > 6) {
    return {
      success: false,
      reason: `Detected ${bandRegions.length} bands. Expected 4 or 5. Re-check framing/lighting.`,
      debug: { bandRegions, bodyType, cropWidth: crop.width }
    };
  }

  // 12) Classify each band's dominant color
  const classified = bandRegions.map(r => classifyBand(r.meanRgb, r.meanHsv));

  // 13) Pick mode based on band count (collapse 6-band to 5 by dropping last if needed)
  let mode = bandRegions.length === 4 ? 4 : 5;
  let bands = classified.slice(0, mode === 4 ? 4 : 5);
  if (bandRegions.length === 6) {
    // Treat as 5-band (temp coefficient dropped — uncommon to need)
    bands = classified.slice(0, 5);
  }

  // 14) Decide reading direction. The "right" orientation has:
  //     - tolerance-capable color (gold/silver/brown/red/green/blue/violet/gray) as last band
  //     - AND a valid resistor value
  const decision = pickReadingDirection(bands, mode);

  // 15) Compute final ohms/tolerance
  const result = window.ResistorEngine.computeOhmsFromPicks(decision.picks, mode);

  return {
    success: true,
    mode,
    picks: decision.picks,
    bands: decision.bandsWithConf,
    ohms: result ? result.ohms : null,
    tol: result ? result.tol : null,
    bodyType,
    reasoning: decision.reason,
  };
}

// =========================================================
// IMPLEMENTATIONS
// =========================================================

function downscaleIfNeeded(imgData, maxDim) {
  const { width: w, height: h } = imgData;
  const m = Math.max(w, h);
  if (m <= maxDim) return imgData;
  const scale = maxDim / m;
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.putImageData(imgData, 0, 0);

  const c2 = document.createElement('canvas');
  c2.width = nw; c2.height = nh;
  const ctx2 = c2.getContext('2d');
  ctx2.drawImage(c, 0, 0, nw, nh);
  return ctx2.getImageData(0, 0, nw, nh);
}

/**
 * Find the largest connected component in the mask (4-connectivity, BFS).
 * Returns indices array and bounding box.
 */
function largestComponent(mask, w, h) {
  const visited = new Uint8Array(mask.length);
  let best = null;
  const stack = new Int32Array(mask.length); // reused

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx] || visited[idx]) continue;

      // BFS
      let top = 0;
      stack[top++] = idx;
      visited[idx] = 1;
      const pixels = [];
      let minX = x, maxX = x, minY = y, maxY = y;
      let sumX = 0, sumY = 0;

      while (top > 0) {
        const cur = stack[--top];
        const cy = (cur / w) | 0;
        const cx = cur - cy * w;
        pixels.push(cur);
        sumX += cx; sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 4-neighbors
        if (cx > 0 && mask[cur-1] && !visited[cur-1]) { visited[cur-1]=1; stack[top++]=cur-1; }
        if (cx < w-1 && mask[cur+1] && !visited[cur+1]) { visited[cur+1]=1; stack[top++]=cur+1; }
        if (cy > 0 && mask[cur-w] && !visited[cur-w]) { visited[cur-w]=1; stack[top++]=cur-w; }
        if (cy < h-1 && mask[cur+w] && !visited[cur+w]) { visited[cur+w]=1; stack[top++]=cur+w; }
      }

      if (!best || pixels.length > best.count) {
        best = {
          count: pixels.length,
          pixels,
          bounds: { minX, maxX, minY, maxY },
          centroid: { x: sumX / pixels.length, y: sumY / pixels.length }
        };
      }
    }
  }
  return best;
}

/**
 * PCA on a set of (x,y) pixel coordinates.
 * Returns angle of principal axis (radians).
 */
function pcaOrientation(pixelIndices) {
  // We need width to recover x,y from index — but indices were stored as linear indices.
  // The caller (largestComponent) doesn't include width; we'll recover via the first item count.
  // Workaround: pass the data via outer closure. Simpler: re-derive in caller. We'll do the
  // PCA here assuming we know how to decode indices — but we don't have w. So we accept
  // a different signature: pixelIndices is the array of linear indices and we need w.
  //
  // To keep this clean, we re-attach the width on the pixels array via a side channel:
  // caller will set pixelIndices.width before calling. (Yes, slight hack.)
  const w = pixelIndices.width;
  const n = pixelIndices.length;
  if (!w || n < 2) return { angle: 0 };

  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    const idx = pixelIndices[i];
    const y = (idx / w) | 0;
    const x = idx - y * w;
    mx += x; my += y;
  }
  mx /= n; my /= n;

  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const idx = pixelIndices[i];
    const y = (idx / w) | 0;
    const x = idx - y * w;
    const dx = x - mx, dy = y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // Angle of principal axis = 0.5 * atan2(2*sxy, sxx-syy)
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { angle, centroid: { x: mx, y: my } };
}

/**
 * Rotate an ImageData by `angle` radians (positive = counterclockwise).
 * Pixels outside the source image are filled with `fillRgb` so post-rotation
 * background detection still finds a uniform background.
 * Returns a new ImageData sized to contain the rotated image.
 */
function rotateImageData(imgData, angle, fillRgb) {
  const { width: w, height: h } = imgData;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const nw = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const nh = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));

  // Put source on canvas
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  src.getContext('2d').putImageData(imgData, 0, 0);

  const dst = document.createElement('canvas');
  dst.width = nw; dst.height = nh;
  const dctx = dst.getContext('2d');
  // Fill with the background colour first
  if (fillRgb) {
    dctx.fillStyle = `rgb(${fillRgb[0]},${fillRgb[1]},${fillRgb[2]})`;
    dctx.fillRect(0, 0, nw, nh);
  }
  dctx.translate(nw / 2, nh / 2);
  dctx.rotate(angle);
  dctx.drawImage(src, -w / 2, -h / 2);
  return dctx.getImageData(0, 0, nw, nh);
}

/**
 * Classify body type by averaging RGB over body-colored pixels in the
 * rotated image (carbon-film beige vs metal-film blue).
 */
function classifyBodyType(imgData) {
  const m = computeBodyColorMask(imgData);
  const { data } = imgData;
  let r=0,g=0,b=0,n=0;
  for (let p = 0; p < m.mask.length; p++) {
    if (!m.mask[p]) continue;
    const i = p * 4;
    r += data[i]; g += data[i+1]; b += data[i+2]; n++;
  }
  if (n === 0) return 'beige';
  r /= n; g /= n; b /= n;
  const [h] = rgbToHsv(r, g, b);
  return (h > 150 && h < 240) ? 'blue' : 'beige';
}

/**
 * Crop ImageData to the bounding box of the body, with inward margins
 * to exclude lead wires and rounded body ends.
 */
function cropToBoundingBox(imgData, bounds, marginXFrac, marginYFrac) {
  const { minX, maxX, minY, maxY } = bounds;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  // We expect the resistor to be horizontal now — trim more on X (lead/shoulder)
  // and more on Y (avoid curved body edges where colors mix).
  const mx = Math.round(bw * marginXFrac);
  const my = Math.round(bh * marginYFrac);
  const x = minX + mx;
  const y = minY + my;
  const w = bw - 2 * mx;
  const h = bh - 2 * my;
  if (w <= 0 || h <= 0) return null;

  // Use a canvas to crop
  const src = document.createElement('canvas');
  src.width = imgData.width; src.height = imgData.height;
  src.getContext('2d').putImageData(imgData, 0, 0);

  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  dst.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
  return dst.getContext('2d').getImageData(0, 0, w, h);
}

/**
 * Sample the central strip of an axis-aligned cropped body image.
 * heightFrac controls how thick the sampling band is (e.g. 0.45 = middle 45%).
 * Returns an array of length=width with avg RGB+HSV per column.
 */
function sampleCentralStrip(imgData, heightFrac) {
  const { data, width: W, height: H } = imgData;
  const yMid = H / 2;
  const halfH = (H * heightFrac) / 2;
  const y0 = Math.max(0, Math.floor(yMid - halfH));
  const y1 = Math.min(H, Math.ceil(yMid + halfH));

  const out = new Array(W);
  for (let x = 0; x < W; x++) {
    let r=0,g=0,b=0,n=0;
    for (let y = y0; y < y1; y++) {
      const idx = (y * W + x) * 4;
      r += data[idx];
      g += data[idx+1];
      b += data[idx+2];
      n++;
    }
    if (n > 0) { r/=n; g/=n; b/=n; }
    const [h, s, v] = rgbToHsv(r, g, b);
    out[x] = { rgb: [r,g,b], hsv: [h,s,v] };
  }
  return out;
}

/**
 * Box-smooth the RGB+HSV signal column-wise.
 */
function smoothStrip(strip, radius) {
  const n = strip.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let r=0,g=0,b=0,c=0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      r += strip[j].rgb[0];
      g += strip[j].rgb[1];
      b += strip[j].rgb[2];
      c++;
    }
    r/=c; g/=c; b/=c;
    out[i] = { rgb: [r,g,b], hsv: rgbToHsv(r,g,b) };
  }
  return out;
}

/**
 * Detect contiguous band regions along the central strip.
 * Strategy: classify each column as 'body' (close to body color) or 'band'.
 * Use an absolute distance threshold — robust to having many or few bands.
 */
function findBandRegions(strip, bodyType) {
  const bodyRef = BODY_REFS.find(r => r.id === bodyType) || BODY_REFS[0];
  const [bh, bs, bv] = bodyRef.hsv;

  function distToBody(hsv) {
    const [h, s, v] = hsv;
    let dh = Math.abs(h - bh); if (dh > 180) dh = 360 - dh;
    const ds = Math.abs(s - bs);
    const dv = Math.abs(v - bv);
    return Math.sqrt((dh/60)*(dh/60) + ds*ds*4 + dv*dv*4);
  }

  const dists = strip.map(s => distToBody(s.hsv));

  // Absolute distance threshold. Columns above this are band columns.
  const BODY_THRESH = 0.6;
  const isBand = dists.map(d => d > BODY_THRESH);

  // Find runs of band columns
  const runs = [];
  let i = 0;
  while (i < isBand.length) {
    if (isBand[i]) {
      let j = i;
      while (j < isBand.length && isBand[j]) j++;
      runs.push({ start: i, end: j - 1, length: j - i });
      i = j;
    } else {
      i++;
    }
  }

  if (runs.length === 0) return [];

  // Filter very short runs (likely noise from edges/transitions)
  const lengths = runs.map(r => r.length).sort((a,b) => a-b);
  const medianLen = lengths[Math.floor(lengths.length/2)];
  const minLen = Math.max(3, medianLen * 0.35);
  const filtered = runs.filter(r => r.length >= minLen);

  // Merge runs separated by tiny gaps
  const merged = [];
  for (const r of filtered) {
    if (merged.length === 0) { merged.push({...r}); continue; }
    const last = merged[merged.length - 1];
    const gap = r.start - last.end - 1;
    if (gap < Math.max(2, medianLen * 0.30)) {
      last.end = r.end;
      last.length = last.end - last.start + 1;
    } else {
      merged.push({...r});
    }
  }

  // Mean color per band, inner 60% to avoid edge bleed
  for (const r of merged) {
    const margin = Math.floor(r.length * 0.20);
    const a = r.start + margin;
    const b = Math.max(a, r.end - margin);
    let R=0,G=0,B=0,n=0;
    for (let k = a; k <= b; k++) {
      R += strip[k].rgb[0];
      G += strip[k].rgb[1];
      B += strip[k].rgb[2];
      n++;
    }
    R/=n; G/=n; B/=n;
    r.meanRgb = [R,G,B];
    r.meanHsv = rgbToHsv(R,G,B);
  }

  return merged;
}

/**
 * Classify a band's mean color into one of the 12 standard band colors.
 * Returns { colorId, confidence (0..1), distances }.
 */
function classifyBand(rgb, hsv) {
  // Distance in a hybrid space:
  //  - For low-saturation colors (black/white/gray/silver), use V (lightness) primarily.
  //  - For chromatic colors, use circular hue distance + saturation/value.
  const [h, s, v] = hsv;

  function dist(ref) {
    const [rh, rs, rv] = ref.hsv;
    const refIsAchromatic = rs < 0.18;
    const isAchromatic = s < 0.20;

    if (refIsAchromatic && isAchromatic) {
      // Both grayscale: just compare lightness
      return Math.abs(v - rv) * 5;
    }
    if (refIsAchromatic !== isAchromatic) {
      // Mismatch in chromaticity — heavy penalty
      return 4 + Math.abs(v - rv) * 2;
    }
    let dh = Math.abs(h - rh); if (dh > 180) dh = 360 - dh;
    const ds = Math.abs(s - rs);
    const dv = Math.abs(v - rv);
    return Math.sqrt((dh/40)*(dh/40) + ds*ds*3 + dv*dv*3);
  }

  const ranked = BAND_REFS
    .map(ref => ({ id: ref.id, d: dist(ref) }))
    .sort((a, b) => a.d - b.d);

  const best = ranked[0];
  const second = ranked[1];
  // Confidence: how much better than the runner-up
  const conf = Math.max(0, Math.min(1, (second.d - best.d) / Math.max(0.4, second.d)));
  return { colorId: best.id, confidence: conf, distances: ranked.slice(0, 3) };
}

/**
 * Decide which direction to read the bands.
 * Strategy:
 *   - The tolerance band is usually gold/silver, and offset toward the right end of the body.
 *   - We have two candidate readings: forward and reversed.
 *   - Prefer the one whose last band is a valid tolerance color.
 *   - Prefer one whose value is in a "reasonable" range (>= 0.1Ω, <= 100GΩ) and is E24/E96 plausible.
 *   - Stronger prior toward gold/silver as last band.
 */
function pickReadingDirection(classified, mode) {
  const tolerancePref = new Set(['gold', 'silver', 'brown', 'red', 'green', 'blue', 'violet', 'gray']);

  function score(arr) {
    const last = arr[arr.length - 1].colorId;
    const first = arr[0].colorId;
    let s = 0;

    // First band can't be black (no leading zero in real resistors)
    if (first === 'black') s -= 5;

    // Tolerance preference
    if (last === 'gold' || last === 'silver') s += 4;
    else if (tolerancePref.has(last)) s += 1;
    else s -= 3; // last band must be valid tolerance color

    // Multiplier slot validity
    const multIdx = mode === 4 ? 2 : 3;
    const multColor = window.ResistorEngine.COLOR_BY_ID[arr[multIdx].colorId];
    if (!multColor || multColor.mult === null) s -= 3;

    // Digit slots validity
    const digitEnd = mode === 4 ? 2 : 3;
    for (let i = 0; i < digitEnd; i++) {
      const c = window.ResistorEngine.COLOR_BY_ID[arr[i].colorId];
      if (!c || c.digit === null) s -= 2;
    }

    // Compute resulting value and check reasonableness
    const picks = arr.map(b => b.colorId);
    const r = window.ResistorEngine.computeOhmsFromPicks(picks, mode);
    if (r && r.ohms > 0) {
      if (r.ohms >= 0.1 && r.ohms <= 100e9) s += 1;
      // E24 nearness bonus
      const e = window.ResistorEngine.nearestE24(r.ohms);
      if (e && e.exact) s += 2;
    } else {
      s -= 4;
    }

    // Average confidence bonus
    const meanConf = arr.reduce((a, b) => a + b.confidence, 0) / arr.length;
    s += meanConf * 1.5;

    return s;
  }

  const forward = classified;
  const reversed = [...classified].reverse();

  const sf = score(forward);
  const sr = score(reversed);

  const chosen = sf >= sr ? forward : reversed;
  return {
    picks: chosen.map(b => b.colorId),
    bandsWithConf: chosen.map(b => ({ colorId: b.colorId, confidence: b.confidence })),
    reason: sf >= sr ? 'forward' : 'reversed',
  };
}

// =========================================================
// Export
// =========================================================
window.ResistorCV = { detectResistor, classifyBand, rgbToHsv };
