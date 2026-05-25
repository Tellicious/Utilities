/* =========================================================
   Resistor sub-app — picker, renderer, value engine
   ========================================================= */

// -------------------- COLOR MODEL --------------------

/**
 * Each band color has:
 *  - id, name, hex
 *  - digit: 0-9 or null (used in digit bands)
 *  - mult: numeric multiplier or null
 *  - tol: tolerance percent or null
 *  - darkText: should label text be dark? (visual contrast)
 */
const COLORS = [
  { id: 'black',  name: 'Black',  hex: '#1a1a1a', digit: 0, mult: 1,         tol: null,  darkText: false },
  { id: 'brown',  name: 'Brown',  hex: '#7a4a25', digit: 1, mult: 10,        tol: 1,     darkText: false },
  { id: 'red',    name: 'Red',    hex: '#d63a3a', digit: 2, mult: 100,       tol: 2,     darkText: false },
  { id: 'orange', name: 'Orange', hex: '#e89146', digit: 3, mult: 1e3,       tol: null,  darkText: true  },
  { id: 'yellow', name: 'Yellow', hex: '#f7e36b', digit: 4, mult: 1e4,       tol: null,  darkText: true  },
  { id: 'green',  name: 'Green',  hex: '#7bcf7e', digit: 5, mult: 1e5,       tol: 0.5,   darkText: true  },
  { id: 'blue',   name: 'Blue',   hex: '#4f7fd6', digit: 6, mult: 1e6,       tol: 0.25,  darkText: false },
  { id: 'violet', name: 'Violet', hex: '#cf8ad8', digit: 7, mult: 1e7,       tol: 0.10,  darkText: true  },
  { id: 'gray',   name: 'Gray',   hex: '#888685', digit: 8, mult: null,      tol: 0.05,  darkText: false },
  { id: 'white',  name: 'White',  hex: '#ffffff', digit: 9, mult: null,      tol: null,  darkText: true  },
  { id: 'gold',   name: 'Gold',   hex: '#c89143', digit: null, mult: 0.1,    tol: 5,     darkText: true  },
  { id: 'silver', name: 'Silver', hex: '#b8b8b8', digit: null, mult: 0.01,   tol: 10,    darkText: true  },
];

const COLOR_BY_ID = Object.fromEntries(COLORS.map(c => [c.id, c]));

// Which colors are valid in each band slot
const VALID = {
  digit:      COLORS.filter(c => c.digit !== null).map(c => c.id),
  multiplier: COLORS.filter(c => c.mult !== null).map(c => c.id),
  tolerance:  COLORS.filter(c => c.tol !== null).map(c => c.id),
};

// Common standard E-series values (E24) for "nearest standard" hint
const E24 = [10,11,12,13,15,16,18,20,22,24,27,30,33,36,39,43,47,51,56,62,68,75,82,91];

// -------------------- STATE --------------------

const state = {
  mode: 4,                 // 4 or 5
  // For 4-band: [d1, d2, mult, tol]
  // For 5-band: [d1, d2, d3, mult, tol]
  picks4: ['brown', 'black', 'red', 'gold'],     // default: 1k 5%
  picks5: ['brown', 'black', 'black', 'brown', 'brown'], // 100 x10 = 1k 1%
};

function currentPicks() {
  return state.mode === 4 ? state.picks4 : state.picks5;
}
function setCurrentPicks(arr) {
  if (state.mode === 4) state.picks4 = arr; else state.picks5 = arr;
}

// Slot kinds for each mode
function slotKinds() {
  return state.mode === 4
    ? ['digit', 'digit', 'multiplier', 'tolerance']
    : ['digit', 'digit', 'digit', 'multiplier', 'tolerance'];
}
function slotHeaders() {
  return state.mode === 4
    ? ['Band 1', 'Band 2', 'Mul.', 'Tol.']
    : ['Band 1', 'Band 2', 'Band 3', 'Mul.', 'Tol.'];
}

// -------------------- VALUE COMPUTATION --------------------

