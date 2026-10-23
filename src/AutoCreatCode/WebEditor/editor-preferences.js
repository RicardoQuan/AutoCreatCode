(() => {
  'use strict';

  const storageKey = 'botech.flow.preferences';
  const defaults = Object.freeze({ theme: 'light', fontSize: 13 });
  const root = document.documentElement;
  const controls = {
    theme: document.getElementById('themeSelect'),
    font: document.getElementById('fontSizeInput'),
    fontValue: document.getElementById('fontSizeValue'),
  };

  function normalize(value) {
    const candidate = value && typeof value === 'object' ? value : {};
    const fontSize = Number(candidate.fontSize);
    return {
      theme: candidate.theme === 'dark' ? 'dark' : 'light',
      fontSize: Number.isFinite(fontSize) ? Math.min(20, Math.max(12, Math.round(fontSize))) : defaults.fontSize,
    };
  }

  function readSaved() {
    try { return normalize(JSON.parse(localStorage.getItem(storageKey) || 'null')); }
    catch (_) { return { ...defaults }; }
  }

  let preferences = readSaved();

  function render(notify) {
    root.dataset.theme = preferences.theme;
    root.style.setProperty('--ui-font-size', `${preferences.fontSize}px`);
    if (controls.theme) controls.theme.value = preferences.theme;
    if (controls.font) controls.font.value = String(preferences.fontSize);
    if (controls.fontValue) controls.fontValue.textContent = `${preferences.fontSize} px`;
    if (notify) window.dispatchEvent(new CustomEvent('flow:preferenceschange', { detail: { ...preferences } }));
  }

  function set(next) {
    preferences = normalize({ ...preferences, ...(next || {}) });
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); }
    catch (_) { /* Private browsing and local-file hosts may disable storage. */ }
    render(true);
    return { ...preferences };
  }

  if (controls.theme) controls.theme.addEventListener('change', () => set({ theme: controls.theme.value }));
  if (controls.font) controls.font.addEventListener('input', () => set({ fontSize: Number(controls.font.value) }));

  const menus = Array.from(document.querySelectorAll('details.top-menu'));
  const closeMenus = except => menus.forEach(menu => { if (menu !== except) menu.open = false; });
  menus.forEach(menu => {
    menu.addEventListener('toggle', () => { if (menu.open) closeMenus(menu); });
    menu.addEventListener('click', event => {
      if (event.target.closest('button.menu-item:not(:disabled)')) menu.open = false;
    });
  });
  document.addEventListener('pointerdown', event => {
    const activeMenu = event.target.closest('details.top-menu');
    if (!activeMenu) closeMenus();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const openMenu = menus.find(menu => menu.open);
    if (!openMenu) return;
    closeMenus();
    const summary = openMenu.querySelector('summary');
    if (summary) summary.focus();
  });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey) return;
    preferences = readSaved();
    render(true);
  });

  window.EquipmentFlowPreferences = Object.freeze({
    get: () => ({ ...preferences }),
    set,
    reset: () => set(defaults),
  });
  render(false);
})();
