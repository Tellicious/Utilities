/* =========================================================
   Resistor CV — robust horizontal/near-horizontal band reader

   Design assumptions:
     - The resistor is approximately horizontal and inside the camera guide.
     - It may be slightly rotated, off-centre, small in the frame, or on a
       moderately cluttered/bright/dark background.
     - The pipeline is entirely client-side and dependency-free.
   ========================================================= */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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
  return [h, max === 0 ? 0 : d / max, max];
}

function rgbDistance(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const idx = clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[idx];
}

function medianRgb(rgbs) {
  return [0, 1, 2].map(ch => median(rgbs.map(rgb => rgb[ch])));
}

const BAND_REFS = [
  { id: 'black',  rgb: [25, 25, 25],     hue: null },
  { id: 'brown',  rgb: [105, 62, 32],    hue: 24 },
  { id: 'red',    rgb: [205, 45, 35],    hue: 3 },
  { id: 'orange', rgb: [235, 115, 30],   hue: 27 },
  { id: 'yellow', rgb: [245, 215, 55],   hue: 52 },
  { id: 'green',  rgb: [55, 150, 75],    hue: 128 },
  { id: 'blue',   rgb: [45, 95, 200],    hue: 222 },
  { id: 'violet', rgb: [155, 80, 175],   hue: 285 },
  { id: 'gray',   rgb: [145, 145, 145],  hue: null },
  { id: 'white',  rgb: [238, 238, 238],  hue: null },
  { id: 'gold',   rgb: [190, 145, 70],   hue: 42 },
  { id: 'silver', rgb: [184, 184, 188],  hue: null },
];

const TOL_COLORS = new Set(['brown', 'red', 'green', 'blue', 'violet', 'gray', 'gold', 'silver']);

function imageDataToCanvas(imgData) {
  const c = document.createElement('canvas');
  c.width = imgData.width;
  c.height = imgData.height;
  c.getContext('2d').putImageData(imgData, 0, 0);
  return c;
}

function canvasToImageData(canvas) {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

function downscaleIfNeeded(imgData, maxDim) {
  const m = Math.max(imgData.width, imgData.height);
  if (m <= maxDim) return imgData;
  const scale = maxDim / m;
  const src = imageDataToCanvas(imgData);
  const dst = document.createElement('canvas');
  dst.width = Math.round(imgData.width * scale);
  dst.height = Math.round(imgData.height * scale);
  dst.getContext('2d').drawImage(src, 0, 0, dst.width, dst.height);
  return canvasToImageData(dst);
}

function sampleBorderRgb(imgData) {
  const { data, width: W, height: H } = imgData;
  const rgbs = [];
  const step = Math.max(1, Math.floor(Math.min(W, H) / 80));
  for (let x = 0; x < W; x += step) {
    for (const y of [0, H - 1]) {
      const i = (y * W + x) * 4;
      rgbs.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  for (let y = 0; y < H; y += step) {
    for (const x of [0, W - 1]) {
      const i = (y * W + x) * 4;
      rgbs.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  return medianRgb(rgbs);
}

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

function dilate(mask, W, H, iterations = 1) {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (cur[p] || (x > 0 && cur[p - 1]) || (x < W - 1 && cur[p + 1]) || (y > 0 && cur[p - W]) || (y < H - 1 && cur[p + W])) next[p] = 1;
    }
    cur = next;
  }
  return cur;
}

function erode(mask, W, H, iterations = 1) {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(cur.length);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (cur[p] && cur[p - 1] && cur[p + 1] && cur[p - W] && cur[p + W]) next[p] = 1;
    }
    cur = next;
  }
  return cur;
}

function close(mask, W, H, iterations = 1) { return erode(dilate(mask, W, H, iterations), W, H, iterations); }

function computeObjectMask(imgData) {
  const { data, width: W, height: H } = imgData;
  const bg = sampleBorderRgb(imgData);
  const mask = new Uint8Array(W * H);
  const chromas = [];
  const bgHsv = rgbToHsv(bg[0], bg[1], bg[2]);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    chromas.push(max - min);
  }
  const chromaCut = Math.max(22, percentile(chromas, 0.72));

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const [h, s, v] = rgbToHsv(r, g, b);
    const dBg = rgbDistance([r, g, b], bg);
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const colored = (s > 0.16 && v > 0.12 && chroma >= chromaCut * 0.55);
    const warmBody = ((h < 78) || (h > 320)) && s > 0.08 && v > 0.22 && v < 0.98;
    const darkInk = v < 0.24 && dBg > 35 && !(bgHsv[2] < 0.25 && dBg < 60);
    const lightMetal = s < 0.12 && v > 0.52 && dBg > 45;
    const notBackground = dBg > 28 && !(s < 0.08 && bgHsv[1] < 0.08 && Math.abs(v - bgHsv[2]) < 0.16);
    if ((colored || warmBody || darkInk || lightMetal) && notBackground) mask[p] = 1;
  }
  return mask;
}

