// Troy landing: font switcher. A review tool for trying headline and body fonts live.
// Shown on localhost / 127.0.0.1, or on any host with ?fonts=1.
// A choice can be shared as a link: ?display=Fraunces&body=Manrope
// It only sets CSS variables on <html> (see tokens.css): --font-display, --font-body,
// --display-scale, --display-weight, --display-tracking.

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// g: the Google Fonts family spec (null = already loaded by the page). scale shrinks headlines for wide faces.
const DISPLAY = [
  { name: 'Instrument Serif', note: 'current', g: null, weight: 400, scale: 1, track: '-0.01em', fb: SERIF },
  { name: 'Fraunces', note: 'soft, warm serif', g: 'Fraunces:opsz,wght@9..144,500', weight: 500, scale: 0.9, track: '-0.02em', fb: SERIF },
  { name: 'Playfair Display', note: 'high contrast', g: 'Playfair+Display:wght@500', weight: 500, scale: 0.9, track: '-0.01em', fb: SERIF },
  { name: 'DM Serif Display', note: 'sturdy', g: 'DM+Serif+Display', weight: 400, scale: 0.92, track: '-0.01em', fb: SERIF },
  { name: 'Newsreader', note: 'bookish', g: 'Newsreader:opsz,wght@6..72,500', weight: 500, scale: 0.94, track: '-0.02em', fb: SERIF },
  { name: 'Libre Caslon Text', note: 'old style', g: 'Libre+Caslon+Text', weight: 400, scale: 0.84, track: '-0.01em', fb: SERIF },
  { name: 'Cormorant Garamond', note: 'delicate', g: 'Cormorant+Garamond:wght@600', weight: 600, scale: 1.04, track: '-0.01em', fb: SERIF },
  { name: 'Cinzel', note: 'Roman inscription capitals', g: 'Cinzel:wght@500', weight: 500, scale: 0.72, track: '0', fb: SERIF, wide: true },
  { name: 'Marcellus', note: 'classical, calm', g: 'Marcellus', weight: 400, scale: 0.88, track: '0', fb: SERIF },
  { name: 'Bricolage Grotesque', note: 'friendly grotesque', g: 'Bricolage+Grotesque:opsz,wght@12..96,600', weight: 600, scale: 0.86, track: '-0.02em', fb: SANS },
  { name: 'Space Grotesk', note: 'technical', g: 'Space+Grotesk:wght@500', weight: 500, scale: 0.84, track: '-0.03em', fb: SANS },
  { name: 'Syne', note: 'wide and bold', g: 'Syne:wght@700', weight: 700, scale: 0.74, track: '-0.02em', fb: SANS, wide: true },
  { name: 'Inter Tight', note: 'plain and tight', g: 'Inter+Tight:wght@600', weight: 600, scale: 0.84, track: '-0.02em', fb: SANS },
];

const BODY = [
  { name: 'Inter', note: 'current', g: null },
  { name: 'DM Sans', note: '', g: 'DM+Sans:wght@400;500;600' },
  { name: 'Manrope', note: '', g: 'Manrope:wght@400;500;600' },
  { name: 'Figtree', note: '', g: 'Figtree:wght@400;500;600' },
  { name: 'IBM Plex Sans', note: '', g: 'IBM+Plex+Sans:wght@400;500;600' },
];

const KEY = 'troy-fontswitch';
const root = document.documentElement;
const params = new URLSearchParams(location.search);
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const showUI = isLocal || params.get('fonts') === '1';

const find = (list, name) =>
  name ? list.find((f) => f.name.toLowerCase() === String(name).trim().toLowerCase()) : undefined;

function loadFont(f) {
  if (!f.g || document.querySelector(`link[data-fontswitch="${f.name}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${f.g}&display=swap`;
  link.dataset.fontswitch = f.name;
  document.head.appendChild(link);
}

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null') || {};
  } catch {
    return {};
  }
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ display: state.display.name, body: state.body.name }));
  } catch { /* private window or blocked storage: the choice just lasts for this visit */ }
}

