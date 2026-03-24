// ── State ────────────────────────────────────────────────────
let eventsCache = [];
const LS_EVENTS_KEY = 'bue-events-v1';
const LS_FX_KEY = 'bue-fx-v1';

function persistEventsToStorage() {
  try {
    localStorage.setItem(LS_EVENTS_KEY, JSON.stringify(eventsCache));
  } catch (_) { /* quota / private mode */ }
}

function readEventsFromStorage() {
  try {
    const raw = localStorage.getItem(LS_EVENTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistFxToStorage(payload) {
  try {
    localStorage.setItem(LS_FX_KEY, JSON.stringify({
      rate: payload.rate,
      quotedAt: payload.quotedAt ?? null,
      cachedAt: Date.now(),
    }));
  } catch (_) {}
}

function readFxFromStorage() {
  try {
    const raw = localStorage.getItem(LS_FX_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o == null || typeof o !== 'object') return null;
    const rate = Number(o.rate);
    if (!Number.isFinite(rate)) return null;
    return { rate, quotedAt: o.quotedAt ?? null };
  } catch {
    return null;
  }
}

/** Muitos browsers reportam navigator.onLine=true sem rede real; combina com falha do fetch de eventos. */
let eventsApiUnreachable = false;

function syncOfflineUi() {
  const offline = !navigator.onLine || eventsApiUnreachable;
  document.body.classList.toggle('app-offline', offline);
  if (offline && document.getElementById('modal-edit')?.classList.contains('open')) {
    closeEditModalOnly();
  }
}

let currentEventId = null;
let currentDay = null;
let editTags = [];
let pendingPhotos = [];
let pendingFiles = [];
let autosaveInFlight = false;
let lastSetDayIdx = 0;
let routeInitialized = false;
let lastAutosaveToastAt = 0;

let mapsLoadPromise = null;
let placeAutocomplete = null;
let detailDirectionsRenderer = null;

const HOTEL_COORDS = { lat: -34.5881959, lng: -58.4387735 };
/** AEP — origem da rota do 1.º evento do dia 0 (Costanera Rafael Obligado). */
const AIRPORT_AEP_COORDS = { lat: -34.5590184, lng: -58.41565109999999 };

let appConfig = {
  mapsKey: null,
  pushPrompt: false,
  airbnbAddress: 'Córdoba 5443, Palermo, Buenos Aires',
  airbnbLat: -34.5881959,
  airbnbLng: -58.4387735,
};

let meUser = null;
let lastLocationSentAt = 0;
let locationTimer10 = null;
let locationTimer3 = null;

const FRIEND_META = [
  { label: 'Mário', email: 'mariovalney@gmail.com' },
  { label: 'Luana', email: 'lu.nagasaka@gmail.com' },
  { label: 'Ingrid', email: 'ig.pessoa@gmail.com' },
  { label: 'Diandra', email: 'diandradb@hotmail.com' },
];

async function fetchAppConfig() {
  try {
    const j = await fetch('/api/config').then(r => r.json());
    appConfig = { ...appConfig, ...j };
    const addrEl = document.getElementById('info-airbnb-addr');
    if (addrEl && j.airbnbAddress) addrEl.textContent = j.airbnbAddress;
  } catch {}
}

function loadGoogleMaps() {
  if (window.google?.maps?.places) return Promise.resolve();
  if (mapsLoadPromise) return mapsLoadPromise;
  mapsLoadPromise = (async () => {
    if (!appConfig.mapsKey) await fetchAppConfig();
    const mapsKey = appConfig.mapsKey;
    if (!mapsKey) return;
    await new Promise((resolve, reject) => {
      const cb = `__gm_init_${Date.now()}`;
      window[cb] = () => { delete window[cb]; resolve(); };
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}&libraries=places&callback=${cb}`;
      s.async = true;
      s.onerror = () => { delete window[cb]; reject(new Error('maps')); };
      document.head.appendChild(s);
    });
  })().catch(() => {});
  return mapsLoadPromise;
}

function bindPlacesAutocomplete() {
  const input = document.querySelector('#edit-form [name=location_address]');
  if (!input || !window.google?.maps?.places) return;
  if (placeAutocomplete) {
    window.google.maps.event.clearInstanceListeners(placeAutocomplete);
    placeAutocomplete = null;
  }
  placeAutocomplete = new google.maps.places.Autocomplete(input, {
    fields: ['formatted_address', 'geometry', 'name'],
  });
  placeAutocomplete.addListener('place_changed', () => {
    const place = placeAutocomplete.getPlace();
    const form = document.getElementById('edit-form');
    if (!place.geometry?.location) return;
    form.querySelector('[name=location_address]').value = place.formatted_address || place.name || '';
    form.querySelector('[name=location_lat]').value = place.geometry.location.lat();
    form.querySelector('[name=location_lng]').value = place.geometry.location.lng();
    autosave();
  });
}

// ── Tabs ─────────────────────────────────────────────────────
const tabs   = document.querySelectorAll('.day-tab');
const panels = document.querySelectorAll('.day-panel');

const TRIP_DAYS = [
  new Date('2026-03-27T00:00:00-03:00'),
  new Date('2026-03-28T00:00:00-03:00'),
  new Date('2026-03-29T00:00:00-03:00'),
  new Date('2026-03-30T00:00:00-03:00'),
];

const TRIP_DAY_ISO_DATE = ['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30'];
const TZ_BUE = 'America/Argentina/Buenos_Aires';

function parseLocationPath() {
  const p = (location.pathname || '/').replace(/\/$/, '') || '/';
  if (p === '/info') return { view: 'tab', day: 4, path: p };
  const dayMap = { '/27-mar': 0, '/28-mar': 1, '/29-mar': 2, '/30-mar': 3 };
  if (dayMap[p] !== undefined) return { view: 'tab', day: dayMap[p], path: p };
  const mEd = /^\/e\/([a-f0-9]{24})\/editar$/i.exec(p);
  if (mEd) return { view: 'edit', id: mEd[1], path: p };
  const mDe = /^\/e\/([a-f0-9]{24})$/i.exec(p);
  if (mDe) return { view: 'detail', id: mDe[1], path: p };
  return { view: 'home', day: null, path: p };
}

function pathnameForDayIdx(idx) {
  const segs = ['27-mar', '28-mar', '29-mar', '30-mar'];
  if (idx >= 0 && idx <= 3) return `/${segs[idx]}`;
  if (idx === 4) return '/info';
  return '/';
}

function showToast(message, opts = {}) {
  const { type = 'success', duration = 3500 } = opts;
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 280);
  }, duration);
}

function maybeToastAutosaveOk() {
  const now = Date.now();
  if (now - lastAutosaveToastAt < 2600) return;
  lastAutosaveToastAt = now;
  showToast('Alterações guardadas', { type: 'success' });
}

function closeAllModalsSilently() {
  clearDetailRoute();
  document.getElementById('modal-detail')?.classList.remove('open');
  closeEditModalOnly();
  closeLightbox();
  document.body.style.overflow = '';
}

let fxArsBrlRate = null;

function roundMoney2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function updateCalcBrlOutput() {
  const input = document.getElementById('calc-ars-input');
  const out = document.getElementById('calc-brl-out');
  if (!input || !out) return;
  if (fxArsBrlRate == null || !Number.isFinite(fxArsBrlRate)) {
    out.textContent = '—';
    return;
  }
  const raw = String(input.value ?? '').trim();
  if (raw === '') {
    out.textContent = '—';
    return;
  }
  const ars = parseFloat(raw.replace(',', '.'));
  if (!Number.isFinite(ars) || ars < 0) {
    out.textContent = '—';
    return;
  }
  const brl = roundMoney2(ars * fxArsBrlRate);
  const perPerson = roundMoney2(brl / 4);
  const main = brl.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const perStr = perPerson.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  out.innerHTML = `${main}<span class="info-calc-brl-per"> (${perStr} por pessoa)</span>`;
}

const DEFAULT_CALC_ARS = 10000;

async function loadArsBrlRate() {
  const input = document.getElementById('calc-ars-input');
  const meta = document.getElementById('calc-fx-meta');
  const errEl = document.getElementById('calc-fx-error');
  const out = document.getElementById('calc-brl-out');
  if (input) input.value = String(DEFAULT_CALC_ARS);
  if (errEl) {
    errEl.style.display = 'none';
    errEl.textContent = '';
  }
  if (meta) meta.textContent = '';
  fxArsBrlRate = null;
  if (out) out.textContent = '—';

  function applyCachedFx() {
    const c = readFxFromStorage();
    if (!c) return false;
    fxArsBrlRate = c.rate;
    if (meta && c.quotedAt) meta.textContent = `Cotação: ${c.quotedAt}`;
    updateCalcBrlOutput();
    if (errEl) {
      errEl.style.display = 'none';
      errEl.textContent = '';
    }
    return true;
  }

  try {
    const res = await fetch('/api/fx/ars-brl');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (!applyCachedFx() && errEl) {
        errEl.textContent = data.error || 'Cotação indisponível';
        errEl.style.display = 'block';
      }
      return;
    }
    const rate = Number(data.rate);
    if (!Number.isFinite(rate)) {
      if (!applyCachedFx() && errEl) {
        errEl.textContent = 'Cotação indisponível';
        errEl.style.display = 'block';
      }
      return;
    }
    fxArsBrlRate = rate;
    persistFxToStorage({ rate, quotedAt: data.quotedAt });
    if (meta && data.quotedAt) {
      meta.textContent = `Cotação: ${data.quotedAt}`;
    }
    updateCalcBrlOutput();
  } catch {
    if (!applyCachedFx() && errEl) {
      errEl.textContent = 'Cotação indisponível';
      errEl.style.display = 'block';
    }
  }
}

function setDay(idx, _opts = {}) {
  if (idx < 0 || idx > 4) idx = 0;
  lastSetDayIdx = idx;
  tabs.forEach((t, i) => t.classList.toggle('active', i === idx));
  panels.forEach((p, i) => {
    if (i === idx) {
      p.classList.add('active');
      p.querySelectorAll('.tl-item').forEach(item => {
        item.style.animation = 'none';
        item.offsetHeight;
        item.style.animation = '';
      });
    } else {
      p.classList.remove('active');
    }
  });
  localStorage.setItem('bue-day', String(idx));
  if (idx === 4) {
    updateAirbnbMapsLink();
    loadArsBrlRate();
    requestAnimationFrame(() => {
      setTimeout(() => refreshFriendsMap(), 50);
    });
  }
}

function userSetDay(idx) {
  closeAllModalsSilently();
  setDay(idx, {});
  history.pushState({ t: 'tab' }, '', pathnameForDayIdx(idx));
}

function applyRouteFromUrl(opts = {}) {
  const r = parseLocationPath();
  const initial = opts.initial === true;

  closeAllModalsSilently();

  if (r.view === 'tab') {
    setDay(r.day, {});
    return;
  }

  if (r.view === 'home') {
    const d = Number(localStorage.getItem('bue-day'));
    const tab = (d >= 0 && d <= 4 && !Number.isNaN(d)) ? d : smartDay();
    setDay(tab, {});
    return;
  }

  const ev = eventsCache.find(e => e._id === r.id);
  if (!ev) {
    const tab = smartDay();
    setDay(tab, {});
    history.replaceState({ t: 'tab' }, '', pathnameForDayIdx(tab));
    return;
  }

  setDay(ev.day, {});

  if (r.view === 'detail') {
    if (initial && history.length === 1) {
      history.replaceState({ t: 'tab' }, '', pathnameForDayIdx(ev.day));
      history.pushState({ t: 'detail' }, '', `/e/${r.id}`);
    }
    openDetail(r.id, { history: false });
    return;
  }

  if (r.view === 'edit') {
    if (initial && history.length === 1) {
      history.replaceState({ t: 'tab' }, '', pathnameForDayIdx(ev.day));
      history.pushState({ t: 'detail' }, '', `/e/${r.id}`);
      history.pushState({ t: 'edit' }, '', `/e/${r.id}/editar`);
    }
    openEditHydrate(r.id);
    return;
  }
}

/** Horário exibido a partir de isoTime (fallback legado: time). */
function formatEventTimeDisplay(ev) {
  if (ev.isoTime) {
    const d = new Date(ev.isoTime);
    if (!Number.isNaN(d.getTime())) {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ_BUE, hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(d);
      const ho = parts.find(p => p.type === 'hour')?.value;
      const mi = parts.find(p => p.type === 'minute')?.value;
      if (ho != null && mi != null) {
        const h = parseInt(ho, 10);
        const m = parseInt(mi, 10);
        return `${h}h${String(m).padStart(2, '0')}`;
      }
    }
  }
  return (ev.time && String(ev.time).trim()) || '';
}

/** Ordenação: isoTime; legado sem ISO usa time+HhMM+dia ou order. */
function eventSortTimestamp(ev) {
  if (ev.isoTime) {
    const t = new Date(ev.isoTime).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const day = Number(ev.day);
  if (day < 0 || day > 3 || !TRIP_DAYS[day]) {
    return day * 86400000 + (ev.order ?? 0) * 60000;
  }
  const m = String(ev.time || '').trim().match(/^(\d{1,2})h(\d{2})$/);
  const base = TRIP_DAYS[day].getTime();
  if (m) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    return base + (h * 60 + min) * 60 * 1000;
  }
  return base + ((ev.order ?? 0) + 1) * 60 * 1000;
}

function compareEventsChronological(a, b) {
  const ca = eventSortTimestamp(a);
  const cb = eventSortTimestamp(b);
  if (ca !== cb) return ca - cb;
  const oa = a.order ?? 0;
  const ob = b.order ?? 0;
  if (oa !== ob) return oa - ob;
  return String(a._id).localeCompare(String(b._id));
}

function smartDay() {
  const now = new Date();
  if (now < TRIP_DAYS[0]) return 0;
  for (let i = TRIP_DAYS.length - 1; i >= 0; i--) {
    if (now >= TRIP_DAYS[i]) return i;
  }
  return 0;
}

const savedDay = localStorage.getItem('bue-day');
let fallbackTab = savedDay !== null ? Number(savedDay) : smartDay();
if (fallbackTab < 0 || fallbackTab > 4 || Number.isNaN(fallbackTab)) fallbackTab = smartDay();

const initialRoute = parseLocationPath();
let bootTab = fallbackTab;
if (initialRoute.view === 'tab') bootTab = initialRoute.day;

setDay(bootTab, {});

if (initialRoute.view === 'home' && (initialRoute.path === '/' || initialRoute.path === '')) {
  history.replaceState({ t: 'tab' }, '', pathnameForDayIdx(bootTab));
}

// ── Status bar ───────────────────────────────────────────────
function fmtTime(d) {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}
function eventBlock(label, name, time) {
  return `<div class="event-block">
    <div class="event-label">${label}</div>
    <div class="event-name">${name}</div>
    <div class="event-time">${time}</div>
  </div>`;
}

function updateBar() {
  const bar = document.getElementById('status-bar');
  const now  = new Date();
  const departure = new Date('2026-03-27T06:45:00-03:00');
  const tripEnd   = new Date('2026-03-30T15:35:00-03:00');

  if (now < departure) {
    const diff = departure - now;
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins  = Math.floor((diff % 3600000) / 60000);
    const val = days > 0
      ? days + (days === 1 ? ' dia' : ' dias')
      : hours + 'h ' + String(mins).padStart(2, '0') + 'min';
    bar.innerHTML = `<span>Partindo em</span>
      <span class="countdown-value">${val}</span>
      <span class="sep">—</span>
      <span>27 Mar, 06:45</span>`;
    return;
  }

  if (now > tripEnd) { bar.style.display = 'none'; return; }

  const timeEvents = [...eventsCache]
    .sort(compareEventsChronological)
    .map((e) => {
      const ts = eventSortTimestamp(e);
      const time = new Date(ts);
      if (Number.isNaN(time.getTime())) return null;
      return { time, label: e.title };
    })
    .filter(Boolean);

  let current = null, next = null;
  for (const ev of timeEvents) {
    if (ev.time <= now) current = ev;
    else if (!next) { next = ev; break; }
  }

  const currentHtml = current
    ? eventBlock('Evento atual', current.label, fmtTime(current.time))
    : eventBlock('Evento atual', 'Dia livre', '—');
  const nextHtml = next
    ? eventBlock('Próximo evento', next.label, fmtTime(next.time))
    : eventBlock('Próximo evento', 'Fim da viagem', '—');

  bar.innerHTML = `<div class="events-grid">${currentHtml}${nextHtml}</div>`;
}

updateBar();
setInterval(updateBar, 60000);

// ── Events API ───────────────────────────────────────────────
async function loadEvents() {
  try {
    const res = await fetch('/api/events');
    const data = await res.json();
    if (!res.ok || !Array.isArray(data)) throw new Error('events bad response');
    eventsCache = data;
    persistEventsToStorage();
    renderAllTimelines();
    updateBar();
    if (!routeInitialized) {
      applyRouteFromUrl({ initial: true });
      routeInitialized = true;
    }
    eventsApiUnreachable = false;
    syncOfflineUi();
  } catch (err) {
    console.error('loadEvents error', err);
    eventsApiUnreachable = true;
    syncOfflineUi();
    const cached = readEventsFromStorage();
    if (cached) {
      eventsCache = cached;
      renderAllTimelines();
      updateBar();
      if (!routeInitialized) {
        applyRouteFromUrl({ initial: true });
        routeInitialized = true;
      }
    }
  }
}

window.addEventListener('popstate', () => applyRouteFromUrl());

function renderTag(t) {
  const cls = t.style === 'dark' ? 'tag dark' : t.style === 'red' ? 'tag red' : 'tag';
  return `<span class="${cls}">${t.label}</span>`;
}

function renderEventCard(ev) {
  const tags = (ev.tags || []).map(renderTag).join('');
  const photoHint = ev.photos?.length
    ? `<div class="tl-photo-hint">📷 ${ev.photos.length} foto${ev.photos.length > 1 ? 's' : ''}</div>`
    : '';
  const timeLabel = formatEventTimeDisplay(ev);
  return `<div class="tl-item" onclick="openDetail('${ev._id}')">
    <div class="tl-left"><div class="tl-dot"></div><div class="tl-line"></div></div>
    <div class="tl-card">
      ${timeLabel ? `<div class="tl-time">${timeLabel}</div>` : ''}
      <div class="tl-title">${ev.title}</div>
      ${ev.description ? `<div class="tl-desc">${ev.description}</div>` : ''}
      ${photoHint}
      ${tags ? `<div class="tl-tags">${tags}</div>` : ''}
    </div>
  </div>`;
}

function renderAllTimelines() {
  const addBtn = (day) =>
    `<div class="btn-add-wrap"><button type="button" class="btn-add-event" onclick="openCreate(${day})">+ Adicionar evento</button></div>`;
  for (let day = 0; day < 4; day++) {
    const container = document.getElementById(`timeline-${day}`);
    if (!container) continue;
    const dayEvents = eventsCache
      .filter(e => e.day === day)
      .sort(compareEventsChronological);
    const cards = dayEvents.length ? dayEvents.map(renderEventCard).join('') : '<div class="tl-loading">Nenhum evento</div>';
    container.innerHTML = cards + addBtn(day);
  }
}

// ── Detail Modal ─────────────────────────────────────────────
function clearDetailRoute() {
  if (detailDirectionsRenderer) {
    detailDirectionsRenderer.setMap(null);
    detailDirectionsRenderer = null;
  }
  const mapEl = document.getElementById('md-route-map');
  if (mapEl) mapEl.innerHTML = '';
  const wrap = document.getElementById('md-route-wrap');
  if (wrap) wrap.classList.remove('visible');
  const routeBtn = document.getElementById('md-route-btn');
  if (routeBtn) routeBtn.style.display = 'none';
}

function renderDetailRoute(ev) {
  const wrap = document.getElementById('md-route-wrap');
  const mapEl = document.getElementById('md-route-map');
  if (!wrap || !mapEl) return;

  const destLat = ev.location?.lat;
  const destLng = ev.location?.lng;
  const routeBtn = document.getElementById('md-route-btn');
  if (destLat == null || destLng == null || Number.isNaN(+destLat) || Number.isNaN(+destLng)) {
    wrap.classList.remove('visible');
    mapEl.innerHTML = '';
    if (routeBtn) routeBtn.style.display = 'none';
    return;
  }

  const sorted = [...eventsCache].sort(compareEventsChronological);
  const idx = sorted.findIndex(e => e._id === ev._id);
  const day0Sorted = eventsCache.filter(e => e.day === 0).sort(compareEventsChronological);
  const isFirstEventOfDay0 = ev.day === 0 && day0Sorted[0] && day0Sorted[0]._id === ev._id;

  let origin = { ...HOTEL_COORDS };
  if (isFirstEventOfDay0) {
    origin = { ...AIRPORT_AEP_COORDS };
  } else if (idx > 0) {
    const prev = sorted[idx - 1];
    const plat = prev.location?.lat;
    const plng = prev.location?.lng;
    if (plat != null && plng != null && !Number.isNaN(+plat) && !Number.isNaN(+plng)) {
      origin = { lat: +plat, lng: +plng };
    }
  }

  const dest = { lat: +destLat, lng: +destLng };

  loadGoogleMaps().then(() => {
    if (!window.google?.maps) return;
    clearDetailRoute();
    wrap.classList.add('visible');
    const map = new google.maps.Map(mapEl, {
      zoom: 12,
      maxZoom: 18,
      center: dest,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
    });
    const ds = new google.maps.DirectionsService();
    const dr = new google.maps.DirectionsRenderer({ map, suppressMarkers: false });
    detailDirectionsRenderer = dr;
    if (routeBtn) {
      routeBtn.href = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&travelmode=driving`;
      routeBtn.style.display = 'block';
    }
    ds.route(
      { origin, destination: dest, travelMode: google.maps.TravelMode.DRIVING },
      (result, status) => {
        if (status === 'OK') dr.setDirections(result);
      }
    );
  });
}

function openDetail(id, opts = {}) {
  currentEventId = id;
  const ev = eventsCache.find(e => e._id === id);
  if (!ev) return;

  clearDetailRoute();

  const modal = document.getElementById('modal-detail');
  modal.querySelector('.md-time').textContent  = formatEventTimeDisplay(ev) || '';
  modal.querySelector('.md-title').textContent = ev.title;
  modal.querySelector('.md-desc').textContent  = ev.description || '';

  const linkEl = modal.querySelector('.md-link');
  const rawLink = (ev.link || '').trim();
  linkEl.classList.remove('has-link');
  linkEl.textContent = '';
  if (rawLink) {
    let ok = false;
    try {
      const u = new URL(rawLink);
      ok = u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) { /* ignore */ }
    if (ok) {
      const a = document.createElement('a');
      a.href = rawLink;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = rawLink;
      linkEl.appendChild(a);
    } else {
      linkEl.textContent = rawLink;
    }
    linkEl.classList.add('has-link');
  }

  const locEl = modal.querySelector('.md-location');
  if (ev.location?.address) {
    const q = ev.location.lat && ev.location.lng
      ? `${ev.location.lat},${ev.location.lng}`
      : encodeURIComponent(ev.location.address);
    locEl.innerHTML = `<a href="https://maps.google.com/?q=${q}" target="_blank" rel="noopener">📍 ${ev.location.address}</a>`;
    locEl.style.display = '';
  } else {
    locEl.style.display = 'none';
  }

  const durEl = modal.querySelector('.md-duration');
  if (ev.durationMinutes) {
    durEl.textContent = `⏱ ${ev.durationMinutes} min`;
    durEl.style.display = '';
  } else {
    durEl.style.display = 'none';
  }

  const gallery = modal.querySelector('.md-gallery');
  const galleryHeading = document.getElementById('md-gallery-heading');
  if (galleryHeading) galleryHeading.style.display = 'block';
  if (ev.photos?.length) {
    gallery.innerHTML = ev.photos.map(f =>
      `<img class="gallery-photo" src="/uploads/${f}" alt="" onclick="openLightbox('/uploads/${f}')">`
    ).join('');
    gallery.style.display = 'flex';
  } else {
    gallery.innerHTML = '<p class="md-gallery-empty">Sem fotos</p>';
    gallery.style.display = 'block';
  }

  const filesWrap = document.getElementById('md-files');
  const filesHeading = document.getElementById('md-files-heading');
  if (filesWrap) filesWrap.textContent = '';
  if (ev.files?.length && filesWrap) {
    if (filesHeading) filesHeading.style.display = 'block';
    ev.files.forEach((f) => {
      const { diskName, displayName } = normalizeEventFile(f);
      const row = document.createElement('div');
      row.className = 'md-file-item';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-file-download';
      btn.textContent = displayName.replace(/\.[^.]+$/, '');
      btn.onclick = () => triggerFileDownload(diskName, displayName);
      row.appendChild(btn);
      filesWrap.appendChild(row);
    });
  } else {
    if (filesHeading) filesHeading.style.display = 'none';
  }

  const navTitle = document.getElementById('detail-nav-title');
  if (navTitle) navTitle.textContent = ev.title.length > 28 ? ev.title.slice(0, 26) + '…' : ev.title;

  modal.querySelector('.md-tags').innerHTML = (ev.tags || []).map(renderTag).join('');

  renderDetailRoute(ev);

  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  if (opts.history !== false) {
    history.pushState({ t: 'detail' }, '', `/e/${id}`);
  }
}

function closeDetailUI() {
  clearDetailRoute();
  document.getElementById('modal-detail').classList.remove('open');
}

function closeDetail() {
  closeDetailUI();
  document.body.style.overflow = '';
  history.back();
}

// ── Lightbox ─────────────────────────────────────────────────
function openLightbox(url) {
  const lb = document.getElementById('lightbox');
  lb.querySelector('img').src = url;
  lb.classList.add('open');
}
function closeLightbox() {
  const lb = document.getElementById('lightbox');
  lb.classList.remove('open');
  lb.querySelector('img').src = '';
}

// ── Edit Modal ───────────────────────────────────────────────
function getEditDayIndex(form) {
  if (currentEventId) {
    const ev = eventsCache.find(e => e._id === currentEventId);
    if (ev) return ev.day;
  }
  if (currentDay != null) return currentDay;
  return 0;
}

function buildIsoTimeFromForm(form, dayIndex) {
  const hEl = form.querySelector('[name=time_h]');
  const mEl = form.querySelector('[name=time_m]');
  const hRaw = hEl?.value?.trim();
  if (hRaw === '' || hRaw === undefined) return { error: 'empty' };
  const hh = parseInt(hRaw, 10);
  if (Number.isNaN(hh) || hh < 0 || hh > 23) return { error: 'hour' };
  let mm = 0;
  const mRaw = mEl?.value?.trim();
  if (mRaw !== '' && mRaw !== undefined) {
    const mp = parseInt(mRaw, 10);
    if (Number.isNaN(mp) || mp < 0 || mp > 59) return { error: 'minute' };
    mm = mp;
  }
  if (dayIndex < 0 || dayIndex > 3) return { error: 'day' };
  const dateStr = TRIP_DAY_ISO_DATE[dayIndex];
  if (!dateStr) return { error: 'day' };
  const iso = `${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-03:00`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { error: 'parse' };
  return { isoTime: iso };
}

function fillTimeInputsFromEvent(ev, form) {
  const hEl = form.querySelector('[name=time_h]');
  const mEl = form.querySelector('[name=time_m]');
  if (!hEl || !mEl) return;
  if (ev?.isoTime) {
    const d = new Date(ev.isoTime);
    if (!Number.isNaN(d.getTime())) {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ_BUE, hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(d);
      const ho = parts.find(p => p.type === 'hour')?.value;
      const mi = parts.find(p => p.type === 'minute')?.value;
      if (ho != null && mi != null) {
        hEl.value = String(parseInt(ho, 10));
        mEl.value = String(parseInt(mi, 10));
        return;
      }
    }
  }
  const t = (ev?.time || '').trim();
  const m = t.match(/(\d{1,2})h(\d{2})/);
  if (m) {
    hEl.value = String(parseInt(m[1], 10));
    mEl.value = String(parseInt(m[2], 10));
  } else {
    hEl.value = '';
    mEl.value = '';
  }
}

function buildEditPayload(form) {
  const dayIdx = getEditDayIndex(form);
  const t = buildIsoTimeFromForm(form, dayIdx);
  if (t.error) return null;
  const title = (form.querySelector('[name=title]').value ?? '').trim();
  if (!title) return null;
  return {
    isoTime: t.isoTime,
    title,
    description: form.querySelector('[name=description]').value,
    location: {
      address: form.querySelector('[name=location_address]').value,
      lat: parseFloat(form.querySelector('[name=location_lat]').value) || null,
      lng: parseFloat(form.querySelector('[name=location_lng]').value) || null,
    },
    durationMinutes: parseInt(form.querySelector('[name=durationMinutes]').value, 10) || null,
    tags: editTags,
    link: (form.querySelector('[name=link]')?.value ?? '').trim(),
  };
}

function mergeEventIntoCache(updated) {
  if (eventsCache.some(e => e._id === updated._id)) {
    eventsCache = eventsCache.map(e => e._id === updated._id ? updated : e);
  } else {
    eventsCache.push(updated);
  }
  persistEventsToStorage();
}

async function uploadPendingPhotosIfAny() {
  if (!currentEventId || !pendingPhotos.length) return null;
  const fd = new FormData();
  pendingPhotos.forEach(f => fd.append('photos', f));
  try {
    const r2 = await fetch(`/api/events/${currentEventId}/photos`, { method: 'POST', body: fd });
    if (!r2.ok) {
      showToast('Erro ao enviar fotos', { type: 'error' });
      return null;
    }
    const updated = await r2.json();
    pendingPhotos = [];
    mergeEventIntoCache(updated);
    renderEditPhotos(updated.photos || []);
    const photoIn = document.getElementById('edit-photo-input');
    if (photoIn) photoIn.value = '';
    return updated;
  } catch {
    showToast('Erro ao enviar fotos', { type: 'error' });
    return null;
  }
}

async function uploadPendingFilesIfAny() {
  if (!currentEventId || !pendingFiles.length) return null;
  const fd = new FormData();
  pendingFiles.forEach(f => fd.append('files', f));
  try {
    const r2 = await fetch(`/api/events/${currentEventId}/files`, { method: 'POST', body: fd });
    if (!r2.ok) {
      showToast('Erro ao enviar arquivos', { type: 'error' });
      return null;
    }
    const updated = await r2.json();
    pendingFiles = [];
    const fi = document.getElementById('edit-files-input');
    if (fi) fi.value = '';
    mergeEventIntoCache(updated);
    renderEditFiles(updated.files || []);
    return updated;
  } catch {
    showToast('Erro ao enviar arquivos', { type: 'error' });
    return null;
  }
}

function getCurrentEditFiles() {
  if (!currentEventId) return [];
  const ev = eventsCache.find(e => e._id === currentEventId);
  return ev?.files || [];
}

function normalizeEventFile(fileItem) {
  if (typeof fileItem === 'string') return { diskName: fileItem, displayName: fileItem };
  return {
    diskName: fileItem?.diskName || '',
    displayName: fileItem?.displayName || fileItem?.diskName || 'arquivo',
  };
}

function triggerFileDownload(diskName, displayName) {
  if (!diskName) return;
  const a = document.createElement('a');
  a.href = `/uploads/${diskName}`;
  a.download = displayName || diskName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function autosave() {
  if (autosaveInFlight) return;
  if (currentEventId == null && currentDay == null) return;
  const form = document.getElementById('edit-form');
  const data = buildEditPayload(form);
  if (!data) {
    const title = (form.querySelector('[name=title]')?.value ?? '').trim();
    showToast(title ? 'Horário inválido' : 'Título e horário obrigatórios', { type: 'error' });
    return;
  }
  autosaveInFlight = true;
  try {
    let updated;
    if (currentEventId) {
      const res = await fetch(`/api/events/${currentEventId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('autosave', err.error || res.status);
        showToast(err.error || 'Erro ao guardar', { type: 'error' });
        return;
      }
      updated = await res.json();
    } else {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, day: currentDay }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('autosave', err.error || res.status);
        showToast(err.error || 'Erro ao guardar', { type: 'error' });
        return;
      }
      updated = await res.json();
      currentEventId = updated._id;
    }
    mergeEventIntoCache(updated);
    await uploadPendingPhotosIfAny();
    await uploadPendingFilesIfAny();
    renderAllTimelines();
    updateBar();
    maybeToastAutosaveOk();
  } catch (err) {
    console.error('autosave', err);
    showToast('Erro ao guardar', { type: 'error' });
  } finally {
    autosaveInFlight = false;
  }
}

function setEditTitles(main, desktop) {
  const m = document.getElementById('edit-nav-title');
  const d = document.getElementById('edit-title-desktop');
  if (m) m.textContent = main;
  if (d) d.textContent = desktop;
}

function updateRemoveButtonVisibility() {
  const b = document.getElementById('btn-remove-event');
  if (b) b.style.display = currentEventId ? 'block' : 'none';
}

function openEditHydrate(id) {
  currentEventId = id;
  const ev = eventsCache.find(e => e._id === id);
  if (!ev) return;

  const form = document.getElementById('edit-form');
  fillTimeInputsFromEvent(ev, form);
  form.querySelector('[name=title]').value            = ev.title || '';
  form.querySelector('[name=description]').value      = ev.description || '';
  form.querySelector('[name=location_address]').value = ev.location?.address || '';
  form.querySelector('[name=location_lat]').value     = ev.location?.lat ?? '';
  form.querySelector('[name=location_lng]').value     = ev.location?.lng ?? '';
  form.querySelector('[name=durationMinutes]').value  = ev.durationMinutes ?? '';
  form.querySelector('[name=link]').value             = ev.link || '';

  editTags    = (ev.tags || []).map(t => ({ ...t }));
  pendingPhotos = [];
  pendingFiles = [];
  const photoIn = document.getElementById('edit-photo-input');
  const filesIn = document.getElementById('edit-files-input');
  if (photoIn) photoIn.value = '';
  if (filesIn) filesIn.value = '';
  refreshTagsUI();
  renderEditPhotos(ev.photos || []);
  renderEditFiles(ev.files || []);

  setEditTitles('Editar evento', 'Editar evento');
  updateRemoveButtonVisibility();

  document.getElementById('modal-edit').classList.add('open');
  document.body.style.overflow = 'hidden';
  loadGoogleMaps().then(() => bindPlacesAutocomplete());
}

function openEdit() {
  const ev = eventsCache.find(e => e._id === currentEventId);
  if (!ev) return;
  closeDetailUI();
  document.body.style.overflow = '';
  history.pushState({ t: 'edit' }, '', `/e/${currentEventId}/editar`);
  openEditHydrate(currentEventId);
}

function openCreate(day) {
  currentEventId = null;
  currentDay = day;
  closeDetailUI();
  document.body.style.overflow = '';

  const form = document.getElementById('edit-form');
  form.reset();
  const noonIso = `${TRIP_DAY_ISO_DATE[day]}T12:00:00-03:00`;
  fillTimeInputsFromEvent({ isoTime: noonIso }, form);
  form.querySelector('[name=location_lat]').value = '';
  form.querySelector('[name=location_lng]').value = '';
  editTags = [];
  pendingPhotos = [];
  pendingFiles = [];
  const photoIn = document.getElementById('edit-photo-input');
  const filesIn = document.getElementById('edit-files-input');
  if (photoIn) photoIn.value = '';
  if (filesIn) filesIn.value = '';
  refreshTagsUI();
  renderEditPhotos([]);
  renderEditFiles([]);

  setEditTitles('Novo evento', 'Novo evento');
  updateRemoveButtonVisibility();

  document.getElementById('modal-edit').classList.add('open');
  document.body.style.overflow = 'hidden';
  loadGoogleMaps().then(() => bindPlacesAutocomplete());
}

function closeEditModalOnly() {
  document.getElementById('modal-edit').classList.remove('open');
  document.body.style.overflow = '';
}

function closeEdit() {
  closeEditModalOnly();
  if (/^\/e\/[a-f0-9]{24}\/editar$/i.test(location.pathname)) {
    history.back();
  }
}

// Tags editor
function refreshTagsUI() {
  const c = document.getElementById('edit-tags');
  c.innerHTML = editTags.map((t, i) => {
    const cls = t.style === 'dark' ? 'tag dark' : t.style === 'red' ? 'tag red' : 'tag';
    return `<span class="edit-tag ${cls}" onclick="cycleTagStyle(${i})">
      ${t.label}
      <button class="rm-tag" onclick="removeTag(event,${i})">×</button>
    </span>`;
  }).join('');
}

function cycleTagStyle(i) {
  const styles = ['default', 'dark', 'red'];
  const cur = editTags[i].style || 'default';
  editTags[i].style = styles[(styles.indexOf(cur) + 1) % styles.length];
  refreshTagsUI();
  autosave();
}

function removeTag(e, i) {
  e.stopPropagation();
  editTags.splice(i, 1);
  refreshTagsUI();
  autosave();
}

function addTag() {
  const input = document.getElementById('new-tag-input');
  const label = input.value.trim();
  if (!label) return;
  editTags.push({ label, style: 'default' });
  input.value = '';
  refreshTagsUI();
  autosave();
}

// Photos editor
function renderEditPhotos(photos) {
  const c = document.getElementById('edit-photos');
  c.innerHTML = photos.map(f => `
    <div class="edit-photo-item">
      <img src="/uploads/${f}" alt="">
      <button class="delete-photo-btn" type="button" onclick="deletePhoto('${f}')">×</button>
    </div>
  `).join('');
}

async function handlePhotoSelect(input) {
  const c = document.getElementById('edit-photos');
  c.querySelectorAll('.edit-photo-item.pending-preview').forEach(n => n.remove());
  pendingPhotos = [...input.files];
  pendingPhotos.forEach((file) => {
    const div = document.createElement('div');
    div.className = 'edit-photo-item pending-preview';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    div.appendChild(img);
    c.appendChild(div);
  });
  await autosave();
}

async function deletePhoto(filename) {
  if (!currentEventId) return;
  if (!confirm('Remover esta foto?')) return;
  try {
    const res = await fetch(`/api/events/${currentEventId}/photos/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    if (!res.ok) {
      showToast('Erro ao remover foto', { type: 'error' });
      return;
    }
    const updated = await res.json();
    eventsCache = eventsCache.map(e => e._id === currentEventId ? updated : e);
    persistEventsToStorage();
    renderAllTimelines();
    renderEditPhotos(updated.photos || []);
    showToast('Foto removida', { type: 'success' });
  } catch {
    showToast('Erro ao remover foto', { type: 'error' });
  }
}

function renderEditFiles(savedFiles) {
  const c = document.getElementById('edit-files');
  if (!c) return;
  c.innerHTML = '';
  (savedFiles || []).forEach((f) => {
    const { diskName, displayName } = normalizeEventFile(f);
    const row = document.createElement('div');
    row.className = 'edit-file-item';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'edit-file-name';
    nameSpan.textContent = displayName;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'delete-photo-btn';
    btn.textContent = '×';
    btn.onclick = () => deleteEventFile(diskName);
    row.appendChild(nameSpan);
    row.appendChild(btn);
    c.appendChild(row);
  });
  pendingFiles.forEach((file) => {
    const row = document.createElement('div');
    row.className = 'edit-file-item pending-preview';
    const span = document.createElement('span');
    span.className = 'edit-file-name';
    span.textContent = file.name;
    row.appendChild(span);
    c.appendChild(row);
  });
}

async function handleAttachmentSelect(input) {
  pendingFiles = Array.from(input.files || []).map((f) => {
    const ext = f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.')) : '';
    const baseName = ext ? f.name.slice(0, f.name.lastIndexOf('.')) : f.name;
    const customName = prompt('Nome para o arquivo:', baseName);
    const finalName = ((customName && customName.trim()) ? customName.trim() : baseName) + ext;
    return new File([f], finalName, { type: f.type, lastModified: f.lastModified });
  });
  renderEditFiles(getCurrentEditFiles());
  await autosave();
}

async function deleteEventFile(filename) {
  if (!currentEventId) return;
  if (!confirm('Remover este arquivo?')) return;
  try {
    const res = await fetch(`/api/events/${currentEventId}/files/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    if (!res.ok) {
      showToast('Erro ao remover arquivo', { type: 'error' });
      return;
    }
    const updated = await res.json();
    eventsCache = eventsCache.map(e => e._id === currentEventId ? updated : e);
    persistEventsToStorage();
    renderAllTimelines();
    renderEditFiles(updated.files || []);
    showToast('Arquivo removido', { type: 'success' });
  } catch {
    showToast('Erro ao remover arquivo', { type: 'error' });
  }
}

async function saveEditWithNotify() {
  if (currentEventId == null && currentDay == null) return;
  const form = document.getElementById('edit-form');
  const data = buildEditPayload(form);
  if (!data) {
    showToast('Preencha título e horário válidos antes de notificar.', { type: 'error' });
    return;
  }
  if (!confirm('Enviar notificação push a todos no grupo?')) return;
  try {
    data.notify = true;
    let updated;
    if (currentEventId) {
      const res = await fetch(`/api/events/${currentEventId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Erro ao notificar', { type: 'error' });
        return;
      }
      updated = await res.json();
    } else {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, day: currentDay }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Erro ao notificar', { type: 'error' });
        return;
      }
      updated = await res.json();
      currentEventId = updated._id;
    }
    mergeEventIntoCache(updated);
    const afterPhotos = await uploadPendingPhotosIfAny();
    if (afterPhotos) updated = afterPhotos;
    const afterFiles = await uploadPendingFilesIfAny();
    if (afterFiles) updated = afterFiles;
    renderAllTimelines();
    updateBar();
    updateRemoveButtonVisibility();
    showToast('Notificação enviada', { type: 'success' });
  } catch {
    showToast('Erro ao notificar', { type: 'error' });
  }
}

async function removeCurrentEvent() {
  if (!currentEventId) return;
  if (!confirm('Remover este evento permanentemente?')) return;
  const id = currentEventId;
  const ev = eventsCache.find(e => e._id === id);
  const dayIdx = ev ? ev.day : lastSetDayIdx;
  try {
    const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Erro ao remover', { type: 'error' });
      return;
    }
    eventsCache = eventsCache.filter(e => e._id !== id);
    persistEventsToStorage();
    currentEventId = null;
    closeEditModalOnly();
    closeDetailUI();
    document.body.style.overflow = '';
    renderAllTimelines();
    updateBar();
    history.replaceState({ t: 'tab' }, '', pathnameForDayIdx(dayIdx));
    setDay(dayIdx, {});
    showToast('Evento removido', { type: 'success' });
  } catch {
    showToast('Erro ao remover evento', { type: 'error' });
  }
}

// ── Aba Informações: perfil, localização, Airbnb, amigos ─────
let friendsMapInstance = null;
const friendsMarkers = [];

async function patchShareLocation(value) {
  try {
    await fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareLocation: value }),
    });
  } catch {}
}

