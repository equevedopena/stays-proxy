// ─────────────────────────────────────────────────────────────────────────────
// Descuentos por hora – Redibuk
// Cada TICK_MINUTES revisa las unidades de rules.json y, si la noche sigue libre,
// baja el precio según los días que faltan para la llegada y la hora local.
//
// Reglas de seguridad:
//  • Por defecto arranca APAGADO y en SIMULACIÓN (no escribe precios).
//  • El % se calcula siempre sobre el precio original del día (no se acumula).
//  • Dentro de un día el descuento solo puede profundizarse, nunca se repite.
//  • Nunca baja del piso (floor) de la unidad.
//  • Solo toca noches disponibles (avail > 0 en el calendario de Stays).
// ─────────────────────────────────────────────────────────────────────────────
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const RULES_PATH   = process.env.RULES_PATH || path.join(__dirname, 'rules.json');
const DATA_DIR     = process.env.DATA_DIR   || path.join(__dirname, 'data');
const STATE_FILE   = path.join(DATA_DIR, 'auto-state.json');
const LOG_FILE     = path.join(DATA_DIR, 'auto-log.jsonl');
const TICK_MINUTES = Number(process.env.TICK_MINUTES || 15);
const ROUND_TO     = Number(process.env.ROUND_TO || 1);
const MAX_DAYS_OUT = 7;
// Si la API de Stays trata "to" como noche incluida (true) o como salida (false).
const SELL_TO_INCLUSIVE = (process.env.SELL_TO_INCLUSIVE || 'true') !== 'false';

let http = null;            // { get(url), post(url, body) } inyectado desde server.js
let DOMAIN = null;
const memLog = [];
let listingCache = { at: 0, map: {} };
let lastRun = null;
let running = false;

// ── Estado persistente ───────────────────────────────────────────────────────
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJSON(file, data) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('No se pudo guardar', file, e.message); }
}
let state = loadJSON(STATE_FILE, { nights: {}, config: {} });
state.nights = state.nights || {};
state.config = state.config || {};

function config() {
  return {
    enabled: state.config.enabled ?? ((process.env.AUTO_ENABLED || 'false') === 'true'),
    dryRun:  state.config.dryRun  ?? ((process.env.AUTO_DRY_RUN || 'true') !== 'false'),
  };
}

function log(entry) {
  const e = { at: new Date().toISOString(), ...entry };
  memLog.push(e); if (memLog.length > 1000) memLog.shift();
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, JSON.stringify(e) + '\n'); } catch {}
  console.log('[auto]', JSON.stringify(e));
}

function loadRules() {
  const r = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  if (!r.units || !r.profiles) throw new Error('rules.json sin "units" o "profiles"');
  return r;
}

// ── Fechas en la zona horaria de las reglas ──────────────────────────────────
function localNow(tz, at) {
  const d = at ? new Date(at) : new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}
// "at" de preview viene como hora local (YYYY-MM-DDTHH:MM): se usa tal cual.
function parseLocalAt(at) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(at || '');
  return m ? { date: m[1], hhmm: m[2] } : null;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isoWeekday(dateStr) { const w = new Date(dateStr + 'T12:00:00Z').getUTCDay(); return w === 0 ? 7 : w; }

// ── Regla aplicable: el mayor % cuyo horario ya empezó ──────────────────────
function pctFor(profile, daysOut, now, arrivalDate) {
  let best = 0, rule = null;
  for (const r of profile) {
    const [a, b] = Array.isArray(r.daysOut) ? r.daysOut : [r.daysOut, r.daysOut];
    if (daysOut < a || daysOut > b) continue;
    if (now.hhmm < r.from) continue;
    if (r.onlyOnWeekdays && !r.onlyOnWeekdays.includes(isoWeekday(now.date))) continue;
    if (r.onlyArrivalWeekdays && !r.onlyArrivalWeekdays.includes(isoWeekday(arrivalDate))) continue;
    if (r.pct > best) { best = r.pct; rule = r; }
  }
  return { pct: best, rule };
}

// Mientras una regla de 2–4 días ya aplicada siga vigente (p. ej. martes → jueves),
// se mantiene: el descuento nunca retrocede dentro de la misma noche.

