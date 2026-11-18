/* Escapadas en coche — app web personal
   Datos: sitios.json (base de datos propia). Servicios en directo: OSRM, Open-Meteo, Wikipedia, Overpass (OSM).
   Historial y fotos: Nextcloud por WebDAV (opcional) + copia en el navegador. */
'use strict';

const ACTIVIDADES = ['Senderismo corto', 'Baño', 'Monumentos', 'Pueblo', 'Mirador', 'Naturaleza', 'Playa', 'Cueva', 'Gastronomía'];
const LS = { settings: 'esc.settings', visits: 'esc.visits', times: 'esc.times', plan: 'esc.plan' };
// Ajustes de la app. Para añadir uno nuevo: ponlo aquí con su valor por defecto, añade su control en la pestaña Ajustes
// (index.html) y léelo con S.settings.ui.<nombre>. Se guarda solo con saveUi().
const DEFAULT_SETTINGS = {
  home: { nombre: 'Aldaia', lat: 39.4637, lon: -0.4626 },
  nc: { url: '', user: '', pass: '', folder: 'Escapadas' },
  ui: { theme: 'auto' },
};

const S = {
  db: null, sites: [], settings: null, visits: { version: 1, visitas: [] },
  plan: { day: 'sat', custom: '', origin: 'home', acts: [], maxMin: 90, hideVisited: false, onlySeason: true, dpfOnly: false },
  gps: null, times: {}, weather: {}, weatherDate: null, map: null, mapLayer: null, current: null,
};

/* ---------- utilidades ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = (s) => parseISO(s).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = (s) => parseISO(s).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function haversineKm(a, b) {
  const R = 6371, toR = (x) => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function fetchJSON(url, opts = {}, timeoutMs = 15000) {
  const ctl = new AbortController(); const h = setTimeout(() => ctl.abort(), timeoutMs);
  try { const r = await fetch(url, { ...opts, signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(h); }
}

/* ---------- fechas y temporada ---------- */
function nextWeekend(today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dow = d.getDay(); // 0 dom, 6 sáb
  const sat = new Date(d); sat.setDate(d.getDate() + ((6 - dow + 7) % 7));
  if (dow === 0) sat.setDate(d.getDate() + 6); // domingo: el sábado siguiente
  const sun = new Date(d); sun.setDate(d.getDate() + ((7 - dow) % 7));
  return { sat: isoDate(sat), sun: isoDate(sun) };
}
function planDate() {
  const w = nextWeekend();
  if (S.plan.day === 'sat') return w.sat;
  if (S.plan.day === 'sun') return w.sun;
  return S.plan.custom || w.sat;
}
function seasonOf(iso) {
  const m = parseISO(iso).getMonth() + 1;
  if (m === 12 || m <= 2) return 'invierno';
  if (m <= 5) return 'primavera';
  if (m <= 8) return 'verano';
  return 'otoño';
}
const isWinterish = (iso) => { const m = parseISO(iso).getMonth() + 1; return m >= 11 || m <= 3; };
const isFireSeason = (iso) => { const m = parseISO(iso).getMonth() + 1; return m >= 6 && m <= 9; };
const isBathSeason = (iso) => { const m = parseISO(iso).getMonth() + 1; return m >= 6 && m <= 9; };

/* Evalúa un sitio para una fecha: devuelve puntuación y avisos */
function evaluate(site, iso, wx) {
  const season = seasonOf(iso);
  const ep = (site.epoca || '').toLowerCase();
  const badges = [];
  let score = 0;
  const seasonOk = ep.includes('todo el año') || ep.includes(season) || (season === 'invierno' && ep.includes('invierno'));
  if (seasonOk) { score += 3; badges.push({ t: 'Buena época', c: 'ok' }); }
  else badges.push({ t: 'No es su mejor época', c: 'warn' });

  if (site.actividades.includes('Baño') && !isBathSeason(iso)) {
    const allYear = /todo el año|25 ºc/i.test(site.bano || '');
    badges.push({ t: allYear ? 'Baño posible (agua templada/fría)' : 'Fuera de temporada de baño', c: allYear ? 'info' : 'warn' });
  }
  if (isWinterish(iso) && (site.nieve === 'Medio' || site.nieve === 'Alto')) {
    badges.push({ t: site.nieve === 'Alto' ? 'Riesgo alto de nieve/hielo' : 'Posible hielo', c: site.nieve === 'Alto' ? 'bad' : 'warn' });
    score -= site.nieve === 'Alto' ? 2 : 1;
  }
  if (isFireSeason(iso) && /^sí/i.test(site.incendios || '')) badges.push({ t: 'Cierra con nivel 3 de incendios', c: 'warn' });

  if (wx) {
    if (wx.snow > 0) { badges.push({ t: `Nieve prevista (${wx.snow} cm)`, c: 'bad' }); score -= 4; }
    else if (wx.tmin <= 0 && (site.nieve !== 'Bajo')) { badges.push({ t: 'Heladas previstas', c: 'warn' }); score -= 1; }
    if (wx.pp >= 70) { badges.push({ t: `Lluvia ${wx.pp}%`, c: 'warn' }); score -= 2; }
    else if (wx.pp >= 40) { badges.push({ t: `Puede llover (${wx.pp}%)`, c: 'info' }); score -= 1; }
    if (wx.tmax >= 34 && !site.actividades.includes('Baño')) { badges.push({ t: `Calor (${Math.round(wx.tmax)}°)`, c: 'warn' }); score -= 1; }
    if (wx.tmax >= 28 && site.actividades.includes('Baño') && isBathSeason(iso)) score += 1;
  }
  return { score, seasonOk, badges };
}