/** Códigos GeolocationPositionError: 1 denied, 2 unavailable, 3 timeout */
const GEO_ERR_DENIED = 1;
const GEO_ERR_UNAVAILABLE = 2;
const GEO_ERR_TIMEOUT = 3;

async function getGeolocationPermissionState() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
    const status = await navigator.permissions.query({ name: 'geolocation' });
    if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') {
      return status.state;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function stopLocationTimers() {
  if (locationTimer10) {
    clearInterval(locationTimer10);
    locationTimer10 = null;
  }
  if (locationTimer3) {
    clearInterval(locationTimer3);
    locationTimer3 = null;
  }
}

function setGeoPromptVisible(show) {
  const b = document.getElementById('geo-prompt');
  if (b) b.classList.toggle('visible', show);
}

async function postMyLocation() {
  if (!meUser || meUser.shareLocation === false) return;
  const now = Date.now();
  if (now - lastLocationSentAt < 150000) return;
  await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await fetch('/api/me/location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          });
          lastLocationSentAt = Date.now();
          refreshFriendsMap();
        } catch {}
        resolve();
      },
      () => resolve(),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });
}

function startLocationTimers() {
  stopLocationTimers();
  if (!meUser || meUser.shareLocation === false) return;
  locationTimer10 = setInterval(() => { postMyLocation(); }, 600000);
  locationTimer3 = setInterval(() => {
    if (document.visibilityState === 'visible') postMyLocation();
  }, 180000);
}