function computeOhms() {
  const picks = currentPicks();
  const kinds = slotKinds();
  let digits = '';
  let mult = 1;
  let tol = 20; // unmarked tolerance default

  for (let i = 0; i < picks.length; i++) {
    const c = COLOR_BY_ID[picks[i]];
    if (!c) return null;
    const k = kinds[i];
    if (k === 'digit') {
      if (c.digit === null) return null;
      digits += String(c.digit);
    } else if (k === 'multiplier') {
      if (c.mult === null) return null;
      mult = c.mult;
    } else if (k === 'tolerance') {
      if (c.tol !== null) tol = c.tol;
    }
  }

  const base = parseInt(digits, 10);
  if (isNaN(base)) return null;
  return { ohms: base * mult, tol, base, mult };
}

function formatOhms(ohms) {
  if (ohms === null || ohms === undefined || isNaN(ohms)) return '—';
  if (ohms === 0) return '0 Ω';

  const abs = Math.abs(ohms);
  let value, unit;
  if (abs >= 1e9)      { value = ohms / 1e9; unit = 'GΩ'; }
  else if (abs >= 1e6) { value = ohms / 1e6; unit = 'MΩ'; }
  else if (abs >= 1e3) { value = ohms / 1e3; unit = 'kΩ'; }
  else                 { value = ohms;       unit = 'Ω';  }

  // Trim trailing zeros but keep up to 3 sig figs after decimal
  let str;
  if (Number.isInteger(value)) str = String(value);
  else str = parseFloat(value.toPrecision(3)).toString();

  return `${str} ${unit}`;
}

function formatRange(ohms, tolPct) {
  const lo = ohms * (1 - tolPct / 100);
  const hi = ohms * (1 + tolPct / 100);
  return `${formatOhms(lo)} – ${formatOhms(hi)}`;
}

function nearestE24(ohms) {
  if (!ohms || ohms <= 0) return null;
  // Reduce to two significant digits
  const exp = Math.floor(Math.log10(ohms));
  const norm = ohms / Math.pow(10, exp - 1); // value in [10, 100)
  let best = E24[0]; let bestDiff = Infinity;
  for (const v of E24) {
    const d = Math.abs(Math.log(v) - Math.log(norm));
    if (d < bestDiff) { bestDiff = d; best = v; }
  }
  const standard = best * Math.pow(10, exp - 1);
  const pctDiff = Math.abs((standard - ohms) / ohms) * 100;
  return { standard, exact: pctDiff < 0.5 };
}

// -------------------- SVG RENDERER --------------------

/**
 * Render the resistor as flat SVG.
 *
 * The body silhouette path is taken VERBATIM from the user-supplied
 * resistor.svg (Inkscape). We keep its original coordinate system
 * (viewBox 2160×1080, with the same transforms) so the path renders
 * identically to the reference. On top of that, we:
 *   - parameterize the body fill colour (beige for 4-band, blue for 5-band)
 *   - draw the lead bar in mid-grey across the full width
 *   - place coloured bands at known x positions inside the body
 */
