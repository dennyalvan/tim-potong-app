/**
 * Shopee Order Sync Worker
 * ------------------------
 * Backend terpisah khusus buat integrasi Shopee Open API v2 — TIDAK menyentuh
 * worker tim-potong-api yang sudah jalan buat produksi/Telegram bot.
 *
 * Alur:
 *   1. Buka  /auth/authorize          -> redirect ke halaman approve Shopee
 *   2. Shopee redirect balik ke       -> /auth/callback?code=...&shop_id=...
 *      Worker tukar code jadi access_token + refresh_token, simpan di KV.
 *   3. Endpoint  /api/orders          -> narik order "Perlu Dikirim" (READY_TO_SHIP)
 *      langsung dari Shopee, auto-refresh token kalau sudah mau expired.
 *
 * WAJIB diisi sebelum dipakai (lihat README.md):
 *   - Secrets (wrangler secret put ...): SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_REDIRECT_URL
 *   - wrangler.toml: KV namespace binding SHOPEE_KV (buat nyimpen access/refresh token)
 *
 * Referensi resmi: https://open.shopee.com/developer-guide (bagian Authorization & Signature)
 */

const HOST = 'https://partner.shopeemobile.com'; // ganti ke partner.test-stable.shopeemobile.com kalau masih di sandbox

// ── HELPER: HMAC-SHA256 pakai Web Crypto (tersedia native di Cloudflare Workers) ──
async function hmacSha256Hex(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*', // persempit ke domain rekap-order kamu kalau mau lebih ketat
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ── Simpan / ambil token dari KV ──
async function saveToken(env, shopId, tokenData) {
  await env.SHOPEE_KV.put(`shop:${shopId}`, JSON.stringify(tokenData));
}
async function getToken(env, shopId) {
  const raw = await env.SHOPEE_KV.get(`shop:${shopId}`);
  return raw ? JSON.parse(raw) : null;
}

// ── Tukar authorization code jadi access_token pertama kali ──
async function exchangeCodeForToken(env, code, shopId) {
  const path = '/api/v2/auth/token/get';
  const ts = nowTs();
  const baseString = `${env.SHOPEE_PARTNER_ID}${path}${ts}`;
  const sign = await hmacSha256Hex(env.SHOPEE_PARTNER_KEY, baseString);

  const url = `${HOST}${path}?partner_id=${env.SHOPEE_PARTNER_ID}&timestamp=${ts}&sign=${sign}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      shop_id: Number(shopId),
      partner_id: Number(env.SHOPEE_PARTNER_ID),
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Shopee auth error: ${data.error} - ${data.message || ''}`);
  return data; // { access_token, refresh_token, expire_in, ... }
}

// ── Refresh access_token pakai refresh_token yang tersimpan ──
async function refreshAccessToken(env, shopId, refreshToken) {
  const path = '/api/v2/auth/access_token/get';
  const ts = nowTs();
  const baseString = `${env.SHOPEE_PARTNER_ID}${path}${ts}`;
  const sign = await hmacSha256Hex(env.SHOPEE_PARTNER_KEY, baseString);

  const url = `${HOST}${path}?partner_id=${env.SHOPEE_PARTNER_ID}&timestamp=${ts}&sign=${sign}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: refreshToken,
      shop_id: Number(shopId),
      partner_id: Number(env.SHOPEE_PARTNER_ID),
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Shopee refresh error: ${data.error} - ${data.message || ''}`);
  return data;
}

// ── Pastikan ada access_token yang masih valid, refresh otomatis kalau perlu ──
async function ensureValidToken(env, shopId) {
  const stored = await getToken(env, shopId);
  if (!stored) throw new Error(`Belum ada token untuk shop_id ${shopId}. Buka /auth/authorize dulu.`);

  const safetyMarginSec = 300; // refresh 5 menit sebelum expired
  if (nowTs() < stored.obtained_at + stored.expire_in - safetyMarginSec) {
    return stored.access_token; // masih valid
  }

  const refreshed = await refreshAccessToken(env, shopId, stored.refresh_token);
  const newData = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    expire_in: refreshed.expire_in,
    obtained_at: nowTs(),
  };
  await saveToken(env, shopId, newData);
  return newData.access_token;
}

// ── Panggil endpoint shop-level Shopee (butuh access_token + shop_id di signature) ──
async function callShopApi(env, shopId, path, params = {}) {
  const accessToken = await ensureValidToken(env, shopId);
  const ts = nowTs();
  const baseString = `${env.SHOPEE_PARTNER_ID}${path}${ts}${accessToken}${shopId}`;
  const sign = await hmacSha256Hex(env.SHOPEE_PARTNER_KEY, baseString);

  const url = new URL(HOST + path);
  url.searchParams.set('partner_id', env.SHOPEE_PARTNER_ID);
  url.searchParams.set('timestamp', ts);
  url.searchParams.set('sign', sign);
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('shop_id', shopId);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString());
  return res.json();
}

// ── ROUTES ──
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // GET /  -> status check sederhana
    if (url.pathname === '/') {
      return json({ status: 'ok', service: 'shopee-order-sync' });
    }

    // GET /auth/authorize -> redirect ke halaman approve Shopee
    if (url.pathname === '/auth/authorize') {
      const path = '/api/v2/shop/auth_partner';
      const ts = nowTs();
      const baseString = `${env.SHOPEE_PARTNER_ID}${path}${ts}`;
      const sign = await hmacSha256Hex(env.SHOPEE_PARTNER_KEY, baseString);
      const authorizeUrl = `${HOST}${path}?partner_id=${env.SHOPEE_PARTNER_ID}&timestamp=${ts}&sign=${sign}&redirect=${encodeURIComponent(env.SHOPEE_REDIRECT_URL)}`;
      return Response.redirect(authorizeUrl, 302);
    }

    // GET /auth/callback?code=...&shop_id=... -> tukar code jadi token, simpan
    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code');
      const shopId = url.searchParams.get('shop_id');
      if (!code || !shopId) return json({ error: 'code atau shop_id tidak ada di query string' }, 400);

      try {
        const tokenRes = await exchangeCodeForToken(env, code, shopId);
        await saveToken(env, shopId, {
          access_token: tokenRes.access_token,
          refresh_token: tokenRes.refresh_token,
          expire_in: tokenRes.expire_in,
          obtained_at: nowTs(),
        });
        return json({
          status: 'authorized',
          shop_id: shopId,
          message: 'Token tersimpan. Sekarang bisa panggil /api/orders?shop_id=' + shopId,
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // GET /api/orders?shop_id=...&status=READY_TO_SHIP -> narik daftar order
    if (url.pathname === '/api/orders') {
      const shopId = url.searchParams.get('shop_id');
      const status = url.searchParams.get('status') || 'READY_TO_SHIP';
      if (!shopId) return json({ error: 'shop_id wajib diisi' }, 400);

      try {
        const data = await callShopApi(env, shopId, '/api/v2/order/get_order_list', {
          order_status: status,
          time_range_field: 'create_time',
          time_from: nowTs() - 30 * 24 * 3600, // 30 hari terakhir, sesuaikan sesuai kebutuhan
          time_to: nowTs(),
          page_size: 100,
        });
        return json(data);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: 'Route tidak ditemukan' }, 404);
  },
};
