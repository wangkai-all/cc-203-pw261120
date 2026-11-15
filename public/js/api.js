/** API client. All errors are surfaced with server-provided messages. */

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!response.ok) {
    const message = body && body.error ? body.error : `请求失败 (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const api = {
  sites() {
    return request('/api/sites');
  },
  site(siteId, params = {}) {
    return request(`/api/sites/${encodeURIComponent(siteId)}?${qs(params)}`);
  },
  analysis(siteId, params = {}) {
    return request(`/api/sites/${encodeURIComponent(siteId)}/analysis?${qs(params)}`);
  },
  triggerAnalysis(siteId, params = {}) {
    return request(`/api/sites/${encodeURIComponent(siteId)}/analysis?${qs(params)}`);
  },
  recompute(siteId, body) {
    return request(`/api/sites/${encodeURIComponent(siteId)}/recompute`, {
      method: 'POST', body: JSON.stringify(body),
    });
  },
  versions(siteId, params = {}) {
    return request(`/api/sites/${encodeURIComponent(siteId)}/versions?${qs(params)}`);
  },
  inbox(siteId, params = {}) {
    return request(`/api/sites/${encodeURIComponent(siteId)}/inbox?${qs(params)}`);
  },
  ingestLate(siteId, itemId, body) {
    return request(`/api/sites/${encodeURIComponent(siteId)}/inbox/${encodeURIComponent(itemId)}/ingest`, {
      method: 'POST', body: JSON.stringify(body),
    });
  },
  records(siteId) {
    return request(`/api/sites/${encodeURIComponent(siteId)}/records`);
  },
  resetSamples() {
    return request('/api/dev/reset-samples', { method: 'POST', body: '{}' });
  },
};

export function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

export function exportUrl(siteId, params, format) {
  return `/api/sites/${encodeURIComponent(siteId)}/export?${qs({ ...params, format })}`;
}
