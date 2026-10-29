const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const auto    = require('./scheduler');

const app = express();
app.use(cors());
app.use(express.json());

const DOMAIN = process.env.STAYS_DOMAIN || 'rcs.stays.net';
const ID     = process.env.STAYS_CLIENT_ID;
const SECRET = process.env.STAYS_CLIENT_SECRET;

function authHeader() {
  const b64 = Buffer.from(`${ID}:${SECRET}`).toString('base64');
  return { Authorization: `Basic ${b64}`, 'Content-Type': 'application/json' };
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', domain: DOMAIN }));

// ── Test conexión ─────────────────────────────────────────────────────────────
app.get('/test', async (req, res) => {
  try {
    const r = await axios.get(`https://${DOMAIN}/external/v1/content/listings?limit=1`,
      { headers: authHeader() });
    res.json({ ok: true, sample: r.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Listar todas las unidades ─────────────────────────────────────────────────
app.get('/listings', async (req, res) => {
  try {
    const r = await axios.get(
      `https://${DOMAIN}/external/v1/content/listings?limit=500`,
      { headers: authHeader() }
    );
    const units = Array.isArray(r.data) ? r.data : (r.data.data || r.data.listing || []);
    res.json(units);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Buscar unidades disponibles (sin reservas) ────────────────────────────────
app.post('/search', async (req, res) => {
  try {
    const { from, to, guests = 1 } = req.body;
    const r = await axios.post(
      `https://${DOMAIN}/external/v1/booking/search-listings`,
      { from, to, guests },
      { headers: authHeader() }
    );
    res.json(Array.isArray(r.data) ? r.data : []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Aplicar descuento (precio por evento/fecha) ───────────────────────────────
app.post('/apply-discount', auto.requireToken, async (req, res) => {
  try {
    const { listingId, from, to, price, discount, label } = req.body;
    const r = await axios.post(
      `https://${DOMAIN}/external/v1/price/sells`,
      {
        _idlisting: listingId,
        from, to,
        price,
        type: 'event',
        status: 'active',
        name: label || `Auto-descuento ${discount}%`,
      },
      { headers: authHeader() }
    );
    res.json({ ok: true, data: r.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Aplicar descuento a múltiples unidades ────────────────────────────────────
app.post('/apply-batch', auto.requireToken, async (req, res) => {
  const { listings, from, to, discount, label } = req.body;
  const results = [];
  for (const u of listings) {
    const base  = u.pricePerNight || u.basePrice || 0;
    const newP  = Math.round(base * (1 - discount / 100));
    try {
      await axios.post(
        `https://${DOMAIN}/external/v1/price/sells`,
        { _idlisting: u._id || u.id, from, to, price: newP,
          type: 'event', status: 'active', name: label || `Auto-descuento ${discount}%` },
        { headers: authHeader() }
      );
      results.push({ id: u._id || u.id, name: u.internalName, ok: true, newPrice: newP });
    } catch (e) {
      results.push({ id: u._id || u.id, name: u.internalName, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 100)); // throttle
  }
  res.json(results);
});

// ── Descuentos por hora (ver scheduler.js y rules.json) ──────────────────────
auto.register(app, {
  domain: DOMAIN,
  http: {
    get:  (url)       => axios.get(url, { headers: authHeader(), timeout: 20000 }),
    post: (url, body) => axios.post(url, body, { headers: authHeader(), timeout: 20000 }),
  },
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stays proxy corriendo en puerto ${PORT}`));