function renderResistorSVG(bandIds, mode) {
  // Body silhouette path, verbatim from resistor.svg. Do not modify.
  const BODY_PATH = "m 798.5625,1308.5625 c -21.47944,0 -37.32619,4.0094 -49.46875,10.5625 -0.0526,0.028 -0.10377,0.065 -0.15625,0.094 -18.04664,8.9915 -27.35769,22.7119 -33.90625,37.4374 -14.51122,27.7533 -22.11341,59.0945 -55.8125,69.0938 -1.31397,0.3899 -2.62206,0.7469 -3.9375,1.125 l 0,46.2188 c 1.31639,0.3788 2.62251,0.766 3.9375,1.1562 64.74738,19.2121 12.93753,117.1875 139.34375,117.1875 0.73556,0 1.52761,-0.033 2.3125,-0.062 1.42733,0.029 2.86724,0.062 4.34375,0.062 30.2139,0 103.1066,-25.625 131.1875,-25.625 l 185.24995,0 c 28.081,0 100.9736,25.625 131.1876,25.625 1.4764,0 2.9164,-0.034 4.3437,-0.062 0.7849,0.03 1.5769,0.062 2.3125,0.062 126.4062,0 74.5964,-97.9754 139.3438,-117.1875 1.3149,-0.3902 2.6211,-0.7774 3.9374,-1.1562 l 0,-46.2188 c -1.3154,-0.3781 -2.6235,-0.7351 -3.9374,-1.125 -33.6993,-9.9993 -41.3013,-41.3405 -55.8126,-69.0938 -6.5485,-14.7255 -15.8596,-28.4459 -33.9062,-37.4374 -0.053,-0.029 -0.1037,-0.065 -0.1562,-0.094 -12.1426,-6.5531 -27.9894,-10.5625 -49.4688,-10.5625 -0.7233,0 -1.4833,0.034 -2.25,0.062 -1.4474,-0.029 -2.9088,-0.062 -4.4062,-0.062 -30.214,0 -103.1066,25.625 -131.1876,25.625 l -185.24995,0 c -28.0809,0 -100.9736,-25.625 -131.1875,-25.625 -1.49753,0 -2.95885,0.034 -4.40625,0.062 -0.76674,-0.029 -1.52669,-0.062 -2.25,-0.062 z";

  // Geometry in the SVG's native coordinate system (from resistor.svg).
  // After the transforms, body occupies viewBox y ≈ 228..508 (height 280).
  // BAND_Y / BAND_H must span this range so the clip-path can crop bands
  // to the body silhouette and produce full-height bands across the body.
  const BODY_CX = 1027.5;
  const BAND_W = 68;
  const BAND_Y = 220;    // start a bit above body top
  const BAND_H = 296;    // extend a bit past body bottom (covers y=220..516)

  // Body fill colour: beige for 4-band carbon-film, light-blue for 5-band metal-film.
  const bodyFill = mode === 5 ? '#aedaef' : '#d9bb7a';
  const bodyStroke = mode === 5 ? '#4f7080' : '#565248';

  // Band positions (offsets from BODY_CX). Mirrors the original SVG's spacing
  // for 4-band: bands 1-3 evenly spaced, then a gap, then the tolerance band.
  // For 5-band: 4 evenly spaced, then a gap, then the tolerance band.
  const nBands = mode === 5 ? 5 : 4;
  let centers;
  if (nBands === 4) {
    // 4-band: bands at offsets -208.5, -93.5, +18.5, then +234.5 (tolerance)
    centers = [-208.5, -93.5, 18.5, 234.5];
  } else {
    // 5-band: 4 digit/multiplier bands evenly spaced + tolerance offset
    centers = [-208.5, -113.5, -18.5, 76.5, 234.5];
  }

  // Lead bar (from original SVG): y=318.11612 to y=366.6, full width
  // We extend it to a wider viewBox so leads protrude on both sides.

  // ---- ViewBox: tight crop around the resistor ----
  // Body x range in viewBox coords: roughly 660..1395 (width 735)
  // Lead y range: 318..366
  // Body y range: 228..512 (after the layer transform)
  // Pick a viewBox that gives some lead margin on each side.
  const VB_X = 500;
  const VB_Y = 200;
  const VB_W = 1150;
  const VB_H = 330;

  // Bands clip path: full body silhouette so bands match exactly.
  // Use a single combined transform on the clipping path so renderers don't
  // get confused by nested <g> transforms inside clipPath elements.
  let svg = `<svg viewBox="${VB_X} ${VB_Y} ${VB_W} ${VB_H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Resistor with bands">`;
  svg += `<defs>`;
  svg += `<clipPath id="bodyClip" clipPathUnits="userSpaceOnUse">`;
  // Combined transform: translate(0,27.6403) then translate(0,-1107.6403) = translate(0,-1080)
  svg += `<path transform="translate(0,-1080)" d="${BODY_PATH}"/>`;
  svg += `</clipPath>`;
  svg += `</defs>`;

  // Lead bar (mid grey, full width)
  svg += `<rect y="345.7564" x="-200" height="48.487324" width="2500" fill="#808080"/>`;

  // Body silhouette (same combined transform as the clipPath)
  svg += `<path transform="translate(0,-1080)" d="${BODY_PATH}" fill="${bodyFill}" stroke="${bodyStroke}" stroke-width="2"/>`;

  // Bands — drawn at absolute viewBox coords (no nested transforms).
  // Body silhouette occupies viewBox y ≈ 228..508 after transforms.
  // Bands need to extend that full range to be clipped properly.
  svg += `<g clip-path="url(#bodyClip)">`;
  for (let i = 0; i < nBands; i++) {
    const id = bandIds[i];
    if (!id) continue;
    const c = COLOR_BY_ID[id];
    if (!c) continue;
    const cx = BODY_CX + centers[i];
    const bx = cx - BAND_W / 2;
    const strokeAttr = (id === 'white') ? ' stroke="#cccccc" stroke-width="1"' : '';
    svg += `<rect x="${bx}" y="${BAND_Y}" width="${BAND_W}" height="${BAND_H}" fill="${c.hex}"${strokeAttr}/>`;
  }
  svg += `</g>`;

  svg += `</svg>`;
  return svg;
}

