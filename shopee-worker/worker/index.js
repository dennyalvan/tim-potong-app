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
 *   4. Endpoint  /api/orders-full     -> versi lengkap /api/orders: narik SEMUA
 *      order_sn (auto-paginate), lalu tarik detail tiap order (SKU/qty per item)
 *      lewat get_order_detail, dan udah diratain jadi baris siap pakai (format
 *      yang sama kayak hasil parse Excel di app rekap-order).
 *   5. Endpoint  /api/order-detail    -> passthrough get_order_detail mentah,
 *      buat debugging / kebutuhan lain di luar /api/orders-full.
 *   6. Cron Trigger (lihat wrangler.toml)  -> jalan berkala, nyegerin cache
 *      /api/orders-full buat tiap toko yang udah ke-authorize (disimpen di KV
 *      key "shops:index"), sekalian jaga refresh_token gak nganggur kelamaan.
 *
 * WAJIB diisi sebelum dipakai (lihat README.md):
 *   - Secrets (wrangler secret put ...): SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_REDIRECT_URL
 *   - wrangler.toml: KV namespace binding SHOPEE_KV (buat nyimpen access/refresh token + cache)
 *
 * Referensi resmi: https://open.shopee.com/developer-guide (bagian Authorization & Signature)
 *
 * CATATAN PENTING soal bentuk response Shopee: hampir semua endpoint v2 ngebungkus
 * data asli di dalam field "response", contoh:
 *   { request_id, error, message, response: { access_token, ... } }
 * callShopApi() di bawah nanganin ini otomatis (unwrap + lempar error kalau
 * data.error keisi), jadi semua kode yang manggil callShopApi() bisa akses
 * field-nya langsung tanpa perlu ".response". Field response_optional_fields
 * (mis. "ship_by_date") mengikuti dokumentasi resmi Shopee — kalau pas testing
 * beneran ternyata namanya beda, tinggal disesuaikan di getOrderDetail().
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

// ── Daftar shop_id yang udah pernah authorize — dipakai Cron Trigger buat tau
// toko mana aja yang perlu di-sync otomatis. ──
async function addShopToIndex(env, shopId) {
  const raw = await env.SHOPEE_KV.get('shops:index');
  const list = raw ? JSON.parse(raw) : [];
  const id = String(shopId);
  if (!list.includes(id)) {
    list.push(id);
    await env.SHOPEE_KV.put('shops:index', JSON.stringify(list));
  }
}
async function getShopIndex(env) {
  const raw = await env.SHOPEE_KV.get('shops:index');
  return raw ? JSON.parse(raw) : [];
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
  return data.response || data; // { access_token, refresh_token, expire_in, ... }
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
  return data.response || data;
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

// ── Panggil endpoint shop-level Shopee (butuh access_token + shop_id di signature).
// Otomatis unwrap ".response" dan lempar error kalau Shopee balikin error. ──
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
  const data = await res.json();
  if (data.error) throw new Error(`Shopee API error (${path}): ${data.error} - ${data.message || ''}`);
  return data.response !== undefined ? data.response : data;
}

