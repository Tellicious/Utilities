(() => {
    'use strict';
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
}

    function n(id) { return parseInputString(document.getElementById(id).value) }

    function formatNumber(value, precision = 4) {
        if (!isFinite(value)) return '—';
        const text = Number(value.toPrecision(precision)).toString();
        const [integer, fraction] = text.split('.');
        const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        return fraction ? `${grouped},${fraction}` : grouped;
    }

    function formatInput(el, precision = 4) {
        const v = parseInputString(el.value);
        if (Number.isNaN(v)) return;
        el.value = formatNumber(v, precision);
    }

    function unformatInput(el) {
        el.value = String(el.value).replace(/\u2009|\u200A|\s/g, '').replace(/\./g, '').replace(',', '.');
    }
    function eng(v, u) { if (!isFinite(v)) return '—'; const a = Math.abs(v); if (a === 0) return '0 ' + u; const units = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n']]; for (const [m, p] of units) { if (a >= m) return `${formatNumber(v / m, 4)} ${p}${u}` } return `${formatNumber(v, 4)} ${u}` }
    function render() { const vin = n('vin'), r1 = n('r1'), r2 = n('r2'), out = document.getElementById('vdValue'), meta = document.getElementById('vdMeta'); if (!(r1 > 0 && r2 > 0) && vin !== 0) { out.textContent = '—'; meta.textContent = 'Enter positive resistor values.'; return } const v = vin * r2 / (r1 + r2), i = vin / (r1 + r2); out.textContent = eng(v, 'V'); meta.textContent = `Current ${eng(i, 'A')} • Total resistance ${eng(r1 + r2, 'Ω')}` }
    document.querySelectorAll('input').forEach(i => {
        i.addEventListener('input', render);
        i.addEventListener('blur', () => formatInput(i));
        i.addEventListener('focus', () => unformatInput(i));
    });
    render();
})();