// The saved choice only applies where the control is visible; a shared link applies anywhere.
const saved = showUI ? readSaved() : {};
const state = {
  display: find(DISPLAY, params.get('display')) || find(DISPLAY, saved.display) || DISPLAY[0],
  body: find(BODY, params.get('body')) || find(BODY, saved.body) || BODY[0],
};

function apply() {
  const d = state.display;
  const b = state.body;
  loadFont(d);
  loadFont(b);
  if (d === DISPLAY[0]) {
    for (const p of ['--font-display', '--display-scale', '--display-weight', '--display-tracking']) root.style.removeProperty(p);
  } else {
    root.style.setProperty('--font-display', `"${d.name}", ${d.fb}`);
    root.style.setProperty('--display-scale', String(d.scale));
    root.style.setProperty('--display-weight', String(d.weight));
    root.style.setProperty('--display-tracking', d.track);
  }
  root.toggleAttribute('data-display-wide', Boolean(d.wide));
  if (b === BODY[0]) root.style.removeProperty('--font-body');
  else root.style.setProperty('--font-body', `"${b.name}", ${SANS}`);
}

apply();

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

function buildList(title, group, list, key) {
  const fs = el('fieldset');
  fs.appendChild(el('legend', {}, title));
  for (const f of list) {
    const label = el('label', { class: 'fontswitch-opt' });
    const input = el('input', { type: 'radio', name: group, value: f.name });
    input.checked = state[key] === f;
    input.addEventListener('change', () => {
      state[key] = f;
      apply();
      save();
    });
    label.appendChild(input);
    label.appendChild(el('span', { class: 'fs-name' }, f.name));
    if (f.note) label.appendChild(el('span', { class: 'fs-note' }, f.note));
    fs.appendChild(label);
  }
  return fs;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = el('textarea', { readonly: '', 'aria-hidden': 'true' });
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function build() {
  if (document.getElementById('fontswitch')) return;
  const wrap = el('div', { class: 'fontswitch', id: 'fontswitch' });
  const toggle = el('button', {
    type: 'button',
    class: 'fontswitch-toggle',
    'aria-expanded': 'false',
    'aria-controls': 'fontswitch-panel',
    'aria-label': 'Try fonts',
  }, 'Aa');
  const panel = el('div', { class: 'fontswitch-panel is-closed', id: 'fontswitch-panel', role: 'group', 'aria-label': 'Fonts' });
  panel.hidden = true;
  panel.appendChild(buildList('Headline font', 'fontswitch-display', DISPLAY, 'display'));
  panel.appendChild(buildList('Body font', 'fontswitch-body', BODY, 'body'));
  const copy = el('button', { type: 'button', class: 'fontswitch-copy' }, 'Copy choice');
  panel.appendChild(copy);
  wrap.appendChild(panel);
  wrap.appendChild(toggle);
  document.body.appendChild(wrap);

  let closeTimer = 0;
  function setOpen(open) {
    clearTimeout(closeTimer);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      panel.hidden = false;
      void panel.offsetWidth; // so the fade starts from the closed state
      panel.classList.remove('is-closed');
    } else {
      panel.classList.add('is-closed');
      closeTimer = setTimeout(() => { panel.hidden = true; }, 180);
    }
  }
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';

  toggle.addEventListener('click', () => {
    const open = !isOpen();
    setOpen(open);
    if (open) (panel.querySelector('input:checked') || copy).focus({ preventScroll: true });
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !wrap.contains(e.target)) setOpen(false);
  });

  let copyTimer = 0;
  copy.addEventListener('click', async () => {
    const ok = await copyText(`Headline: ${state.display.name} / Body: ${state.body.name}`);
    copy.textContent = ok ? 'Copied' : `${state.display.name} / ${state.body.name}`;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copy.textContent = 'Copy choice'; }, 1800);
  });
}

if (showUI) {
  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build, { once: true });
}
