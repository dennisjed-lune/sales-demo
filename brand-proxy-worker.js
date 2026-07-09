/* Cloudflare Worker: context.dev brand proxy for the Lune sales demo.
 *
 * Keeps the ctxt_secret_ API key server-side (context.dev keys must never
 * ship in client-side code). The demo POSTs { name } here; the worker calls
 * context.dev's Brand API with the secret and relays the JSON back.
 *
 * Deploy (one-time, ~3 minutes):
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler deploy brand-proxy-worker.js --name lune-brand-proxy
 *   wrangler secret put CONTEXT_DEV_API_KEY --name lune-brand-proxy   # paste the ctxt_secret_ key
 *
 * Then set in index.html:
 *   window.BRAND_PROXY_URL = "https://lune-brand-proxy.<your-subdomain>.workers.dev";
 */

// Hard cap on context.dev calls per UTC day (edge-cache hits don't count).
// Counter uses the Cache API — per-colo and best-effort, which is fine at
// this scale; raise the number here when the demo needs more headroom.
const DAILY_LIMIT = 5;

const ALLOWED_ORIGINS = [
  'https://sales.lunedata.io',
  'https://dennisjed-lune.github.io',
  'http://localhost:8747',
  'http://localhost:4178',
  'http://192.168.70.101:8747',
];

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const ok = ALLOWED_ORIGINS.some((o) => origin === o || origin.startsWith(o));
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });

    let body;
    try { body = await req.json(); } catch (e) { return new Response('bad json', { status: 400, headers: cors }); }
    const name = String((body && body.name) || '').trim().slice(0, 80);
    if (!name) return new Response('name required', { status: 400, headers: cors });

    // Edge-cache by name for a day — repeat demos of the same bank cost 0 credits.
    const cacheKey = new Request('https://brand-proxy.cache/' + encodeURIComponent(name.toLowerCase()));
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const cached = new Response(hit.body, hit);
      Object.entries(cors).forEach(([k, v]) => cached.headers.set(k, v));
      return cached;
    }

    // Daily quota — only uncached upstream calls count.
    const day = new Date().toISOString().slice(0, 10);
    const quotaKey = new Request('https://brand-proxy.cache/__quota/' + day);
    const q = await cache.match(quotaKey);
    const used = q ? (parseInt(await q.text(), 10) || 0) : 0;
    if (used >= DAILY_LIMIT) {
      return new Response(JSON.stringify({ status: 'quota_exceeded', limit: DAILY_LIMIT }), {
        status: 429, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const upstream = await fetch('https://api.context.dev/v1/brand/retrieve', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.CONTEXT_DEV_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'by_name', name }),
    });
    const text = await upstream.text();
    const res = new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
    });
    await cache.put(quotaKey, new Response(String(used + 1), { headers: { 'Cache-Control': 'public, max-age=93600' } }));
    if (upstream.ok) await cache.put(cacheKey, res.clone());
    return res;
  },
};
