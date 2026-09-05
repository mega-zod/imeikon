function validImei(imei) {
  return /^\d{15}$/.test(imei);
}

async function checkImei(imei, apiKey, apiBaseUrl) {
  const data = await fetchImeiApi('/api/check/0/', { imei }, apiKey, apiBaseUrl);
  const status = String(data?.status || '').toLowerCase();
  const isPending = ['pending', 'processing', 'running'].includes(status);
  const historyId = Number(data?.history_id ?? data?.id ?? 0);

  if (isPending && historyId) {
    return normalizeReport(await pollImeiResult(historyId, apiKey, apiBaseUrl), imei);
  }

  return normalizeReport(data, imei);
}

async function pollImeiResult(historyId, apiKey, apiBaseUrl, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const data = await fetchImeiApi(`/api/search_history/${historyId}/`, {}, apiKey, apiBaseUrl);
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

async function fetchImeiApi(path, params, apiKey, apiBaseUrl) {
  const url = new URL(path, apiBaseUrl);
  url.searchParams.set('API_KEY', apiKey);
  url.searchParams.set('format', 'json');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let response;

  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const apiKey = process.env.IMEI_API_KEY;
  const apiBaseUrl = (process.env.IMEI_API_BASE_URL || 'https://dash.imei.info').replace(/\/+$/, '');
  const imei = String(req.body?.imei || '').replace(/\s|-/g, '');

  if (!validImei(imei)) return res.status(422).json({ error: 'Enter a valid 15-digit IMEI.' });
  if (!apiKey) return res.status(503).json({ error: 'API key is not configured on the server.' });

  try {
    const report = await checkImei(imei, apiKey, apiBaseUrl);
    return res.status(200).json(report);
  } catch (err) {
    return res.status(err?.statusCode || 500).json({ error: err?.message || 'IMEI check failed.' });
  }
}