// -------------------- DOM ELEMENTS --------------------

const els = {
  render:      document.getElementById('resistorRender'),
  resultValue: document.getElementById('resultValue'),
  resultMeta:  document.getElementById('resultMeta'),
  columns:     document.getElementById('pickerColumns'),
  modeBtns:    document.querySelectorAll('.appbar .seg__btn'),
  reverseIn:   document.getElementById('reverseInput'),
  reverseGo:   document.getElementById('reverseGo'),
  reverseHint: document.getElementById('reverseHint'),
  appbar:      document.getElementById('appbar'),
  openLookup:  document.getElementById('openLookup'),
  sheet:       document.getElementById('lookupSheet'),
};

// -------------------- COLUMNS RENDERING --------------------

function renderColumns() {
  const kinds = slotKinds();
  const heads = slotHeaders();
  const picks = currentPicks();

  // Set grid columns dynamically
  els.columns.style.gridTemplateColumns = `repeat(${kinds.length}, 1fr)`;

  els.columns.innerHTML = '';

  kinds.forEach((kind, slotIdx) => {
    const col = document.createElement('div');
    col.className = 'col';

    const head = document.createElement('div');
    head.className = 'col__head';
    head.textContent = heads[slotIdx];
    col.appendChild(head);

    // Cells wrapper: flex-grows to fill column, distributes swatches evenly
    const cells = document.createElement('div');
    cells.className = 'col__cells';

    // Render every color row in the same order across columns,
    // disabling invalid ones (rather than hiding) — keeps alignment.
    COLORS.forEach(c => {
      const allowed = VALID[kind].includes(c.id);
      const sw = document.createElement('button');
      sw.className = 'swatch ' + (c.darkText ? 'swatch--dark-text' : 'swatch--light-text');
      sw.style.background = c.hex;
      sw.dataset.colorId = c.id;
      sw.dataset.slot = slotIdx;

      // Label content depends on column type
      let label = '';
      if (kind === 'digit')           label = c.digit !== null ? String(c.digit) : '';
      else if (kind === 'multiplier') label = c.mult !== null ? formatMultiplierLabel(c.mult) : '';
      else if (kind === 'tolerance')  label = c.tol !== null ? `±${c.tol}%` : '';

      sw.innerHTML = `<span class="swatch__label">${label}</span>`;

      if (!allowed) {
        sw.classList.add('swatch--disabled');
        sw.setAttribute('aria-hidden', 'true');
        sw.tabIndex = -1;
      } else {
        // White swatch needs a subtle border so it's not invisible
        if (c.id === 'white') sw.style.border = '1px solid var(--border-strong)';
        if (picks[slotIdx] === c.id) sw.classList.add('swatch--selected');
        sw.addEventListener('click', () => onSwatchClick(slotIdx, c.id));
      }
      cells.appendChild(sw);
    });

    col.appendChild(cells);
    els.columns.appendChild(col);
  });
}

function formatMultiplierLabel(m) {
  if (m === 0.01) return '×0.01';
  if (m === 0.1)  return '×0.1';
  if (m < 1000)   return `×${m}`;
  if (m < 1e6)    return `×${m/1e3}k`;
  if (m < 1e9)    return `×${m/1e6}M`;
  return `×${m/1e9}G`;
}

function onSwatchClick(slotIdx, colorId) {
  const picks = currentPicks().slice();
  picks[slotIdx] = colorId;
  setCurrentPicks(picks);
  renderAll();
  haptic();
}

// Tiny haptic for iOS (some Safari versions ignore it but it's harmless)
function haptic() {
  if (navigator.vibrate) try { navigator.vibrate(8); } catch (_) {}
}

// -------------------- TOP-LEVEL RENDER --------------------