function components(mask, W, H) {
  const labels = new Int32Array(mask.length);
  const stack = [];
  const out = [];
  let label = 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (!mask[p] || labels[p]) continue;
    labels[p] = label;
    stack.length = 0; stack.push(p);
    let count = 0, sumX = 0, sumY = 0, minX = x, maxX = x, minY = y, maxY = y;
    while (stack.length) {
      const q = stack.pop();
      const qx = q % W, qy = (q - qx) / W;
      count++; sumX += qx; sumY += qy;
      if (qx < minX) minX = qx; if (qx > maxX) maxX = qx; if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
      const ns = [];
      if (qx > 0) ns.push(q - 1); if (qx < W - 1) ns.push(q + 1); if (qy > 0) ns.push(q - W); if (qy < H - 1) ns.push(q + W);
      for (const n of ns) if (mask[n] && !labels[n]) { labels[n] = label; stack.push(n); }
    }
    const cMask = new Uint8Array(mask.length);
    for (let i = 0; i < labels.length; i++) if (labels[i] === label) cMask[i] = 1;
    out.push({ mask: cMask, count, bounds: { minX, maxX, minY, maxY }, cx: sumX / count, cy: sumY / count });
    label++;
  }
  return out;
}

function chooseBestComponent(imgData, mask) {
  const W = imgData.width, H = imgData.height;
  const comps = components(mask, W, H);
  if (!comps.length) return null;
  let best = null, bestScore = -Infinity;
  for (const c of comps) {
    const b = c.bounds;
    const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
    const aspect = bw / Math.max(1, bh);
    const areaFrac = c.count / (W * H);
    const touches = b.minX <= 1 || b.maxX >= W - 2 || b.minY <= 1 || b.maxY >= H - 2;
    if (c.count < Math.max(80, W * H * 0.00045)) continue;
    if (areaFrac > 0.45) continue;
    if (bw < W * 0.06 || bh < H * 0.025) continue;
    let score = 0;
    score += Math.log(c.count + 1) * 1.8;
    score += Math.max(0, 3.6 - Math.abs(Math.log(Math.max(0.25, aspect) / 4.8))) * 7;
    score += (1 - Math.abs(c.cy / H - 0.5)) * 4;
    if (touches) score -= 15;
    if (aspect < 1.4) score -= 8;
    if (bh > H * 0.45) score -= 7;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best || comps.sort((a, b) => b.count - a.count)[0];
}

function pcaAngle(mask, W, H, cx, cy) {
  let sxx = 0, syy = 0, sxy = 0, count = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy; count++;
  }
  if (!count) return 0;
  sxx /= count; syy /= count; sxy /= count;
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

function refineBodyBox(imgData, coarseBox) {
  const { data, width: W, height: H } = imgData;
  const padX = Math.round((coarseBox.maxX - coarseBox.minX + 1) * 0.10);
  const padY = Math.round((coarseBox.maxY - coarseBox.minY + 1) * 0.65);
  const x0 = clamp(coarseBox.minX - padX, 0, W - 1), x1 = clamp(coarseBox.maxX + padX, 0, W - 1);
  const y0 = clamp(coarseBox.minY - padY, 0, H - 1), y1 = clamp(coarseBox.maxY + padY, 0, H - 1);

  const rowScore = [];
  for (let y = y0; y <= y1; y++) {
    let s = 0;
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      if ((hsv[1] > 0.12 && hsv[2] > 0.12) || hsv[2] < 0.28) s++;
    }
    rowScore.push(s);
  }
  const maxS = Math.max(...rowScore, 1);
  let ys = [];
  for (let i = 0; i < rowScore.length; i++) if (rowScore[i] > maxS * 0.24) ys.push(y0 + i);
  const ry0 = ys.length ? percentile(ys, 0.05) : coarseBox.minY;
  const ry1 = ys.length ? percentile(ys, 0.95) : coarseBox.maxY;
  return { minX: x0, maxX: x1, minY: clamp(Math.floor(ry0), 0, H - 1), maxY: clamp(Math.ceil(ry1), 0, H - 1) };
}