/* ---------- rutas para Google Maps ---------- */
function mapsLink(destination, waypoints = [], origin = null) {
  const p = new URLSearchParams({ api: '1', destination, travelmode: 'driving' });
  if (origin) p.set('origin', origin);
  if (waypoints.length) p.set('waypoints', waypoints.slice(0, 9).map((w) => `${w}, Comunidad Valenciana`).join('|'));
  return 'https://www.google.com/maps/dir/?' + p.toString();
}
function routeLinks(site) {
  const home = S.settings.home.nombre + ', Valencia';
  const loop = [...site.ida, site.destino.split(',')[0], ...site.vuelta].slice(0, 9);
  return {
    ida: mapsLink(site.destino, site.ida),
    vuelta: mapsLink(home, site.vuelta),
    completa: mapsLink(home, loop),
  };
}

/* ---------- tiempos reales en coche (OSRM) ---------- */
function originPoint() {
  if (S.plan.origin === 'gps' && S.gps) return S.gps;
  return { lat: +S.settings.home.lat, lon: +S.settings.home.lon };
}
async function loadTimes() {
  const o = originPoint();
  const key = `${o.lat.toFixed(3)},${o.lon.toFixed(3)}`;
  const cache = load(LS.times, {});
  if (cache[key] && cache[key].v === S.db.version) { S.times = cache[key].t; return; }
  const coords = [[o.lon, o.lat], ...S.sites.map((s) => [s.lon, s.lat])].map((c) => c.map((x) => x.toFixed(5)).join(',')).join(';');
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=duration,distance`;
  try {
    const j = await fetchJSON(url, {}, 20000);
    const t = {};
    S.sites.forEach((s, i) => {
      const dur = j.durations?.[0]?.[i + 1], dist = j.distances?.[0]?.[i + 1];
      if (dur != null) t[s.id] = { min: Math.round(dur / 60), km: Math.round(dist / 1000) };
    });
    S.times = t;
    // guardamos como mucho 6 orígenes
    const keys = Object.keys(cache); if (keys.length > 5) delete cache[keys[0]];
    cache[key] = { v: S.db.version, t }; save(LS.times, cache);
  } catch (e) {
    S.times = {}; // usamos los tiempos estimados de la base de datos
    $('#planStatus').textContent = 'No he podido calcular tiempos reales ahora; uso los estimados.';
  }
}
const timeOf = (site) => S.times[site.id] || (S.plan.origin === 'home' ? { min: site.min, km: site.km, est: true } : null);

/* ---------- tiempo previsto (Open-Meteo) ---------- */
const WMO = (c) => c === 0 ? ['☀️', 'Despejado'] : c <= 2 ? ['🌤️', 'Poco nuboso'] : c === 3 ? ['☁️', 'Nublado'] : c <= 48 ? ['🌫️', 'Niebla'] :
  c <= 57 ? ['🌦️', 'Llovizna'] : c <= 67 ? ['🌧️', 'Lluvia'] : c <= 77 ? ['🌨️', 'Nieve'] : c <= 82 ? ['🌧️', 'Chubascos'] : c <= 86 ? ['🌨️', 'Chubascos de nieve'] : ['⛈️', 'Tormenta'];
async function loadWeather(iso) {
  if (S.weatherDate === iso) return;
  S.weather = {}; S.weatherDate = iso;
  const days = Math.round((parseISO(iso) - parseISO(isoDate(new Date()))) / 86400000);
  if (days < 0 || days > 15) return; // fuera del alcance de la previsión
  const lat = S.sites.map((s) => s.lat).join(','), lon = S.sites.map((s) => s.lon).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,snowfall_sum,wind_speed_10m_max&timezone=Europe%2FMadrid&start_date=${iso}&end_date=${iso}`;
  try {
    let j = await fetchJSON(url, {}, 20000);
    if (!Array.isArray(j)) j = [j];
    S.sites.forEach((s, i) => {
      const d = j[i]?.daily; if (!d) return;
      S.weather[s.id] = { code: d.weather_code[0], tmax: d.temperature_2m_max[0], tmin: d.temperature_2m_min[0], pp: d.precipitation_probability_max[0] ?? 0, snow: d.snowfall_sum[0] ?? 0, wind: d.wind_speed_10m_max[0] };
    });
  } catch { /* sin previsión */ }
}

/* ---------- Wikipedia ---------- */
const wikiCache = {};
async function wiki(title) {
  if (!title) return null;
  if (wikiCache[title]) return wikiCache[title];
  const t = encodeURIComponent(title.replace(/ /g, '_'));
  const out = { extract: '', url: '', images: [] };
  try {
    const s = await fetchJSON(`https://es.wikipedia.org/api/rest_v1/page/summary/${t}`);
    out.extract = s.extract || ''; out.url = s.content_urls?.desktop?.page || '';
    if (s.thumbnail?.source) out.thumb = s.thumbnail.source;
    if (s.originalimage?.source) out.images.push(s.originalimage.source);
  } catch { /* nada */ }
  try {
    const m = await fetchJSON(`https://es.wikipedia.org/api/rest_v1/page/media-list/${t}`);
    for (const it of m.items || []) {
      if (it.type !== 'image' || !it.srcset?.length) continue;
      if (/\.svg|logo|escudo|bandera|flag|coat|mapa|map|locator|icon/i.test(it.title || '')) continue;
      let src = it.srcset[it.srcset.length - 1].src; if (src.startsWith('//')) src = 'https:' + src;
      if (!out.images.some((x) => x.split('/').pop() === src.split('/').pop())) out.images.push(src);
      if (out.images.length >= 8) break;
    }
  } catch { /* nada */ }
  wikiCache[title] = out; return out;
}
async function thumbFor(site, el) {
  const w = await wiki(site.wiki);
  const src = w?.thumb || w?.images?.[0];
  if (src && el) el.style.backgroundImage = `url("${src}")`;
}