function renderAll() {
  const picks = currentPicks();
  els.render.innerHTML = renderResistorSVG(picks, state.mode);

  const r = computeOhms();
  if (!r) {
    els.resultValue.textContent = '—';
    els.resultMeta.textContent = 'Pick a colour for every band';
  } else {
    els.resultValue.textContent = `${formatOhms(r.ohms)}  ± ${r.tol}%`;
    const range = formatRange(r.ohms, r.tol);
    const e = nearestE24(r.ohms);
    let meta = `Range: ${range}`;
    if (e) {
      if (e.exact) meta += `  ·  E24 standard ✓`;
      else meta += `  ·  Nearest E24: ${formatOhms(e.standard)}`;
    }
    els.resultMeta.innerHTML = meta;
  }

  renderColumns();
}

// -------------------- MODE TOGGLE --------------------

els.modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const b = Number(btn.dataset.bands);
    if (b === state.mode) return;
    state.mode = b;
    els.modeBtns.forEach(x => {
      const active = Number(x.dataset.bands) === state.mode;
      x.classList.toggle('seg__btn--active', active);
      x.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderAll();
    haptic();
  });
});

// -------------------- REVERSE LOOKUP --------------------

/**
 * Parse strings like:
 *   "4.7k", "4k7", "470", "1M", "2.2 MΩ", "10R", "100"
 */
function parseResistance(input) {
  if (!input) return null;
  let s = input.trim().toLowerCase().replace(/\s+/g, '').replace(/ω/g, '').replace(/ohms?/g, '');

  // Handle "4k7" / "4r7" style (digit-multiplier-digit)
  const mid = s.match(/^(\d+)([rkmg])(\d+)$/);
  if (mid) {
    const [, a, suffix, b] = mid;
    const combined = `${a}.${b}`;
    return scaleBySuffix(parseFloat(combined), suffix);
  }

  // Handle "4.7k" / "470" / "1m"
  const m = s.match(/^(\d*\.?\d+)([rkmg])?$/);
  if (m) {
    const [, num, suffix] = m;
    return scaleBySuffix(parseFloat(num), suffix);
  }

  return null;
}
function scaleBySuffix(n, suffix) {
  if (!suffix || suffix === 'r') return n;
  if (suffix === 'k') return n * 1e3;
  if (suffix === 'm') return n * 1e6;
  if (suffix === 'g') return n * 1e9;
  return n;
}

/**
 * Given a value, find the band combination that represents it.
 * Tries the current mode first; falls back to the other mode if exact match unavailable.
 */
function bandsForValue(value, mode) {
  if (!value || value <= 0) return null;

  // Number of significant digits
  const nDigits = mode === 5 ? 3 : 2;

  // Convert value to "digits + exponent" form
  // e.g., 4700 with 2 digits => digits=47, exponent=2 (mult=100)
  //       4700 with 3 digits => digits=470, exponent=1 (mult=10)
  // We need digits to be exactly nDigits long.
  const exp = Math.floor(Math.log10(value)) - (nDigits - 1);
  const digits = Math.round(value / Math.pow(10, exp));
  const mult = Math.pow(10, exp);

  // Reconstructed value with rounding
  const reconstructed = digits * mult;
  const exact = Math.abs(reconstructed - value) / value < 0.001;

  // Validate multiplier is in our list
  const multColor = COLORS.find(c => c.mult !== null && Math.abs(c.mult - mult) / Math.max(c.mult, mult) < 1e-9);
  if (!multColor) return null;

  // Validate digits fit
  const digitStr = String(digits).padStart(nDigits, '0');
  if (digitStr.length !== nDigits) return null;

  const digitColors = [];
  for (const ch of digitStr) {
    const c = COLORS.find(x => x.digit === Number(ch));
    if (!c) return null;
    digitColors.push(c.id);
  }

  // Default tolerance: gold (5%) — most common, also the original picks
  return {
    picks: [...digitColors, multColor.id, 'gold'],
    exact
  };
}