async function refreshMeUser() {
  try {
    meUser = await fetch('/api/me').then(r => r.json());
    const nameEl = document.getElementById('info-name');
    const mailEl = document.getElementById('info-email');
    const cb = document.getElementById('share-location-cb');
    if (nameEl) nameEl.textContent = meUser.name || '—';
    if (mailEl) mailEl.textContent = meUser.email || '—';
    if (cb) cb.checked = meUser.shareLocation !== false;
  } catch {}
}

async function requestGeolocationAndEnable() {
  const cb = document.getElementById('share-location-cb');
  if (!navigator.geolocation) {
    if (cb) cb.checked = false;
    showToast('Este browser não suporta geolocalização.', { type: 'error', duration: 5000 });
    return;
  }
  const perm = await getGeolocationPermissionState();
  if (perm === 'denied') {
    await patchShareLocation(false);
    if (meUser) meUser.shareLocation = false;
    if (cb) cb.checked = false;
    setGeoPromptVisible(true);
    stopLocationTimers();
    showToast(
      'A localização está bloqueada para este site. Nas definições do browser (ícone do cadeado ou do site), permite a localização e tenta outra vez.',
      { type: 'error', duration: 9000 }
    );
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async () => {
      await patchShareLocation(true);
      if (meUser) meUser.shareLocation = true;
      if (cb) cb.checked = true;
      setGeoPromptVisible(false);
      lastLocationSentAt = 0;
      await postMyLocation();
      startLocationTimers();
    },
    async (err) => {
      const code = err && err.code;
      if (code === GEO_ERR_DENIED) {
        await patchShareLocation(false);
        if (meUser) meUser.shareLocation = false;
        if (cb) cb.checked = false;
        setGeoPromptVisible(false);
        stopLocationTimers();
        showToast('Permissão de localização negada. A partilha foi desativada.', { type: 'error', duration: 6000 });
        return;
      }
      if (code === GEO_ERR_TIMEOUT) {
        showToast(
          'Demorou demasiado a obter a posição. Tenta outra vez ou toca em «Permitir localização».',
          { type: 'error', duration: 6500 }
        );
        return;
      }
      if (code === GEO_ERR_UNAVAILABLE) {
        showToast('Posição indisponível neste momento. Tenta mais tarde ou noutro sítio.', { type: 'error', duration: 6000 });
        return;
      }
      showToast('Não foi possível obter a localização.', { type: 'error', duration: 5000 });
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

async function applyInitialShareState() {
  if (!meUser || meUser.shareLocation === false) {
    setGeoPromptVisible(false);
    return;
  }
  if (!navigator.geolocation) {
    await patchShareLocation(false);
    if (meUser) meUser.shareLocation = false;
    const cb0 = document.getElementById('share-location-cb');
    if (cb0) cb0.checked = false;
    setGeoPromptVisible(false);
    stopLocationTimers();
    showToast('Este browser não suporta geolocalização. A partilha foi desativada.', { type: 'error', duration: 5000 });
    return;
  }
  const perm = await getGeolocationPermissionState();
  if (perm === 'denied') {
    await patchShareLocation(false);
    if (meUser) meUser.shareLocation = false;
    const cb1 = document.getElementById('share-location-cb');
    if (cb1) cb1.checked = false;
    setGeoPromptVisible(true);
    stopLocationTimers();
    showToast(
      'A localização está bloqueada para este site. Nas definições do browser, permite a localização e recarrega a página.',
      { type: 'error', duration: 9000 }
    );
    return;
  }
  setGeoPromptVisible(true);
  navigator.geolocation.getCurrentPosition(
    () => {
      setGeoPromptVisible(false);
      startLocationTimers();
      lastLocationSentAt = 0;
      postMyLocation();
    },
    async (err) => {
      const code = err && err.code;
      if (code === GEO_ERR_DENIED) {
        await patchShareLocation(false);
        if (meUser) meUser.shareLocation = false;
        const cb = document.getElementById('share-location-cb');
        if (cb) cb.checked = false;
        setGeoPromptVisible(false);
        stopLocationTimers();
        showToast('Permissão de localização negada. A partilha foi desativada.', { type: 'error', duration: 6000 });
        return;
      }
      if (code === GEO_ERR_TIMEOUT) {
        showToast('Demorou demasiado a obter a posição. Usa «Permitir localização» ou tenta outra vez.', { type: 'error', duration: 6500 });
        setGeoPromptVisible(true);
        return;
      }
      if (code === GEO_ERR_UNAVAILABLE) {
        showToast('Posição indisponível neste momento. Tenta mais tarde.', { type: 'error', duration: 6000 });
        setGeoPromptVisible(true);
        return;
      }
      showToast('Não foi possível obter a localização.', { type: 'error', duration: 5000 });
      setGeoPromptVisible(true);
    },
    { timeout: 12000 }
  );
}

function updateAirbnbMapsLink() {
  const btn = document.getElementById('airbnb-maps-btn');
  if (!btn) return;
  const lat = appConfig.airbnbLat ?? HOTEL_COORDS.lat;
  const lng = appConfig.airbnbLng ?? HOTEL_COORDS.lng;
  const dest = `${lat},${lng}`;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const o = `${pos.coords.latitude},${pos.coords.longitude}`;
      btn.href = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(dest)}`;
    },
    () => {
      btn.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
    },
    { timeout: 8000, maximumAge: 300000 }
  );
}

function fitFriendsAllPositions(positions, centerFallback) {
  if (!friendsMapInstance || !window.google?.maps) return;
  const center = centerFallback || { lat: HOTEL_COORDS.lat, lng: HOTEL_COORDS.lng };
  const pad = { top: 56, right: 56, bottom: 56, left: 56 };
  google.maps.event.trigger(friendsMapInstance, 'resize');
  if (!positions.length) {
    friendsMapInstance.setCenter(center);
    friendsMapInstance.setZoom(13);
    return;
  }
  if (positions.length === 1) {
    friendsMapInstance.setCenter(positions[0]);
    friendsMapInstance.setZoom(13);
    return;
  }
  const bounds = new google.maps.LatLngBounds();
  positions.forEach(p => bounds.extend(p));
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  if (ne.equals(sw)) {
    friendsMapInstance.setCenter(positions[0]);
    friendsMapInstance.setZoom(14);
    return;
  }
  friendsMapInstance.fitBounds(bounds, pad);
}

function setFriendsFocusActive(activeBtn) {
  const row = document.getElementById('friends-focus-btns');
  if (!row) return;
  row.querySelectorAll('button.friends-focus-active').forEach((b) => b.classList.remove('friends-focus-active'));
  if (activeBtn && !activeBtn.disabled) activeBtn.classList.add('friends-focus-active');
}

function renderFriendsFocusButtons(data, positions, center) {
  const row = document.getElementById('friends-focus-btns');
  if (!row) return;
  row.innerHTML = '';
  const byEmail = new Map();
  data.forEach((r) => {
    if (r.lat != null && r.lng != null && !Number.isNaN(+r.lat) && !Number.isNaN(+r.lng)) {
      byEmail.set(r.email, { lat: +r.lat, lng: +r.lng });
    }
  });
  const todosBtn = document.createElement('button');
  todosBtn.type = 'button';
  todosBtn.textContent = 'Todos';
  todosBtn.addEventListener('click', () => {
    setFriendsFocusActive(todosBtn);
    fitFriendsAllPositions(positions, center);
  });
  row.appendChild(todosBtn);
  FRIEND_META.forEach(({ label, email }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    const pos = byEmail.get(email);
    if (pos) {
      btn.addEventListener('click', () => {
        setFriendsFocusActive(btn);
        friendsMapInstance.setCenter(pos);
        friendsMapInstance.setZoom(15);
      });
    } else {
      btn.disabled = true;
      btn.title = 'Posição não disponível';
    }
    row.appendChild(btn);
  });
  setFriendsFocusActive(todosBtn);
}

async function refreshFriendsMap() {
  await loadGoogleMaps();
  if (!window.google?.maps) return;
  const el = document.getElementById('info-friends-map');
  if (!el) return;
  let data = [];
  try {
    data = await fetch('/api/friends/locations').then(r => r.json());
  } catch {}
  const center = { lat: HOTEL_COORDS.lat, lng: HOTEL_COORDS.lng };
  if (!friendsMapInstance) {
    friendsMapInstance = new google.maps.Map(el, {
      zoom: 13,
      maxZoom: 18,
      center,
      mapTypeControl: false,
      streetViewControl: false,
    });
  }
  friendsMarkers.forEach(m => m.setMap(null));
  friendsMarkers.length = 0;
  const positions = [];
  data.forEach((row) => {
    const meta = FRIEND_META.find(f => f.email === row.email);
    const title = meta ? meta.label : row.email;
    if (row.lat != null && row.lng != null && !Number.isNaN(+row.lat) && !Number.isNaN(+row.lng)) {
      const pos = { lat: +row.lat, lng: +row.lng };
      positions.push(pos);
      friendsMarkers.push(new google.maps.Marker({
        position: pos,
        map: friendsMapInstance,
        title,
      }));
    }
  });
  fitFriendsAllPositions(positions, center);
  renderFriendsFocusButtons(data, positions, center);
}

function setupInfoTab() {
  document.getElementById('calc-ars-input')?.addEventListener('input', updateCalcBrlOutput);
  document.getElementById('geo-allow-btn')?.addEventListener('click', () => {
    requestGeolocationAndEnable();
  });
  document.getElementById('share-location-cb')?.addEventListener('change', (e) => {
    if (e.target.checked) {
      requestGeolocationAndEnable();
    } else {
      patchShareLocation(false);
      if (meUser) meUser.shareLocation = false;
      setGeoPromptVisible(false);
      stopLocationTimers();
    }
  });
}

// ── Push notifications ───────────────────────────────────────
function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function initPush() {
  if (!('PushManager' in window)) return;
  try {
    if (appConfig.pushPrompt !== true) await fetchAppConfig();
    if (appConfig.pushPrompt !== true) return;
    const { key } = await fetch('/api/push/vapid-key').then(r => r.json());
    if (!key) return;
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) return;
    setTimeout(() => {
      const banner = document.getElementById('push-banner');
      banner.style.display = 'flex';
      document.getElementById('push-allow').onclick = async () => {
        banner.style.display = 'none';
        try {
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key),
          });
          await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub }),
          });
        } catch {}
      };
      document.getElementById('push-deny').onclick = () => { banner.style.display = 'none'; };
    }, 3000);
  } catch {}
}

// ── Service Worker ───────────────────────────────────────────
// Procura nova versão ao abrir, ao voltar à aba e a cada hora. Recarrega só quando uma
// nova versão do SW realmente assume controle (evita reload na primeira instalação).
if ('serviceWorker' in navigator) {
  (async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      let pendingReload = false;

      const trackInstalling = (w) => {
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            pendingReload = true;
          }
        });
      };

      if (navigator.serviceWorker.controller && reg.waiting) pendingReload = true;
      if (reg.installing) trackInstalling(reg.installing);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) trackInstalling(w);
      });

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!pendingReload) return;
        pendingReload = false;
        window.location.reload();
      });

      const pingUpdate = () => { reg.update().catch(() => {}); };
      setInterval(pingUpdate, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') pingUpdate();
      });
      pingUpdate();
    } catch (_) {}
  })();
}

// ── Install Prompt (mobile only) ─────────────────────────────
let deferredPrompt = null;
const banner     = document.getElementById('install-banner');
const installBtn = document.getElementById('install-btn');
const closeBtn   = document.getElementById('install-close');

window.addEventListener('beforeinstallprompt', e => {
  if (window.matchMedia('(hover: hover)').matches) return; // ignora desktop
  e.preventDefault();
  deferredPrompt = e;
  banner.style.display = 'flex';
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  banner.style.display = 'none';
});

closeBtn.addEventListener('click', () => { banner.style.display = 'none'; });
window.addEventListener('appinstalled', () => { banner.style.display = 'none'; });

// ── Init ─────────────────────────────────────────────────────
setupInfoTab();
syncOfflineUi();
window.addEventListener('online', () => {
  eventsApiUnreachable = false;
  syncOfflineUi();
  loadEvents();
});
window.addEventListener('offline', syncOfflineUi);
fetchAppConfig().then(() => {
  loadEvents();
  initPush();
  refreshMeUser().then(() => applyInitialShareState());
});