function columnSamples(imgData, bbox) {
  const { data, width: W } = imgData;
  const { minX, maxX, minY, maxY } = bbox;
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const yA = minY + Math.floor(bh * 0.18);
  const yB = minY + Math.floor(bh * 0.82);
  const xA = minX + Math.floor(bw * 0.04);
  const xB = maxX - Math.floor(bw * 0.04);
  const xs = [], rgbs = [];
  for (let x = xA; x <= xB; x++) {
    const vals = [];
    for (let y = yA; y <= yB; y++) {
      const rel = (y - minY) / Math.max(1, bh - 1);
      if (rel > 0.44 && rel < 0.56) continue; // avoid horizontal glare line
      const i = (y * W + x) * 4;
      vals.push([data[i], data[i + 1], data[i + 2]]);
    }
    if (vals.length) { xs.push(x); rgbs.push(medianRgb(vals)); }
  }
  return { xs, rgbs };
}

function smoothColors(rgbs, win = 5) {
  const out = [];
  const half = Math.floor(win / 2);
  for (let i = 0; i < rgbs.length; i++) {
    const vals = rgbs.slice(Math.max(0, i - half), Math.min(rgbs.length, i + half + 1));
    out.push(medianRgb(vals));
  }
  return out;
}

function classifyBand(rgb) {
  const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  let candidates = BAND_REFS;
  if (v < 0.20) candidates = BAND_REFS.filter(c => c.id === 'black' || c.id === 'brown');
  else if (s < 0.12) {
    if (v > 0.78) candidates = BAND_REFS.filter(c => c.id === 'white' || c.id === 'silver' || c.id === 'gray');
    else candidates = BAND_REFS.filter(c => c.id === 'gray' || c.id === 'silver' || c.id === 'black');
  }

  let best = null, bestScore = Infinity, second = Infinity;
  for (const ref of candidates) {
    let score = rgbDistance(rgb, ref.rgb);
    if (ref.hue != null && s > 0.12) {
      const dh = Math.min(Math.abs(h - ref.hue), 360 - Math.abs(h - ref.hue));
      score += dh * 1.7;
    }
    if (ref.id === 'gold') score -= (h > 30 && h < 60 && s > 0.20 && v > 0.35) ? 22 : -8;
    if (ref.id === 'brown') score -= (h < 35 || h > 340) && v < 0.55 ? 18 : 0;
    if (score < bestScore) { second = bestScore; bestScore = score; best = ref; }
    else if (score < second) second = score;
  }
  const distScore = clamp((135 - bestScore) / 135, 0, 1);
  const gapScore = clamp((second - bestScore) / 70, 0, 1);
  return { id: best.id, distance: bestScore, confidence: 0.58 * distScore + 0.42 * gapScore };
}