function doReverseLookup() {
  const value = parseResistance(els.reverseIn.value);
  if (value === null) {
    els.reverseHint.innerHTML = `<span class="bad">Couldn't parse that.</span> Try <code>4.7k</code>, <code>220</code>, <code>1M</code>, or <code>4k7</code>.`;
    return;
  }
  const result = bandsForValue(value, state.mode);
  if (!result) {
    els.reverseHint.innerHTML = `Can't represent <strong>${formatOhms(value)}</strong> with ${state.mode}-band colours. Try switching modes.`;
    return;
  }
  setCurrentPicks(result.picks);
  renderAll();
  els.reverseHint.innerHTML = result.exact
    ? `<span class="ok">✓ Showing colours for <strong>${formatOhms(value)}</strong>.</span>`
    : `<span class="ok">✓ Showing colours for nearest representable value.</span>`;
  // Auto-close after a short delay so the user sees the confirmation
  setTimeout(closeLookup, 650);
}

els.reverseGo.addEventListener('click', doReverseLookup);
els.reverseIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doReverseLookup(); });

// -------------------- LOOKUP MODAL --------------------

function openLookup() {
  els.sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  // Reset hint to default and focus the input on next frame so animation plays first
  els.reverseHint.innerHTML = `Accepts forms like <code>4.7k</code>, <code>4k7</code>, <code>220</code>, <code>1M</code>.`;
  requestAnimationFrame(() => {
    els.reverseIn.focus();
    els.reverseIn.select();
  });
}

function closeLookup() {
  els.sheet.hidden = true;
  document.body.style.overflow = '';
}

els.openLookup.addEventListener('click', openLookup);

// Close on scrim, × button, or any element marked data-close
els.sheet.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', closeLookup);
});

// Close on Escape
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.sheet.hidden) closeLookup();
});

// -------------------- VIEW SWITCHING (tab bar) --------------------

const tabBtns = document.querySelectorAll('.tabbar__btn');
const views = {
  picker: document.getElementById('view-picker'),
  camera: document.getElementById('view-camera'),
};

function switchView(name) {
  Object.entries(views).forEach(([k, el]) => el.dataset.active = (k === name) ? 'true' : 'false');
  tabBtns.forEach(b => {
    const on = b.dataset.view === name;
    b.classList.toggle('tabbar__btn--active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  // Hide picker-only controls (Bands toggle + Lookup icon) when on camera tab.
  const showPickerControls = (name === 'picker');
  document.querySelectorAll('.appbar__cluster .picker-only').forEach(el => {
    el.hidden = !showPickerControls;
  });

  // Notify camera module
  if (name === 'camera') window.dispatchEvent(new CustomEvent('camera:enter'));
  else window.dispatchEvent(new CustomEvent('camera:leave'));
}

tabBtns.forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

// Expose to camera module: apply detected bands and switch to picker
window.applyDetectedBands = function(picks, mode) {
  state.mode = mode;
  els.modeBtns.forEach(x => {
    const active = Number(x.dataset.bands) === mode;
    x.classList.toggle('seg__btn--active', active);
    x.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  setCurrentPicks(picks);
  renderAll();
  switchView('picker');
};

// Expose helpers for camera module
window.ResistorEngine = {
  COLORS,
  COLOR_BY_ID,
  renderResistorSVG,
  computeOhmsFromPicks(picks, mode) {
    // Temp state swap to reuse computeOhms — cleaner: do inline
    const kinds = mode === 4
      ? ['digit', 'digit', 'multiplier', 'tolerance']
      : ['digit', 'digit', 'digit', 'multiplier', 'tolerance'];
    let digits = ''; let mult = 1; let tol = 20;
    for (let i = 0; i < picks.length; i++) {
      const c = COLOR_BY_ID[picks[i]];
      if (!c) return null;
      const k = kinds[i];
      if (k === 'digit') {
        if (c.digit === null) return null;
        digits += String(c.digit);
      } else if (k === 'multiplier') {
        if (c.mult === null) return null;
        mult = c.mult;
      } else if (k === 'tolerance') {
        if (c.tol !== null) tol = c.tol;
      }
    }
    const base = parseInt(digits, 10);
    if (isNaN(base)) return null;
    return { ohms: base * mult, tol };
  },
  formatOhms,
  nearestE24,
};

// -------------------- APP BAR SCROLL BORDER --------------------
window.addEventListener('scroll', () => {
  els.appbar.classList.toggle('appbar--scrolled', window.scrollY > 4);
}, { passive: true });

// -------------------- BOOT --------------------
renderAll();
