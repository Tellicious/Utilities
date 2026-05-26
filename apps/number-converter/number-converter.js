(() => {
  'use strict';

  const BIT_COUNT = 64;
  const MAX_VALUE = (1n << 64n) - 1n;

  const decimalInput = document.getElementById('decimalInput');
  const hexInput = document.getElementById('hexInput');
  const binaryGrid = document.getElementById('binaryGrid');
  const statusText = document.getElementById('statusText');
  const clearBtn = document.getElementById('clearBtn');

  let value = 0n;
  let isRendering = false;

  function normalizeDecimal(raw) {
    return raw.trim().replace(/[._\s]/g, '');
  }

  function normalizeHex(raw) {
    return raw.trim().replace(/^0x/i, '').replace(/[ _\s\u2009]/g, '');
  }

  function formatDecimal(num) {
    return num.toString(10).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function formatHex(num) {
    const hex = num.toString(16).toUpperCase();
    return hex.replace(/\B(?=(?:[0-9A-F]{2})+(?![0-9A-F]))/g, '\u2009');
  }

  function parseDecimal(raw) {
    const text = normalizeDecimal(raw);
    if (!text) return { value: 0n, empty: true };
    if (!/^\d+$/.test(text)) return { error: 'Decimal accepts digits 0–9 only.' };
    const parsed = BigInt(text);
    if (parsed > MAX_VALUE) return { error: 'Decimal value is larger than 64 bits.' };
    return { value: parsed };
  }

  function parseHex(raw) {
    const text = normalizeHex(raw);
    if (!text) return { value: 0n, empty: true };
    if (!/^[0-9a-fA-F]+$/.test(text)) return { error: 'Hex accepts digits 0–9 and A–F only.' };
    if (text.length > 16) return { error: 'Hex value is larger than 64 bits.' };
    const parsed = BigInt(`0x${text}`);
    if (parsed > MAX_VALUE) return { error: 'Hex value is larger than 64 bits.' };
    return { value: parsed };
  }

  function toBinary64(num) {
    return num.toString(2).padStart(BIT_COUNT, '0');
  }

  function setStatus(message = '', isError = false) {
    statusText.textContent = message;
    statusText.classList.toggle('status--error', Boolean(isError));
    statusText.classList.toggle('status--ok', Boolean(message && !isError));
  }

  function renderBinary(num) {
    const bits = toBinary64(num);
    binaryGrid.querySelectorAll('.bit-btn').forEach((button) => {
      const bitIndex = Number(button.dataset.bit);
      const bitValue = bits[BIT_COUNT - 1 - bitIndex];
      button.textContent = bitValue;
      button.dataset.value = bitValue;
      button.setAttribute('aria-pressed', bitValue === '1' ? 'true' : 'false');
      button.setAttribute('aria-label', `Bit ${bitIndex}, currently ${bitValue}. Tap to flip.`);
    });
  }

  function render(source) {
    isRendering = true;
    if (source !== 'decimal') decimalInput.value = formatDecimal(value);
    if (source !== 'hex') hexInput.value = formatHex(value);
    renderBinary(value);
    isRendering = false;
  }

  function applyParsed(parsed, source) {
    if (parsed.error) {
      setStatus(parsed.error, true);
      return;
    }
    value = parsed.value;
    setStatus('', false);
    render(source);

    if (!parsed.empty) {
      const input = source === 'decimal' ? decimalInput : hexInput;
      input.value = source === 'decimal' ? formatDecimal(value) : formatHex(value);
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function buildBinaryGrid() {
    binaryGrid.textContent = '';
    for (let row = 0; row < 4; row += 1) {
      const topBit = 63 - (row * 16);
      const rowEl = document.createElement('div');
      rowEl.className = 'binary-row';

      for (let col = 0; col < 16; col += 1) {
        const bit = topBit - col;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bit-btn';
        button.dataset.bit = String(bit);
        button.addEventListener('click', () => flipBit(bit));
        rowEl.appendChild(button);
      }

      const labels = document.createElement('div');
      labels.className = 'bit-labels';
      for (let col = 0; col < 16; col += 1) {
        const label = document.createElement('span');
        label.className = 'bit-label';
        const bit = topBit - col;
        if (bit % 8 === 7 || bit === 0) label.textContent = String(bit);
        if (bit === 0) label.classList.add('bit-label--end');
        labels.appendChild(label);
      }

      const wrap = document.createElement('div');
      wrap.className = 'bit-wrap';
      wrap.append(rowEl, labels);
      binaryGrid.appendChild(wrap);
    }
  }

  function flipBit(bit) {
    value ^= (1n << BigInt(bit));
    setStatus('', false);
    render('binary');
  }

  decimalInput.addEventListener('input', () => {
    if (isRendering) return;
    applyParsed(parseDecimal(decimalInput.value), 'decimal');
  });

  hexInput.addEventListener('input', () => {
    if (isRendering) return;
    applyParsed(parseHex(hexInput.value), 'hex');
  });

  hexInput.addEventListener('blur', () => {
    if (!hexInput.value.trim()) return;
    hexInput.value = formatHex(value);
  });

  clearBtn.addEventListener('click', () => {
    value = 0n;
    decimalInput.value = '';
    hexInput.value = '';
    setStatus('');
    renderBinary(value);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  window.addEventListener('scroll', () => {
    document.getElementById('appbar').classList.toggle('appbar--scrolled', window.scrollY > 2);
  }, { passive: true });

  buildBinaryGrid();
  renderBinary(value);
})();