function findBands(imgData, bbox) {
  const { minX, maxX } = bbox;
  const bw = maxX - minX + 1;
  const { xs, rgbs } = columnSamples(imgData, bbox);
  if (xs.length < 10) return [];
  const smooth = smoothColors(rgbs, 5);

  // Estimate body colour from low-gradient, saturated columns, then detect colour-deviation peaks.
  const gradients = smooth.map((rgb, i) => i === 0 ? 0 : rgbDistance(rgb, smooth[i - 1]));
  const stable = smooth.filter((rgb, i) => gradients[i] < percentile(gradients, 0.58));
  const body = medianRgb(stable.length > 8 ? stable : smooth);
  const dists = smooth.map(rgb => {
    const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    return rgbDistance(rgb, body) + (s > 0.20 ? 8 : 0) + (v < 0.24 ? 18 : 0);
  });
  const medD = median(dists);
  const mad = median(dists.map(d => Math.abs(d - medD)));
  const threshold = Math.max(22, medD + 1.45 * Math.max(6, mad));
  const minBandWidth = Math.max(2, Math.floor(bw * 0.008));
  const maxBandWidth = Math.max(8, Math.floor(bw * 0.085));

  const runs = [];
  let i = 0;
  while (i < dists.length) {
    if (dists[i] > threshold) {
      let start = i, peak = dists[i], peakIdx = i;
      while (i < dists.length && dists[i] > threshold * 0.84) {
        if (dists[i] > peak) { peak = dists[i]; peakIdx = i; }
        i++;
      }
      let end = i;
      if (end - start >= minBandWidth) {
        // Wide runs are usually merged neighbouring bands; split around local peaks.
        if (end - start > maxBandWidth) {
          const local = [];
          for (let k = start + 1; k < end - 1; k++) if (dists[k] >= dists[k - 1] && dists[k] >= dists[k + 1] && dists[k] > threshold * 1.05) local.push(k);
          if (local.length > 1) {
            for (const pk of local) {
              const half = Math.max(minBandWidth, Math.floor(maxBandWidth * 0.34));
              runs.push({ start: Math.max(start, pk - half), end: Math.min(end, pk + half + 1), peakIdx: pk });
            }
          } else runs.push({ start, end, peakIdx });
        } else runs.push({ start, end, peakIdx });
      }
    } else i++;
  }

  const merged = [];
  for (const r of runs.sort((a, b) => a.start - b.start)) {
    const prev = merged[merged.length - 1];
    if (prev && r.start - prev.end <= Math.max(1, Math.floor(bw * 0.006))) prev.end = Math.max(prev.end, r.end);
    else merged.push({ ...r });
  }

  const bands = [];
  for (const r of merged) {
    let vals = [];
    for (let k = r.start; k < r.end; k++) vals.push(smooth[k]);
    const rgb = medianRgb(vals);
    const c = classifyBand(rgb);
    const center = (xs[r.start] + xs[r.end - 1]) / 2;
    // Filter out end-cap/shoulder artifacts extremely close to body ends unless they look like tolerance metal.
    const rel = (center - minX) / Math.max(1, bw);
    if ((rel < 0.025 || rel > 0.975) && c.id !== 'gold' && c.id !== 'silver') continue;
    bands.push({ x_start: xs[r.start], x_end: xs[r.end - 1], x_center: center, rgb, ...c });
  }

  // Keep the most plausible 3-6 bands: strongest, spatially distinct, left-to-right.
  const distinct = [];
  for (const b of bands.sort((a, b) => (b.confidence + b.distance / 1000) - (a.confidence + a.distance / 1000))) {
    if (!distinct.some(d => Math.abs(d.x_center - b.x_center) < bw * 0.035)) distinct.push(b);
  }
  return distinct.sort((a, b) => a.x_center - b.x_center).slice(0, 6);
}

function pickBandCount(bands) {
  if (bands.length <= 4) return { mode: 4, bands: bands.slice(0, Math.min(4, bands.length)) };
  if (bands.length >= 5) return { mode: 5, bands: bands.slice(0, 5) };
  return { mode: 4, bands };
}

function pickReadingDirection(bands, mode) {
  if (bands.length < mode) return { picks: bands.map(b => b.id), bandsWithConf: bands, reason: 'Too few bands detected' };
  const f = bands.slice(0, mode);
  const r = [...f].reverse();
  const fTol = TOL_COLORS.has(f[f.length - 1].id);
  const rTol = TOL_COLORS.has(r[r.length - 1].id);
  if (fTol && !rTol) return { picks: f.map(b => b.id), bandsWithConf: f, reason: 'Reading direction: left to right' };
  if (rTol && !fTol) return { picks: r.map(b => b.id), bandsWithConf: r, reason: 'Reading direction: right to left' };

  // Prefer the orientation where the tolerance band is more isolated from the significant bands.
  const fGap = f.length > 1 ? f[f.length - 1].x_center - f[f.length - 2].x_center : 0;
  const rGap = r.length > 1 ? r[r.length - 1].x_center - r[r.length - 2].x_center : 0;
  const chosen = rGap > fGap * 1.18 ? r : f;
  return { picks: chosen.map(b => b.id), bandsWithConf: chosen, reason: 'Reading direction: inferred from spacing' };
}