/* ---------- comida cerca (OpenStreetMap) ---------- */
async function foodNear(site) {
  const q = `[out:json][timeout:20];(
    nwr["amenity"~"^(restaurant|bar|cafe|fast_food)$"](around:2000,${site.lat},${site.lon});
    nwr["tourism"="picnic_site"](around:2500,${site.lat},${site.lon});
    nwr["leisure"="picnic_table"](around:1500,${site.lat},${site.lon});
    nwr["amenity"="bbq"](around:2500,${site.lat},${site.lon});
  );out center 60;`;
  const j = await fetchJSON('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 25000);
  const items = (j.elements || []).map((e) => {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon; const t = e.tags || {};
    const kind = t.amenity === 'restaurant' ? 'Restaurante' : t.amenity === 'bar' ? 'Bar' : t.amenity === 'cafe' ? 'Cafetería' : t.amenity === 'fast_food' ? 'Comida rápida'
      : t.amenity === 'bbq' ? 'Barbacoa/paellero' : 'Zona de picnic';
    return { name: t.name || kind, kind, lat, lon, cuisine: t.cuisine, d: haversineKm(site, { lat, lon }), picnic: !['Restaurante', 'Bar', 'Cafetería', 'Comida rápida'].includes(kind) };
  }).filter((x) => x.lat);
  items.sort((a, b) => a.d - b.d);
  // quitamos mesas sueltas repetidas
  const seen = new Set();
  return items.filter((x) => { const k = x.name + x.kind; if (x.picnic && seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25);
}

/* ---------- Nextcloud (WebDAV) ---------- */
const NC = {
  ok() { const n = S.settings.nc; return !!(n.url && n.user && n.pass); },
  base() { const n = S.settings.nc; return n.url.replace(/\/+$/, '') + '/remote.php/dav/files/' + encodeURIComponent(n.user); },
  path(...parts) { return [S.settings.nc.folder || 'Escapadas', ...parts].filter(Boolean).map((p) => p.split('/').map(encodeURIComponent).join('/')).join('/'); },
  headers(extra = {}) {
    const n = S.settings.nc; const raw = new TextEncoder().encode(`${n.user}:${n.pass}`);
    let bin = ''; raw.forEach((b) => { bin += String.fromCharCode(b); });
    return { Authorization: 'Basic ' + btoa(bin), ...extra };
  },
  async req(method, rel, body, extra) {
    const r = await fetch(this.base() + '/' + rel, { method, headers: this.headers(extra), body });
    return r;
  },
  async mkcol(rel) { const r = await this.req('MKCOL', rel); if (!(r.ok || r.status === 405)) throw new Error('No se pudo crear la carpeta (' + r.status + ')'); },
  async ensureFolder(sub) {
    await this.mkcol(this.path());
    if (sub) await this.mkcol(this.path(sub));
  },
  async test() { const r = await this.req('PROPFIND', '', null, { Depth: '0' }); if (!(r.ok || r.status === 207)) throw new Error('Respuesta ' + r.status); await this.ensureFolder(); },
  async getVisits() { const r = await this.req('GET', this.path('escapadas-visitas.json')); if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
  async putVisits(data) { await this.ensureFolder(); const r = await this.req('PUT', this.path('escapadas-visitas.json'), JSON.stringify(data, null, 1), { 'Content-Type': 'application/json' }); if (!r.ok) throw new Error('HTTP ' + r.status); },
  async putPhoto(folder, name, file) { const r = await this.req('PUT', this.path(folder, name), file, { 'Content-Type': file.type || 'application/octet-stream' }); if (!r.ok) throw new Error('HTTP ' + r.status); },
  webFolderUrl(folder) { const n = S.settings.nc; return n.url.replace(/\/+$/, '') + '/apps/files/?dir=' + encodeURIComponent('/' + (n.folder || 'Escapadas') + '/' + folder); },
};
const folderName = (site) => `${site.municipio} - ${site.nombre}`.replace(/[\\/:*?"<>|]/g, '-');

async function syncVisits() {
  if (!NC.ok()) return;
  try {
    const remote = await NC.getVisits();
    if (remote && Array.isArray(remote.visitas)) {
      // fusionamos por id (lo remoto manda si existe en ambos)
      const byId = new Map(S.visits.visitas.map((v) => [v.id, v]));
      remote.visitas.forEach((v) => byId.set(v.id, v));
      S.visits.visitas = [...byId.values()];
      S.visits.borradas = [...new Set([...(S.visits.borradas || []), ...(remote.borradas || [])])];
      S.visits.visitas = S.visits.visitas.filter((v) => !S.visits.borradas.includes(v.id));
    }
    save(LS.visits, S.visits);
    await NC.putVisits(S.visits);
  } catch (e) { console.warn('Sync Nextcloud', e); toast('No he podido conectar con Nextcloud: el historial queda guardado en el móvil.'); }
}
async function persistVisits() {
  save(LS.visits, S.visits);
  if (NC.ok()) { try { await NC.putVisits(S.visits); } catch { toast('Guardado en el móvil. Nextcloud no responde; se subirá en la próxima sincronización.'); } }
}
const visitsOf = (id) => S.visits.visitas.filter((v) => v.siteId === id).sort((a, b) => b.fecha.localeCompare(a.fecha));

/* ---------- PLANEAR ---------- */
function renderPlanControls() {
  const w = nextWeekend();
  $('#daySeg').innerHTML = [['sat', 'Sáb ' + parseISO(w.sat).getDate()], ['sun', 'Dom ' + parseISO(w.sun).getDate()], ['custom', 'Otro día']]
    .map(([k, t]) => `<button data-d="${k}" class="${S.plan.day === k ? 'on' : ''}">${t}</button>`).join('');
  $('#dayCustom').style.display = S.plan.day === 'custom' ? 'block' : 'none';
  $('#dayCustom').value = S.plan.custom || w.sat;
  $$('#originSeg button').forEach((b) => b.classList.toggle('on', b.dataset.o === S.plan.origin));
  $('#originSeg button[data-o=home]').textContent = S.settings.home.nombre || 'Casa';
  $('#actChips').innerHTML = `<button class="chip ${S.plan.acts.length ? '' : 'on'}" data-a="">Me da igual</button>` +
    ACTIVIDADES.map((a) => `<button class="chip ${S.plan.acts.includes(a) ? 'on' : ''}" data-a="${esc(a)}">${esc(a)}</button>`).join('');
  $('#maxMin').value = S.plan.maxMin; $('#maxMinLbl').textContent = S.plan.maxMin;
  $('#hideVisited').checked = S.plan.hideVisited; $('#onlySeason').checked = S.plan.onlySeason; $('#dpfOnly').checked = S.plan.dpfOnly;
}
function bindPlanControls() {
  $('#daySeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.plan.day = b.dataset.d; refreshPlan(); });
  $('#dayCustom').addEventListener('change', (e) => { S.plan.custom = e.target.value; refreshPlan(); });
  $('#originSeg').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.o === 'gps') {
      if (!navigator.geolocation) return toast('Este navegador no da la ubicación.');
      $('#planStatus').textContent = 'Buscando tu ubicación…';
      navigator.geolocation.getCurrentPosition((p) => { S.gps = { lat: p.coords.latitude, lon: p.coords.longitude }; S.plan.origin = 'gps'; refreshPlan(true); },
        () => { toast('No he podido obtener tu ubicación.'); $('#planStatus').textContent = ''; }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
    } else { S.plan.origin = 'home'; refreshPlan(true); }
  });
  $('#actChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return; const a = b.dataset.a;
    if (!a) S.plan.acts = []; else S.plan.acts = S.plan.acts.includes(a) ? S.plan.acts.filter((x) => x !== a) : [...S.plan.acts, a];
    refreshPlan();
  });
  $('#maxMin').addEventListener('input', (e) => { S.plan.maxMin = +e.target.value; $('#maxMinLbl').textContent = e.target.value; });
  $('#maxMin').addEventListener('change', () => refreshPlan());
  ['hideVisited', 'onlySeason', 'dpfOnly'].forEach((id) => $('#' + id).addEventListener('change', (e) => { S.plan[id] = e.target.checked; refreshPlan(); }));
  $('#btnSurprise').addEventListener('click', () => {
    const list = rankedSites().filter((x) => !visitsOf(x.site.id).length);
    const pool = (list.length ? list : rankedSites()).slice(0, 6);
    if (!pool.length) return toast('No hay sitios con estos filtros.');
    openDetail(pool[Math.floor(Math.random() * pool.length)].site.id);
  });
}
function rankedSites() {
  const iso = planDate();
  const out = [];
  for (const site of S.sites) {
    const t = timeOf(site);
    const min = t ? t.min : site.min;
    if (min > S.plan.maxMin) continue;
    if (S.plan.acts.length && !S.plan.acts.some((a) => site.actividades.includes(a))) continue;
    if (S.plan.dpfOnly && site.dpf !== 'Buena') continue;
    const visited = visitsOf(site.id).length;
    if (S.plan.hideVisited && visited) continue;
    const ev = evaluate(site, iso, S.weather[site.id]);
    if (S.plan.onlySeason && !ev.seasonOk) continue;
    let score = ev.score + (visited ? -1.5 : 0) + S.plan.acts.filter((a) => site.actividades.includes(a)).length * 1.5;
    if (site.dpf === 'Buena') score += 0.5;
    out.push({ site, t, ev, score, visited });
  }
  out.sort((a, b) => b.score - a.score || (a.t?.min ?? a.site.min) - (b.t?.min ?? b.site.min));
  return out;
}
let refreshing = 0;
async function refreshPlan(recalcTimes = false) {
  save(LS.plan, { ...S.plan, day: S.plan.day === 'custom' ? 'custom' : S.plan.day });
  renderPlanControls();
  const my = ++refreshing;
  const iso = planDate();
  $('#hdrSub').textContent = `Plan para el ${fmtDate(iso)} · ${seasonOf(iso)}`;
  $('#planStatus').textContent = 'Calculando tiempos y previsión…';
  renderResults();
  await Promise.all([recalcTimes || !Object.keys(S.times).length ? loadTimes() : null, loadWeather(iso)]);
  if (my !== refreshing) return;
  const days = Math.round((parseISO(iso) - parseISO(isoDate(new Date()))) / 86400000);
  const notes = [];
  notes.push(Object.keys(S.times).length ? `Tiempos reales desde ${S.plan.origin === 'gps' ? 'tu ubicación' : S.settings.home.nombre}.` : 'Tiempos estimados.');
  notes.push(days > 15 ? 'La previsión del tiempo llega cuando falten 16 días o menos.' : Object.keys(S.weather).length ? 'Previsión del tiempo incluida.' : 'Sin previsión del tiempo ahora mismo.');
  if (isFireSeason(iso)) notes.push('En verano mira el nivel de incendios el día antes (se publica sobre las 17:00).');
  $('#planStatus').textContent = notes.join(' ');
  renderResults();
}
function siteCard(r) {
  const { site, t, ev, visited } = r;
  const wx = S.weather[site.id];
  const wxs = wx ? `<span class="b">${WMO(wx.code)[0]} ${Math.round(wx.tmin)}–${Math.round(wx.tmax)}°</span>` : '';
  const tm = t ? `<span class="b">🚗 ${t.est ? '≈' : ''}${t.min} min · ${t.km} km</span>` : '';
  const vis = visited ? `<span class="b ok">✓ Visitado${visited > 1 ? ' ×' + visited : ''}</span>` : '';
  return `<div class="card site" data-id="${site.id}">
    <div class="thumb" data-thumb="${site.id}"></div>
    <div class="body">
      <h3>${esc(site.nombre)}</h3>
      <div class="mun">${esc(site.municipio)} · ${esc(site.actividades.join(', '))}</div>
      <div class="meta">${tm}${wxs}${vis}${ev.badges.map((b) => `<span class="b ${b.c}">${esc(b.t)}</span>`).join('')}</div>
    </div></div>`;
}
function renderResults() {
  const list = rankedSites();
  const el = $('#results');
  if (!list.length) { el.innerHTML = `<div class="empty">No hay sitios con estos filtros.<br>Prueba a quitar «Solo los que van bien en esta época» o a subir el tiempo máximo.</div>`; return; }
  el.innerHTML = `<div class="small muted" style="margin:0 4px 8px">${list.length} sitios, los mejores para ese día primero</div>` + list.map(siteCard).join('');
  // miniaturas poco a poco
  const io = new IntersectionObserver((ents) => ents.forEach((en) => {
    if (!en.isIntersecting) return; io.unobserve(en.target);
    const s = S.sites.find((x) => x.id === en.target.dataset.thumb); thumbFor(s, en.target);
  }), { rootMargin: '200px' });
  $$('[data-thumb]', el).forEach((x) => io.observe(x));
}

/* ---------- DETALLE ---------- */
async function openDetail(id) {
  const site = S.sites.find((s) => s.id === id); if (!site) return;
  S.current = site;
  const iso = planDate();
  const t = timeOf(site); const wx = S.weather[site.id]; const ev = evaluate(site, iso, wx);
  const links = routeLinks(site);
  const vs = visitsOf(site.id);
  const d = $('#detail');
  d.innerHTML = `
  <div class="dhead"><button id="dClose" aria-label="Volver">←</button><h2>${esc(site.nombre)}</h2></div>
  <main>
    <div class="gallery" id="dGallery"><img alt="" style="width:88vw"></div>
    <div class="card" style="margin-top:12px">
      <div class="mun muted">${esc(site.municipio)} · ${esc(site.tipo)}</div>
      <div class="meta">${t ? `<span class="b">🚗 ${t.est ? '≈' : ''}${t.min} min · ${t.km} km (directo)</span>` : ''}
        <span class="b ${site.dpf === 'Buena' ? 'ok' : 'warn'}">DPF: ${site.dpf === 'Buena' ? 'trayecto largo' : 'combinar con otro'}</span>
        ${ev.badges.map((b) => `<span class="b ${b.c}">${esc(b.t)}</span>`).join('')}</div>
      <p id="dExtract" class="small" style="margin-bottom:0"></p>
    </div>

    <div class="card">
      <h2>Ruta en coche</h2>
      <div class="small"><b>Ida:</b> ${site.ida.length ? esc(site.ida.join(' → ')) + ' → ' : 'por autovía → '}${esc(site.municipio)}</div>
      <div class="small" style="margin-bottom:10px"><b>Vuelta:</b> ${esc(site.vuelta.join(' → ') || 'directo')} → ${esc(S.settings.home.nombre)}</div>
      <div class="routes">
        <a class="btn" target="_blank" rel="noopener" href="${links.ida}">▶ Ida en Maps</a>
        <a class="btn sec" target="_blank" rel="noopener" href="${links.vuelta}">◀ Vuelta en Maps</a>
        <a class="btn ghost full small" target="_blank" rel="noopener" href="${links.completa}">Ruta completa ida y vuelta (desde tu ubicación)</a>
      </div>
      <p class="small muted" style="margin-bottom:0">Ábrela en el móvil y se verá en la pantalla del coche con Android Auto. Revisa el recorrido antes de salir.</p>
    </div>

    <div class="card">
      <h2>El día ${esc(fmtDate(iso))}</h2>
      ${wx ? `<div class="wx"><div class="ico">${WMO(wx.code)[0]}</div><div><b>${WMO(wx.code)[1]}</b> · ${Math.round(wx.tmin)}° / ${Math.round(wx.tmax)}°<br>
        <span class="small muted">Lluvia ${wx.pp}% · viento ${Math.round(wx.wind)} km/h${wx.snow ? ` · nieve ${wx.snow} cm` : ''}</span></div></div>` : '<div class="small muted">Sin previsión todavía para ese día.</div>'}
      <div class="row" style="margin-top:10px">
        <a class="btn ghost small" target="_blank" rel="noopener" href="https://wpr.112cv.gva.es/external/api/storage/descargar/pdf/previfoc/previfoc.pdf">🔥 Nivel de incendios</a>
        <a class="btn ghost small" target="_blank" rel="noopener" href="https://infocar.dgt.es/etraffic/">🚧 Carreteras DGT</a>
      </div>
    </div>

    <div class="card">
      <h2>Qué hay</h2>
      <dl class="facts">
        <dt>Qué ver</dt><dd>${esc(site.quever)}</dd>
        <dt>Actividades</dt><dd>${esc(site.actividades.join(', '))}</dd>
        <dt>Mejor época</dt><dd>${esc(site.epoca)}</dd>
        ${site.avisos ? `<dt>Avisos</dt><dd>${esc(site.avisos)}</dd>` : ''}
        <dt>Baño</dt><dd>${esc(site.bano)}</dd>
        <dt>Acceso / tasas</dt><dd>${esc(site.tasas)}</dd>
        <dt>Nieve/hielo</dt><dd>${esc(site.nieve)}</dd>
        <dt>Incendios</dt><dd>${/^sí/i.test(site.incendios) ? 'Cierra con nivel 3' : esc(site.incendios)}</dd>
      </dl>
    </div>

    <div class="card">
      <h2>Comer</h2>
      <dl class="facts"><dt>Allí</dt><dd>${esc(site.comer)}</dd><dt>Llevar comida</dt><dd>${esc(site.picnic)}</dd></dl>
      <button class="btn sec small" id="dFood" style="margin-top:10px">Buscar bares, restaurantes y merenderos cerca</button>
      <div id="dFoodList" class="small" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <h2>Mis visitas</h2>
      <div id="dVisits">${vs.length ? vs.map(visitHtml).join('') : '<div class="small muted">Aún no has ido.</div>'}</div>
      <button class="btn block" id="dAddVisit" style="margin-top:10px">＋ He estado aquí</button>
      <div id="dVisitForm"></div>
    </div>
    <div class="small muted" id="dCredits" style="margin:0 4px 20px"></div>
  </main>`;
  d.classList.add('open'); d.scrollTop = 0;
  history.pushState({ detail: id }, '', '#' + id);
  $('#dClose').onclick = () => history.back();
  $('#dFood').onclick = () => showFood(site);
  $('#dAddVisit').onclick = () => showVisitForm(site);
  bindVisitButtons(site);
  // Wikipedia
  const w = await wiki(site.wiki);
  if (S.current !== site) return;
  const g = $('#dGallery');
  if (w?.images?.length) g.innerHTML = w.images.map((src) => `<img loading="lazy" src="${esc(src)}" alt="${esc(site.nombre)}">`).join('');
  else g.innerHTML = '';
  if (w?.extract) $('#dExtract').textContent = w.extract;
  $('#dCredits').innerHTML = w?.url ? `Texto e imágenes: <a target="_blank" rel="noopener" href="${esc(w.url)}">Wikipedia</a> y Wikimedia Commons (licencias libres; autoría en cada imagen).` : '';
}
function closeDetail() { $('#detail').classList.remove('open'); S.current = null; }
window.addEventListener('popstate', () => { if ($('#detail').classList.contains('open')) closeDetail(); });

async function showFood(site) {
  const el = $('#dFoodList'); el.innerHTML = 'Buscando en OpenStreetMap…';
  try {
    const items = await foodNear(site);
    if (!items.length) { el.innerHTML = 'No aparece nada registrado a menos de 2 km. Mejor llevar comida.'; return; }
    const li = (x) => `<li><a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${x.lat},${x.lon}">${esc(x.name)}</a> · ${esc(x.kind)}${x.cuisine ? ' (' + esc(x.cuisine.replace(/;/g, ', ')) + ')' : ''} · ${x.d < 1 ? Math.round(x.d * 1000) + ' m' : x.d.toFixed(1) + ' km'}</li>`;
    const eat = items.filter((x) => !x.picnic), pic = items.filter((x) => x.picnic);
    el.innerHTML = (eat.length ? `<b>Para comer o tomar algo</b><ul class="food">${eat.slice(0, 12).map(li).join('')}</ul>` : '') +
      (pic.length ? `<b>Para comer lo que lleves</b><ul class="food">${pic.slice(0, 8).map(li).join('')}</ul>` : '') +
      '<div class="muted">Datos de OpenStreetMap: pueden faltar sitios o haber cerrado alguno.</div>';
  } catch { el.innerHTML = 'No he podido consultar OpenStreetMap ahora. Prueba otra vez en un rato.'; }
}

/* ---------- visitas ---------- */
function visitHtml(v) {
  const stars = v.valoracion ? '★'.repeat(v.valoracion) + '☆'.repeat(5 - v.valoracion) : '';
  const site = S.sites.find((s) => s.id === v.siteId);
  const folder = site && v.fotos?.length && NC.ok() ? `<a target="_blank" rel="noopener" href="${esc(NC.webFolderUrl(folderName(site)))}">📷 ${v.fotos.length} fotos en Nextcloud</a>` : (v.fotos?.length ? `📷 ${v.fotos.length} fotos` : '');
  return `<div class="visit"><b>${esc(fmtShort(v.fecha))}</b> ${stars ? `<span style="color:#c9b458">${stars}</span>` : ''}
    ${v.km ? `<span class="b">${v.km} km de viaje</span>` : ''}
    ${v.notas ? `<div class="small">${esc(v.notas)}</div>` : ''}
    <div class="small row" style="justify-content:space-between">${folder}<span>
      <button class="btn ghost small" data-addphotos="${v.id}">＋ Fotos</button>
      <button class="btn ghost small" data-delvisit="${v.id}">Borrar</button></span></div></div>`;
}
function bindVisitButtons(site) {
  $$('[data-delvisit]').forEach((b) => b.onclick = async () => {
    if (!confirm('¿Borrar esta visita del historial? (las fotos se quedan en Nextcloud)')) return;
    S.visits.visitas = S.visits.visitas.filter((v) => v.id !== b.dataset.delvisit);
    S.visits.borradas = [...(S.visits.borradas || []), b.dataset.delvisit];
    await persistVisits(); refreshVisitsBlock(site);
  });
  $$('[data-addphotos]').forEach((b) => b.onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*,video/*'; inp.multiple = true;
    inp.onchange = async () => { const v = S.visits.visitas.find((x) => x.id === b.dataset.addphotos); await uploadPhotos(site, v, [...inp.files]); await persistVisits(); refreshVisitsBlock(site); };
    inp.click();
  });
}
function refreshVisitsBlock(site) {
  const vs = visitsOf(site.id);
  $('#dVisits').innerHTML = vs.length ? vs.map(visitHtml).join('') : '<div class="small muted">Aún no has ido.</div>';
  bindVisitButtons(site);
}
function showVisitForm(site) {
  const t = timeOf(site);
  const kmEst = t ? Math.round(t.km * 2.3) : '';
  $('#dAddVisit').style.display = 'none';
  $('#dVisitForm').innerHTML = `
    <label class="lbl">Fecha</label><input type="date" id="fFecha" value="${isoDate(new Date())}">
    <label class="lbl">Km del viaje completo</label><input type="number" id="fKm" inputmode="numeric" placeholder="${kmEst ? 'unos ' + kmEst + ' km (estimado)' : ''}">
    <label class="lbl">Valoración</label><div class="stars" id="fStars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}">☆</button>`).join('')}</div>
    <label class="lbl">Notas</label><textarea id="fNotas" placeholder="Dónde comimos, qué tal la carretera, volver en primavera…"></textarea>
    <label class="lbl">Fotos ${NC.ok() ? '(se suben a Nextcloud: ' + esc((S.settings.nc.folder || 'Escapadas') + '/' + folderName(site)) + ')' : '(configura Nextcloud en Ajustes para subirlas)'}</label>
    <input type="file" id="fFotos" accept="image/*,video/*" multiple ${NC.ok() ? '' : 'disabled'}>
    <progress id="fProg" value="0" max="1" style="display:none;margin-top:8px"></progress>
    <div class="row" style="margin-top:12px"><button class="btn" id="fSave">Guardar visita</button><button class="btn ghost" id="fCancel">Cancelar</button></div>`;
  let rating = 0;
  $('#fStars').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; rating = +b.dataset.n; $$('#fStars button').forEach((x, i) => { x.textContent = i < rating ? '★' : '☆'; }); };
  $('#fCancel').onclick = () => { $('#dVisitForm').innerHTML = ''; $('#dAddVisit').style.display = ''; };
  $('#fSave').onclick = async () => {
    const v = { id: uid(), siteId: site.id, lugar: site.nombre, municipio: site.municipio, fecha: $('#fFecha').value || isoDate(new Date()),
      km: +$('#fKm').value || null, valoracion: rating || null, notas: $('#fNotas').value.trim(), fotos: [] };
    $('#fSave').disabled = true;
    const files = [...($('#fFotos').files || [])];
    S.visits.visitas.push(v);
    if (files.length) await uploadPhotos(site, v, files);
    await persistVisits();
    toast('Visita guardada');
    $('#dVisitForm').innerHTML = ''; $('#dAddVisit').style.display = '';
    refreshVisitsBlock(site);
  };
}
async function uploadPhotos(site, v, files) {
  if (!files.length) return;
  if (!NC.ok()) { toast('Configura Nextcloud en Ajustes para subir fotos.'); return; }
  const folder = folderName(site);
  const prog = $('#fProg'); if (prog) { prog.style.display = 'block'; prog.max = files.length; prog.value = 0; }
  try { await NC.ensureFolder(folder); } catch (e) { toast('No he podido crear la carpeta en Nextcloud: ' + e.message); return; }
  let ok = 0;
  for (const [i, f] of files.entries()) {
    const ext = (f.name.split('.').pop() || 'jpg').toLowerCase();
    const base = f.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '-');
    const name = `${v.fecha}_${base || 'foto' + (i + 1)}.${ext}`;
    try { await NC.putPhoto(folder, name, f); v.fotos.push(name); ok++; } catch (e) { console.warn(e); }
    if (prog) prog.value = i + 1;
  }
  toast(ok === files.length ? `${ok} fotos subidas a Nextcloud` : `Subidas ${ok} de ${files.length} fotos`);
}

/* ---------- MAPA ---------- */
function renderMap() {
  if (!window.L) { $('#map').innerHTML = '<div class="empty">No se ha podido cargar el mapa (sin conexión).</div>'; return; }
  if (!S.map) {
    S.map = L.map('map', { zoomControl: true }).setView([39.4, -0.55], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(S.map);
  }
  if (S.mapLayer) S.mapLayer.remove();
  S.mapLayer = L.layerGroup().addTo(S.map);
  const h = S.settings.home;
  L.circleMarker([h.lat, h.lon], { radius: 7, color: '#c8553d', fillColor: '#c8553d', fillOpacity: 1 }).bindTooltip(h.nombre).addTo(S.mapLayer);
  S.sites.forEach((s) => {
    const vis = visitsOf(s.id).length > 0;
    const m = L.circleMarker([s.lat, s.lon], { radius: 8, weight: 2, color: '#fff', fillColor: vis ? '#2e7d4f' : '#2f6fb3', fillOpacity: .95 }).addTo(S.mapLayer);
    m.bindTooltip(`${s.nombre} (${s.municipio})`);
    m.on('click', () => openDetail(s.id));
  });
  setTimeout(() => S.map.invalidateSize(), 50);
}

/* ---------- VISITADOS ---------- */
function renderVisits() {
  const vs = [...S.visits.visitas].sort((a, b) => b.fecha.localeCompare(a.fecha));
  const year = new Date().getFullYear();
  const yearVs = vs.filter((v) => v.fecha.startsWith(String(year)));
  const km = yearVs.reduce((a, v) => a + (v.km || 0), 0);
  const places = new Set(vs.map((v) => v.siteId)).size;
  $('#stats').innerHTML = `<div><b>${yearVs.length}</b><span class="small muted">escapadas en ${year}</span></div>
    <div><b>${km}</b><span class="small muted">km en ${year}</span></div>
    <div><b>${places}/${S.sites.length}</b><span class="small muted">sitios conocidos</span></div>`;
  $('#visitList').innerHTML = vs.length ? vs.map((v) => {
    const s = S.sites.find((x) => x.id === v.siteId);
    return `<div class="card site" data-id="${esc(v.siteId)}"><div class="thumb" data-thumb="${esc(v.siteId)}"></div><div class="body">
      <h3>${esc(s ? s.nombre : v.lugar)}</h3><div class="mun">${esc(s ? s.municipio : v.municipio || '')} · ${esc(fmtShort(v.fecha))}</div>
      <div class="meta">${v.km ? `<span class="b">${v.km} km</span>` : ''}${v.valoracion ? `<span class="b">${'★'.repeat(v.valoracion)}</span>` : ''}${v.fotos?.length ? `<span class="b">📷 ${v.fotos.length}</span>` : ''}</div>
      ${v.notas ? `<div class="small muted" style="margin-top:4px">${esc(v.notas)}</div>` : ''}</div></div>`;
  }).join('') : '<div class="empty">Todavía no hay visitas. Cuando vuelvas de una escapada, abre el sitio y pulsa «He estado aquí».</div>';
  $$('#visitList [data-thumb]').forEach((el) => { const s = S.sites.find((x) => x.id === el.dataset.thumb); if (s) thumbFor(s, el); });
}

/* ---------- AJUSTES ---------- */
const darkMQ = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
function applyTheme() {
  const t = S.settings.ui.theme;
  const dark = t === 'dark' || (t === 'auto' && darkMQ?.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = dark ? '#173a2e' : '#1f5f4a';
  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
}
darkMQ?.addEventListener?.('change', () => { if (S.settings?.ui.theme === 'auto') applyTheme(); });
function saveUi(key, value) { S.settings.ui[key] = value; save(LS.settings, S.settings); }

function renderSettings() {
  const st = S.settings;
  $('#sHomeName').value = st.home.nombre; $('#sHomeLat').value = st.home.lat; $('#sHomeLon').value = st.home.lon;
  $('#sNcUrl').value = st.nc.url; $('#sNcUser').value = st.nc.user; $('#sNcPass').value = st.nc.pass; $('#sNcFolder').value = st.nc.folder;
  $('#dbInfo').textContent = `${S.sites.length} sitios (versión ${S.db.version})`;
  applyTheme();
}
function readSettingsForm() {
  const st = S.settings;
  const homeChanged = st.home.lat !== +$('#sHomeLat').value || st.home.lon !== +$('#sHomeLon').value;
  st.home = { nombre: $('#sHomeName').value.trim() || 'Casa', lat: +$('#sHomeLat').value || DEFAULT_SETTINGS.home.lat, lon: +$('#sHomeLon').value || DEFAULT_SETTINGS.home.lon };
  st.ui = st.ui || { ...DEFAULT_SETTINGS.ui };
  st.nc = { url: $('#sNcUrl').value.trim(), user: $('#sNcUser').value.trim(), pass: $('#sNcPass').value, folder: $('#sNcFolder').value.trim() || 'Escapadas' };
  save(LS.settings, st);
  return homeChanged;
}
function bindSettings() {
  $('#themeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; saveUi('theme', b.dataset.t); applyTheme(); });
  $('#btnSaveSettings').onclick = async () => { const hc = readSettingsForm(); toast('Ajustes guardados'); if (hc) { S.times = {}; } await syncVisits(); };
  $('#btnTestNc').onclick = async () => {
    readSettingsForm(); const el = $('#ncStatus');
    if (!NC.ok()) { el.textContent = 'Rellena dirección, usuario y contraseña de aplicación.'; return; }
    el.textContent = 'Probando…';
    try { await NC.test(); el.innerHTML = '<span style="color:var(--ok)">✓ Conectado. La carpeta está lista.</span>'; await syncVisits(); }
    catch (e) {
      el.innerHTML = `<span style="color:var(--bad)">✗ No conecta (${esc(e.message)}).</span> Comprueba que Tailscale está activo en el móvil, que la dirección es https y que Nextcloud permite esta web (ver instrucciones).`;
    }
  };
  $('#btnExport').onclick = () => {
    const blob = new Blob([JSON.stringify(S.visits, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `escapadas-visitas-${isoDate(new Date())}.json`; a.click();
  };
  $('#fileImport').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text()); if (!Array.isArray(j.visitas)) throw new Error();
      const byId = new Map(S.visits.visitas.map((v) => [v.id, v])); j.visitas.forEach((v) => byId.set(v.id, v));
      S.visits.visitas = [...byId.values()]; await persistVisits(); toast(`Historial cargado (${j.visitas.length} visitas)`);
    } catch { toast('Ese archivo no es un historial válido.'); }
  };
}

/* ---------- navegación ---------- */
function showView(v) {
  $$('.view').forEach((x) => x.classList.toggle('active', x.id === 'v-' + v));
  $$('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.v === v));
  if (v === 'map') renderMap();
  if (v === 'visits') renderVisits();
  if (v === 'settings') renderSettings();
  if (v === 'plan') renderResults();
  window.scrollTo(0, 0);
}

/* ---------- arranque ---------- */
async function init() {
  S.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), load(LS.settings, {}));
  S.settings.nc = Object.assign({}, DEFAULT_SETTINGS.nc, S.settings.nc || {});
  S.settings.ui = Object.assign({}, DEFAULT_SETTINGS.ui, S.settings.ui || {});
  applyTheme();
  S.visits = load(LS.visits, { version: 1, visitas: [] });
  Object.assign(S.plan, load(LS.plan, {}), { origin: 'home' });
  try { S.db = await fetchJSON('sitios.json?v=' + Date.now()); }
  catch { S.db = await (await caches.match('sitios.json'))?.json(); }
  if (!S.db) { $('#results').innerHTML = '<div class="empty">No se ha podido cargar la base de datos.</div>'; return; }
  S.sites = S.db.sitios;
  if (!load(LS.settings, null) && S.db.origen) S.settings.home = { ...S.db.origen };

  $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.v)));
  document.addEventListener('click', (e) => { const c = e.target.closest('.site[data-id]'); if (c) openDetail(c.dataset.id); });
  bindPlanControls(); bindSettings();
  refreshPlan(true);
  syncVisits().then(() => { if ($('#v-visits').classList.contains('active')) renderVisits(); });
  if (location.hash.length > 1) { const id = location.hash.slice(1); if (S.sites.some((s) => s.id === id)) { history.replaceState(null, '', location.pathname); openDetail(id); } }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
