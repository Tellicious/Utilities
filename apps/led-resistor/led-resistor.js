(() => {
    'use strict';
    const E24 = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91];
    function parseInputString(raw) { if (raw == null) return NaN; let s = String(raw).trim(); if (!s) return NaN; s = s.replace(/\u2009|\u200A|\s/g, ''); const hasComma = s.indexOf(',') !== -1; const hasDot = s.indexOf('.') !== -1; if (hasComma && hasDot) { s = s.replace(/\./g, ''); s = s.replace(',', '.'); } else if (hasComma) { s = s.replace(',', '.'); } else { const dots = (s.match(/\./g) || []).length; if (dots > 1) { const idx = s.lastIndexOf('.'); s = s.slice(0, idx).replace(/\./g, '') + s.slice(idx); } } const n = Number(s); return Number.isNaN(n) ? NaN : n; }
    function num(id) { return parseInputString(document.getElementById(id).value) }
    function formatNumber(value, precision = 3) { if (!isFinite(value)) return '—'; const text = Number(value.toPrecision(precision)).toString(); const [integer, fraction] = text.split('.'); const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return fraction ? `${grouped},${fraction}` : grouped; }
    function fmt(o) { if (o >= 1e6) return `${formatNumber(o / 1e6, 3)} MΩ`; if (o >= 1e3) return `${formatNumber(o / 1e3, 3)} kΩ`; return `${formatNumber(o, 3)} Ω` }
    function nearest(v) { let e = Math.floor(Math.log10(v)) - 1, n = v / 10 ** e, b = E24[0], d = 1e9; for (const x of E24) { const dd = Math.abs(Math.log(x) - Math.log(n)); if (dd < d) { d = dd; b = x } } return b * 10 ** e }
    function render() { const vs = num('vs'), vf = num('vf'), ma = num('ma'), c = Math.max(1, Math.floor(num('count') || 1)), out = document.getElementById('ledValue'), meta = document.getElementById('ledMeta'); const drop = vf * c, i = ma / 1000; if (!vs || !vf || !ma || drop >= vs || i <= 0) { out.textContent = '—'; meta.textContent = 'Supply must be greater than total LED forward voltage.'; return } const r = (vs - drop) / i, std = nearest(r), p = i * i * std; out.textContent = fmt(std); meta.textContent = `Calculated ${fmt(r)} • ${Number((p * 1000).toPrecision(3))} mW, use at least ${p < .125 ? '1/8 W' : p < .25 ? '1/4 W' : p < .5 ? '1/2 W' : '1 W+'}` }
    document.querySelectorAll('input').forEach(i => {
        i.addEventListener('input', render);
        i.addEventListener('blur', () => { if (i.value) i.value = String(formatNumber(parseInputString(i.value), 4)).replace(/\./g, '.'); });
        i.addEventListener('focus', () => { i.value = String(i.value).replace(/\u2009|\u200A|\s/g, '').replace(/\./g, '').replace(',', '.'); });
    }); render();
})();