// ── Stays ────────────────────────────────────────────────────────────────────
async function resolveListings(force) {
  if (!force && Date.now() - listingCache.at < 6 * 3600e3 && Object.keys(listingCache.map).length) return listingCache.map;
  const map = {}; let skip = 0;
  for (let page = 0; page < 60; page++) {
    const r = await http.get(`https://${DOMAIN}/external/v1/content/listings?limit=20&skip=${skip}`);
    const arr = Array.isArray(r.data) ? r.data : (r.data.data || r.data.listing || []);
    for (const u of arr) { if (u.internalName) map[u.internalName.trim()] = u._id || u.id; }
    if (arr.length < 20) break; skip += arr.length;
  }
  listingCache = { at: Date.now(), map };
  return map;
}

function extractDay(cal, date, currency) {
  const arr = Array.isArray(cal) ? cal : (cal && (cal.data || cal.calendar)) || [];
  const day = arr.find(d => String(d.date).slice(0, 10) === date);
  if (!day) return null;
  const pr = Array.isArray(day.prices) ? day.prices[0] : day.prices;
  const val = pr && pr._mcval ? (pr._mcval[currency] ?? Object.values(pr._mcval)[0]) : null;
  return { avail: Number(day.avail), price: val == null ? null : Number(val), raw: day };
}

async function readNight(listingId, date, currency) {
  const r = await http.get(`https://${DOMAIN}/external/v1/calendar/listing/${listingId}?from=${date}&to=${date}`);
  return extractDay(r.data, date, currency);
}

