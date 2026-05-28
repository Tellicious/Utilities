(() => { 'use strict'; function parseInputString(raw) {
    if (raw == null) return NaN;
    let s = String(raw).trim();
    if (!s) return NaN;
    // formatNumber() uses European separators: dot for thousands,
    // comma for decimals. Parse that same convention back in so a
    // formatted value like "1.000" is read as 1000, not 1.
    s = s.replace(/\u2009|\u200A|\s/g, '');
    const hasComma = s.indexOf(',') !== -1;
    const hasDot = s.indexOf('.') !== -1;
    if (hasComma && hasDot) {
        s = s.replace(/\./g, '').replace(',', '.');
    } else if (hasComma) {
        s = s.replace(',', '.');
    } else if (hasDot) {
        const isGroupedThousands = /^\d{1,3}(\.\d{3})+$/.test(s);
        const dots = (s.match(/\./g) || []).length;
        if (isGroupedThousands) s = s.replace(/\./g, '');
        else if (dots > 1) {
            const idx = s.lastIndexOf('.');
            s = s.slice(0, idx).replace(/\./g, '') + s.slice(idx);
        }
    }
    const n = Number(s);
    return Number.isNaN(n) ? NaN : n;
} function n(id) { return parseInputString(document.getElementById(id).value) } function formatNumber(value, precision = 4) { if (!isFinite(value)) return '—'; const text = Number(value.toPrecision(precision)).toString(); const [integer, fraction] = text.split('.'); const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return fraction ? `${grouped},${fraction}` : grouped; } function fmt(x, sig = 4) { return formatNumber(x, sig) } function formatInput(el, precision = 4) { const v = parseInputString(el.value); if (Number.isNaN(v)) return; el.value = formatNumber(v, precision); } function unformatInput(el) { el.value = String(el.value).replace(/\u2009|\u200A|\s/g, '').replace(/\./g, '').replace(',', '.'); } function render() { const c = n('cap'), i = n('cur'), e = n('eff') / 100, out = document.getElementById('batValue'), meta = document.getElementById('batMeta'); if (!(c > 0 && i > 0 && e > 0)) { out.textContent = '—'; meta.textContent = 'Enter capacity, current and usable percentage.'; return } const h = c * e / i, d = h / 24; out.textContent = h < 48 ? `${fmt(h, 3)} h` : `${fmt(d, 3)} days`; meta.textContent = `${fmt(h, 4)} hours at ${fmt(e * 100, 3)}% usable capacity.` } document.querySelectorAll('input').forEach(i => { i.addEventListener('input', render); i.addEventListener('blur', () => formatInput(i)); i.addEventListener('focus', () => unformatInput(i)); }); render(); })();