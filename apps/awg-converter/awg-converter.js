(() => {
    'use strict'; let busy = false; const ids = ['awg', 'mm', 'mm2', 'inch', 'in2']; const $ = id => document.getElementById(id);
    function parseInputString(raw) {
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
} function v(id) { return parseInputString($(id).value) }
    function formatNumber(value, decimals = 4) { if (!isFinite(value)) return ''; const fixed = Number(value.toFixed(decimals)).toString(); const [integer, fraction] = fixed.split('.'); const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return fraction ? `${grouped},${fraction}` : grouped; }
    function put(id, x) { if (!isFinite(x)) { $(id).value = ''; return } if (id === 'awg') $(id).value = String(Math.round(x)); else if (id === 'in2') $(id).value = formatNumber(x, 5); else $(id).value = formatNumber(x, 4) }
    function fromAwg(a) { return 0.127 * Math.pow(92, (36 - a) / 39) } function awgFromMm(d) { return 36 - 39 * Math.log(d / 0.127) / Math.log(92) } function update(src) { if (busy) return; busy = true; let d; let x = v(src); if (src === 'awg') { x = Math.round(x); if (String($(src).value) !== '' && $(src).value !== String(x)) $(src).value = String(x) } if (!(x > 0)) { ids.filter(i => i !== src).forEach(i => $(i).value = ''); busy = false; return } if (src === 'awg') d = fromAwg(x); if (src === 'mm') d = x; if (src === 'mm2') d = 2 * Math.sqrt(x / Math.PI); if (src === 'inch') d = x * 25.4; if (src === 'in2') d = 2 * Math.sqrt((x * 645.16) / Math.PI); const area = Math.PI * d * d / 4; if (src !== 'awg') put('awg', awgFromMm(d)); if (src !== 'mm') put('mm', d); if (src !== 'mm2') put('mm2', area); if (src !== 'inch') put('inch', d / 25.4); if (src !== 'in2') put('in2', area / 645.16); busy = false }
    ids.forEach(id => {
        const el = $(id);
        el.addEventListener('input', () => update(id));
        el.addEventListener('blur', () => { if (el.value) el.value = formatNumber(parseInputString(el.value), el.id === 'in2' ? 5 : 4); });
        el.addEventListener('focus', () => { el.value = String(el.value).replace(/\u2009|\u200A|\s/g, '').replace(/\./g, '').replace(',', '.'); });
    });
    $('awg').value = '24'; update('awg');
})();