async function writePrice(listingId, date, price, label) {
  const body = { _idlisting: listingId, from: date, to: SELL_TO_INCLUSIVE ? date : addDays(date, 1),
                 price, type: 'event', status: 'active', name: label };
  const r = await http.post(`https://${DOMAIN}/external/v1/price/sells`, body);
  return r.data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const roundTo = (v, n) => Math.round(v / n) * n;

// ── Un ciclo ─────────────────────────────────────────────────────────────────
// mode: 'run' (respeta enabled/dryRun) | 'preview' (nunca escribe ni guarda estado)
async function tick({ mode = 'run', at = null } = {}) {
  const rules = loadRules();
  const cfg = config();
  const now = parseLocalAt(at) || localNow(rules.timezone);
  const preview = mode === 'preview';
  const write = !preview && !cfg.dryRun;
  const plan = [];
  const ids = await resolveListings();

  // Limpia noches pasadas
  if (!preview) for (const k of Object.keys(state.nights)) if (k.split('|')[1] < now.date) delete state.nights[k];

  for (const [unit, uc] of Object.entries(rules.units)) {
    const profile = rules.profiles[uc.profile];
    const listingId = uc.id || ids[unit];
    if (!profile) { plan.push({ unit, error: `perfil "${uc.profile}" no existe` }); continue; }
    if (!listingId) { plan.push({ unit, error: 'unidad no encontrada en Stays (revisar nombre interno)' }); continue; }

    for (let k = 0; k <= MAX_DAYS_OUT; k++) {
      const date = addDays(now.date, k);
      const { pct, rule } = pctFor(profile, k, now, date);
      const key = `${unit}|${date}`;
      const st = state.nights[key];
      if (!pct && !st) continue;

      let night;
      try { night = await readNight(listingId, date, rules.currency); await sleep(250); }
      catch (e) { plan.push({ unit, date, error: 'calendario: ' + e.message }); continue; }
      if (!night || night.price == null) { plan.push({ unit, date, error: 'sin precio en el calendario' }); continue; }
      if (!(night.avail > 0)) { plan.push({ unit, date, daysOut: k, action: 'ocupada', price: night.price }); continue; }

      // Precio base: el original del día. Si el calendario cambió por fuera (sync de PriceLabs), se toma el nuevo.
      let base = night.price, applied = 0, wasSim = false;
      if (st && (night.price === st.appliedPrice || night.price === st.base)) { base = st.base; applied = st.appliedPct; wasSim = !!st.simulated; }
      else if (st) { plan.push({ unit, date, note: `precio cambió por fuera (${st.base}→${night.price}); nueva base` }); }

      const target = Math.max(uc.floor || 0, roundTo(base * (1 - pct / 100), rules.roundTo ?? ROUND_TO));
      const item = { unit, date, daysOut: k, hora: now.hhmm, base, pct, target, piso: uc.floor || 0, regla: rule ? `${rule.from} -${rule.pct}%` : null };

      if (!pct || pct <= applied) { plan.push({ ...item, action: applied ? `${wasSim ? 'ya simulado' : 'ya aplicado'} -${applied}%` : 'sin regla' }); continue; }
      if (target >= base) { plan.push({ ...item, action: 'piso impide bajar' }); continue; }

      if (preview) { plan.push({ ...item, action: 'aplicaría' }); continue; }
      if (!write) {
        plan.push({ ...item, action: 'simulado' });
        log({ tipo: 'simulado', ...item });
        state.nights[key] = { base, appliedPct: pct, appliedPrice: target, simulated: true, at: new Date().toISOString() };
        continue;
      }
      try {
        const resp = await writePrice(listingId, date, target, `AUTO ${unit} ${date} -${pct}%`);
        state.nights[key] = { base, appliedPct: pct, appliedPrice: target, at: new Date().toISOString() };
        plan.push({ ...item, action: 'aplicado' });
        log({ tipo: 'aplicado', ...item, respuesta: resp });
        await sleep(300);
      } catch (e) {
        plan.push({ ...item, action: 'error', error: e.message });
        log({ tipo: 'error', ...item, error: e.response ? JSON.stringify(e.response.data) : e.message });
      }
    }
  }
  if (!preview) { lastRun = { at: new Date().toISOString(), local: now, dryRun: cfg.dryRun, items: plan.length }; saveJSON(STATE_FILE, state); }
  return { now, dryRun: preview ? null : cfg.dryRun, mode, plan };
}

async function safeTick() {
  if (running || !config().enabled) return;
  running = true;
  try { await tick(); } catch (e) { log({ tipo: 'error-ciclo', error: e.message }); }
  finally { running = false; }
}

// ── Rutas de control (requieren ADMIN_TOKEN) ────────────────────────────────
function requireToken(req, res, next) {
  const t = process.env.ADMIN_TOKEN;
  if (!t) return res.status(503).json({ error: 'Falta ADMIN_TOKEN en las variables de entorno' });
  const got = req.get('x-admin-token') || req.query.token;
  if (got !== t) return res.status(401).json({ error: 'token inválido' });
  next();
}

function register(app, deps) {
  http = deps.http; DOMAIN = deps.domain;

  app.get('/auto/status', requireToken, (req, res) => {
    let rules = null; try { rules = loadRules(); } catch (e) { rules = { error: e.message }; }
    res.json({ ...config(), tickMinutes: TICK_MINUTES, lastRun, nights: state.nights, rules });
  });
  app.get('/auto/log', requireToken, (req, res) => res.json(memLog.slice(-Number(req.query.limit || 200))));
  app.get('/auto/preview', requireToken, async (req, res) => {
    try { res.json(await tick({ mode: 'preview', at: req.query.at })); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/auto/run', requireToken, async (req, res) => {
    if (running) return res.status(409).json({ error: 'ya hay un ciclo corriendo' });
    running = true;
    try { res.json(await tick()); } catch (e) { res.status(500).json({ error: e.message }); } finally { running = false; }
  });
  app.post('/auto/config', requireToken, (req, res) => {
    const { enabled, dryRun } = req.body || {};
    if (typeof enabled === 'boolean') state.config.enabled = enabled;
    if (typeof dryRun === 'boolean') state.config.dryRun = dryRun;
    saveJSON(STATE_FILE, state);
    log({ tipo: 'config', ...config() });
    res.json(config());
  });
  app.post('/auto/reset-night', requireToken, (req, res) => {
    const { unit, date } = req.body || {};
    delete state.nights[`${unit}|${date}`]; saveJSON(STATE_FILE, state); res.json({ ok: true });
  });
  app.get('/diag/listings', requireToken, async (req, res) => {
    try { res.json(await resolveListings(true)); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/diag/calendar', requireToken, async (req, res) => {
    try {
      const ids = await resolveListings();
      const id = ids[req.query.unit] || req.query.unit;
      const r = await http.get(`https://${DOMAIN}/external/v1/calendar/listing/${id}?from=${req.query.from}&to=${req.query.to || req.query.from}`);
      res.json({ listingId: id, data: r.data });
    } catch (e) { res.status(500).json({ error: e.response ? e.response.data : e.message }); }
  });

  setInterval(safeTick, TICK_MINUTES * 60e3);
  setTimeout(safeTick, 20e3);
  console.log(`[auto] programado cada ${TICK_MINUTES} min · ${JSON.stringify(config())}`);
}

module.exports = { register, requireToken, _test: { pctFor, localNow, addDays, isoWeekday, extractDay, tick, setDeps: (h, d) => { http = h; DOMAIN = d; }, state: () => state } };
