const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const NOMIX_BASE = 'https://panel.nomixclicker.com';
const LABELS_FILE = path.join(__dirname, 'data', 'labels.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');

// Upstash Redis (used in production when env vars are set)
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = !!(UPSTASH_URL && UPSTASH_TOKEN);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API KEY ──
function getApiKey() {
  if (process.env.NOMIX_API_KEY) return process.env.NOMIX_API_KEY;
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).apiKey || null; } catch { return null; }
}

// ── LABELS (Redis in prod, file locally) ──
async function getLabels() {
  if (useRedis) {
    try {
      const res = await fetch(`${UPSTASH_URL}/get/labels`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      const data = await res.json();
      return data.result ? JSON.parse(data.result) : {};
    } catch { return {}; }
  }
  try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')); } catch { return {}; }
}

async function setLabels(labels) {
  if (useRedis) {
    await fetch(`${UPSTASH_URL}/set/labels`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(labels)
    });
  } else {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(LABELS_FILE, JSON.stringify(labels, null, 2));
  }
}

function nomixHeaders(apiKey) {
  return { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
}

// ── CONFIG ──
app.get('/api/config', (req, res) => {
  const apiKey = getApiKey();
  if (!fs.existsSync(CONFIG_FILE)) return res.json({ apiKey: apiKey || '', refreshInterval: 10000, fromEnv: !!process.env.NOMIX_API_KEY });
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    res.json({ ...c, apiKey: apiKey || '', fromEnv: !!process.env.NOMIX_API_KEY });
  } catch { res.json({ apiKey: apiKey || '', refreshInterval: 10000, fromEnv: !!process.env.NOMIX_API_KEY }); }
});

app.post('/api/config', (req, res) => {
  if (process.env.NOMIX_API_KEY) {
    // In production, only save refresh interval (API key is in env)
    let existing = {};
    if (fs.existsSync(CONFIG_FILE)) { try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {} }
    const { refreshInterval } = req.body;
    const config = { ...existing, ...(refreshInterval !== undefined && { refreshInterval }) };
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch {}
    return res.json({ ok: true });
  }
  const { apiKey, refreshInterval } = req.body;
  let existing = {};
  if (fs.existsSync(CONFIG_FILE)) { try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {} }
  const config = { ...existing, ...(apiKey !== undefined && { apiKey }), ...(refreshInterval !== undefined && { refreshInterval }) };
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  res.json({ ok: true });
});

// ── LABELS ──
app.get('/api/labels', async (req, res) => res.json(await getLabels()));

app.post('/api/labels/:deviceId', async (req, res) => {
  const labels = await getLabels();
  labels[req.params.deviceId] = { ...labels[req.params.deviceId], ...req.body };
  await setLabels(labels);
  res.json({ ok: true });
});

// ── DEVICES ──
app.get('/api/devices', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(401).json({ error: 'No API key configured' });
  try {
    const r = await fetch(`${NOMIX_BASE}/clicker/v1/devices`, { headers: nomixHeaders(apiKey) });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/statuses', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(401).json({ error: 'No API key configured' });
  try {
    const listRes = await fetch(`${NOMIX_BASE}/clicker/v1/devices`, { headers: nomixHeaders(apiKey) });
    const ids = await listRes.json();
    const results = await Promise.all(
      ids.map(id =>
        fetch(`${NOMIX_BASE}/clicker/v1/${id}/status`, { headers: nomixHeaders(apiKey) })
          .then(r => r.json())
          .catch(() => ({ device_id: id, connected: false }))
      )
    );
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/devices/:deviceId/screenshot', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(401).json({ error: 'No API key configured' });
  try {
    const r = await fetch(`${NOMIX_BASE}/clicker/v1/${req.params.deviceId}/screenshot`, { headers: nomixHeaders(apiKey) });
    if (!r.ok) return res.status(r.status).json({ error: 'Device not available' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    r.body.pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices/:deviceId/restart', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(401).json({ error: 'No API key configured' });
  try {
    const r = await fetch(`${NOMIX_BASE}/clicker/v1/${req.params.deviceId}/restart`, {
      method: 'POST',
      headers: nomixHeaders(apiKey)
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`\n  Matureminds Clicker Dashboard → http://localhost:${PORT}`);
  console.log(`  API key: ${getApiKey() ? 'set ✓' : 'NOT SET'}`);
  console.log(`  Storage: ${useRedis ? 'Upstash Redis ✓' : 'local files'}\n`);
});
