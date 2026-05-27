(() => {
    'use strict';
    let kind = 'r', conn = 's';
    const $ = id => document.getElementById(id);
    const R_UNITS = [['MΩ', 1e6], ['kΩ', 1e3], ['Ω', 1], ['mΩ', 1e-3]];
    const C_UNITS = [['F', 1], ['mF', 1e-3], ['nF', 1e-9], ['µF', 1e-6], ['pF', 1e-12]];
    function parseInputString(raw) { if (raw == null) return NaN; let s = String(raw).trim(); if (!s) return NaN; s = s.replace(/\u2009|\u200A|\s/g, ''); const hasComma = s.indexOf(',') !== -1; const hasDot = s.indexOf('.') !== -1; if (hasComma && hasDot) { s = s.replace(/\./g, ''); s = s.replace(',', '.'); } else if (hasComma) { s = s.replace(',', '.'); } else { const dots = (s.match(/\./g) || []).length; if (dots > 1) { const idx = s.lastIndexOf('.'); s = s.slice(0, idx).replace(/\./g, '') + s.slice(idx); } } const nRaw = Number(s); return Number.isNaN(nRaw) ? NaN : nRaw; }
    function n(i) { const raw = parseInputString($('v' + i).value); if (!(raw > 0)) return null; const sel = $('unit' + i); return raw * Number(sel.value || 1) }
    function formatNumber(value, precision = 4) { if (!isFinite(value)) return '—'; const text = Number(value.toPrecision(precision)).toString(); const [integer, fraction] = text.split('.'); const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return fraction ? `${grouped},${fraction}` : grouped; }

    function formatInput(el, precision = 4) { const v = parseInputString(el.value); if (Number.isNaN(v)) return; el.value = formatNumber(v, precision); }
    function unformatInput(el) { el.value = String(el.value).replace(/\u2009|\u200A|\s/g, '').replace(/\./g, '').replace(',', '.'); }
    function eng(v, u) { if (!isFinite(v)) return '—'; if (v === 0) return '0 ' + u; const a = Math.abs(v), ps = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']]; for (const [m, p] of ps) { if (a >= m) return `${formatNumber(v / m, 4)} ${p}${u}` } return `${formatNumber(v, 4)} ${u}` }
    function fillUnits() { const opts = kind === 'r' ? R_UNITS : C_UNITS; for (let i = 1; i <= 4; i++) { const sel = $('unit' + i); const old = sel.value; sel.innerHTML = opts.map(([label, m]) => `<option value="${m}">${label}</option>`).join(''); const def = kind === 'r' ? 1 : 1e-6; sel.value = opts.some(([, m]) => String(m) === old) ? old : String(def); } }
    function setSeg() { ['res', 'cap'].forEach(id => $(id).classList.toggle('seg__btn--active', (id === 'res') === (kind === 'r')));['series', 'parallel'].forEach(id => $(id).classList.toggle('seg__btn--active', (id === 'series') === (conn === 's'))); fillUnits(); render() }
    function render() { const vals = [1, 2, 3, 4].map(n).filter(Boolean), out = $('spValue'), meta = $('spMeta'), unit = kind === 'r' ? 'Ω' : 'F'; if (!vals.length) { out.textContent = '—'; meta.textContent = 'Enter up to four positive values.'; return } let eq; if (kind === 'r') eq = conn === 's' ? vals.reduce((a, b) => a + b, 0) : 1 / vals.reduce((a, b) => a + 1 / b, 0); else eq = conn === 's' ? 1 / vals.reduce((a, b) => a + 1 / b, 0) : vals.reduce((a, b) => a + b, 0); out.textContent = eng(eq, unit); meta.textContent = `${kind === 'r' ? 'Resistors' : 'Capacitors'} in ${conn === 's' ? 'series' : 'parallel'} • ${vals.length} value${vals.length === 1 ? '' : 's'}` }
    ['v1', 'v2', 'v3', 'v4'].forEach(id => {
        const el = $(id);
        el.addEventListener('input', render);
        el.addEventListener('blur', () => formatInput(el));
        el.addEventListener('focus', () => unformatInput(el));
    });
    ['unit1', 'unit2', 'unit3', 'unit4'].forEach(id => $(id).addEventListener('change', render)); $('res').onclick = () => { kind = 'r'; setSeg() }; $('cap').onclick = () => { kind = 'c'; setSeg() }; $('series').onclick = () => { conn = 's'; setSeg() }; $('parallel').onclick = () => { conn = 'p'; setSeg() }; setSeg();
})();