function buildDebugCanvas(imgData, bbox, bands) {
  const { minX, maxX, minY, maxY } = bbox;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const margin = Math.floor(Math.min(w, h) * 0.35);
  const cx0 = clamp(minX - margin, 0, imgData.width - 1);
  const cy0 = clamp(minY - margin, 0, imgData.height - 1);
  const cx1 = clamp(maxX + margin, 0, imgData.width - 1);
  const cy1 = clamp(maxY + margin, 0, imgData.height - 1);
  const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
  const src = imageDataToCanvas(imgData);
  const debug = document.createElement('canvas');
  debug.width = cw; debug.height = ch;
  const ctx = debug.getContext('2d');
  ctx.drawImage(src, cx0, cy0, cw, ch, 0, 0, cw, ch);
  ctx.strokeStyle = 'rgba(0, 120, 255, 0.9)'; ctx.lineWidth = 2;
  ctx.strokeRect(minX - cx0, minY - cy0, w, h);
  for (const b of bands) {
    ctx.strokeStyle = b.confidence < 0.40 ? 'rgba(255, 185, 0, 0.98)' : 'rgba(255, 0, 0, 0.96)';
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x_start - cx0, minY - cy0, Math.max(2, b.x_end - b.x_start + 1), h);
  }
  return debug;
}

async function detectResistor(imageData) {
  const work = downscaleIfNeeded(imageData, 900);
  let mask = computeObjectMask(work);
  mask = close(mask, work.width, work.height, 3);
  mask = dilate(mask, work.width, work.height, 1);
  let cc = chooseBestComponent(work, mask);
  if (!cc || cc.count < 120) {
    return { success: false, reason: "Couldn't find a resistor-like object. Put the resistor inside the guide and keep the background simple.", debugImage: imageDataToCanvas(work) };
  }

  const angleRad = pcaAngle(cc.mask, work.width, work.height, cc.cx, cc.cy);
  let angleDeg = clamp(angleRad * 180 / Math.PI, -25, 25);
  const bgRgb = sampleBorderRgb(work);
  let rotated = rotateImageData(work, angleDeg, bgRgb);
  mask = computeObjectMask(rotated);
  mask = close(mask, rotated.width, rotated.height, 3);
  mask = dilate(mask, rotated.width, rotated.height, 1);
  cc = chooseBestComponent(rotated, mask);
  if (!cc) {
    return { success: false, reason: 'Detection failed after alignment.', debugImage: imageDataToCanvas(rotated) };
  }

  let bbox = refineBodyBox(rotated, cc.bounds);
  if ((bbox.maxY - bbox.minY) > (bbox.maxX - bbox.minX)) {
    rotated = rotateImageData(rotated, 90, bgRgb);
    mask = computeObjectMask(rotated);
    mask = close(mask, rotated.width, rotated.height, 3);
    cc = chooseBestComponent(rotated, mask);
    if (cc) bbox = refineBodyBox(rotated, cc.bounds);
  }

  const bands = findBands(rotated, bbox);
  const debugImage = buildDebugCanvas(rotated, bbox, bands);

  if (bands.length < 3) {
    return { success: false, reason: `Only ${bands.length} band${bands.length === 1 ? '' : 's'} detected. Try more even light, less glare, or crop closer to the resistor.`, debugImage, bands };
  }

  const counted = pickBandCount(bands);
  const decision = pickReadingDirection(counted.bands, counted.mode);
  const computation = (window.ResistorEngine && window.ResistorEngine.computeOhmsFromPicks)
    ? window.ResistorEngine.computeOhmsFromPicks(decision.picks, counted.mode)
    : null;

  return {
    success: true,
    mode: counted.mode,
    picks: decision.picks,
    bands: decision.bandsWithConf.map(b => ({ colorId: b.id, confidence: b.confidence, rgb: b.rgb })),
    ohms: computation ? computation.ohms : null,
    tol: computation ? computation.tol : null,
    reasoning: decision.reason,
    debugImage,
  };
}

window.ResistorCV = { detectResistor };
