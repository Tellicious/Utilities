/* Shared Utilities app helpers */
(function () {
  'use strict';
  const KEY = 'utilities.theme';
  const root = document.documentElement;
  function applyTheme(mode) {
    const safe = ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto';
    root.dataset.theme = safe;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const dark = safe === 'dark' || (safe === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      meta.setAttribute('content', dark ? '#161513' : '#fafaf9');
    }
  }
  window.UtilitiesSettings = {
    get theme() { return localStorage.getItem(KEY) || 'auto'; },
    set theme(v) { localStorage.setItem(KEY, v); applyTheme(v); },
    applyTheme,
  };
  applyTheme(localStorage.getItem(KEY) || 'auto');
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(localStorage.getItem(KEY) || 'auto'));
})();