// ── Tarik SEMUA order_sn untuk status tertentu, auto-paginate pakai cursor
// sampai habis. Dibatasi 50 halaman (~5000 order) buat jaga-jaga kalau ada
// bug bikin loop gak berhenti. ──
async function listAllOrderSns(env, shopId, status, days) {
  const orderSns = [];
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const data = await callShopApi(env, shopId, '/api/v2/order/get_order_list', {
      order_status: status,
      time_range_field: 'create_time',
      time_from: nowTs() - days * 24 * 3600,
      time_to: nowTs(),
      page_size: 100,
      cursor,
    });
    (data.order_list || []).forEach(o => orderSns.push(o.order_sn));
    if (!data.more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return orderSns;
}

// ── Detail order (SKU/qty per item) — max 50 order_sn per panggilan (batas Shopee). ──
async function getOrderDetail(env, shopId, orderSnList, optionalFields = 'item_list,order_status,pay_time,ship_by_date') {
  if (orderSnList.length > 50) throw new Error('getOrderDetail: maksimal 50 order_sn per panggilan (batas Shopee)');
  return callShopApi(env, shopId, '/api/v2/order/get_order_detail', {
    order_sn_list: orderSnList.join(','),
    response_optional_fields: optionalFields,
  });
}

// ── Gabungan get_order_list + get_order_detail, diratain jadi baris siap pakai
// dengan bentuk PERSIS sama kayak hasil parse Excel di app rekap-order (lihat
// extractFileData() di rekap-order/index.html), jadi tinggal disambung ke
// buildRekap() tanpa perlu mapping tambahan di frontend. ──
async function fetchOrdersFull(env, shopId, { status = 'READY_TO_SHIP', days = 30 } = {}) {
  const orderSns = await listAllOrderSns(env, shopId, status, days);
  const rows = [];

  const chunkSize = 50;
  for (let i = 0; i < orderSns.length; i += chunkSize) {
    const chunk = orderSns.slice(i, i + chunkSize);
    const detail = await getOrderDetail(env, shopId, chunk);
    (detail.order_list || []).forEach(order => {
      const payTime = order.pay_time ? new Date(order.pay_time * 1000).toISOString() : null;
      const shipByDate = order.ship_by_date ? new Date(order.ship_by_date * 1000).toISOString() : null;
      const isBatal = order.order_status === 'CANCELLED';

      (order.item_list || []).forEach(item => {
        // Item tanpa variasi tetep punya 1 entri di model_list (default Shopee) —
        // fallback ini cuma jaga-jaga kalau suatu saat itemnya kosong.
        const models = (item.model_list && item.model_list.length)
          ? item.model_list
          : [{ model_sku: item.item_sku, model_name: '', model_quantity_purchased: item.item_quantity_purchased || 0 }];

        models.forEach(model => {
          const qty = model.model_quantity_purchased || 0;
          if (!qty) return;
          rows.push({
            sku: model.model_sku || item.item_sku || '',
            variasi: model.model_name || '',
            produk: item.item_name || '',
            qty,
            pesanan: order.order_sn,
            resi: '', // no. resi baru ada setelah label dicetak (bukan dari endpoint ini)
            isBatal,
            waktuKirim: shipByDate,
            waktuBayar: payTime,
          });
        });
      });
    });
  }

  return { shop_id: String(shopId), order_count: orderSns.length, rows, synced_at: new Date().toISOString() };
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
        await addShopToIndex(env, shopId);
        return json({
          status: 'authorized',
          shop_id: shopId,
          message: 'Token tersimpan. Sekarang bisa panggil /api/orders?shop_id=' + shopId,
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // GET /api/orders?shop_id=...&status=READY_TO_SHIP -> narik daftar order (ringkasan, 1 halaman)
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

    // GET /api/order-detail?shop_id=...&order_sn_list=SN1,SN2,... -> detail mentah (max 50 order_sn)
    if (url.pathname === '/api/order-detail') {
      const shopId = url.searchParams.get('shop_id');
      const orderSnParam = url.searchParams.get('order_sn_list');
      if (!shopId || !orderSnParam) return json({ error: 'shop_id dan order_sn_list wajib diisi' }, 400);
      const orderSnList = orderSnParam.split(',').map(s => s.trim()).filter(Boolean);

      try {
        const data = await getOrderDetail(env, shopId, orderSnList);
        return json(data);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // GET /api/orders-full?shop_id=...&status=READY_TO_SHIP&days=30
    // -> auto-paginate SEMUA order + tarik detail SKU/qty per item, diratain jadi
    // baris siap pakai buat app rekap-order (tombol "Sync dari Shopee"). Juga
    // nyimpen hasilnya ke KV sebagai cache buat Cron Trigger.
    if (url.pathname === '/api/orders-full') {
      const shopId = url.searchParams.get('shop_id');
      const status = url.searchParams.get('status') || 'READY_TO_SHIP';
      const days = Number(url.searchParams.get('days')) || 30;
      if (!shopId) return json({ error: 'shop_id wajib diisi' }, 400);

      try {
        const result = await fetchOrdersFull(env, shopId, { status, days });
        await env.SHOPEE_KV.put(`cache:orders:${shopId}`, JSON.stringify(result));
        return json(result);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: 'Route tidak ditemukan' }, 404);
  },

  // ── Cron Trigger (jadwal di wrangler.toml) — nyegerin cache /api/orders-full
  // buat tiap toko yang udah authorize (tersimpan di KV "shops:index"). Selain
  // biar data selalu update tanpa perlu buka app, ini juga jaga supaya
  // refresh_token gak nganggur kelamaan (Shopee bisa minta re-authorize kalau
  // gak pernah dipakai dalam waktu lama). ──
  async scheduled(event, env, ctx) {
    const shopIds = await getShopIndex(env);
    for (const shopId of shopIds) {
      try {
        const result = await fetchOrdersFull(env, shopId, { status: 'READY_TO_SHIP', days: 30 });
        await env.SHOPEE_KV.put(`cache:orders:${shopId}`, JSON.stringify(result));
      } catch (e) {
        // 1 toko error jangan sampe ngehentiin sync toko lain di cron ini.
        console.error(`[cron] sync gagal buat shop_id ${shopId}: ${e.message}`);
      }
    }
  },
};
