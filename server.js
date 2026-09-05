import express from 'express';
import dotenv from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: [join(__dirname, '.env'), join(__dirname, '..', '.env')] });

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.IMEI_API_KEY;
const IMEI_API_BASE_URL = (process.env.IMEI_API_BASE_URL || 'https://dash.imei.info').replace(/\/+$/, '');

if (!API_KEY) console.warn('IMEI_API_KEY is not set. The site will start, but live checks will fail.');

app.use(express.json());
app.use(express.static('public'));

app.get('/api/check', (_req, res) => {
  res.status(405).json({ error: 'Use the form or send a POST request with an IMEI.' });
});

function validImei(imei) {
  return /^\d{15}$/.test(imei);
}

async function checkImei(imei) {
  const data = await fetchImeiApi('/api/check/0/', { imei });
  const status = String(data?.status || '').toLowerCase();
  const isPending = ['pending', 'processing', 'running'].includes(status);
  const historyId = Number(data?.history_id ?? data?.id ?? 0);

  if (isPending && historyId) {
    return normalizeReport(await pollImeiResult(historyId), imei);
  }

  return normalizeReport(data, imei);
}

async function pollImeiResult(historyId, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const data = await fetchImeiApi(`/api/search_history/${historyId}/`);
    const status = String(data?.status || '').toLowerCase();

    if (status === 'done' || status === 'completed') return data;
    if (['error', 'failed', 'cancelled'].includes(status)) {
      const error = new Error(`IMEI service returned status: ${data?.status || 'failed'}`);
      error.statusCode = 502;
      throw error;
    }
  }

  const error = new Error('IMEI result was not ready before the server timeout.');
  error.statusCode = 504;
  throw error;
}

async function fetchImeiApi(path, params = {}) {
  const url = new URL(path, IMEI_API_BASE_URL);
  url.searchParams.set('API_KEY', API_KEY);
  url.searchParams.set('format', 'json');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let response;

  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json'
      }
    });
  } catch (err) {
    const error = new Error(`Could not reach IMEI.info API: ${err?.cause?.message || err?.message || 'network request failed'}`);
    error.statusCode = 502;
    throw error;
  }
  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!response.ok) {
    const error = new Error(data?.detail || data?.message || text || 'IMEI check failed.');
    error.statusCode = response.status;
    throw error;
  }

  if (data?.detail && String(data.detail).toLowerCase().includes('token')) {
    const error = new Error(`Authorization failed: ${data.detail}`);
    error.statusCode = 401;
    throw error;
  }

  return data;
}

function normalizeReport(data, imei) {
  const result = data?.result && typeof data.result === 'object' ? data.result : data;
  return {
    imei: String(result.imei || imei),
    brand: result.brand ?? result.brand_name ?? null,
    model: result.model ?? result.model_name ?? null,
    blacklistStatus: result.blacklistStatus ?? result.blacklist_status ?? null,
    carrierLock: result.carrierLock ?? result.carrier_lock ?? null,
    purchaseCountry: result.purchaseCountry ?? result.purchase_country ?? null,
    originalCarrier: result.originalCarrier ?? result.original_carrier ?? null,
    specifications: result.specifications ?? null
  };
}

app.post('/api/check', async (req, res) => {
  const imei = String(req.body?.imei || '').replace(/\s|-/g, '');
  if (!validImei(imei)) return res.status(422).json({ error: 'Enter a valid 15-digit IMEI.' });
  if (!API_KEY) return res.status(503).json({ error: 'API key is not configured on the server.' });

  try {
    const report = await checkImei(imei);
    res.json(report);
  } catch (err) {
    const status = err?.statusCode || 500;
    res.status(status).json({ error: err?.message || 'IMEI check failed.' });
  }
});

app.listen(PORT, () => console.log(`IMEI checker running on http://localhost:${PORT}`));
