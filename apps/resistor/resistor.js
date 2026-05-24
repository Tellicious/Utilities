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
 * Body shape: classic axial pill with leads on each side.
 * Bands are evenly spaced; tolerance band is offset further to the right
 * to convey reading direction (matches real resistors).
 */
function renderResistorSVG(bandIds, mode) {
  const W = 460, H = 140;
  const cy = H / 2;

  // Body geometry — pill shape with subtle "shoulders"
  const bodyX = 80, bodyY = 36, bodyW = 300, bodyH = 68;

  // Build body path: rounded pill with slight bulge ends
  const r = 14;
  const bodyColor = mode === 5 ? '#aedaef' : '#ead9a8'; // metal-film blue vs carbon beige

  // Compute band positions
  // 4-band: 4 bands; positions: d1, d2, mult cluster on left, tolerance offset to right
  // 5-band: similar with extra digit
  const nBands = mode === 5 ? 5 : 4;
  const bandW = 22;
  // Left group: first (nBands - 1) bands evenly spaced over left ~60% of body
  // Tolerance band placed in the right ~25% of the body
  const leftGroupStart = bodyX + 26;
  const leftGroupEnd   = bodyX + bodyW * 0.62;
  const tolX = bodyX + bodyW - 50;

  const leftCount = nBands - 1;
  const leftStep = (leftGroupEnd - leftGroupStart) / Math.max(1, leftCount - 1);
  const positions = [];
  for (let i = 0; i < leftCount; i++) {
    positions.push(leftGroupStart + i * leftStep);
  }
  positions.push(tolX);

  // Build SVG
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Resistor with bands">`;

  // Leads
  svg += `<line x1="0" y1="${cy}" x2="${bodyX + 8}" y2="${cy}" stroke="#a8a8a3" stroke-width="3.5" stroke-linecap="round"/>`;
  svg += `<line x1="${bodyX + bodyW - 8}" y1="${cy}" x2="${W}" y2="${cy}" stroke="#a8a8a3" stroke-width="3.5" stroke-linecap="round"/>`;

  // Body
  svg += `<rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="${r}" ry="${r}" fill="${bodyColor}"/>`;
  // Subtle shoulders (slight dark edges at tips)
  svg += `<rect x="${bodyX}" y="${bodyY}" width="14" height="${bodyH}" rx="${r}" ry="${r}" fill="rgba(0,0,0,0.06)"/>`;
  svg += `<rect x="${bodyX + bodyW - 14}" y="${bodyY}" width="14" height="${bodyH}" rx="${r}" ry="${r}" fill="rgba(0,0,0,0.06)"/>`;

  // Bands — clipped to body
  svg += `<defs><clipPath id="bodyClip"><rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="${r}" ry="${r}"/></clipPath></defs>`;
  svg += `<g clip-path="url(#bodyClip)">`;
  for (let i = 0; i < nBands; i++) {
    const id = bandIds[i];
    if (!id) continue;
    const c = COLOR_BY_ID[id];
    if (!c) continue;
    const x = positions[i] - bandW / 2;
    // White band gets a faint outline so it's visible
    const stroke = (id === 'white') ? ' stroke="#dcdcd6" stroke-width="0.5"' : '';
    svg += `<rect x="${x}" y="${bodyY}" width="${bandW}" height="${bodyH}" fill="${c.hex}"${stroke}/>`;
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
  modeBtns:    document.querySelectorAll('.picker__modes .seg__btn'),
  reverseIn:   document.getElementById('reverseInput'),
  reverseGo:   document.getElementById('reverseGo'),
  reverseHint: document.getElementById('reverseHint'),
  appbar:      document.getElementById('appbar'),
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
      else if (kind === 'tolerance')  label = c.tol !== null ? `± ${c.tol}%` : '';

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
      col.appendChild(sw);
    });

    els.columns.appendChild(col);
  });
}

function formatMultiplierLabel(m) {
  if (m === 0.01) return '0.01';
  if (m === 0.1)  return '0.1';
  if (m < 1000)   return `${m}Ω`;
  if (m < 1e6)    return `${m/1e3}kΩ`;
  if (m < 1e9)    return `${m/1e6}MΩ`;
  return `${m/1e9}GΩ`;
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
    els.reverseHint.textContent = "Couldn't parse that. Try forms like 4.7k, 220, 1M, 4k7.";
    els.reverseHint.style.color = '';
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
    ? `Showing colours for <strong>${formatOhms(value)}</strong>.`
    : `Showing colours for the nearest representable value.`;
}

els.reverseGo.addEventListener('click', doReverseLookup);
els.reverseIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doReverseLookup(); });

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
