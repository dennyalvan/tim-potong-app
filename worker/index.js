// ============================================================
// CODE WORKER PRODUKSI ver.46
// ============================================================
// PERUBAHAN ver.46 (request Denny): handleSubmitProduksi_ sekarang nyimpen sumber kg (manual/
// "Pakai Habis"/"Pakai Estimasi") ke kolom baru tim_potong.sumber_kg - dikirim dari Mini App
// lewat payload.kgSumber (item tunggal), payload.kombinasi.kgSumber[] (kombinasi, per slot -
// slot 1/2 disimpan di dalam ref_stok.sumberKg), atau payload.kgSumber1/kgSumber2 (custom).
// Ini GANTI dari sebelumnya nampilin "[Pakai Habis]"/"[Estimasi]" di teks Telegram - sekarang
// keterangan itu cuma di antrian Mini App & kolom database ini, gak lagi masuk pesan Telegram.
// ============================================================
// CODE WORKER PRODUKSI ver.45
// ============================================================
// PERUBAHAN ver.45: fix bug FUNDAMENTAL di fitur "Riwayat Pemakaian" (dashboard) - dibuktikan
// langsung ke Supabase (Denny lapor screenshot: STEEL BLUE roll 1608 & MUSTARD roll 1863
// nampilin "kg awal estimasi" >40kg padahal kg_terpakai KEDUANYA = 0.00 di database, riwayat yang
// tampil sebenarnya milik roll LAIN). Root cause: kode_roll TERNYATA gak unik sama sekali - query
// pembuktian nemu kode "7046" dipakai 10 roll MERAH BERBEDA sekaligus, "0002" dipakai HITAM &
// COKLAT bareng, dst. Endpoint lama /data/export-tim-potong (filter teks kode_roll, ver.48
// sempat ditambah cek warna) gak akan PERNAH 100% benar selama itu masih text-matching. Endpoint
// baru GET /data/riwayat-pemakaian-kain - sumbernya log_pemakaian_kain (stok_kain_id = FK asli
// ke stok_kain.id, gak mungkin salah karena itu row database, bukan ketikan bebas).
//
// Riwayat versi lengkap: git log.
//
// SETUP AWAL (referensi kalau perlu deploy ulang dari nol): Cloudflare Worker "tim-potong-api"
// + Supabase (SUPABASE_URL, SUPABASE_SECRET_KEY sebagai secret) + Telegram
// (TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_CHAT_ID, TELEGRAM_QC_CHAT_ID, ALLOWED_USER_ID opsional)
// + INTERNAL_SYNC_TOKEN (secret baru ver.29, buat proxy Apps Script -> Supabase)
// + ADMIN_USER_ID (secret baru ver.33, buat fitur Hapus Laporan & Hapus Log QC).
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // v.02: CORS - tanpa ini, browser/WebView (termasuk Mini App Telegram) NOLAK baca balasan
    // Worker karena beda origin (GitHub Pages vs *.workers.dev). "OPTIONS" adalah preflight
    // request yang otomatis dikirim browser SEBELUM request POST beneran - wajib dibalas cepat
    // dengan header izin ini, baru browser mau lanjut kirim POST yang asli.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS_ });
    }

    if (url.pathname === '/' && request.method === 'GET') {
      return jsonResponse({ ok: true, pesan: 'Worker Produksi TIM POTONG jalan normal.' });
    }

    // v.18: WEBHOOK UTAMA Telegram - jalur cepat khusus /produksi & /stok (balas tombol
    // LANGSUNG dari sini, gak nyentuh Sheets/Apps Script sama sekali), semua update LAIN
    // (laporan teks, foto nota, callback tombol nota) diteruskan mentah-mentah ke Apps Script
    // yang tetap pegang logic aslinya. Lihat handleTelegramWebhook_ di bawah.
    if (url.pathname === '/telegram-webhook' && request.method === 'POST') {
      return await handleTelegramWebhook_(request, env);
    }

    // Endpoint SEMENTARA buat testing Tahap 1 - bakal dihapus/diganti nanti di Tahap 3+
    // begitu endpoint submit beneran sudah ada. Fungsinya CUMA cek initData valid atau enggak.
    if (url.pathname === '/tes-validasi-initdata' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      const hasil = await validasiInitData_(body.initData, env);
      return jsonResponse(hasil, hasil.ok ? 200 : 400);
    }

    // v.03 (Tahap 2) - endpoint data referensi buat dropdown Mini App, baca langsung dari
    // Supabase. Semua GET, gak perlu initData (data referensi doang, bukan nulis apa-apa).
    if (url.pathname === '/data/kategori-varian' && request.method === 'GET') {
      return await proxySupabaseGet_(env, '/rest/v1/kategori_varian_produksi?select=*&order=urutan.asc');
    }
    if (url.pathname === '/data/kombinasi-warna' && request.method === 'GET') {
      return await proxySupabaseGet_(env, '/rest/v1/kombinasi_warna?select=*');
    }
    if (url.pathname === '/data/standar-pemakaian' && request.method === 'GET') {
      return await proxySupabaseGet_(env, '/rest/v1/standar_pemakaian?select=*');
    }
    if (url.pathname === '/data/warna-kanonik' && request.method === 'GET') {
      return await handleWarnaKanonik_(env);
    }
    if (url.pathname === '/data/stok-roll' && request.method === 'GET') {
      return await handleStokRollPerWarna_(env);
    }

    // v.04 (Tahap 3) - submit item produksi BIASA (belum kombinasi) ke tim_potong.
    // BELUM potong stok kain, BELUM anti-duplikat - lihat catatan di banner atas file.
    if (url.pathname === '/submit-produksi' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      return await handleSubmitProduksi_(body, env);
    }

    // v.09 (Dashboard Tahap 1) - daftar laporan yang belum SELESAI, buat tab "Proses & QC"
    if (url.pathname === '/data/laporan-qc' && request.method === 'GET') {
      return await handleDaftarLaporanQC_(env);
    }

    // v.10 (Dashboard Tahap 2) - submit input QC (mode Ringkas / Rincian)
    if (url.pathname === '/submit-qc' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      return await handleSubmitQC_(body, env);
    }

    // v.32 - cek apakah user Telegram yang buka Dashboard ini termasuk admin (daftar di secret
    // ADMIN_USER_ID) - dipakai frontend buat nentuin tombol "Hapus Laporan" ditampilin atau
    // enggak. Ini CUMA buat kepentingan tampilan (UX) - keamanan sebenarnya tetap ditegakkan di
    // /data/hapus-laporan sendiri (endpoint itu ngecek ulang dari nol, gak percaya klaim client).
    if (url.pathname === '/data/cek-admin' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      return await handleCekAdmin_(body, env);
    }

    // v.32 - hapus 1 laporan tim_potong beserta semua data anaknya (log_qc, log_pemakaian_kain,
    // arsip_selesai - stok kain otomatis balik lewat trigger yang sudah ada), KHUSUS admin
    // (daftar di secret ADMIN_USER_ID, dipisah koma kalau lebih dari 1 orang). Sekalian best-
    // effort hapus pesan notifikasi QC di Telegram (kalau ada) - gagal hapus pesan TIDAK
    // menggagalkan hapus datanya (mis. pesan udah lama/dihapus manual/bot bukan admin grup).
    if (url.pathname === '/data/hapus-laporan' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      return await handleHapusLaporan_(body, env);
    }

    // v.34 - hapus/batalkan 1 baris submit QC (log_qc), dipakai tombol Hapus di tab REKAP QC.
    // Beda dari /data/hapus-laporan (itu hapus 1 laporan tim_potong LENGKAP) - ini cuma
    // membatalkan 1x submit-nya, progress laporan induk dihitung ulang dari sisanya.
    if (url.pathname === '/data/hapus-log-qc' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      return await handleHapusLogQC_(body, env);
    }

    // v.11 (Dashboard Tahap 3) - ringkasan + detail stok kain yang BELUM DISENTUH SAMA SEKALI
    if (url.pathname === '/data/stok-utuh' && request.method === 'GET') {
      return await handleStokUtuh_(env);
    }

    // v.30 - roll yang udah HABIS (kg_sisa <= 0), buat "Arsip"/"Stok Habis" di tab Stok Kain
    // (request Denny - dipisah dari /data/stok-utuh yang emang sengaja cuma nampilin sisa > 0)
    if (url.pathname === '/data/stok-habis' && request.method === 'GET') {
      return await handleStokHabis_(env);
    }

    // v.47 - roll yang udah kepake SEBAGIAN tapi belum habis (kg_terpakai>0 & kg_sisa>0),
    // kategori terpisah di tab Stok Kain (request Denny).
    if (url.pathname === '/data/stok-terpakai-sebagian' && request.method === 'GET') {
      return await handleStokTerpakaiSebagian_(env);
    }

    // v.41 - detail 1 roll KHUSUS admin: harga_rp_kg, diskon_rp_kg, subtotal (nilai SISA stok =
    // kg_sisa x harga bersih diskon), plus riwayat write-off manual. Dipakai buka form Edit di
    // dashboard. Info harga SENGAJA gak pernah lewat /data/stok-utuh (endpoint publik) - baru
    // kebuka lewat endpoint ini setelah initData divalidasi & terbukti admin.
    if (url.pathname === '/data/detail-stok-kain' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      return await handleDetailStokKainAdmin_(body, env);
    }

    // v.41 - edit field stok_kain (tgl_beli/supplier/warna/kg/kode_roll/harga/diskon), admin-only.
    if (url.pathname === '/data/edit-stok-kain' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      return await handleEditStokKain_(body, env);
    }

    // v.41 - write-off manual: tandai sejumlah kg (boleh partial) sebagai terpakai TANPA lewat
    // laporan produksi (misal rusak/hilang/sisa gak kepake), admin-only, tercatat di
    // log_writeoff_kain sebagai histori (gak pernah dihapus fisik).
    if (url.pathname === '/data/writeoff-kain' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      return await handleWriteoffKain_(body, env);
    }

    // v.41 - batal 1 write-off (soft-cancel, status='dibatalkan' - BUKAN dihapus fisik biar
    // histori tetap ada), balikin kg_terpakai ke stok_kain, admin-only.
    if (url.pathname === '/data/batal-writeoff' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      return await handleBatalWriteoff_(body, env);
    }

    // v.42 - edit 1x submit QC (log_qc) yang udah masuk: batalkan baris lama (append-only,
    // reuse persis logic /data/hapus-log-qc) lalu submit ulang angka terkoreksi lewat jalur
    // /submit-qc yang sama, admin-only.
    if (url.pathname === '/data/edit-log-qc' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      return await handleEditLogQC_(body, env);
    }

    // v.42 - edit data dasar laporan produksi (tim_potong): nama item/jumlah/ukuran, TERMASUK
    // kode roll & kg pemakaian buat stok opname. Kode roll/kg yang berubah otomatis potong-ulang
    // stok (hapus potongan lama -> trigger yang sudah ada balikin kg_terpakai -> potong lagi
    // pakai nilai baru, reuse kurangiStokKain_ yang sama dipakai submit produksi). Item kombinasi
    // (ref_stok) belum didukung buat field ini di v1. jumlah/ukuran diblokir kalau laporan udah
    // punya progres QC (status != kosong) - admin-only.
    if (url.pathname === '/data/edit-produksi' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Body harus JSON.' }, 400); }
      return await handleEditProduksi_(body, env);
    }

    // v.13 (Dashboard Tahap 4) - arsip laporan yang sudah SELESAI, N hari terakhir
    if (url.pathname === '/data/arsip-selesai' && request.method === 'GET') {
      const hari = parseInt(url.searchParams.get('hari'), 10) || 3;
      return await handleArsipSelesai_(env, hari);
    }

    // v.14 - export flat buat sinkron ke Sheet akuntansi (SEMUA status, N bulan terakhir)
    if (url.pathname === '/data/export-akuntansi' && request.method === 'GET') {
      const bulan = parseInt(url.searchParams.get('bulan'), 10) || 6;
      return await handleExportAkuntansi_(env, bulan);
    }

    // v.15 - Rekap QC: histori submit QC apa adanya (1 baris = 1x submit), buat tab baru
    // "Rekap QC" di Dashboard. SENGAJA gak nyertain harga_jait/total_bayar (info akunting,
    // bukan buat tim potong/QC lihat).
    if (url.pathname === '/data/rekap-qc' && request.method === 'GET') {
      const hari = parseInt(url.searchParams.get('hari'), 10) || 14;
      return await handleRekapQC_(env, hari);
    }

    // v.27 - export stok_kain yang MASIH ADA SISA (kg_sisa > 0), dipakai skrip Apps Script
    // terpisah (CODE SYNC AKUNTANSI.js) buat sinkron sheet STOK KAIN tiap jam.
    if (url.pathname === '/data/export-stok-kain' && request.method === 'GET') {
      return await handleExportStokKain_(env);
    }

    // v.28 - export tim_potong MENTAH (semua kolom, bukan versi ringkas kayak
    // export-akuntansi), dipakai CODE SYNC AKUNTANSI.js buat sinkron sheet TIM POTONG asli.
    if (url.pathname === '/data/export-tim-potong' && request.method === 'GET') {
      const bulan = parseInt(url.searchParams.get('bulan'), 10) || 6;
      return await handleExportTimPotongMentah_(env, bulan);
    }

    // v.45 - riwayat pemakaian kain per roll, dipakai fitur "Riwayat Pemakaian" di dashboard.
    // SUMBERNYA log_pemakaian_kain (FK stok_kain_id ASLI ke stok_kain.id) - BUKAN tim_potong
    // di-filter teks kode_roll kayak sebelumnya. Root cause bug yang ditemukan Denny (roll warna
    // lain nyasar tampil, "kg awal estimasi" ngaco >40kg padahal roll max ~30kg): kode_roll
    // TERNYATA gak unik sama sekali - bisa dobel di warna SAMA (mis. 10 roll MERAH beda semua
    // pake kode "7046") maupun warna BEDA (kode "0002" dipake HITAM & COKLAT sekaligus). Text-
    // matching (kode_roll, atau kode_roll+warna) gak akan pernah 100% benar selama itu bisa
    // tabrakan - FK stok_kain_id yang gak mungkin salah, karena itu row database asli, bukan
    // ketikan bebas. Cuma 38 baris (2026-08-19) - diambil semua sekaligus, gak perlu filter bulan.
    if (url.pathname === '/data/riwayat-pemakaian-kain' && request.method === 'GET') {
      return await handleRiwayatPemakaianKain_(env);
    }

    // v.28 - export log_qc MENTAH TERMASUK harga_jait/total_bayar (beda dari /data/rekap-qc
    // yang sengaja gak nyertain info uang itu buat tim potong/QC) - KHUSUS dipakai CODE SYNC
    // AKUNTANSI.js buat sinkron sheet LOG QC, bukan buat dashboard/Mini App.
    if (url.pathname === '/data/export-log-qc' && request.method === 'GET') {
      const bulan = parseInt(url.searchParams.get('bulan'), 10) || 6;
      return await handleExportLogQCMentah_(env, bulan);
    }

    // v.29 - proxy INSERT stok_kain buat CODE TIM POTONG.js (Apps Script) - dipakai KHUSUS
    // buat fitur "kain masuk" (command teks & konfirmasi baca nota foto), karena UrlFetchApp
    // Apps Script gak bisa dipakai langsung ke Supabase (ke-block "Forbidden use of secret API
    // key in browser" - Apps Script gak bisa override User-Agent, keterbatasan Google, bukan
    // bug kita). Jadi Apps Script kirim ke SINI (bukan ke Supabase langsung), Worker yang
    // terusin pakai SUPABASE_SECRET_KEY (sudah kesimpen aman sebagai Cloudflare secret, gak
    // perlu lagi nempel di kode Apps Script). Proteksi: header X-Internal-Token harus cocok
    // env.INTERNAL_SYNC_TOKEN (secret baru, beda dari SUPABASE_SECRET_KEY).
    if (url.pathname === '/internal/stok-masuk' && request.method === 'POST') {
      return await handleInternalStokMasuk_(request, env);
    }

    // v.37 - proxy DEBUG/DEPLOY ke Apps Script (CODE TIM POTONG) - biar Claude bisa baca/tulis
    // Script Properties DAN deploy kode baru ke Apps Script tanpa Denny buka dashboard manual.
    // Proteksi: header X-GAS-Debug-Token harus cocok env.GAS_DEBUG_TOKEN (secret TERPISAH dari
    // INTERNAL_SYNC_TOKEN - kalau salah satu bocor, yang lain tetap aman). Worker cuma neruskan
    // body mentah ke Apps Script Web App (yang punya action-nya sendiri: gasDebugGetProperty/
    // gasDebugSetProperty/gasDebugDeleteProperty/gasDebugListProperties/gasDebugUpdateCode) -
    // logic sebenarnya ada di sisi Apps Script, Worker di sini murni jembatan jaringan (karena
    // domain script.google.com gak bisa diakses langsung dari sandbox Claude).
    if (url.pathname === '/internal/gas-debug' && request.method === 'POST') {
      return await handleGasDebugProxy_(request, env);
    }

    return jsonResponse({ ok: false, error: 'Endpoint tidak ditemukan: ' + url.pathname }, 404);
  }
};

const CORS_HEADERS_ = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS_)
  });
}

// ============================================================
// Validasi initData Telegram Mini App - PORTING PERSIS dari validasiInitDataMiniApp_() di
// CODE TIM POTONG.js (Apps Script), pakai Web Crypto API (bukan Utilities.computeHmacSha256Signature
// yang cuma ada di Apps Script). Algoritmanya identik, sumbernya sama:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ============================================================
async function validasiInitData_(initData, env) {
  try {
    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (!botToken || !initData) return { ok: false, error: 'initData atau TELEGRAM_BOT_TOKEN kosong.' };

    const pasangan = [];
    let hashDiterima = null;
    initData.split('&').forEach(function (bagian) {
      const idx = bagian.indexOf('=');
      if (idx === -1) return;
      const key = decodeURIComponent(bagian.substring(0, idx));
      const val = decodeURIComponent(bagian.substring(idx + 1));
      if (key === 'hash') { hashDiterima = val; } else { pasangan.push(key + '=' + val); }
    });
    if (!hashDiterima) return { ok: false, error: 'initData tidak punya hash.' };
    pasangan.sort();
    const dataCheckString = pasangan.join('\n');

    const encoder = new TextEncoder();
    const secretKeyBytes = await hmacSha256_(encoder.encode('WebAppData'), encoder.encode(botToken));
    const hashBytes = await hmacSha256_(secretKeyBytes, encoder.encode(dataCheckString));
    const hashHex = Array.from(hashBytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');

    if (hashHex !== hashDiterima) return { ok: false, error: 'Tanda tangan initData tidak cocok (kemungkinan dipalsukan).' };

    const authDateStr = pasangan.find(function (p) { return p.indexOf('auth_date=') === 0; });
    const authDate = authDateStr ? parseInt(authDateStr.split('=')[1], 10) : 0;
    if (!authDate || (Date.now() / 1000 - authDate) > 86400) {
      return { ok: false, error: 'initData sudah kedaluwarsa, buka ulang Mini App-nya.' };
    }

    const userStr = pasangan.find(function (p) { return p.indexOf('user=') === 0; });
    let userId = null;
    if (userStr) {
      try { userId = String(JSON.parse(userStr.substring(5)).id); } catch (e2) { userId = null; }
    }

    const allowedUserId = env.ALLOWED_USER_ID;
    if (allowedUserId && userId !== String(allowedUserId)) {
      return { ok: false, error: 'User Telegram ini tidak diizinkan input produksi.' };
    }

    return { ok: true, userId: userId };
  } catch (e) {
    return { ok: false, error: 'Error validasi: ' + e.message };
  }
}

// v.32 - cek userId Telegram terhadap daftar admin di secret ADMIN_USER_ID (dipisah koma kalau
// lebih dari 1 orang, mis. "111111,222222"). Dipakai buat fitur Hapus Laporan - user biasa
// TETAP bisa lihat & submit seperti biasa, cuma aksi hapus yang dibatasi ke daftar ini.
function cekAdmin_(userId, env) {
  const daftar = String(env.ADMIN_USER_ID || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return daftar.length > 0 && daftar.indexOf(String(userId)) !== -1;
}

async function handleCekAdmin_(body, env) {
  const validasi = await validasiInitData_(body.initData, env);
  if (!validasi.ok) return jsonResponse(validasi, 401);
  return jsonResponse({ ok: true, isAdmin: cekAdmin_(validasi.userId, env) });
}

async function handleHapusLaporan_(body, env) {
  const validasi = await validasiInitData_(body.initData, env);
  if (!validasi.ok) return jsonResponse(validasi, 401);
  if (!cekAdmin_(validasi.userId, env)) {
    return jsonResponse({ ok: false, error: 'Kamu tidak punya izin menghapus laporan.' }, 403);
  }

  const timPotongId = parseInt(body.timPotongId, 10);
  if (!timPotongId) return jsonResponse({ ok: false, error: 'timPotongId wajib diisi.' }, 400);

  try {
    const rowsTP = await ambilDariSupabase_(env, '/rest/v1/tim_potong?select=id,jenis_warna_baju,id_pesan_qc&id=eq.' + timPotongId);
    if (!rowsTP || rowsTP.length === 0) {
      return jsonResponse({ ok: false, error: 'Laporan id=' + timPotongId + ' tidak ditemukan (mungkin sudah dihapus duluan).' }, 404);
    }
    const tp = rowsTP[0];

    // hapus_tim_potong_lengkap() (fungsi Postgres yang sudah ada) - hapus child-first
    // (log_pemakaian_kain -> arsip_selesai -> log_qc -> tim_potong). Stok kain otomatis balik
    // lewat trigger kembalikan_stok_kain_saat_hapus_log_pemakaian yang udah lama ada.
    const resRpc = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/hapus_tim_potong_lengkap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY },
      body: JSON.stringify({ ids: [timPotongId] })
    });
    if (resRpc.status >= 300) {
      return jsonResponse({ ok: false, error: 'Gagal hapus dari Supabase: HTTP ' + resRpc.status + ' ' + (await resRpc.text()).substring(0, 300) }, 500);
    }
    const ringkasanHapus = await resRpc.json();

    // Best-effort hapus pesan notifikasi QC di Telegram - CATATAN: notifikasi PRODUKSI (grup
    // Tim Potong) SENGAJA TIDAK ikut dihapus, karena 1 pesan produksi bisa berisi BEBERAPA item
    // sekaligus (submit gabungan) - kalau ikut dihapus, item LAIN yang masih valid di pesan yang
    // sama ikut hilang catatannya. Notifikasi QC aman dihapus karena 1 laporan = 1 pesan sendiri.
    let pesanQCTerhapus = false;
    if (tp.id_pesan_qc && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_QC_CHAT_ID) {
      try {
        const resDel = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/deleteMessage', {
          method: 'post',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_QC_CHAT_ID, message_id: tp.id_pesan_qc })
        });
        const dataDel = await resDel.json();
        pesanQCTerhapus = !!dataDel.ok;
      } catch (e) { /* diabaikan - hapus data tetap dianggap sukses walau pesan gagal dihapus */ }
    }

    return jsonResponse({ ok: true, nama: tp.jenis_warna_baju, ringkasan: ringkasanHapus, pesanQCTerhapus: pesanQCTerhapus });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// v.34: hapus/batalkan 1 baris submit QC (log_qc) dari tab REKAP QC - BEDA dari Hapus Laporan
// (yang hapus 1 laporan tim_potong LENGKAP). Ini cuma membatalkan 1x submit-nya doang, progress
// laporan induknya dihitung ulang dari sisa log_qc yang masih aktif, notifikasi Telegram QC-nya
// ikut di-update biar sinkron. Khusus admin, sama pola cek-nya kayak Hapus Laporan.
async function handleHapusLogQC_(body, env) {
  const validasi = await validasiInitData_(body.initData, env);
  if (!validasi.ok) return jsonResponse(validasi, 401);
  if (!cekAdmin_(validasi.userId, env)) {
    return jsonResponse({ ok: false, error: 'Kamu tidak punya izin menghapus data QC.' }, 403);
  }

  const logQcId = parseInt(body.logQcId, 10);
  if (!logQcId) return jsonResponse({ ok: false, error: 'logQcId wajib diisi.' }, 400);

  try {
    const rowsLog = await ambilDariSupabase_(env, '/rest/v1/log_qc?select=id,tim_potong_id,status&id=eq.' + logQcId);
    if (!rowsLog || rowsLog.length === 0) {
      return jsonResponse({ ok: false, error: 'Data QC id=' + logQcId + ' tidak ditemukan (mungkin sudah dihapus duluan).' }, 404);
    }
    if (rowsLog[0].status !== 'aktif') {
      return jsonResponse({ ok: false, error: 'Data ini sudah dibatalkan sebelumnya.' }, 400);
    }
    const timPotongId = rowsLog[0].tim_potong_id;

    // Batalkan (append-only - gak dihapus fisik, cuma ditandai, sama kayak pola Undo yang lain)
    await fetch(env.SUPABASE_URL + '/rest/v1/log_qc?id=eq.' + logQcId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'dibatalkan' })
    });

    const rowsTP = await ambilDariSupabase_(env, '/rest/v1/tim_potong?select=id,jumlah,id_pesan_qc,jenis_warna_baju,kode_roll&id=eq.' + timPotongId);
    if (!rowsTP || rowsTP.length === 0) {
      return jsonResponse({ ok: true, catatan: 'Data QC dibatalkan, tapi laporan induknya (id=' + timPotongId + ') sudah gak ada.' });
    }
    const tp = rowsTP[0];

    // Hitung ulang dari SISA log_qc yang masih aktif (setelah pembatalan barusan)
    const kolomUkuran = Object.values(KOLOM_UKURAN_MAP).join(',');
    const rowsSisaAktif = await ambilDariSupabase_(env, '/rest/v1/log_qc?select=varian,total,reject,' + kolomUkuran + '&tim_potong_id=eq.' + timPotongId + '&status=eq.aktif');

    let totalSelesai = 0, totalReject = 0, varianQC = null;
    const perUkuranMap = {};
    rowsSisaAktif.forEach(function (r) {
      totalSelesai += Number(r.total) || 0;
      const rejectObj = parseRejectNotasi_(r.reject);
      totalReject += Object.values(rejectObj).reduce(function (s, v) { return s + v; }, 0);
      if (!varianQC) varianQC = r.varian;
      const ukuranObj = kolomKeUkuran_(r);
      Object.keys(ukuranObj).forEach(function (u) { perUkuranMap[u] = (perUkuranMap[u] || 0) + ukuranObj[u]; });
    });
    const perUkuranBaru = DAFTAR_UKURAN_TIMPOTONG.filter(function (u) { return perUkuranMap[u]; }).map(function (u) { return { ukuran: u, selesai: perUkuranMap[u] }; });

    const sudahSelesaiSemua = (totalSelesai + totalReject) >= tp.jumlah;
    // v.40 FIX: kalau SEMUA log_qc aktif buat laporan ini dibatalkan (rowsSisaAktif kosong,
    // totalSelesai+totalReject balik ke 0), status harus balik jadi STRING KOSONG (sama kayak
    // laporan yang belum pernah disentuh QC sama sekali) - BUKAN "PROSES 0/Y (0 reject)". Bug
    // lama: rumus di bawah selalu bikin teks "PROSES x/y (z reject)" walau x=0 dan z=0,
    // nyangkut jadi keterangan status yang beda dari laporan lain yang emang belum diproses.
    const statusBaru = sudahSelesaiSemua
      ? 'SELESAI'
      : ((totalSelesai + totalReject) === 0 ? '' : ('PROSES ' + totalSelesai + '/' + tp.jumlah + ' (' + totalReject + ' reject)'));

    await fetch(env.SUPABASE_URL + '/rest/v1/tim_potong?id=eq.' + timPotongId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: statusBaru })
    });

    // Kalau tadinya sudah SELESAI & kearsip, tapi sekarang jadi gak lengkap lagi gara-gara
    // pembatalan ini - bersihin arsip_selesai-nya, TAPI lewat fungsi khusus yang gak ikut
    // membatalkan SEMUA log_qc lagi (beda dari kasus hapus arsip manual biasa).
    if (!sudahSelesaiSemua) {
      await fetch(env.SUPABASE_URL + '/rest/v1/rpc/hapus_arsip_selesai_partial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY },
        body: JSON.stringify({ p_tim_potong_id: timPotongId })
      }).catch(function () { /* diabaikan - status tim_potong sudah benar walau ini gagal */ });
    }

    // Sinkronkan notifikasi Telegram QC (kalau ada) biar angkanya gak beda sama dashboard.
    // Kalau progress balik ke NOL total (gak ada log_qc aktif SAMA SEKALI buat laporan ini
    // setelah pembatalan barusan) - hapus pesannya sekalian, bukan diedit jadi "0 dari N" yang
    // gak ada gunanya ditampilin. id_pesan_qc dikosongkan lagi biar submit QC berikutnya kirim
    // pesan baru dari awal (sama kayak submit pertama kali).
    let pesanQCTerhapus = false;
    if (tp.id_pesan_qc) {
      const tidakAdaProgresSamaSekali = rowsSisaAktif.length === 0;
      if (tidakAdaProgresSamaSekali) {
        try {
          const resDel = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/deleteMessage', {
            method: 'post',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: env.TELEGRAM_QC_CHAT_ID, message_id: tp.id_pesan_qc })
          });
          const dataDel = await resDel.json();
          pesanQCTerhapus = !!dataDel.ok;
        } catch (e) { /* diabaikan - pembatalan data tetap dianggap sukses walau pesan gagal dihapus */ }
        await fetch(env.SUPABASE_URL + '/rest/v1/tim_potong?id=eq.' + timPotongId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
          body: JSON.stringify({ id_pesan_qc: null })
        });
      } else {
        await kirimAtauEditNotifikasiQC_(env, tp, totalSelesai, totalReject, statusBaru, varianQC, perUkuranBaru);
      }
    }

    return jsonResponse({ ok: true, timPotongId: timPotongId, statusBaru: statusBaru, pesanQCTerhapus: pesanQCTerhapus });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// v.42 - edit 1x submit QC: secara internal batalkan baris log_qc lama (persis logic
// handleHapusLogQC_ - status jadi 'dibatalkan', BUKAN dihapus fisik, progress dihitung ulang dari
// sisa yang aktif) lalu submit ulang dengan angka terkoreksi lewat handleSubmitQC_ yang sama
// dipakai submit biasa. Dari sisi admin di dashboard keliatan 1 aksi "Edit", tapi di database
// jejaknya tetap 2 baris (lama dibatalkan + baru aktif) - audit trail total_bayar tetap utuh.
async function handleEditLogQC_(body, env) {
  const logQcId = parseInt(body.logQcId, 10);
  if (!logQcId) return jsonResponse({ ok: false, error: 'logQcId wajib diisi.' }, 400);

  const resBatal = await handleHapusLogQC_({ initData: body.initData, logQcId: logQcId }, env);
  const dataBatal = await resBatal.json();
  if (!dataBatal.ok) return jsonResponse({ ok: false, error: 'Gagal batalkan data lama: ' + dataBatal.error }, resBatal.status);
  if (!dataBatal.timPotongId) return jsonResponse({ ok: false, error: 'Data lama dibatalkan, tapi laporan induknya sudah gak ada - gak bisa submit ulang.' }, 400);

  const bodySubmitBaru = Object.assign({ initData: body.initData, timPotongId: dataBatal.timPotongId }, body.dataBaru || {});
  return await handleSubmitQC_(bodySubmitBaru, env);
}

// v.42 - edit data dasar laporan produksi (tim_potong), termasuk kode roll/kg buat stok opname
// (request Denny). Kode roll/kg/nama yang berubah -> hapus SEMUA log_pemakaian_kain lama punya
// laporan ini (trigger trg_kembalikan_stok_kain_saat_hapus_log_pemakaian yang SUDAH ADA otomatis
// balikin kg_terpakai ke roll lama - kalau laporan ini belum pernah kesentuh stok, DELETE 0 baris,
// gak masalah) -> potong ulang pakai kurangiStokKain_ yang SAMA PERSIS dipakai submit produksi.
// 1 mekanisme ini otomatis nyakup laporan yang sudah PERNAH & yang BELUM PERNAH kesentuh stok.
async function handleEditProduksi_(body, env) {
  const validasi = await validasiInitData_(body.initData, env);
  if (!validasi.ok) return jsonResponse(validasi, 401);
  if (!cekAdmin_(validasi.userId, env)) {
    return jsonResponse({ ok: false, error: 'Kamu tidak punya izin mengedit data produksi.' }, 403);
  }

  const id = parseInt(body.id, 10);
  if (!id) return jsonResponse({ ok: false, error: 'id wajib diisi.' }, 400);

  try {
    const rows = await ambilDariSupabase_(env, '/rest/v1/tim_potong?select=*&id=eq.' + id);
    if (!rows || rows.length === 0) return jsonResponse({ ok: false, error: 'Laporan id=' + id + ' tidak ditemukan.' }, 404);
    const tp = rows[0];

    // Guardrail: jumlah/ukuran diblokir kalau laporan ini udah punya progres QC (status != '') -
    // ubah kuantitas setelah QC jalan bisa bikin hitungan yang udah lapor jadi gak konsisten.
    const jumlahBaru = body.jumlah !== undefined ? parseInt(body.jumlah, 10) : tp.jumlah;
    const ubahJumlah = jumlahBaru !== tp.jumlah;
    let ubahUkuran = false;
    if (body.ukuran) {
      DAFTAR_UKURAN_TIMPOTONG.forEach(function (u) {
        const kolom = KOLOM_UKURAN_MAP[u];
        if (body.ukuran[u] !== undefined && (parseFloat(body.ukuran[u]) || 0) !== (parseFloat(tp[kolom]) || 0)) ubahUkuran = true;
      });
    }
    if ((ubahJumlah || ubahUkuran) && tp.status) {
      return jsonResponse({ ok: false, error: 'Laporan ini sudah punya progres QC (status: "' + tp.status + '") - jumlah/ukuran gak bisa diubah lewat sini karena bisa bikin hitungan QC yang udah jalan jadi gak konsisten. Batalkan dulu submit QC terkait kalau memang perlu diubah.' }, 400);
    }

    const namaBaru = body.jenisWarnaBaju !== undefined ? String(body.jenisWarnaBaju).trim() : tp.jenis_warna_baju;
    const kodeRollBaru = body.kodeRoll !== undefined ? (body.kodeRoll ? String(body.kodeRoll).trim() : null) : tp.kode_roll;
    const kgBaru = body.pemakaianKainKg !== undefined ? (parseFloat(body.pemakaianKainKg) || 0) : (parseFloat(tp.pemakaian_kain_kg) || 0);
    if (!namaBaru) return jsonResponse({ ok: false, error: 'Nama item wajib diisi.' }, 400);

    const perluPotongUlang = (namaBaru !== tp.jenis_warna_baju) || (kodeRollBaru !== tp.kode_roll) || (kgBaru !== (parseFloat(tp.pemakaian_kain_kg) || 0));
    const itemKombinasi = Array.isArray(tp.ref_stok) && tp.ref_stok.length > 0;
    if (perluPotongUlang && itemKombinasi) {
      return jsonResponse({ ok: false, error: 'Item ini kombinasi (2-3 warna) - edit nama/kode roll/kg belum didukung lewat sini (v1), soalnya breakdown warna ke-2/ke-3-nya (ref_stok) ikut kepotong terpisah dan belum ada form buat itu. Kasih tau saya kalau perlu, atau edit field lain (jumlah/ukuran) yang gak nyentuh stok.' }, 400);
    }

    if (perluPotongUlang) {
      const rowsLogLama = await ambilDariSupabase_(env, '/rest/v1/log_pemakaian_kain?select=id&tim_potong_id=eq.' + id);
      if (rowsLogLama.length > 0) {
        const resDel = await fetch(env.SUPABASE_URL + '/rest/v1/log_pemakaian_kain?tim_potong_id=eq.' + id, {
          method: 'DELETE',
          headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' }
        });
        if (resDel.status >= 300) return jsonResponse({ ok: false, error: 'Gagal hapus potongan stok lama: HTTP ' + resDel.status }, 500);
      }
    }

    const payload = { jenis_warna_baju: namaBaru, kode_roll: kodeRollBaru, pemakaian_kain_kg: kgBaru };
    if (body.jumlah !== undefined) payload.jumlah = jumlahBaru;
    if (body.ukuran) {
      DAFTAR_UKURAN_TIMPOTONG.forEach(function (u) {
        if (body.ukuran[u] !== undefined) payload[KOLOM_UKURAN_MAP[u]] = parseFloat(body.ukuran[u]) || null;
      });
    }

    const resUpdate = await fetch(env.SUPABASE_URL + '/rest/v1/tim_potong?id=eq.' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
      body: JSON.stringify(payload)
    });
    if (resUpdate.status >= 300) return jsonResponse({ ok: false, error: 'Gagal update laporan: HTTP ' + resUpdate.status + ' ' + (await resUpdate.text()).substring(0, 300) }, 500);

    let peringatanStok = [];
    if (perluPotongUlang && kgBaru > 0) {
      const kamusMap = await ambilKamusSinonimWarnaMap_(env);
      const hasilStok = await kurangiStokKain_(env, namaBaru, kgBaru, kodeRollBaru, id, kamusMap);
      if (!hasilStok.matched) peringatanStok.push(hasilStok.keterangan);
    }

    return jsonResponse({ ok: true, peringatanStok: peringatanStok });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// ANTI-DUPLIKAT (Tahap 5) - porting KONSEP dari cekDanCatatDuplikat_() (Apps Script), tapi
// fingerprint dihitung dari JSON item (bukan teks bebas) & disimpan di tabel Supabase
// log_anti_duplikat (bukan sheet). Jendela waktu SAMA: 24 jam.
// ============================================================
const ANTIDUPLIKAT_WINDOW_MS_ = 24 * 60 * 60 * 1000;

async function hashFingerprint_(teks) {
  const bytes = new TextEncoder().encode(teks);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function formatJarakWaktu_(ms) {
  const menit = Math.round(ms / 60000);
  if (menit < 1) return 'kurang dari 1 menit';
  if (menit < 60) return menit + ' menit';
  const jam = Math.round(menit / 60);
  return jam + ' jam';
}

// v.21: sekarang bisa "longgar lagi" kalau data ASLI dari kiriman yang kecatat itu sudah
// dihapus - TAPI cuma kalau SEMUA baris tim_potong hasil kiriman itu sudah dihapus (Opsi B,
// dipilih Denny). Kalau MASIH ADA minimal 1 baris tersisa dari kiriman itu, tetap dianggap
// duplikat - biar gak ada celah kirim ulang batch yang cuma sebagian barisnya dihapus (lihat
// diskusi lengkap di percakapan). `tim_potong_ids` bisa NULL (submit sebelumnya belum sempat
// nyimpen ID-nya, misal masih diproses / gagal di tengah, ATAU catatan lama dari SEBELUM kolom
// ini ada - lihat catatan v.22) - kalau NULL, TETAP dianggap duplikat dulu (jaga-jaga race
// condition submit hampir bersamaan), bukan otomatis dianggap "sudah kehapus".
// v.22: BEDAKAN null (belum sempat/gak jelas) dari array KOSONG `[]` (KONFIRMASI submit itu
// gagal total, gak ada 1 baris pun kebentuk) - array kosong sekarang otomatis dianggap "gak
// ada yang perlu dilindungi", boleh lolos. Sebelumnya array kosong ke-treat SAMA kayak null
// (tetap ngeblock terus - bug kecil, ketauan pas nyari kenapa catatan v.21 lama masih nyangkut).
async function cekDanCatatDuplikat_(env, chatId, fingerprint, preview) {
  const batasWaktu = new Date(Date.now() - ANTIDUPLIKAT_WINDOW_MS_).toISOString();
  const path = '/rest/v1/log_anti_duplikat?select=id,waktu,tim_potong_ids&chat_id=eq.' + encodeURIComponent(chatId) +
    '&fingerprint=eq.' + encodeURIComponent(fingerprint) + '&waktu=gte.' + encodeURIComponent(batasWaktu) +
    '&order=waktu.desc&limit=1';
  const existing = await ambilDariSupabase_(env, path);

  if (existing && existing.length > 0) {
    const rec = existing[0];
    const ids = Array.isArray(rec.tim_potong_ids) ? rec.tim_potong_ids : null;
    let masihDianggapDuplikat = true;
    if (Array.isArray(ids)) {
      if (ids.length === 0) {
        masihDianggapDuplikat = false; // konfirmasi: kiriman itu emang gak pernah kebentuk baris tim_potong
      } else {
        const stillExist = await ambilDariSupabase_(env, '/rest/v1/tim_potong?select=id&id=in.(' + ids.join(',') + ')&limit=1');
        masihDianggapDuplikat = !!(stillExist && stillExist.length > 0);
      }
    }
    if (masihDianggapDuplikat) {
      const waktuLama = new Date(rec.waktu).getTime();
      return { duplikat: true, jarakMs: Date.now() - waktuLama };
    }
    // semua baris terkait kiriman lama itu sudah dihapus - lolos, lanjut catat ulang di bawah
    // (seperti kiriman baru, bukan reuse baris lama - biar riwayat "waktu" tetap akurat).
  }

  // Bukan duplikat - catat kiriman ini biar submit BERIKUTNYA yang sama persis bisa kedeteksi.
  // v.21: 'return=representation' (bukan 'minimal' lagi) - butuh ID baris ini balik, dipakai
  // buat nempelin tim_potong_ids SETELAH insert tim_potong sukses (lihat handleSubmitProduksi_).
  const resInsert = await fetch(env.SUPABASE_URL + '/rest/v1/log_anti_duplikat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY,
      Prefer: 'return=representation'
    },
    body: JSON.stringify([{ chat_id: chatId, fingerprint: fingerprint, preview: preview }])
  });
  let recordId = null;
  try {
    const inserted = await resInsert.json();
    if (Array.isArray(inserted) && inserted[0]) recordId = inserted[0].id;
  } catch (e) { /* gagal ambil ID gak fatal - cuma berarti tim_potong_ids gak sempat ketempel */ }

  return { duplikat: false, recordId: recordId };
}

// v.21: dipanggil handleSubmitProduksi_ SETELAH insert tim_potong sukses - nempelin daftar ID
// baris yang baru kebentuk ke record log_anti_duplikat yang tadi dicatat cekDanCatatDuplikat_,
// biar nanti bisa dicek "masih ada apa udah kehapus semua" (lihat cekDanCatatDuplikat_ di atas).
async function tempelkanTimPotongIdsKeAntiDuplikat_(env, recordId, timPotongIds) {
  if (!recordId || !Array.isArray(timPotongIds) || timPotongIds.length === 0) return;
  try {
    await fetch(env.SUPABASE_URL + '/rest/v1/log_anti_duplikat?id=eq.' + recordId, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ tim_potong_ids: timPotongIds })
    });
  } catch (e) { /* gagal nempel gak fatal - efeknya paling cuma anti-duplikat kurang presisi
    utk kiriman ini doang, gak ganggu data produksi yang udah kesimpen */ }
}

// ============================================================
// NOTIFIKASI TELEGRAM (Tahap 5) - porting dari kirimPesanKeGrupUtama_() (Apps Script).
// Butuh secret TELEGRAM_GROUP_CHAT_ID (sama nilainya seperti di Apps Script Script Properties).
// ============================================================
const DAYS_ID_ = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

function formatTanggalIndoJakarta_(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', day: 'numeric', month: '2-digit', year: '2-digit' }).formatToParts(date);
  const get = function (type) { const p = parts.find(function (x) { return x.type === type; }); return p ? p.value : ''; };
  // Hari dalam Indonesia dihitung manual dari weekday UTC+7 (Intl weekday locale id-ID kadang
  // beda-beda hasilnya antar environment, jadi dihitung manual biar konsisten).
  const jakartaMs = date.getTime() + 7 * 60 * 60 * 1000;
  const dayIdx = new Date(jakartaMs).getUTCDay();
  return DAYS_ID_[dayIdx] + ',  ' + get('day') + '/' + get('month') + '/' + get('year');
}

// v.23: BUG NYATA ditemukan Denny - kolom `tanggal` di tim_potong sebelumnya default ke
// `new Date().toISOString().slice(0,10)` yang hitung tanggal pakai UTC MENTAH, bukan WIB
// (Asia/Jakarta, UTC+7). Efeknya: submit jam 00:00-06:59 WIB (masih jam 17:00-23:59 UTC hari
// SEBELUMNYA) kesimpen dengan tanggal KEMARIN, padahal buat Denny itu masih hari yang sama.
// Helper ini (dipakai gantiin toISOString di bawah) hitung tanggal YYYY-MM-DD dari kalender
// Asia/Jakarta yang sebenarnya - konsisten sama formatTanggalIndoJakarta_ di atas.
function tanggalHariIniJakarta_() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = function (type) { const p = parts.find(function (x) { return x.type === type; }); return p ? p.value : ''; };
  return get('year') + '-' + get('month') + '-' + get('day');
}

function htmlEscape_(teks) {
  return String(teks || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// v.26: format direvisi lagi (contoh Denny) -
//   Senin, 3/08/26
//   ✅ Hasil Cutting
//
//   <b>1. RFL MERAH 24.85kg / 0132</b>
//   📎 S18, M36, L43, XL36, XXL36 = 169
// Bedanya dari ver.20: kg sekarang nempel LANGSUNG setelah nama warna (bukan di akhir), kode
// roll dipisah "/" (bukan lagi "(Roll ...)"), dan baris ukuran dikasih prefix emoji 📎.
async function kirimNotifikasiProduksi_(env, rowsTersimpan, peringatanStok) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_GROUP_CHAT_ID;
  if (!botToken || !chatId) return; // belum diset, diam saja (gak fatal, data tetap tersimpan)

  const barisTeks = rowsTersimpan.map(function (r, i) {
    const ukuranObj = kolomKeUkuran_(r);
    const totalQty = Object.keys(ukuranObj).reduce(function (sum, u) { return sum + ukuranObj[u]; }, 0);
    const ukuranTeks = Object.keys(ukuranObj).map(function (u) { return u + ukuranObj[u]; }).join(', ') + ' = ' + totalQty;
    const kgTeks = r.pemakaian_kain_kg ? (' ' + r.pemakaian_kain_kg + 'kg') : '';
    const rollTeks = r.kode_roll ? (' / ' + r.kode_roll) : '';
    const judulItem = '<b>' + (i + 1) + '. ' + htmlEscape_(r.jenis_warna_baju) + kgTeks + rollTeks + '</b>';
    return judulItem + '\n📎 ' + htmlEscape_(ukuranTeks);
  }).join('\n\n');

  let teks = formatTanggalIndoJakarta_(new Date()) + '\n✅ Hasil Cutting\n\n' + barisTeks;
  if (peringatanStok && peringatanStok.length > 0) {
    teks += '\n\n⚠️ ' + htmlEscape_(peringatanStok.join(' | '));
  }

  try {
    await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: teks, parse_mode: 'HTML' })
    });
  } catch (e) {
    // gagal kirim notifikasi TIDAK dianggap fatal - data produksi sudah tersimpan duluan
  }
}

// ============================================================
// REKAP QC (BARU) - histori submit QC apa adanya, 1 baris = 1x submit, urut kronologis.
// SENGAJA gak nyertain harga_jait/total_bayar di response - itu info akunting, bukan buat
// ditampilkan ke tim potong/QC di tab ini (sesuai desain dari thread Apps Script).
// ============================================================
async function handleRekapQC_(env, hari) {
  try {
    const batasWaktu = new Date(Date.now() - hari * 24 * 60 * 60 * 1000).toISOString();
    const path = '/rest/v1/log_qc?select=id,waktu,tim_potong_id,varian,warna,' +
      Object.values(KOLOM_UKURAN_MAP).join(',') + ',reject,total,status' +
      '&status=eq.aktif&waktu=gte.' + encodeURIComponent(batasWaktu) + '&order=waktu.desc';
    const rows = await ambilDariSupabase_(env, path);

    const hasil = rows.map(function (r) {
      const ukuranObj = kolomKeUkuran_(r);
      const perUkuran = Object.keys(ukuranObj).map(function (u) { return { ukuran: u, selesai: ukuranObj[u] }; });
      const rejectObj = parseRejectNotasi_(r.reject);
      const rejectTotal = Object.values(rejectObj).reduce(function (s, v) { return s + v; }, 0);
      return {
        id: r.id,
        waktu: r.waktu,
        timPotongId: r.tim_potong_id,
        varian: r.varian,
        warna: r.warna,
        perUkuran: perUkuran,
        reject: r.reject,
        rejectTotal: rejectTotal,
        total: r.total
      };
    });

    return jsonResponse(hasil);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// EXPORT AKUNTANSI - data flat SEMUA status, N bulan terakhir (buat sinkron ke Sheet)
// ============================================================
async function handleExportAkuntansi_(env, bulan) {
  try {
    const batasTanggal = new Date();
    batasTanggal.setMonth(batasTanggal.getMonth() - bulan);
    const batasStr = batasTanggal.toISOString().slice(0, 10);

    const [rowsTP, daftarPrefix] = await Promise.all([
      ambilDariSupabase_(env, '/rest/v1/tim_potong?select=*&tanggal=gte.' + batasStr + '&order=tanggal.asc,id.asc'),
      ambilDaftarPrefixQC_(env)
    ]);

    if (rowsTP.length === 0) return jsonResponse([]);

    const idList = rowsTP.map(function (r) { return r.id; }).join(',');
    const rowsLog = await ambilDariSupabase_(env, '/rest/v1/log_qc?select=tim_potong_id,' + Object.values(KOLOM_UKURAN_MAP).join(',') + ',reject&status=eq.aktif&tim_potong_id=in.(' + idList + ')');
    const agregasi = {};
    rowsLog.forEach(function (log) {
      if (!agregasi[log.tim_potong_id]) agregasi[log.tim_potong_id] = { selesai: 0, reject: 0 };
      const ukuranBarisIni = kolomKeUkuran_(log);
      const rejectBarisIni = parseRejectNotasi_(log.reject);
      agregasi[log.tim_potong_id].selesai += Object.values(ukuranBarisIni).reduce(function (s, v) { return s + v; }, 0);
      agregasi[log.tim_potong_id].reject += Object.values(rejectBarisIni).reduce(function (s, v) { return s + v; }, 0);
    });

    const hasil = rowsTP.map(function (tp) {
      const cocok = cariKategoriQC_(tp.jenis_warna_baju, daftarPrefix);
      const kategoriBadge = cocok ? String(cocok.kategoriQc).split(' ')[0] : '';
      const agg = agregasi[tp.id] || { selesai: 0, reject: 0 };
      return {
        id: tp.id,
        tanggal: tp.tanggal,
        jenisWarnaBaju: tp.jenis_warna_baju,
        kategoriBadge: kategoriBadge,
        kodeRoll: tp.kode_roll || '',
        pemakaianKainKg: tp.pemakaian_kain_kg || 0,
        jumlah: tp.jumlah,
        totalSelesai: agg.selesai,
        totalReject: agg.reject,
        sisa: tp.jumlah - agg.selesai - agg.reject,
        status: tp.status || ''
      };
    });

    return jsonResponse(hasil);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// v.27 - EXPORT STOK KAIN yang masih ada sisa (kg_sisa > 0), dipakai CODE SYNC AKUNTANSI.js
// (fungsi sinkronKeSheetStokKain) buat sinkron sheet "STOK KAIN" tiap jam. Field camelCase
// biar konsisten sama handleExportAkuntansi_ di atas.
// ============================================================
async function handleExportStokKain_(env) {
  try {
    const rows = await ambilDariSupabase_(env, '/rest/v1/stok_kain?select=*&kg_sisa=gt.0&order=tgl_beli.asc,id.asc');
    const hasil = rows.map(function (r) {
      return {
        id: r.id,
        tglBeli: r.tgl_beli,
        supplier: r.supplier,
        warna: r.warna,
        kg: r.kg,
        kodeRoll: r.kode_roll,
        hargaRpKg: r.harga_rp_kg,
        diskonRpKg: r.diskon_rp_kg,
        kgTerpakai: r.kg_terpakai,
        kgSisa: r.kg_sisa
      };
    });
    return jsonResponse(hasil);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// v.28 - EXPORT TIM POTONG MENTAH (semua kolom asli, breakdown ukuran per XS-6XL) - dipakai
// CODE SYNC AKUNTANSI.js buat sinkron sheet "TIM POTONG" (append-only, beda dari
// export-akuntansi yang formatnya sudah diringkas buat CERMIN AKUNTANSI).
// ============================================================
async function handleExportTimPotongMentah_(env, bulan) {
  try {
    const batasTanggal = new Date();
    batasTanggal.setMonth(batasTanggal.getMonth() - bulan);
    const batasStr = batasTanggal.toISOString().slice(0, 10);
    const rows = await ambilDariSupabase_(env, '/rest/v1/tim_potong?select=*&tanggal=gte.' + batasStr + '&order=tanggal.asc,id.asc');
    const hasil = rows.map(function (r) {
      return {
        id: r.id,
        tanggal: r.tanggal,
        pemakaianKainKg: r.pemakaian_kain_kg,
        kodeRoll: r.kode_roll,
        jenisWarnaBaju: r.jenis_warna_baju,
        ukuran: kolomKeUkuran_(r),
        jumlah: r.jumlah,
        refStok: r.ref_stok,
        status: r.status,
        idPesanQc: r.id_pesan_qc
      };
    });
    return jsonResponse(hasil);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// v.45 - RIWAYAT PEMAKAIAN KAIN per roll (dashboard, fitur "Riwayat Pemakaian" tab Stok Kain) -
// dari log_pemakaian_kain (stok_kain_id = FK asli), JOIN tim_potong (embed PostgREST lewat FK
// tim_potong_id) buat ambil jumlah pcs & tanggal laporan produksi terkait. Lihat catatan panjang
// di routing di atas soal kenapa ini gantiin pendekatan lama (filter tim_potong by teks
// kode_roll) - itu APPROACH YANG SALAH SECARA FUNDAMENTAL karena kode_roll gak dijamin unik.
// ============================================================
async function handleRiwayatPemakaianKain_(env) {
  try {
    const rows = await ambilDariSupabase_(env, '/rest/v1/log_pemakaian_kain?select=id,stok_kain_id,kg,item_produksi,waktu_wib,tim_potong(jumlah,tanggal)&order=waktu.desc');
    const hasil = rows.map(function (r) {
      return {
        id: r.id,
        stokKainId: r.stok_kain_id,
        namaItem: r.item_produksi,
        kg: parseFloat(r.kg) || 0,
        tanggal: r.tim_potong ? r.tim_potong.tanggal : null,
        jumlah: r.tim_potong ? r.tim_potong.jumlah : null
      };
    });
    return jsonResponse(hasil);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}


// 2 punya formula SUBTOTAL yang dikelola manual Denny - JANGAN PERNAH ditulis ulang otomatis).
// ============================================================
async function handleExportLogQCMentah_(env, bulan) {
  try {
    const batasWaktu = new Date();
    batasWaktu.setMonth(batasWaktu.getMonth() - bulan);
    const rows = await ambilDariSupabase_(env, '/rest/v1/log_qc?select=*&waktu=gte.' + encodeURIComponent(batasWaktu.toISOString()) + '&order=waktu.asc,id.asc');
    const hasil = rows.map(function (r) {
      return {
        id: r.id,
        waktu: r.waktu,
        timPotongId: r.tim_potong_id,
        varian: r.varian,
        warna: r.warna,
        ukuran: kolomKeUkuran_(r),
        reject: r.reject,
        total: r.total,
        hargaJait: r.harga_jait,
        totalBayar: r.total_bayar,
        status: r.status
      };
    });
    return jsonResponse(hasil);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// v.29 - INSERT stok_kain. Endpoint HTTP ini TETAP ADA (dipakai gas-debug/tools lain kalau
// perlu), tapi sejak v.37 logic intinya dipindah ke tambahStokKainMasukSupabase_() di bawah,
// biar bisa dipakai bareng dari 2 tempat: endpoint HTTP ini (request luar) DAN
// tanganiPesanMasuk_() (dipanggil langsung dari Worker sendiri, tanpa HTTP round-trip).
// ============================================================
async function tambahStokKainMasukSupabase_(env, data) {
  const payload = {
    tgl_beli: data.tglBeli || new Date().toISOString().slice(0, 10),
    supplier: data.supplier || null,
    warna: data.warna,
    kg: data.kg,
    kode_roll: data.kodeRoll || null,
    kg_terpakai: 0
  };
  if (data.harga !== undefined && data.harga !== null && data.harga !== '') payload.harga_rp_kg = data.harga;
  if (data.diskon) payload.diskon_rp_kg = data.diskon;

  const res = await fetch(env.SUPABASE_URL + '/rest/v1/stok_kain', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify([payload])
  });

  if (res.status >= 300) {
    throw new Error('HTTP ' + res.status + ': ' + (await res.text()).substring(0, 300));
  }
}

async function handleInternalStokMasuk_(request, env) {
  try {
    const token = request.headers.get('X-Internal-Token');
    if (!token || token !== env.INTERNAL_SYNC_TOKEN) {
      return jsonResponse({ ok: false, error: 'Token tidak valid' }, 401);
    }

    const body = await request.json();
    if (!body.warna || body.kg === undefined || body.kg === null) {
      return jsonResponse({ ok: false, error: 'warna dan kg wajib diisi' }, 400);
    }

    await tambahStokKainMasukSupabase_(env, {
      tglBeli: body.tglBeli, supplier: body.supplier, warna: body.warna,
      kg: body.kg, kodeRoll: body.kodeRoll, harga: body.harga, diskon: body.diskon
    });

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// v.37 - PARSING TEKS "MASUK ..." (migrasi dari CODE TIM POTONG Apps Script) - port 1:1 dari
// fungsi isBarisMasuk/isBarisPasanganKgKode/isBarisWarnaKgKode/isBarisLanjutanMasuk/
// extractKodeRoll/pisahkanBarisMasukDanProduksi/parseBarisMasuk di Apps Script. Sengaja PERSIS
// (bukan ditulis ulang gaya baru) karena kedua runtime (Apps Script V8 & Cloudflare Workers V8)
// pakai mesin regex yang sama persis - jadi hasil parsing dijamin identik dengan versi lama,
// gak perlu re-desain aturan dari nol. Mendukung 4 gaya penulisan (D/C/B/A), lihat komentar di
// parseBarisMasuk_ untuk detail tiap gaya & contohnya.
//
// Baris "RIB" TIDAK di-skip di sini (beda dari fitur baca-nota-foto) - konsisten sama perilaku
// lama jalur teks manual, yang memang belum pernah menerapkan aturan skip RIB.
//
// CATATAN PENTING: sejak migrasi ini, tab Sheet "STOK KAIN" TIDAK LAGI otomatis nambah baris
// tiap ada laporan "Masuk..." baru (karena Worker gak punya akses tulis ke Google Sheets sama
// sekali) - stok baru cuma masuk ke Supabase. Tab Sheet-nya sekarang murni cerminan "stok aktif
// sekarang" yang di-refresh manual lewat tombol "Sinkron Sekarang" di project Apps Script
// terpisah SYNC AKUNTANSI (fungsi sinkronKeSheetStokKain) - ini sudah dikonfirmasi Denny sebagai
// perilaku yang diinginkan, bukan bug.
// ============================================================
function isBarisMasuk_(line) {
  return /^\s*masuk\b/i.test(line);
}

function isBarisPasanganKgKode_(line) {
  return /^[\d]+[.,]?[\d]*\s*\/\s*\S+\s*$/.test(line.trim());
}

function isBarisWarnaKgKode_(line) {
  return /^\S.*?\s+[\d]+[.,]?[\d]*\s*kg?\s*\/\s*\S+\s*$/i.test(line.trim());
}

function isBarisLanjutanMasuk_(line) {
  return isBarisPasanganKgKode_(line) || isBarisWarnaKgKode_(line);
}

// Ekstrak kode roll dari akhir baris. Dukung 2 format:
//  1. Format lama, pakai kata "rol" eksplisit: "... 25,4kg - rol 0178"
//  2. Format baru, TANPA kata "rol" sama sekali - "/" murni pemisah kg vs kode roll:
//     "Anak putih 25,05/6097" -> kg=25,05, kode roll=6097.
function extractKodeRoll_(line) {
  const cleaned = line.replace(/[-\/]/g, ' ');
  const m = cleaned.match(/\brol\.?\s*(\S+)\s*$/i);
  if (m) return { kodeRoll: m[1].trim(), lineWithoutKode: cleaned.slice(0, m.index).trim() };

  const mSlash = line.match(/^(.*[\d])\s*\/\s*(\S+)\s*$/);
  if (mSlash) {
    return { kodeRoll: mSlash[2].trim(), lineWithoutKode: mSlash[1].trim() };
  }

  return { kodeRoll: null, lineWithoutKode: line };
}

// Kelompokkan teks pesan jadi: blok-blok "Masuk" (tiap blok = array baris mentahnya, BUKAN
// digabung jadi 1 string lagi - supaya warna per baris bisa dibedakan) + sisa baris produksi
// biasa (dikembalikan gabungan, dipakai cuma buat pesan pengingat "pakai Mini App ya").
function pisahkanBarisMasukDanProduksi_(text) {
  const semuaBaris = String(text || '').split('\n');
  const blokMasukList = [];
  const barisProduksiList = [];
  let blokAktif = null;

  function baruIkutiKgKode(mulaiDari) {
    for (let j = mulaiDari; j < semuaBaris.length; j++) {
      const t = semuaBaris[j].trim();
      if (!t) continue;
      if (isBarisPasanganKgKode_(t)) return true;
      if (isBarisMasuk_(t)) return false;
      if (t.indexOf('/') === -1) continue;
      return false;
    }
    return false;
  }

  for (let i = 0; i < semuaBaris.length; i++) {
    const rawLine = semuaBaris[i];
    const line = rawLine.trim();

    if (!line) {
      if (blokAktif && baruIkutiKgKode(i + 1)) continue;
      if (blokAktif) { blokMasukList.push(blokAktif); blokAktif = null; }
      continue;
    }

    if (isBarisMasuk_(line)) {
      if (blokAktif) blokMasukList.push(blokAktif);
      blokAktif = [line];
      continue;
    }

    if (blokAktif && isBarisLanjutanMasuk_(line)) {
      blokAktif.push(line);
      continue;
    }

    if (blokAktif && line.indexOf('/') === -1 && baruIkutiKgKode(i + 1)) {
      blokAktif.push(line);
      continue;
    }

    if (blokAktif) { blokMasukList.push(blokAktif); blokAktif = null; }
    barisProduksiList.push(rawLine);
  }
  if (blokAktif) blokMasukList.push(blokAktif);

  return { blokMasuk: blokMasukList, barisProduksi: barisProduksiList.join('\n') };
}

// lines: ARRAY baris mentah (sudah di-trim) untuk 1 blok Masuk, baris pertama diawali "Masuk".
function parseBarisMasuk_(lines) {
  const headerLine = lines[0];
  const sisaBarisLain = lines.slice(1);
  const tanpaMasuk = headerLine.trim().replace(/^masuk\s+/i, '');

  // FORMAT D: header "<warna> - <supplier>" - PEMISAH STRIP EKSPLISIT dikelilingi spasi.
  // Contoh: "Masuk Putih 30S - Focus" / "25.43 / 6352" / "Hitam 30S" / "28.22 / 3674"
  const headerPunyaPasangan = /[\d]+[.,]?[\d]*\s*kg?\s*\/\s*\S+/i.test(tanpaMasuk);
  const mFormatD = !headerPunyaPasangan ? tanpaMasuk.match(/^(.+?)\s-\s(.+)$/) : null;
  if (mFormatD && sisaBarisLain.length > 0) {
    const warnaAwalD = mFormatD[1].trim().toUpperCase();
    const supplierD = mFormatD[2].trim().toUpperCase();
    if (warnaAwalD && supplierD) {
      const hasilD = [];
      let warnaSaatIni = warnaAwalD;
      let semuaBarisCocokD = true;
      for (const lineLainD of sisaBarisLain) {
        const t = lineLainD.trim();
        if (!t) continue;
        const mKgKodeD = t.match(/^([\d]+[.,]?[\d]*)\s*\/\s*(\S+)\s*$/);
        if (mKgKodeD) {
          const kgD = parseFloat(mKgKodeD[1].replace(',', '.'));
          const kodeD = mKgKodeD[2].trim();
          if (isNaN(kgD)) { semuaBarisCocokD = false; break; }
          hasilD.push({ warna: warnaSaatIni, kg: kgD, kodeRoll: kodeD, supplier: supplierD });
          continue;
        }
        if (t.indexOf('/') === -1) { warnaSaatIni = t.toUpperCase(); continue; }
        semuaBarisCocokD = false; break;
      }
      if (semuaBarisCocokD && hasilD.length > 0) return hasilD;
    }
  }

  // FORMAT C: header CUMA nama supplier, tiap baris lanjutan punya WARNA+KG+KODE sendiri.
  // Contoh: "Masuk ochim" / "Kubus 24,70kg/1615" / "Dasty 24,6kg/ 1358"
  if (!headerPunyaPasangan && sisaBarisLain.length > 0) {
    const supplierC = tanpaMasuk.trim().toUpperCase();
    const hasilC = [];
    let semuaBarisCocok = true;
    for (const lineLain of sisaBarisLain) {
      const mBaris = lineLain.match(/^(.*?)\s+([\d]+[.,]?[\d]*)\s*kg?\s*\/\s*(\S+)\s*$/i);
      if (!mBaris) { semuaBarisCocok = false; break; }
      const warnaC = mBaris[1].trim().toUpperCase();
      const kgC = parseFloat(mBaris[2].replace(',', '.'));
      const kodeC = mBaris[3].trim();
      if (!warnaC || isNaN(kgC)) { semuaBarisCocok = false; break; }
      hasilC.push({ warna: warnaC, kg: kgC, kodeRoll: kodeC, supplier: supplierC });
    }
    if (semuaBarisCocok && hasilC.length > 0) return hasilC;
  }

  // FORMAT B: banyak roll sekaligus, WARNA SAMA untuk semua.
  // Contoh: "Masuk navy 24s ochim 25.10 / 0666 24.90 / 0963"
  const tanpaMasukGabung = lines.join(' ').trim().replace(/^masuk\s+/i, '');
  const polaPasangan = /([\d]+[.,]?[\d]*)\s*\/\s*(\S+)/g;
  const pasangan = [];
  let m;
  let firstIndex = -1;
  while ((m = polaPasangan.exec(tanpaMasukGabung)) !== null) {
    if (firstIndex === -1) firstIndex = m.index;
    pasangan.push({ kg: parseFloat(m[1].replace(',', '.')), kodeRoll: m[2].trim() });
  }
  if (pasangan.length > 0) {
    const keterangan = tanpaMasukGabung.slice(0, firstIndex).trim();
    const kataKeterangan = keterangan.split(/\s+/).filter(function (w) { return w; });
    const warna = kataKeterangan.length > 0 ? kataKeterangan[0].toUpperCase() : '';
    const supplier = kataKeterangan.length > 1 ? kataKeterangan[kataKeterangan.length - 1].toUpperCase() : '';
    return pasangan.map(function (p) {
      return { warna: warna, kg: p.kg, kodeRoll: p.kodeRoll, supplier: supplier };
    });
  }

  // FORMAT A (lama, fallback): satu roll, pakai kata "rol".
  const stripped = extractKodeRoll_(headerLine.trim());
  const tanpaMasukLama = stripped.lineWithoutKode.replace(/^masuk\s+/i, '').trim();
  const mLama = tanpaMasukLama.match(/^(.*?)\s*([\d]+[.,]?[\d]*)\s*(?:kg\.?)?\s*$/i);
  if (!mLama) return [];
  const warnaLama = mLama[1].trim().toUpperCase();
  const kgLama = parseFloat(mLama[2].replace(',', '.'));
  if (!warnaLama || isNaN(kgLama)) return [];
  return [{ warna: warnaLama, kg: kgLama, kodeRoll: stripped.kodeRoll, supplier: '' }];
}

// Kirim pesan teks polos ke 1 chat Telegram - dipakai buat notifikasi error dari
// tanganiPesanMasuk_ (parse gagal / anti-duplikat).
async function kirimPesanTelegram_(env, chatId, teks) {
  try {
    await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: teks })
    });
  } catch (e) {
    // gak fatal kalau notifikasi gagal terkirim
  }
}

// v.37 - HANDLER UTAMA "Masuk ..." - dipanggil dari handleTelegramWebhook_ SEBELUM pesan
// diteruskan ke Apps Script (lihat routing di bawah). Menggantikan alur lama yang lewat
// Apps Script (doPost -> tambahStokKainMasuk -> tambahStokKainMasukKeSupabase_ via HTTP ke
// Worker) - sekarang parsing DAN tulis ke Supabase dua-duanya di Worker, gak ada lagi
// round-trip HTTP internal ke Apps Script buat fitur ini.
async function tanganiPesanMasuk_(env, message) {
  const chatId = message.chat.id;
  const teks = message.text;

  // Filter user opsional (sama polanya kayak dulu di Apps Script) - kalau Script
  // Property/env var terkait belum diisi, gak ada pembatasan (semua user diproses).
  const blockedIds = String(env.BLOCKED_USER_IDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const senderId = message.from ? String(message.from.id) : null;
  if (blockedIds.length > 0 && senderId && blockedIds.indexOf(senderId) !== -1) {
    return jsonResponse({ ok: true, pesan: 'diabaikan (user diblokir)' });
  }
  const allowedId = env.ALLOWED_USER_ID;
  if (allowedId && senderId !== String(allowedId)) {
    return jsonResponse({ ok: true, pesan: 'diabaikan (bukan user diizinkan)' });
  }

  // Anti-duplikat - pakai mekanisme Supabase yang SUDAH ADA (log_anti_duplikat, dipakai juga
  // oleh Mini App /submit-produksi), namespace key "kainmasuk_<chatId>" biar gak ketuker sama
  // dedup Mini App. Jendela 24 jam, sama kayak versi Apps Script lama.
  const fingerprint = await hashFingerprint_(String(teks || '').trim().replace(/\s+/g, ' ').toUpperCase());
  const cek = await cekDanCatatDuplikat_(env, 'kainmasuk_' + chatId, fingerprint, teks.substring(0, 300));
  if (cek.duplikat) {
    await kirimPesanTelegram_(env, chatId, '🔁 Pesan ini sama persis kayak laporan ' + formatJarakWaktu_(cek.jarakMs) + ' lalu - dianggap kiriman ganda, tidak diproses lagi.');
    return jsonResponse({ ok: true, pesan: 'diabaikan (duplikat)' });
  }

  const kelompok = pisahkanBarisMasukDanProduksi_(teks);
  if (kelompok.blokMasuk.length === 0) {
    return jsonResponse({ ok: true, pesan: 'tidak ada blok Masuk yang terdeteksi' });
  }

  let jumlahBerhasil = 0;
  const galat = [];
  for (const blok of kelompok.blokMasuk) {
    const daftarMasuk = parseBarisMasuk_(blok);
    if (!daftarMasuk || daftarMasuk.length === 0) {
      galat.push('Gagal parsing blok: "' + blok[0] + '"');
      continue;
    }
    for (const pm of daftarMasuk) {
      try {
        await tambahStokKainMasukSupabase_(env, { warna: pm.warna, kg: pm.kg, kodeRoll: pm.kodeRoll, supplier: pm.supplier });
        jumlahBerhasil++;
      } catch (e) {
        galat.push(pm.warna + ' (' + pm.kg + 'kg): ' + e.message);
      }
    }
  }

  console.log('Kain masuk diproses via Worker:', jumlahBerhasil, 'berhasil,', galat.length, 'gagal. Chat:', chatId);

  if (galat.length > 0) {
    await kirimPesanTelegram_(env, chatId, '⚠️ ' + jumlahBerhasil + ' baris berhasil disimpan, tapi ada ' + galat.length + ' yang gagal:\n' + galat.join('\n'));
  }

  return jsonResponse({ ok: true, jumlahBerhasil, jumlahGagal: galat.length });
}

// ============================================================
// v.37 - Proxy DEBUG/DEPLOY ke Apps Script (CODE TIM POTONG). Worker cuma jembatan jaringan -
// terima request dari Claude (tervalidasi GAS_DEBUG_TOKEN), teruskan MENTAH-MENTAH ke Apps
// Script Web App (yang punya actionnya sendiri: gasDebugGetProperty/gasDebugSetProperty/
// gasDebugDeleteProperty/gasDebugListProperties/gasDebugUpdateCode), balikin respons Apps
// Script apa adanya. Body request WAJIB ada field "action" + field lain sesuai action-nya
// (lihat handler masing-masing action di Apps Script).
// ============================================================
async function handleGasDebugProxy_(request, env) {
  try {
    const token = request.headers.get('X-GAS-Debug-Token');
    if (!token || token !== env.GAS_DEBUG_TOKEN) {
      return jsonResponse({ ok: false, error: 'Token tidak valid' }, 401);
    }

    const body = await request.json();
    if (!body.action) {
      return jsonResponse({ ok: false, error: 'Field "action" wajib diisi' }, 400);
    }

    const res = await fetch(env.APPS_SCRIPT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, body, { gasDebugToken: env.GAS_DEBUG_TOKEN }))
    });

    const teksRespons = await res.text();
    let jsonRespons;
    try {
      jsonRespons = JSON.parse(teksRespons);
    } catch (parseErr) {
      return jsonResponse({ ok: false, error: 'Respons Apps Script bukan JSON valid: ' + teksRespons.substring(0, 500) }, 502);
    }

    return jsonResponse(jsonRespons, res.status >= 300 ? 502 : 200);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// DASHBOARD - Arsip Selesai (Tahap 4)
// ============================================================
async function handleArsipSelesai_(env, hari) {
  try {
    const batasWaktu = new Date(Date.now() - hari * 24 * 60 * 60 * 1000).toISOString();
    // PostgREST bisa "embed" data tim_potong terkait langsung dalam 1 request (lewat relasi FK
    // tim_potong_id -> tim_potong.id yang udah ada), jadi gak perlu 2x fetch terpisah.
    const path = '/rest/v1/arsip_selesai?select=waktu,tim_potong(id,jenis_warna_baju,jumlah,kode_roll,tanggal)' +
      '&waktu=gte.' + encodeURIComponent(batasWaktu) + '&order=waktu.desc';
    const rows = await ambilDariSupabase_(env, path);
    const hasil = rows.map(function (r) {
      const tp = r.tim_potong || {};
      return {
        waktu: r.waktu,
        timPotongId: tp.id || null,
        jenisWarnaBaju: tp.jenis_warna_baju || null,
        jumlah: tp.jumlah || null,
        kodeRoll: tp.kode_roll || null,
        tanggal: tp.tanggal || null
      };
    });
    return jsonResponse(hasil);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// DASHBOARD - Stok Kain, SEMUA roll yang masih ada sisa (Tahap 3)
// ============================================================
async function handleStokUtuh_(env) {
  try {
    const [rowsStok, rowsKamus] = await Promise.all([
      ambilDariSupabase_(env, '/rest/v1/stok_kain?select=id,warna,kode_roll,kg_sisa&kg_sisa=gt.0'),
      ambilDariSupabase_(env, '/rest/v1/kamus_sinonim_warna?select=kanonik,sinonim')
    ]);

    const petaKanonik = {};
    rowsKamus.forEach(function (row) {
      const kanonik = String(row.kanonik || '').toUpperCase();
      if (!kanonik) return;
      petaKanonik[kanonik] = kanonik;
      (row.sinonim || []).forEach(function (s) { const su = String(s || '').toUpperCase(); if (su) petaKanonik[su] = kanonik; });
    });

    const grup = {}; // { WARNA_KANONIK: { totalKg, rolls: [{id, kodeRoll, kg}] } }
    rowsStok.forEach(function (row) {
      const warnaRaw = String(row.warna || '').trim();
      const kodeRoll = String(row.kode_roll || '').trim();
      const kg = parseFloat(row.kg_sisa) || 0;
      // v.17: SEBELUMNYA baris yang kode_roll-nya kosong/null ikut KE-SKIP TOTAL (bukan cuma
      // kode rollnya yang gak kelihatan, tapi WARNANYA JUGA gak pernah nyampe ke Dashboard/Mini
      // App sama sekali) - bug nyata, ditemukan Denny lewat testing (kode roll diisi "-" atau
      // "0" work, dikosongkan/NULL enggak). kode_roll kosong itu valid (roll belum
      // dicatat/diketahui), BUKAN alasan buat nyembunyiin stoknya.
      if (!warnaRaw || kg <= 0) return;
      const kanonik = petaKanonik[warnaRaw.toUpperCase()] || warnaRaw.toUpperCase();
      if (!grup[kanonik]) grup[kanonik] = { totalKg: 0, rolls: [] };
      grup[kanonik].totalKg += kg;
      // v.41: sertakan id (stok_kain.id) per roll - dibutuhkan tombol Edit/Write-off admin,
      // bukan cuma tampilan (id bukan data sensitif, aman ikut ke endpoint publik ini).
      grup[kanonik].rolls.push({ id: row.id, kodeRoll: kodeRoll || null, kg: kg });
    });

    let totalKgSemua = 0, totalRollSemua = 0;
    const perWarna = Object.keys(grup).map(function (warna) {
      grup[warna].rolls.sort(function (a, b) { return b.kg - a.kg; });
      totalKgSemua += grup[warna].totalKg;
      totalRollSemua += grup[warna].rolls.length;
      return { warna: warna, totalKg: Math.round(grup[warna].totalKg * 10) / 10, jumlahRoll: grup[warna].rolls.length, rolls: grup[warna].rolls };
    });

    return jsonResponse({
      totalKg: Math.round(totalKgSemua * 10) / 10,
      totalRoll: totalRollSemua,
      totalWarna: perWarna.length,
      perWarna: perWarna
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// v.30 - DASHBOARD Stok Kain: roll yang udah HABIS (kg_sisa <= 0) - dipisah dari
// handleStokUtuh_ (yang sengaja cuma nampilin sisa > 0) buat ditampung di bagian "Arsip"/"Stok
// Habis", sama kayak pola Arsip Selesai di tab Proses & QC.
// ============================================================
async function handleStokHabis_(env) {
  try {
    const [rowsStok, rowsKamus] = await Promise.all([
      ambilDariSupabase_(env, '/rest/v1/stok_kain?select=id,warna,kode_roll,kg_sisa&kg_sisa=lte.0&order=kode_roll.desc'),
      ambilDariSupabase_(env, '/rest/v1/kamus_sinonim_warna?select=kanonik,sinonim')
    ]);
    const petaKanonik = {};
    rowsKamus.forEach(function (row) {
      const kanonik = String(row.kanonik || '').toUpperCase();
      if (!kanonik) return;
      petaKanonik[kanonik] = kanonik;
      (row.sinonim || []).forEach(function (s) { const su = String(s || '').toUpperCase(); if (su) petaKanonik[su] = kanonik; });
    });
    const hasil = rowsStok
      .map(function (row) {
        const warnaRaw = String(row.warna || '').trim();
        if (!warnaRaw) return null;
        const kanonik = petaKanonik[warnaRaw.toUpperCase()] || warnaRaw.toUpperCase();
        // v.41: sertakan id - dibutuhkan buat fitur batal write-off (roll yang jadi habis
        // KARENA write-off tetap harus bisa dibuka form-nya buat dibatalkan).
        return { id: row.id, warna: kanonik, kodeRoll: row.kode_roll || null };
      })
      .filter(function (x) { return x; });
    return jsonResponse(hasil);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// v.47 - roll yang UDAH KEPAKE SEBAGIAN tapi belum habis (kg_terpakai>0 DAN kg_sisa>0) - kategori
// terpisah dari grid utama (semua roll kg_sisa>0, campur yang fresh & yang udah kesentuh) dan
// dari Stok Habis (kg_sisa<=0). Request Denny. Sengaja tetap nampilin kg (di sini kg_sisa, bukan
// ~0 kayak Stok Habis) - itu justru info yang mau dilihat: sisa berapa dari roll yang udah jalan.
async function handleStokTerpakaiSebagian_(env) {
  try {
    const [rowsStok, rowsKamus] = await Promise.all([
      ambilDariSupabase_(env, '/rest/v1/stok_kain?select=id,warna,kode_roll,kg_sisa&kg_terpakai=gt.0&kg_sisa=gt.0&order=kode_roll.desc'),
      ambilDariSupabase_(env, '/rest/v1/kamus_sinonim_warna?select=kanonik,sinonim')
    ]);
    const petaKanonik = {};
    rowsKamus.forEach(function (row) {
      const kanonik = String(row.kanonik || '').toUpperCase();
      if (!kanonik) return;
      petaKanonik[kanonik] = kanonik;
      (row.sinonim || []).forEach(function (s) { const su = String(s || '').toUpperCase(); if (su) petaKanonik[su] = kanonik; });
    });
    const hasil = rowsStok
      .map(function (row) {
        const warnaRaw = String(row.warna || '').trim();
        if (!warnaRaw) return null;
        const kanonik = petaKanonik[warnaRaw.toUpperCase()] || warnaRaw.toUpperCase();
        return { id: row.id, warna: kanonik, kodeRoll: row.kode_roll || null, kg: parseFloat(row.kg_sisa) || 0 };
      })
      .filter(function (x) { return x; });
    return jsonResponse(hasil);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

async function handleDetailStokKainAdmin_(body, env) {
  const validasi = await validasiInitData_(body.initData, env);
  if (!validasi.ok) return jsonResponse(validasi, 401);
  if (!cekAdmin_(validasi.userId, env)) {
    return jsonResponse({ ok: false, error: 'Kamu tidak punya izin melihat detail ini.' }, 403);
  }

  const id = parseInt(body.id, 10);
  if (!id) return jsonResponse({ ok: false, error: 'id wajib diisi.' }, 400);

  try {
    const rows = await ambilDariSupabase_(env, '/rest/v1/stok_kain?select=*&id=eq.' + id);
    if (!rows || rows.length === 0) return jsonResponse({ ok: false, error: 'Roll id=' + id + ' tidak ditemukan.' }, 404);
    const s = rows[0];

    const [riwayatPakai, riwayatWriteoff] = await Promise.all([
      ambilDariSupabase_(env, '/rest/v1/log_pemakaian_kain?select=id&stok_kain_id=eq.' + id),
      ambilDariSupabase_(env, '/rest/v1/log_writeoff_kain?select=id,kg,catatan,status,waktu_wib&stok_kain_id=eq.' + id + '&order=waktu.desc')
    ]);

    const harga = parseFloat(s.harga_rp_kg) || 0;
    const diskon = parseFloat(s.diskon_rp_kg) || 0;
    const kgSisa = parseFloat(s.kg_sisa) || 0;
    // Subtotal = nilai SISA stok (bukan nilai total dibeli) - kesepakatan sama Denny.
    const subtotal = Math.round(kgSisa * Math.max(harga - diskon, 0));

    return jsonResponse({
      ok: true,
      id: s.id,
      tglBeli: s.tgl_beli,
      supplier: s.supplier,
      warna: s.warna,
      kg: parseFloat(s.kg) || 0,
      kodeRoll: s.kode_roll,
      kgTerpakai: parseFloat(s.kg_terpakai) || 0,
      kgSisa: kgSisa,
      hargaRpKg: harga,
      diskonRpKg: diskon,
      subtotal: subtotal,
      jumlahRiwayatPakai: riwayatPakai.length,
      riwayatWriteoff: riwayatWriteoff
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

async function handleEditStokKain_(body, env) {
  const validasi = await validasiInitData_(body.initData, env);
  if (!validasi.ok) return jsonResponse(validasi, 401);
  if (!cekAdmin_(validasi.userId, env)) {
    return jsonResponse({ ok: false, error: 'Kamu tidak punya izin mengedit stok kain.' }, 403);
  }

  const id = parseInt(body.id, 10);
  if (!id) return jsonResponse({ ok: false, error: 'id wajib diisi.' }, 400);

  try {
    const rows = await ambilDariSupabase_(env, '/rest/v1/stok_kain?select=id,kode_roll,kg_terpakai&id=eq.' + id);
    if (!rows || rows.length === 0) return jsonResponse({ ok: false, error: 'Roll id=' + id + ' tidak ditemukan.' }, 404);
    const existing = rows[0];

    const kgBaru = parseFloat(body.kg);
    if (!(kgBaru >= 0)) return jsonResponse({ ok: false, error: 'Kg harus diisi angka >= 0.' }, 400);
    const kgTerpakaiSekarang = parseFloat(existing.kg_terpakai) || 0;
    if (kgBaru < kgTerpakaiSekarang) {
      return jsonResponse({ ok: false, error: 'Kg baru (' + kgBaru + ') gak boleh lebih kecil dari kg yang sudah terpakai (' + kgTerpakaiSekarang + '). Kalau maksudnya menandai sisa kain gak kepake, pakai fitur Write-off, bukan turunin angka Kg di sini.' }, 400);
    }

    const kodeRollBaru = body.kodeRoll !== undefined ? (body.kodeRoll ? String(body.kodeRoll).trim() : null) : existing.kode_roll;
    let peringatan = null;
    if (kodeRollBaru !== existing.kode_roll) {
      const cekRiwayat = await ambilDariSupabase_(env, '/rest/v1/log_pemakaian_kain?select=id&stok_kain_id=eq.' + id + '&limit=1');
      if (cekRiwayat.length > 0) {
        peringatan = 'Kode roll diganti dari "' + (existing.kode_roll || '-') + '" ke "' + (kodeRollBaru || '-') + '". Roll ini sudah punya riwayat pemakaian - laporan produksi LAMA tetap nyimpen kode roll LAMA (teks biasa, bukan link), jadi "Riwayat Pemakaian" di tab ini untuk kode baru gak akan nunjukin riwayat lama itu.';
      }
    }

    const payload = {
      tgl_beli: body.tglBeli || null,
      supplier: body.supplier || 'TIDAK DIKETAHUI',
      warna: String(body.warna || '').trim(),
      kg: kgBaru,
      kode_roll: kodeRollBaru,
      harga_rp_kg: (body.hargaRpKg === '' || body.hargaRpKg === undefined || body.hargaRpKg === null) ? null : parseFloat(body.hargaRpKg),
      diskon_rp_kg: (body.diskonRpKg === '' || body.diskonRpKg === undefined || body.diskonRpKg === null) ? null : parseFloat(body.diskonRpKg)
    };
    if (!payload.warna) return jsonResponse({ ok: false, error: 'Warna wajib diisi.' }, 400);

    const res = await fetch(env.SUPABASE_URL + '/rest/v1/stok_kain?id=eq.' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
      body: JSON.stringify(payload)
    });
    if (res.status >= 300) return jsonResponse({ ok: false, error: 'Gagal update: HTTP ' + res.status + ' ' + (await res.text()).substring(0, 300) }, 500);

    return jsonResponse({ ok: true, peringatan: peringatan });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

async function handleWriteoffKain_(body, env) {
  const validasi = await validasiInitData_(body.initData, env);
  if (!validasi.ok) return jsonResponse(validasi, 401);
  if (!cekAdmin_(validasi.userId, env)) {
    return jsonResponse({ ok: false, error: 'Kamu tidak punya izin melakukan write-off.' }, 403);
  }

  const stokKainId = parseInt(body.stokKainId, 10);
  const kg = parseFloat(body.kg);
  if (!stokKainId) return jsonResponse({ ok: false, error: 'stokKainId wajib diisi.' }, 400);
  if (!(kg > 0)) return jsonResponse({ ok: false, error: 'Kg write-off harus diisi angka > 0.' }, 400);

  try {
    const rows = await ambilDariSupabase_(env, '/rest/v1/stok_kain?select=id,kg_terpakai,kg_sisa,kode_roll,warna&id=eq.' + stokKainId);
    if (!rows || rows.length === 0) return jsonResponse({ ok: false, error: 'Roll id=' + stokKainId + ' tidak ditemukan.' }, 404);
    const s = rows[0];
    const kgSisa = parseFloat(s.kg_sisa) || 0;
    if (kg > kgSisa) {
      return jsonResponse({ ok: false, error: 'Kg write-off (' + kg + ') gak boleh lebih besar dari kg sisa saat ini (' + kgSisa + ').' }, 400);
    }

    const resInsert = await fetch(env.SUPABASE_URL + '/rest/v1/log_writeoff_kain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=representation' },
      // v.45: sertakan kode_roll & warna sebagai SNAPSHOT (teks biasa, bukan live lookup lewat
      // stok_kain_id) - biar gampang di-scan langsung di Table Editor Supabase tanpa follow FK
      // (request Denny). Sama pola kayak log_pemakaian_kain.warna - kalau roll di-rename
      // belakangan, baris write-off lama tetap nyimpen kode/warna yang lama.
      body: JSON.stringify([{ stok_kain_id: stokKainId, kg: kg, catatan: body.catatan || null, status: 'aktif', kode_roll: s.kode_roll, warna: s.warna }])
    });
    if (resInsert.status >= 300) return jsonResponse({ ok: false, error: 'Gagal simpan write-off: HTTP ' + resInsert.status + ' ' + (await resInsert.text()).substring(0, 300) }, 500);
    const writeoffBaru = (await resInsert.json())[0];

    const kgTerpakaiBaru = (parseFloat(s.kg_terpakai) || 0) + kg;
    const resUpdate = await fetch(env.SUPABASE_URL + '/rest/v1/stok_kain?id=eq.' + stokKainId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
      body: JSON.stringify({ kg_terpakai: kgTerpakaiBaru })
    });
    if (resUpdate.status >= 300) return jsonResponse({ ok: false, error: 'Write-off tersimpan tapi gagal update kg_terpakai: HTTP ' + resUpdate.status }, 500);

    return jsonResponse({ ok: true, writeoffId: writeoffBaru.id });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

async function handleBatalWriteoff_(body, env) {
  const validasi = await validasiInitData_(body.initData, env);
  if (!validasi.ok) return jsonResponse(validasi, 401);
  if (!cekAdmin_(validasi.userId, env)) {
    return jsonResponse({ ok: false, error: 'Kamu tidak punya izin membatalkan write-off.' }, 403);
  }

  const writeoffId = parseInt(body.writeoffId, 10);
  if (!writeoffId) return jsonResponse({ ok: false, error: 'writeoffId wajib diisi.' }, 400);

  try {
    const rows = await ambilDariSupabase_(env, '/rest/v1/log_writeoff_kain?select=id,stok_kain_id,kg,status&id=eq.' + writeoffId);
    if (!rows || rows.length === 0) return jsonResponse({ ok: false, error: 'Data write-off id=' + writeoffId + ' tidak ditemukan.' }, 404);
    const w = rows[0];
    if (w.status !== 'aktif') return jsonResponse({ ok: false, error: 'Write-off ini sudah dibatalkan sebelumnya.' }, 400);

    // Soft-cancel (bukan dihapus fisik) - biar histori tetap kelihatan, sama pola log_qc.
    await fetch(env.SUPABASE_URL + '/rest/v1/log_writeoff_kain?id=eq.' + writeoffId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'dibatalkan' })
    });

    const rowsStok = await ambilDariSupabase_(env, '/rest/v1/stok_kain?select=id,kg_terpakai&id=eq.' + w.stok_kain_id);
    if (rowsStok.length > 0) {
      const kgTerpakaiBaru = Math.max((parseFloat(rowsStok[0].kg_terpakai) || 0) - (parseFloat(w.kg) || 0), 0);
      await fetch(env.SUPABASE_URL + '/rest/v1/stok_kain?id=eq.' + w.stok_kain_id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
        body: JSON.stringify({ kg_terpakai: kgTerpakaiBaru })
      });
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// DASHBOARD - Submit QC (Tahap 2)
// ============================================================

// Mode RINGKAS: 2 angka TOTAL (bukan per ukuran) - otomatis "dituang" ke ukuran yang masih
// ada sisa, URUT sesuai DAFTAR_UKURAN_TIMPOTONG (XS,S,M,L,XL,XXL,3XL,4XL,5XL,6XL), Selesai
// dialokasikan dulu SELURUHNYA baru Reject (masing-masing isi kapasitas sisa tiap ukuran).
function distribusiRingkas_(perUkuran, totalSelesaiBaru, totalRejectBaru) {
  const urutan = perUkuran.slice().sort(function (a, b) {
    return DAFTAR_UKURAN_TIMPOTONG.indexOf(a.ukuran) - DAFTAR_UKURAN_TIMPOTONG.indexOf(b.ukuran);
  });
  const deltaSelesai = {}, deltaReject = {};
  let sisaSelesai = totalSelesaiBaru;
  urutan.forEach(function (u) {
    if (sisaSelesai <= 0) return;
    const kapasitas = u.sisa;
    if (kapasitas <= 0) return;
    const ambil = Math.min(kapasitas, sisaSelesai);
    deltaSelesai[u.ukuran] = ambil;
    u.sisa -= ambil; // kurangi kapasitas lokal, dipakai lagi buat alokasi reject di bawah
    sisaSelesai -= ambil;
  });
  let sisaReject = totalRejectBaru;
  urutan.forEach(function (u) {
    if (sisaReject <= 0) return;
    const kapasitas = u.sisa;
    if (kapasitas <= 0) return;
    const ambil = Math.min(kapasitas, sisaReject);
    deltaReject[u.ukuran] = ambil;
    u.sisa -= ambil;
    sisaReject -= ambil;
  });
  return { deltaSelesai: deltaSelesai, deltaReject: deltaReject, sisaSelesaiTakTertampung: sisaSelesai, sisaRejectTakTertampung: sisaReject };
}

async function handleSubmitQC_(body, env) {
  const validasi = await validasiInitData_(body.initData, env);
  if (!validasi.ok) return jsonResponse(validasi, 401);

  const timPotongId = parseInt(body.timPotongId, 10);
  if (!timPotongId) return jsonResponse({ ok: false, error: 'timPotongId wajib diisi.' }, 400);

  try {
    const rowsTP = await ambilDariSupabase_(env, '/rest/v1/tim_potong?select=*&id=eq.' + timPotongId);
    if (!rowsTP || rowsTP.length === 0) return jsonResponse({ ok: false, error: 'Laporan tim_potong id=' + timPotongId + ' tidak ditemukan.' }, 404);
    const tp = rowsTP[0];
    if (tp.status === 'SELESAI') return jsonResponse({ ok: false, error: 'Laporan ini sudah berstatus SELESAI, tidak bisa diinput lagi.' }, 400);

    // v.15 - ADOPSI skema baru: log_qc sekarang "1 baris = 1x submit" dengan kolom ukuran_xs
    // dst terpisah (BUKAN 1 baris per ukuran lagi) + kolom reject TEKS notasi ringkas ("M1,
    // L2"). Buat tau progress SAAT INI, semua baris log_qc aktif buat laporan ini harus
    // dijumlahkan per ukuran (bisa banyak baris riwayat submit sebelumnya).
    const rowsLog = await ambilDariSupabase_(env, '/rest/v1/log_qc?select=' + Object.values(KOLOM_UKURAN_MAP).join(',') + ',reject&status=eq.aktif&tim_potong_id=eq.' + timPotongId);
    const agregasi = {}; // { XS: {selesai, reject}, ... }
    rowsLog.forEach(function (log) {
      const selesaiBarisIni = kolomKeUkuran_(log);
      const rejectBarisIni = parseRejectNotasi_(log.reject);
      DAFTAR_UKURAN_TIMPOTONG.forEach(function (u) {
        if (!agregasi[u]) agregasi[u] = { selesai: 0, reject: 0 };
        agregasi[u].selesai += selesaiBarisIni[u] || 0;
        agregasi[u].reject += rejectBarisIni[u] || 0;
      });
    });
    const ukuranAsliTP = kolomKeUkuran_(tp);
    const perUkuran = Object.keys(ukuranAsliTP).map(function (u) {
      const qty = ukuranAsliTP[u];
      const p = agregasi[u] || { selesai: 0, reject: 0 };
      return { ukuran: u, qty: qty, selesai: p.selesai, reject: p.reject, sisa: qty - p.selesai - p.reject };
    });

    let deltaSelesai = {}, deltaReject = {};
    if (body.mode === 'ringkas') {
      const s = parseFloat(body.ringkas && body.ringkas.selesai) || 0;
      const r = parseFloat(body.ringkas && body.ringkas.reject) || 0;
      if (s <= 0 && r <= 0) return jsonResponse({ ok: false, error: 'Isi minimal 1 angka Selesai/Reject.' }, 400);
      const hasilDistribusi = distribusiRingkas_(perUkuran, s, r);
      if (hasilDistribusi.sisaSelesaiTakTertampung > 0 || hasilDistribusi.sisaRejectTakTertampung > 0) {
        return jsonResponse({ ok: false, error: 'Jumlah yang diinput melebihi sisa qty yang belum diproses (sisa total: ' + perUkuran.reduce(function (s2, u) { return s2 + u.sisa; }, 0) + ').' }, 400);
      }
      deltaSelesai = hasilDistribusi.deltaSelesai;
      deltaReject = hasilDistribusi.deltaReject;
    } else if (body.mode === 'rincian') {
      const rincian = Array.isArray(body.rincian) ? body.rincian : [];
      for (const r of rincian) {
        const baris = perUkuran.find(function (u) { return u.ukuran === r.ukuran; });
        if (!baris) return jsonResponse({ ok: false, error: 'Ukuran "' + r.ukuran + '" tidak ada di laporan ini.' }, 400);
        const s = parseFloat(r.selesai) || 0;
        const rj = parseFloat(r.reject) || 0;
        if (s + rj > baris.sisa + 0.0001) {
          return jsonResponse({ ok: false, error: 'Ukuran ' + r.ukuran + ': ' + (s + rj) + ' melebihi sisa (' + baris.sisa + ').' }, 400);
        }
        if (s > 0) deltaSelesai[r.ukuran] = s;
        if (rj > 0) deltaReject[r.ukuran] = rj;
      }
      if (Object.keys(deltaSelesai).length === 0 && Object.keys(deltaReject).length === 0) {
        return jsonResponse({ ok: false, error: 'Tidak ada angka yang diisi.' }, 400);
      }
    } else {
      return jsonResponse({ ok: false, error: 'mode harus "ringkas" atau "rincian".' }, 400);
    }

    // v.15 - Tulis SATU baris LOG QC buat submit ini (bukan 1 baris per ukuran lagi). Kolom
    // "warna" sekarang APA ADANYA (nama item lengkap dari tim_potong, TIDAK dipotong prefix-nya
    // seperti versi sebelumnya - ini koreksi eksplisit dari thread Apps Script).
    const daftarPrefixInfo = await ambilDaftarPrefixQC_(env);
    const cocokKategori = cariKategoriQC_(tp.jenis_warna_baju, daftarPrefixInfo);
    let varianQC = cocokKategori ? cocokKategori.varian : '';
    if (!varianQC) {
      const infoWarnaVarian = await ambilInfoWarnaVarianUntukLog_(env, tp.jenis_warna_baju);
      varianQC = infoWarnaVarian.varian;
    }

    const totalDeltaSelesai = Object.keys(deltaSelesai).reduce(function (s, u) { return s + deltaSelesai[u]; }, 0);
    const notasiReject = bangunRejectNotasi_(deltaReject);

    const tarifMap = await ambilTarifJahitMap_(env);
    const hargaJait = tarifMap[String(varianQC || '').toUpperCase()] || null;
    const totalBayar = hargaJait ? totalDeltaSelesai * hargaJait : null;

    const waktu = new Date().toISOString();
    const barisLogBaru = Object.assign({
      waktu: waktu,
      tim_potong_id: timPotongId,
      varian: varianQC || null,
      warna: tp.jenis_warna_baju,
      reject: notasiReject,
      total: totalDeltaSelesai,
      harga_jait: hargaJait,
      total_bayar: totalBayar,
      status: 'aktif'
    }, ukuranKeKolom_(deltaSelesai));

    const resLog = await fetch(env.SUPABASE_URL + '/rest/v1/log_qc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
      body: JSON.stringify([barisLogBaru])
    });
    if (resLog.status >= 300) return jsonResponse({ ok: false, error: 'Gagal simpan log_qc: HTTP ' + resLog.status + ' ' + (await resLog.text()).substring(0, 300) }, 500);

    // Hitung ulang total & tentukan status baru
    const totalSelesaiBaru = perUkuran.reduce(function (s, u) { return s + u.selesai + (deltaSelesai[u.ukuran] || 0); }, 0);
    const totalRejectBaru = perUkuran.reduce(function (s, u) { return s + u.reject + (deltaReject[u.ukuran] || 0); }, 0);
    const sudahSelesaiSemua = (totalSelesaiBaru + totalRejectBaru) >= tp.jumlah;
    const statusBaru = sudahSelesaiSemua ? 'SELESAI' : ('PROSES ' + totalSelesaiBaru + '/' + tp.jumlah + ' (' + totalRejectBaru + ' reject)');
    // v.31: breakdown SELESAI per ukuran (SETELAH delta submit ini) - dipakai buat baris "XL 44"
    // dst di pesan notifikasi QC format baru (lihat kirimAtauEditNotifikasiQC_).
    const perUkuranBaru = perUkuran.map(function (u) { return { ukuran: u.ukuran, selesai: u.selesai + (deltaSelesai[u.ukuran] || 0) }; });

    await fetch(env.SUPABASE_URL + '/rest/v1/tim_potong?id=eq.' + timPotongId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: statusBaru })
    });

    if (sudahSelesaiSemua) {
      // v.24: arsip_selesai sekarang disimpan DETAIL (format terinspirasi LOG QC - Warna,
      // Varian, breakdown ukuran, Total Reject) bukan cuma (tim_potong_id, waktu) doang -
      // biar gampang diidentifikasi langsung di Supabase Table Editor tanpa perlu buka
      // tim_potong terpisah. Breakdown ukuran diambil APA ADANYA dari tim_potong (qty ASLI
      // yang dipotong), bukan dari log_qc (yang isinya per-submit, bisa banyak baris).
      const kolomUkuranAsli = {};
      DAFTAR_UKURAN_TIMPOTONG.forEach(function (u) { kolomUkuranAsli[KOLOM_UKURAN_MAP[u]] = tp[KOLOM_UKURAN_MAP[u]]; });
      await fetch(env.SUPABASE_URL + '/rest/v1/arsip_selesai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
        body: JSON.stringify([Object.assign({
          tim_potong_id: timPotongId,
          waktu: waktu,
          tanggal: tp.tanggal,
          warna: tp.jenis_warna_baju,
          kode_roll: tp.kode_roll,
          varian: varianQC || null,
          jumlah: tp.jumlah,
          total_reject: totalRejectBaru
        }, kolomUkuranAsli)])
      });
    }

    const idPesanBaru = await kirimAtauEditNotifikasiQC_(env, tp, totalSelesaiBaru, totalRejectBaru, statusBaru, varianQC, perUkuranBaru);
    if (idPesanBaru && idPesanBaru !== tp.id_pesan_qc) {
      await fetch(env.SUPABASE_URL + '/rest/v1/tim_potong?id=eq.' + timPotongId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, Prefer: 'return=minimal' },
        body: JSON.stringify({ id_pesan_qc: idPesanBaru })
      });
    }

    return jsonResponse({ ok: true, status: statusBaru, totalSelesai: totalSelesaiBaru, totalReject: totalRejectBaru, sisa: tp.jumlah - totalSelesaiBaru - totalRejectBaru });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// Ambil Warna & Varian buat catatan LOG QC (dipakai kalau kategori_varian_qc gak kasih
// varian-nya langsung) - reuse cariInfoQCLengkap_ yang sebelumnya dipakai buat produksi,
// tapi versi ini butuh daftar prefix produksi (kategori_varian_produksi), BUKAN kategori QC.
// Peta {VARIAN: harga_per_pcs} dari tabel tarif_jahit (dipakai isi kolom Harga Jait/Total
// Bayar di log_qc). Varian gak ketemu di tabel ini -> harga_jait tetap null, gak menggagalkan
// submit (Denny bisa isi tarif_jahit belakangan, data historisnya nyusul otomatis kapan aja
// di-hitung ulang manual kalau perlu).
async function ambilTarifJahitMap_(env) {
  try {
    const rows = await ambilDariSupabase_(env, '/rest/v1/tarif_jahit?select=varian,harga_per_pcs');
    const peta = {};
    rows.forEach(function (r) { peta[String(r.varian || '').toUpperCase()] = parseFloat(r.harga_per_pcs) || null; });
    return peta;
  } catch (e) {
    return {};
  }
}

async function ambilInfoWarnaVarianUntukLog_(env, namaItem) {
  try {
    const rows = await ambilDariSupabase_(env, '/rest/v1/kategori_varian_produksi?select=kategori,label_varian,prefix_tele');
    const daftarPrefix = rows.filter(function (r) { return String(r.prefix_tele || '').trim(); })
      .map(function (r) { return { prefix: String(r.prefix_tele).trim().toUpperCase(), kategori: r.kategori, varian: r.label_varian }; })
      .sort(function (a, b) { return b.prefix.length - a.prefix.length; });
    const info = { daftarPrefix: daftarPrefix, kategoriTanpaPrefix: [] };
    const hasil = cariInfoQCLengkap_(namaItem, info);
    return { warna: hasil.warna, varian: hasil.varian };
  } catch (e) {
    return { warna: '', varian: '' };
  }
}

// v.31: format direvisi total (contoh Denny) - 2 format beda tergantung status:
//   LENGKAP:
//     Sabtu,  1/08/26
//     ✅ LENGKAP 👍
//
//     <b>LS24 SAGE</b> (9103)
//     <b><u>DEWASA PANJANG</u></b>
//     XL 44
//     XXL 7
//     Total: 51
//   BELUM LENGKAP (baris ukuran cuma yang SUDAH ada progress-nya, sisanya gak ditampilin):
//     Sabtu,  1/08/26
//     🔴 BELUM LENGKAP
//
//     <b>LS24 SAGE</b> (9103)
//     <b><u>DEWASA PANJANG</u></b>
//     XXL 7
//     Total: 7 dari 51
// CATATAN ASUMSI (belum ada di contoh Denny - reject-nya kebetulan 0 di kedua contoh): kalau
// totalReject > 0, ditambah 1 baris "Reject: <n>" sebelum baris Total. Kalau ternyata Denny mau
// beda, gampang diubah - tinggal baris `if (totalReject > 0) teks += ...` di bawah.
async function kirimAtauEditNotifikasiQC_(env, tp, totalSelesai, totalReject, statusBaru, varianQC, perUkuranBaru) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_QC_CHAT_ID;
  if (!botToken || !chatId) return null;

  const sudahLengkap = statusBaru === 'SELESAI';
  const headerStatus = sudahLengkap ? '✅ LENGKAP 👍' : '🔴 BELUM LENGKAP';
  const barisUkuran = (perUkuranBaru || [])
    .filter(function (u) { return u.selesai > 0; })
    .map(function (u) { return u.ukuran + ' ' + u.selesai; })
    .join('\n');

  let teks = formatTanggalIndoJakarta_(new Date()) + '\n' + headerStatus + '\n\n';
  teks += '<b>' + htmlEscape_(tp.jenis_warna_baju) + '</b>' + (tp.kode_roll ? (' (' + htmlEscape_(tp.kode_roll) + ')') : '') + '\n';
  if (varianQC) teks += '<b><u>' + htmlEscape_(varianQC) + '</u></b>\n';
  if (barisUkuran) teks += barisUkuran + '\n';
  if (totalReject > 0) teks += 'Reject: ' + totalReject + '\n';
  teks += sudahLengkap ? ('Total: ' + tp.jumlah) : ('Total: ' + totalSelesai + ' dari ' + tp.jumlah);

  if (tp.id_pesan_qc) {
    const resEdit = await fetch('https://api.telegram.org/bot' + botToken + '/editMessageText', {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: tp.id_pesan_qc, text: teks, parse_mode: 'HTML' })
    });
    const dataEdit = await resEdit.json();
    if (dataEdit.ok) return tp.id_pesan_qc;
    // kalau gagal edit (mis. pesan lama udah kehapus manual), lanjut kirim baru di bawah
  }

  try {
    const resKirim = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: teks, parse_mode: 'HTML' })
    });
    const dataKirim = await resKirim.json();
    return dataKirim.ok ? dataKirim.result.message_id : null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// DASHBOARD - Daftar Laporan QC (Tahap 1)
// ============================================================

// Porting PERSIS dari cariKategoriTimQC() (Apps Script) - cocokkan nama item ke tabel
// kategori_varian_qc (prefix terpanjang dulu), balikin string kategori_qc PERSIS
// (mis. "DEWASA POLOS"). Badge Anak/Dewasa di dashboard cuma ambil KATA PERTAMA dari ini.
async function ambilDaftarPrefixQC_(env) {
  const rows = await ambilDariSupabase_(env, '/rest/v1/kategori_varian_qc?select=kategori_qc,varian,prefix_sheet&order=id.asc');
  const daftarPrefix = rows
    .filter(function (r) { return String(r.prefix_sheet || '').trim(); })
    .map(function (r) { return { prefix: String(r.prefix_sheet).trim().toUpperCase(), kategoriQc: r.kategori_qc, varian: r.varian }; })
    .sort(function (a, b) { return b.prefix.length - a.prefix.length; }); // terpanjang dulu

  // Fallback: kategori yang punya varian TANPA prefix sama sekali (mis. item cuma nama warna
  // polos) - kalau CUMA ADA 1 kategori kayak gitu, itu dipakai sebagai fallback pas nama item
  // gak cocok ke prefix manapun. Porting persis dari cariKategoriTimQC() (Apps Script).
  const tanpaPrefixSet = {};
  rows.forEach(function (r) {
    if (!String(r.prefix_sheet || '').trim()) tanpaPrefixSet[r.kategori_qc] = true;
  });
  const kategoriTanpaPrefix = Object.keys(tanpaPrefixSet);

  return { daftarPrefix: daftarPrefix, kategoriTanpaPrefix: kategoriTanpaPrefix };
}

function cariKategoriQC_(namaItem, info) {
  const daftarPrefix = info.daftarPrefix;
  const nama = String(namaItem || '').trim().toUpperCase();
  for (let i = 0; i < daftarPrefix.length; i++) {
    const p = daftarPrefix[i].prefix;
    if (nama === p) return daftarPrefix[i];
    if (nama.indexOf(p) === 0) {
      const setelah = nama.charAt(p.length);
      if (setelah === '' || setelah === ' ' || setelah === '-') return daftarPrefix[i];
    }
  }
  if (info.kategoriTanpaPrefix.length === 1) return { kategoriQc: info.kategoriTanpaPrefix[0] };
  return null;
}

async function handleDaftarLaporanQC_(env) {
  try {
    const [rowsTP, daftarPrefix] = await Promise.all([
      ambilDariSupabase_(env, '/rest/v1/tim_potong?select=*&status=neq.SELESAI&order=tanggal.asc,id.asc'),
      ambilDaftarPrefixQC_(env)
    ]);

    if (rowsTP.length === 0) return jsonResponse([]);

    const idList = rowsTP.map(function (r) { return r.id; }).join(',');
    // v.15 - ADOPSI skema baru: log_qc "1 baris = 1x submit", ukuran_xs dst kolom terpisah,
    // reject notasi teks ("M1, L2") - perlu di-parse & dijumlahkan per ukuran per tim_potong_id.
    const rowsLog = await ambilDariSupabase_(env, '/rest/v1/log_qc?select=tim_potong_id,' + Object.values(KOLOM_UKURAN_MAP).join(',') + ',reject&status=eq.aktif&tim_potong_id=in.(' + idList + ')');

    const agregasi = {}; // { [tim_potong_id]: { [ukuran]: { selesai, reject } } }
    rowsLog.forEach(function (log) {
      if (!agregasi[log.tim_potong_id]) agregasi[log.tim_potong_id] = {};
      const selesaiBarisIni = kolomKeUkuran_(log);
      const rejectBarisIni = parseRejectNotasi_(log.reject);
      DAFTAR_UKURAN_TIMPOTONG.forEach(function (u) {
        if (!agregasi[log.tim_potong_id][u]) agregasi[log.tim_potong_id][u] = { selesai: 0, reject: 0 };
        agregasi[log.tim_potong_id][u].selesai += selesaiBarisIni[u] || 0;
        agregasi[log.tim_potong_id][u].reject += rejectBarisIni[u] || 0;
      });
    });

    const hasil = rowsTP.map(function (tp) {
      const cocok = cariKategoriQC_(tp.jenis_warna_baju, daftarPrefix);
      const kategoriBadge = cocok ? String(cocok.kategoriQc).split(' ')[0] : '';

      const progresPerTP = agregasi[tp.id] || {};
      const ukuranAsliTP = kolomKeUkuran_(tp);
      const perUkuran = Object.keys(ukuranAsliTP).map(function (u) {
        const qty = ukuranAsliTP[u];
        const p = progresPerTP[u] || { selesai: 0, reject: 0 };
        return { ukuran: u, qty: qty, selesai: p.selesai, reject: p.reject, sisa: qty - p.selesai - p.reject };
      });

      const totalSelesai = perUkuran.reduce(function (s, u) { return s + u.selesai; }, 0);
      const totalReject = perUkuran.reduce(function (s, u) { return s + u.reject; }, 0);

      return {
        id: tp.id,
        tanggal: tp.tanggal,
        createdAt: tp.created_at,
        jenisWarnaBaju: tp.jenis_warna_baju,
        kategoriBadge: kategoriBadge,
        kodeRoll: tp.kode_roll,
        pemakaianKainKg: tp.pemakaian_kain_kg,
        jumlah: tp.jumlah,
        perUkuran: perUkuran,
        totalSelesai: totalSelesai,
        totalReject: totalReject,
        sisa: tp.jumlah - totalSelesai - totalReject
      };
    });

    return jsonResponse(hasil);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}
// HARUS selalu sinkron dengan daftar prefix di kategori_varian_produksi (pernah jadi bug nyata
// di sistem lama: OSH/RING salah kebaca jadi nama warna karena daftar ini gak lengkap).
// ============================================================
const DAFTAR_UKURAN_TIMPOTONG = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL', '6XL'];

// ============================================================
// ADOPSI SKEMA BARU (dari thread Apps Script terpisah) - tim_potong.ukuran (dulu JSONB) dan
// log_qc (dulu 1 baris/ukuran) SEKARANG SAMA-SAMA pakai kolom terpisah per ukuran
// (ukuran_xs, ukuran_s, dst) - BUKAN JSONB lagi. Helper di bawah buat "terjemahin" bolak-balik
// antara representasi objek {XS:n, S:n, ...} yang dipakai LOGIKA INTERNAL Worker ini (gak
// berubah) dengan kolom-kolom fisik di database (yang berubah).
// ============================================================
const KOLOM_UKURAN_MAP = {
  XS: 'ukuran_xs', S: 'ukuran_s', M: 'ukuran_m', L: 'ukuran_l', XL: 'ukuran_xl', XXL: 'ukuran_xxl',
  '3XL': 'ukuran_3xl', '4XL': 'ukuran_4xl', '5XL': 'ukuran_5xl', '6XL': 'ukuran_6xl'
};

// Objek {XS:2, M:5} -> {ukuran_xs:2, ukuran_m:5, ukuran_s:null, ...} siap buat INSERT/PATCH.
function ukuranKeKolom_(ukuranObj) {
  const hasil = {};
  DAFTAR_UKURAN_TIMPOTONG.forEach(function (u) {
    const v = ukuranObj && ukuranObj[u] ? parseFloat(ukuranObj[u]) : null;
    hasil[KOLOM_UKURAN_MAP[u]] = v && v > 0 ? v : null;
  });
  return hasil;
}

// Baris dari Supabase (punya kolom ukuran_xs, ukuran_s, dst) -> objek {XS:2, M:5} (cuma yang
// isinya > 0) buat dipakai logika internal yang sudah ada.
function kolomKeUkuran_(row) {
  const hasil = {};
  DAFTAR_UKURAN_TIMPOTONG.forEach(function (u) {
    const v = parseFloat(row[KOLOM_UKURAN_MAP[u]]);
    if (v > 0) hasil[u] = v;
  });
  return hasil;
}

// Notasi ringkas Reject ("M1, L2") -> objek {M:1, L:2}. Regex aman buat kode ukuran yang
// diawali angka juga (mis. "3XL7") karena non-greedy + anchor akhir string bikin mesin regex
// otomatis nyari batas paling pas (dites: "3XL7" -> ukuran="3XL", angka="7", BUKAN "3"+"XL7").
function parseRejectNotasi_(teks) {
  const hasil = {};
  if (!teks) return hasil;
  String(teks).split(',').forEach(function (bagian) {
    const t = bagian.trim();
    const m = t.match(/^(.+?)(\d+)$/);
    if (m) {
      const u = m[1].toUpperCase();
      hasil[u] = (hasil[u] || 0) + parseInt(m[2], 10);
    }
  });
  return hasil;
}

// Objek {M:1, L:2} -> notasi ringkas "M1, L2" (urut sesuai DAFTAR_UKURAN_TIMPOTONG, bukan
// urutan sembarang), null kalau kosong semua.
function bangunRejectNotasi_(rejectObj) {
  const bagian = DAFTAR_UKURAN_TIMPOTONG
    .filter(function (u) { return rejectObj[u] > 0; })
    .map(function (u) { return u + rejectObj[u]; });
  return bagian.length > 0 ? bagian.join(', ') : null;
}

const KODE_GAYA_BUKAN_WARNA_ = ['LT', 'PJ', 'CP', 'SET', 'SET.', 'ANAK', 'OSA', 'RFL', 'RUFFLE', 'TS24', 'TS30', 'LS24-', 'LS30', 'ONESET', 'PENDEK', 'OSHT', 'TST', 'SPEN', 'LS', 'LS24', 'OS', 'OSH', 'TS', 'LST', 'RING', 'HL', 'PC', 'POLO'];

function ekstrakKataWarna_(itemName) {
  return String(itemName || '').split(/\s+/)
    .map(function (w) { return w.replace(/[.\-]/g, ''); })
    .filter(function (w) { return w && KODE_GAYA_BUKAN_WARNA_.indexOf(w.toUpperCase()) === -1; });
}

// Bikin peta TERM -> [semua term dalam 1 grup sinonim, termasuk dirinya] dari tabel
// kamus_sinonim_warna. Porting dari bacaKamusSinonimWarna() (Apps Script).
async function ambilKamusSinonimWarnaMap_(env) {
  const rows = await ambilDariSupabase_(env, '/rest/v1/kamus_sinonim_warna?select=kanonik,sinonim');
  const map = {};
  rows.forEach(function (row) {
    const semua = [String(row.kanonik || '').toUpperCase()]
      .concat((row.sinonim || []).map(function (s) { return String(s || '').toUpperCase(); }))
      .filter(Boolean);
    semua.forEach(function (term) { map[term] = semua; });
  });
  return map;
}

function getSinonimWarna_(warna, kamusMap) {
  const w = String(warna || '').toUpperCase();
  return kamusMap[w] || [w];
}

// ============================================================
// PORTING dari cariInfoQCLengkap_() (CODE TIM POTONG.js Apps Script) - cari Varian dari tabel
// kategori_varian_produksi + pisahkan Warna dari nama item (nama item = "<Prefix> <WARNA>").
// Dipakai buat isi kolom Varian/Warna di LOG QC. info.kategoriTanpaPrefix SENGAJA dikosongkan
// (array kosong) di pemanggilan dari Worker ini - fallback "tanpa prefix" utamanya relevan
// buat kategori_varian_QC (beda tabel), bukan kategori_varian_produksi yang dipakai di sini.
function cariInfoQCLengkap_(namaItem, info) {
  const daftarPrefix = (info && info.daftarPrefix) || [];
  const namaAsli = String(namaItem || '').trim();
  const nama = namaAsli.toUpperCase();
  for (let i = 0; i < daftarPrefix.length; i++) {
    const p = daftarPrefix[i].prefix.toUpperCase();
    if (!p) continue;
    if (nama === p) {
      return { varian: daftarPrefix[i].varian || '', warna: '' };
    }
    if (nama.indexOf(p) === 0) {
      const setelahPrefix = nama.charAt(p.length);
      if (setelahPrefix === '' || setelahPrefix === ' ' || setelahPrefix === '-') {
        const warna = namaAsli.slice(p.length).replace(/^[\s-]+/, '').trim();
        return { varian: daftarPrefix[i].varian || '', warna: warna };
      }
    }
  }
  return { varian: '', warna: namaAsli };
}

// ============================================================
// PORTING PERSIS dari updateStokKain() (Apps Script) - prioritas pencocokan: 1) Warna+Kode
// Roll EXACT MATCH (kalau kode roll disebutkan - TIDAK ADA fallback tebak-tebak), 2) Warna+Kg
// terdekat (cuma kalau kode roll TIDAK disebutkan sama sekali).
// ============================================================
async function kurangiStokKain_(env, itemName, kainKg, kodeRoll, timPotongId, kamusMap) {
  const kataWarna = ekstrakKataWarna_(itemName);
  if (kataWarna.length === 0) {
    return { matched: false, keterangan: 'Tidak ada kata warna terdeteksi dari nama "' + itemName + '"' };
  }
  const warnaUtama = kataWarna[0];
  const daftarWarnaCari = getSinonimWarna_(warnaUtama, kamusMap);

  const rowsStok = await ambilDariSupabase_(env, '/rest/v1/stok_kain?select=id,warna,kode_roll,kg_terpakai,kg_sisa&kg_sisa=gt.0');
  const kodeRollNorm = kodeRoll ? String(kodeRoll).trim().toUpperCase() : null;

  function cariBaris(wajibKodeRollCocok) {
    let best = null, bestDiff = Infinity;
    rowsStok.forEach(function (row) {
      const warnaCell = String(row.warna || '').toUpperCase();
      const kgSisa = parseFloat(row.kg_sisa) || 0;
      if (kgSisa <= 0) return;
      const cocokWarna = daftarWarnaCari.some(function (w) { return warnaCell.indexOf(w) !== -1; });
      if (!cocokWarna) return;
      if (wajibKodeRollCocok) {
        const kodeCell = String(row.kode_roll || '').trim().toUpperCase();
        if (!kodeCell || kodeCell !== kodeRollNorm) return;
      }
      const diff = Math.abs(kgSisa - kainKg);
      if (diff < bestDiff) { bestDiff = diff; best = row; }
    });
    return best;
  }

  const matched = kodeRollNorm ? cariBaris(true) : cariBaris(false);

  if (!matched) {
    const daftarStr = daftarWarnaCari.join(' / ');
    const keterangan = kodeRollNorm
      ? ('Kode Roll "' + kodeRollNorm + '" (warna "' + daftarStr + '", kg ' + kainKg + ') tidak ketemu PERSIS di stok_kain - tidak dicoba tebak dari kg terdekat')
      : ('Warna "' + daftarStr + '" (kg ' + kainKg + ') tidak ketemu stok kain yang cocok/cukup');
    return { matched: false, keterangan: keterangan };
  }

  const kgTerpakaiBaru = (parseFloat(matched.kg_terpakai) || 0) + kainKg;
  const resUpdate = await fetch(env.SUPABASE_URL + '/rest/v1/stok_kain?id=eq.' + matched.id, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ kg_terpakai: kgTerpakaiBaru })
  });
  if (resUpdate.status >= 300) {
    return { matched: false, keterangan: 'Gagal update stok_kain: HTTP ' + resUpdate.status };
  }

  await fetch(env.SUPABASE_URL + '/rest/v1/log_pemakaian_kain', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify([{
      tim_potong_id: timPotongId,
      stok_kain_id: matched.id,
      kg: kainKg,
      waktu: new Date().toISOString(),
      warna: matched.warna,
      item_produksi: itemName
    }])
  });

  return { matched: true, stokKainId: matched.id };
}

// ============================================================
// PORTING PERSIS dari bikinAwalan_() di HTML PRODUKSI.html (Apps Script):
// Kata "ANAK" HANYA muncul untuk varian Pendek/Panjang (Kode Item kosong atau "PJG") - varian
// Anak lainnya yang sudah punya kode sendiri (RFL/SET./ONSET/SPEN/CELANA) TIDAK pakai kata
// "ANAK" sama sekali. Kategori DEWASA TIDAK PERNAH pakai kata "DEWASA", di varian manapun.
// ============================================================
function bikinAwalan_(kategori, kodeItem) {
  const kodeUpper = kodeItem ? String(kodeItem).toUpperCase() : '';
  const butuhKataAnak = String(kategori || '').toLowerCase() === 'anak' && (kodeUpper === '' || kodeUpper === 'PJG');
  if (butuhKataAnak) {
    return kodeUpper ? ('ANAK ' + kodeUpper) : 'ANAK';
  }
  return kodeUpper;
}

// ============================================================
// Handler submit produksi (item BIASA, bukan kombinasi) - Tahap 3.
// Body yang diharapkan: { initData, items: [ item, ... ] }
// Tiap item (non-custom):
//   { kategori: "Anak"|"Dewasa", kodeItem: "<prefix dari kategori_varian_produksi>",
//     warna: "NAVY", kg: 25.5, kodeRoll: "0962", ukuran: {"S":40,"M":55}, tanggal: "2026-07-26" (opsional) }
// Item CUSTOM (belum terdaftar di varian):
//   { custom: true, namaCustom: "NAMA ITEM LENGKAP BEBAS", warna1, kg1, kodeRoll1,
//     warna2 (opsional, produk kombinasi 2 warna), kg2, kodeRoll2, ukuran, tanggal }
//   v.16: warna1/warna2 EKSPLISIT (ganti kg/kodeRoll polos versi lama) - dipakai buat potong
//   stok akurat, bukan nebak dari namaCustom. Semua tetap opsional (item custom boleh gak ada
//   warna/kg sama sekali, kayak sebelumnya) - kalau kg1 diisi, warna1 jadi wajib.
// ============================================================
async function handleSubmitProduksi_(body, env) {
  const validasi = await validasiInitData_(body.initData, env);
  if (!validasi.ok) return jsonResponse(validasi, 401);

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return jsonResponse({ ok: false, error: 'Tidak ada item yang dikirim.' }, 400);

  // v.07 (Tahap 5): anti-duplikat - fingerprint dihitung dari ISI item (bukan teks bebas kayak
  // sistem lama, karena Mini App sekarang kirim data terstruktur). Key pakai 'miniapp_' + userId,
  // sama pola kayak sistem lama (initData cuma kasih identitas USER, bukan chat).
  const keyDuplikat = 'miniapp_' + (validasi.userId || 'unknown');
  const fingerprint = await hashFingerprint_(JSON.stringify(items));
  const cekDuplikat = await cekDanCatatDuplikat_(env, keyDuplikat, fingerprint, JSON.stringify(items).substring(0, 300));
  if (cekDuplikat.duplikat) {
    return jsonResponse({
      ok: false,
      duplikat: true,
      error: 'DUPLIKAT: data ini sama persis kayak yang barusan dikirim ' + formatJarakWaktu_(cekDuplikat.jarakMs) + ' lalu - tidak diproses lagi biar gak dobel.'
    }, 409);
  }

  const rows = [];
  // v.16: warna eksplisit item custom (index SEJAJAR dgn `rows`) - dipakai pas potong stok di
  // bawah, karena `jenis_warna_baju` utk custom item bebas format & gak selalu bisa ditebak
  // warnanya. Asumsi: urutan baris balik dari Supabase (`hasil`) SAMA dgn urutan `rows` yang
  // dikirim (1x POST array, gak ada trigger yang bisa acak urutan) - kalau suatu saat ada
  // laporan potong stok custom-item ketuker antar baris, ini titik pertama yang perlu dicurigai.
  const warnaUtamaPerRow = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const ukuran = it.ukuran && typeof it.ukuran === 'object' ? it.ukuran : {};
    const jumlah = Object.keys(ukuran).reduce(function (s, k) { return s + (parseFloat(ukuran[k]) || 0); }, 0);
    if (jumlah <= 0) return jsonResponse({ ok: false, error: 'Item ke-' + (i + 1) + ': tidak ada qty ukuran yang diisi.' }, 400);

    let namaItem, kgUtama, kodeRollUtama, refStok = null, warnaCustomUtama = null, sumberKgUtama = null;

    if (it.kombinasi) {
      // Item KOMBINASI (2-3 warna) - porting konsep "RefStok": baris ini nama-nya gabungan
      // 2 warna PERTAMA, kg/roll UTAMA ambil dari warna pertama (dipotong lewat jalur sama
      // seperti item biasa). Warna KE-2 (dan ke-3 kalau ada) masing-masing punya kg/roll
      // sendiri, disimpan di ref_stok buat dipotong TERPISAH (lihat bagian potong stok di bawah).
      const kb = it.kombinasi;
      const warnaArr = Array.isArray(kb.warna) ? kb.warna.map(function (w) { return String(w || '').trim().toUpperCase(); }) : [];
      const kgArr = Array.isArray(kb.kg) ? kb.kg.map(function (v) { return parseFloat(v) || 0; }) : [];
      const rollArr = Array.isArray(kb.kodeRoll) ? kb.kodeRoll.map(function (r) { return r ? String(r).trim() : null; }) : [];
      const sumberKgArr = Array.isArray(kb.kgSumber) ? kb.kgSumber : [];
      if (warnaArr.length < 2 || warnaArr.length > 3 || warnaArr.some(function (w) { return !w; })) {
        return jsonResponse({ ok: false, error: 'Item ke-' + (i + 1) + ': kombinasi harus 2 atau 3 warna, semua wajib diisi.' }, 400);
      }
      const awalan = bikinAwalan_(it.kategori, it.kodeItem);
      namaItem = (awalan ? awalan + ' ' : '') + warnaArr[0] + ' ' + warnaArr[1];
      kgUtama = kgArr[0] || null;
      kodeRollUtama = rollArr[0] || null;
      sumberKgUtama = sumberKgArr[0] || null;
      refStok = [];
      for (let k = 1; k < warnaArr.length; k++) {
        refStok.push({ warna: warnaArr[k], kg: kgArr[k] || 0, kodeRoll: rollArr[k], sumberKg: sumberKgArr[k] || null });
      }
    } else if (it.custom) {
      // v.16: warna1/warna2 EKSPLISIT (bukan nebak dari namaCustom yang bebas format kayak
      // sebelumnya) - dipakai buat potong stok akurat. Warna ke-2 (kalau ada, produk kombinasi
      // 2 warna bahan) dipotong TERPISAH lewat ref_stok, PERSIS mekanisme yang kombinasi biasa
      // udah punya di atas. namaItem tetap bebas ketik apa adanya, cuma dipakai buat pencatatan/
      // tampilan - warna1/warna2 yang dipakai buat cocokkan ke stok_kain, bukan namaItem.
      namaItem = String(it.namaCustom || '').trim().toUpperCase();
      if (!namaItem) return jsonResponse({ ok: false, error: 'Item ke-' + (i + 1) + ': nama custom kosong.' }, 400);
      const warna1_ = it.warna1 ? String(it.warna1).trim().toUpperCase() : null;
      kgUtama = it.kg1 != null && it.kg1 !== '' ? parseFloat(it.kg1) : null;
      kodeRollUtama = it.kodeRoll1 ? String(it.kodeRoll1).trim() : null;
      sumberKgUtama = it.kgSumber1 || null;
      if (kgUtama && !warna1_) {
        return jsonResponse({ ok: false, error: 'Item ke-' + (i + 1) + ': kg diisi tapi warna 1 kosong - gak jelas mau potong stok warna apa.' }, 400);
      }
      warnaCustomUtama = warna1_;
      if (it.warna2) {
        const warna2_ = String(it.warna2).trim().toUpperCase();
        const kg2_ = it.kg2 != null && it.kg2 !== '' ? parseFloat(it.kg2) : 0;
        if (!kg2_ || kg2_ <= 0) {
          return jsonResponse({ ok: false, error: 'Item ke-' + (i + 1) + ': warna ke-2 "' + warna2_ + '" butuh kg lebih dari 0.' }, 400);
        }
        refStok = [{ warna: warna2_, kg: kg2_, kodeRoll: it.kodeRoll2 ? String(it.kodeRoll2).trim() : null, sumberKg: it.kgSumber2 || null }];
      }
    } else {
      const awalan = bikinAwalan_(it.kategori, it.kodeItem);
      const warna = String(it.warna || '').trim().toUpperCase();
      if (!warna) return jsonResponse({ ok: false, error: 'Item ke-' + (i + 1) + ': warna kosong.' }, 400);
      namaItem = (awalan ? awalan + ' ' : '') + warna;
      kgUtama = it.kg != null && it.kg !== '' ? parseFloat(it.kg) : null;
      kodeRollUtama = it.kodeRoll ? String(it.kodeRoll).trim() : null;
      sumberKgUtama = it.kgSumber || null;
    }

    rows.push(Object.assign({
      tanggal: it.tanggal || tanggalHariIniJakarta_(),
      jenis_warna_baju: namaItem,
      pemakaian_kain_kg: kgUtama,
      sumber_kg: sumberKgUtama,
      kode_roll: kodeRollUtama,
      jumlah: jumlah,
      status: '',
      ref_stok: refStok
    }, ukuranKeKolom_(ukuran)));
    warnaUtamaPerRow.push(warnaCustomUtama);
  }

  // v.06: kg WAJIB positif kalau diisi - kg minus/nol gak masuk akal ("pakai kain minus kg")
  // dan pernah kebukti bisa nyebabin bug (kg_terpakai malah NAMBAH balik alih-alih berkurang).
  // v.08 (kombinasi): kg di dalam ref_stok juga dicek positif, bukan cuma kg utama.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].pemakaian_kain_kg !== null && rows[i].pemakaian_kain_kg <= 0) {
      return jsonResponse({ ok: false, error: 'Item ke-' + (i + 1) + ': kg harus lebih besar dari 0 (dikirim: ' + rows[i].pemakaian_kain_kg + ').' }, 400);
    }
    if (Array.isArray(rows[i].ref_stok)) {
      for (const bd of rows[i].ref_stok) {
        if (!bd.kg || bd.kg <= 0) {
          return jsonResponse({ ok: false, error: 'Item ke-' + (i + 1) + ': kg warna "' + bd.warna + '" di kombinasi harus lebih besar dari 0.' }, 400);
        }
      }
    }
  }

  try {
    const res = await fetch(env.SUPABASE_URL + '/rest/v1/tim_potong', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY,
        Prefer: 'return=representation'
      },
      body: JSON.stringify(rows)
    });
    if (res.status >= 300) {
      return jsonResponse({ ok: false, error: 'HTTP ' + res.status + ': ' + (await res.text()).substring(0, 300) }, 500);
    }
    const hasil = await res.json();

    // v.21: begitu tim_potong sukses ke-insert, tempelkan ID barisnya ke record anti-duplikat
    // yang tadi dicatat cekDanCatatDuplikat_ - dipakai buat cek "masih ada apa udah kehapus
    // semua" kalau nanti ada kiriman identik lagi. Gak nge-block proses (dijalankan tapi gak
    // ditunggu blocking respons ke user - kalau gagal, gak fatal, cuma anti-duplikat kiriman
    // ini doang yang kurang presisi).
    await tempelkanTimPotongIdsKeAntiDuplikat_(env, cekDuplikat.recordId, hasil.map(function (r) { return r.id; }));

    // v.05 (Tahap 4) - potong stok kain buat tiap item yang punya kg. Item TETAP masuk ke
    // tim_potong walau stoknya gak ketemu cocok - cuma dikasih peringatan di response, gak
    // diblokir (sama seperti sistem lama, baris ditandai kuning bukan ditolak).
    const kamusMap = await ambilKamusSinonimWarnaMap_(env);
    const peringatanStok = [];
    for (let i = 0; i < hasil.length; i++) {
      const row = hasil[i];
      if (row.pemakaian_kain_kg && parseFloat(row.pemakaian_kain_kg) > 0) {
        // v.16: item custom pakai warna eksplisit (warnaUtamaPerRow) kalau ada, bukan nebak dari
        // jenis_warna_baju yang bebas format - item biasa/kombinasi tetap seperti sebelumnya.
        const namaBuatPotong = warnaUtamaPerRow[i] || row.jenis_warna_baju;
        const hasilStok = await kurangiStokKain_(env, namaBuatPotong, parseFloat(row.pemakaian_kain_kg), row.kode_roll, row.id, kamusMap);
        if (!hasilStok.matched) {
          peringatanStok.push('Item "' + row.jenis_warna_baju + '": ' + hasilStok.keterangan);
        }
      }
      // v.08 (kombinasi) - potong breakdown warna ke-2 (dan ke-3 kalau ada) SECARA TERPISAH,
      // masing-masing dicocokkan lewat namanya sendiri (bukan lewat nama item gabungan).
      if (Array.isArray(row.ref_stok)) {
        for (const bd of row.ref_stok) {
          const hasilBd = await kurangiStokKain_(env, bd.warna, parseFloat(bd.kg), bd.kodeRoll, row.id, kamusMap);
          if (!hasilBd.matched) {
            peringatanStok.push('Item "' + row.jenis_warna_baju + '" (breakdown warna "' + bd.warna + '"): ' + hasilBd.keterangan);
          }
        }
      }
    }

    await kirimNotifikasiProduksi_(env, hasil, peringatanStok);
    return jsonResponse({ ok: true, jumlahItem: hasil.length, items: hasil, peringatanStok: peringatanStok });
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Gagal menyimpan ke Supabase: ' + e.message }, 500);
  }
}
async function hmacSha256_(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, messageBytes);
  return new Uint8Array(sig);
}

// ============================================================
// Helper: query GET ke Supabase (PostgREST), balikin Response siap kirim ke client APA ADANYA
// (dipakai buat endpoint yang datanya gak perlu diolah dulu, tinggal diteruskan).
// ============================================================
async function proxySupabaseGet_(env, path) {
  try {
    const res = await fetch(env.SUPABASE_URL + path, {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY
      }
    });
    const teks = await res.text();
    return new Response(teks, {
      status: res.status,
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS_)
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Gagal ambil data dari Supabase: ' + e.message }, 500);
  }
}

// Helper: query GET ke Supabase, balikin data SUDAH di-parse jadi array/object JS (dipakai
// endpoint yang datanya perlu diolah dulu di Worker sebelum dikirim ke client).
async function ambilDariSupabase_(env, path) {
  const res = await fetch(env.SUPABASE_URL + path, {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY
    }
  });
  if (res.status >= 300) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).substring(0, 300));
  return await res.json();
}

// ============================================================
// PORTING dari bacaPetaWarnaKanonik() (Apps Script) - PERBEDAAN: di Supabase, "kanonik" udah
// jadi kolom sendiri (kamus_sinonim_warna.kanonik), gak perlu lagi "kolom pertama yang terisi"
// kayak di sheet. Hasilnya: {SINONIM_ATAU_KANONIK: KANONIK}, dipakai Mini App buat translate
// warna combo SEBELUM dicocokkan ke stok.
// ============================================================
async function ambilPetaWarnaKanonik_(env) {
  const rows = await ambilDariSupabase_(env, '/rest/v1/kamus_sinonim_warna?select=kanonik,sinonim');
  const peta = {};
  rows.forEach(function (row) {
    const kanonik = String(row.kanonik || '').toUpperCase();
    if (!kanonik) return;
    peta[kanonik] = kanonik;
    (row.sinonim || []).forEach(function (s) {
      const su = String(s || '').toUpperCase();
      if (su) peta[su] = kanonik;
    });
  });
  return peta;
}

async function handleWarnaKanonik_(env) {
  try {
    const peta = await ambilPetaWarnaKanonik_(env);
    return jsonResponse(peta);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// PORTING dari bacaStokRollPerWarna() (Apps Script) - SEMUA roll dengan kg_sisa > 0 (bukan cuma
// yang belum disentuh sama sekali), dikelompokkan per warna KANONIK, diurutkan kg_sisa terbesar
// dulu per grup.
// ============================================================
async function handleStokRollPerWarna_(env) {
  try {
    const [rowsStok, rowsKamus] = await Promise.all([
      ambilDariSupabase_(env, '/rest/v1/stok_kain?select=warna,kode_roll,kg_sisa&kg_sisa=gt.0'),
      ambilDariSupabase_(env, '/rest/v1/kamus_sinonim_warna?select=kanonik,sinonim')
    ]);

    const petaKanonik = {};
    rowsKamus.forEach(function (row) {
      const kanonik = String(row.kanonik || '').toUpperCase();
      if (!kanonik) return;
      petaKanonik[kanonik] = kanonik;
      (row.sinonim || []).forEach(function (s) {
        const su = String(s || '').toUpperCase();
        if (su) petaKanonik[su] = kanonik;
      });
    });

    const grup = {};
    rowsStok.forEach(function (row) {
      const warnaRaw = String(row.warna || '').trim();
      const kodeRoll = String(row.kode_roll || '').trim();
      const kgSisa = parseFloat(row.kg_sisa) || 0;
      // v.17: SEBELUMNYA baris yang kode_roll-nya kosong/null ikut KE-SKIP TOTAL (bukan cuma
      // kode rollnya yang gak kelihatan, tapi WARNANYA JUGA gak pernah nyampe ke Mini App sama
      // sekali - ini akar bug "warna gak muncul di autosuggest" yang dicurigai Denny). kode_roll
      // kosong itu valid (roll belum dicatat/diketahui), BUKAN alasan buat nyembunyiin stoknya.
      if (!warnaRaw || kgSisa <= 0) return;
      const kanonik = petaKanonik[warnaRaw.toUpperCase()] || warnaRaw.toUpperCase();
      if (!grup[kanonik]) grup[kanonik] = [];
      grup[kanonik].push({ kodeRoll: kodeRoll || null, kg: kgSisa });
    });
    Object.keys(grup).forEach(function (k) {
      grup[k].sort(function (a, b) { return b.kg - a.kg; });
    });

    return jsonResponse(grup);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ============================================================
// v.18: WEBHOOK TELEGRAM UTAMA - jalur cepat /produksi & /stok
// ============================================================
// Kenapa ada 2 jalur: Telegram cuma izinkan 1 webhook URL per bot, jadi Worker ini yang jadi
// penerima UTAMA sekarang (gantiin Apps Script). Command /produksi & /stok DIBALAS LANGSUNG di
// sini (cuma butuh 1x panggilan Telegram API, gak ada logDebug/buka-Spreadsheet kayak Apps
// Script versi lama) - inilah yang bikin responnya bisa di bawah 1 detik, bukan 2-3 detik lagi.
// SEMUA update lain (laporan teks manual, foto nota supplier, callback tombol konfirmasi nota)
// diteruskan MENTAH-MENTAH ke Apps Script (proxyKeAppsScript_) - logic aslinya di sana TIDAK
// disentuh/diubah sama sekali, tetap jalan persis seperti sebelumnya.
//
// STATE pasangan pesan terakhir (buat hapus instan begitu ada command baru) SEKARANG di
// Cloudflare KV (binding `TIM_POTONG_KV`), gantiin PropertiesService Apps Script - alasannya
// simpel: begitu command ini ditangani di sini, Apps Script gak pernah lihat command ini lagi,
// jadi state-nya harus pindah tempat juga.
//
// CATATAN: fitur "jaring pengaman pembersihan harian jam 1 pagi" (versi Apps Script lama) TIDAK
// ikut diporting ke sini - itu murni backup kalau hapus instan gagal (bot kehilangan izin admin
// sementara, dll), bukan mekanisme utama. Kalau nanti ternyata beneran dibutuhkan, bisa
// ditambahkan pakai Cron Trigger Cloudflare - untuk sekarang sengaja diprioritaskan yang inti
// dulu (kecepatan respons).
// ============================================================

// ============================================================
// v.38 - MIGRASI FITUR "BACA NOTA" (foto struk/nota supplier -> baca otomatis pakai Claude
// Vision -> preview -> konfirmasi tombol -> simpan ke Supabase) dari Apps Script ke Worker.
// Port 1:1 dari parseNotaKainDenganAI_/prosesItemNota_/bangunTeksPreviewNota_/dkk di Apps
// Script - termasuk prompt AI-nya persis sama, biar hasil baca gak berubah.
//
// Bedanya dari Apps Script:
//  - CacheService (batas 6 jam, per-project) -\u003e Cloudflare KV (TIM_POTONG_KV, TTL 30 menit
//    persis kayak sebelumnya, tapi scope-nya di Worker bukan lagi di Apps Script).
//  - LockService TIDAK diporting - Workers gak punya masalah single-thread yang sama kayak
//    Apps Script, jadi gak butuh lock buat tombol "Simpan" (risiko dobel-tap sangat kecil,
//    diterima sebagai trade-off simplisitas).
//  - Perlu secret BARU: ANTHROPIC_API_KEY di Cloudflare Worker (sebelumnya Script Property
//    Apps Script, TERNYATA sudah lama kosong/gak keisi - fitur ini kemungkinan sempat gak
//    jalan sebelum migrasi ini).
// ============================================================

// Ekstrak kode roll dari akhir baris. Dukung 2 format:
//  1. Format lama, pakai kata "rol" eksplisit: "... 25,4kg - rol 0178"
//  2. Format baru (rev.28), TANPA kata "rol" sama sekali - "/" murni pemisah kg vs kode roll.
function ekstrakKodeRoll4Digit_(kodeRollRaw) {
  const segmen = String(kodeRollRaw || '').trim().split('/');
  const segmenTerakhir = segmen[segmen.length - 1] || '';
  const angka = segmenTerakhir.replace(/[^0-9]/g, '');
  if (!angka) return '';
  return angka.length > 4 ? angka.slice(-4) : angka.padStart(4, '0');
}

// Ubah "DD/MM/YYYY" (atau DD-MM-YYYY / D/M/YY) dari nota jadi Date object. Fallback ke hari ini
// kalau formatnya gak ketemu/gagal dibaca sama sekali (jangan sampai fitur ini gagal total cuma
// gara-gara AI salah format tanggal).
function parseTanggalNota_(str) {
  const m = String(str || '').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!m) return new Date();
  let d = parseInt(m[1], 10);
  let mo = parseInt(m[2], 10) - 1;
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  const tgl = new Date(y, mo, d);
  return isNaN(tgl.getTime()) ? new Date() : tgl;
}

function formatTanggalIndoSimpel_(date) {
  const dayName = DAYS_ID_[date.getDay()];
  const day = date.getDate();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);
  return dayName + ',  ' + day + '/' + month + '/' + year;
}

function tanggalKeIso_(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + mo + '-' + d;
}

function arrayBufferKeBase64_(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Kirim foto nota ke Claude Vision API, minta dibaca jadi JSON terstruktur. Prompt PERSIS sama
// dengan versi Apps Script - jangan diubah tanpa alasan kuat, sudah "dilatih" pakai banyak
// contoh nota asli.
async function parseNotaKainDenganAI_(env, base64Image, mimeType) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'ANTHROPIC_API_KEY belum diset di Worker.' };
  }

  const promptTeks = [
    'Ini foto nota/struk/invoice pembelian kain dari supplier. Formatnya BISA BEDA-BEDA tiap',
    'supplier/toko (tabel rapi ATAU struk kasir polos) - baca isinya dengan PENGERTIAN, bukan',
    'posisi kolom yang kaku. Baca SELURUH baris barang di nota ini dan keluarkan HANYA JSON murni',
    '(tanpa markdown, tanpa penjelasan, tanpa ```), dengan format PERSIS:',
    '{',
    '  "tanggal": "DD/MM/YYYY (sesuai tanggal yang tertulis di nota)",',
    '  "supplier": "nama supplier/toko kalau KELIHATAN JELAS (kop surat/logo/nama toko), kalau tidak ada/tidak yakin kosongkan jadi string kosong",',
    '  "items": [',
    '    { "jenisKain": "nama jenis kain SAJA, TANPA nama warna di belakangnya",',
    '      "warna": "nama warna barang ini",',
    '      "kodeRoll": "kode roll/batch APA ADANYA persis seperti tertulis (nota bisa nyebut ini KP, No. Roll, Roll, dsb - ambil utuh, JANGAN diformat ulang)",',
    '      "qty": angka desimal qty/berat barang ini (contoh 24.14, titik sebagai desimal, TANPA pemisah ribuan),',
    '      "harga": angka bulat harga per kg (buang semua titik/koma pemisah ribuan),',
    '      "diskon": angka bulat diskon per kg KALAU ADA (buang pemisah ribuan) - kalau nota sama sekali gak nyebut diskon buat barang ini, HAPUS field ini (jangan isi 0) }',
    '  ]',
    '}',
    'Catatan penting:',
    '- Kalau nama warna TIDAK punya kolom sendiri, warna biasanya kata/frasa TERAKHIR di nama',
    '  barang, contoh "SJ. COTTON CARDED 30S KUNING BUSUK" -> jenisKain "SJ. COTTON CARDED 30S",',
    '  warna "KUNING BUSUK".',
    '- Kalau ada baris "Diskon" TERPISAH di bawah 1 barang (bukan kolom, tapi baris sendiri dengan',
    '  qty yang SAMA seperti barang di atasnya), itu diskon PER KG untuk barang tersebut - gabungkan',
    '  ke item yang bersangkutan sebagai field "diskon", JANGAN dianggap barang/item baru.',
    '- Baris seperti "Ecer"/"Eceran" itu PENANDA KATEGORI (bukan nama barang) - barang di',
    '  bawahnya tetap dibaca sebagai item biasa.',
    '- Sertakan SEMUA baris barang, termasuk yang namanya mengandung kata "RIB" (jangan dilewati,',
    '  biar dipilah di sistem lain).',
    '- Kalau header nota punya field "No. Bon", "Sales", "SPV", "Kasir" (gaya struk kasir), itu SELALU',
    '  nota dari supplier FOCUS - isi field "supplier" dengan "FOCUS".',
    '- Kalau nota punya logo oval "OCM" dan kolom "Banyaknya" / "Nama Barang" / "Harga" / "Jumlah"',
    '  (nota tulisan tangan), itu SELALU nota dari supplier OCM - isi field "supplier" dengan "OCM".',
    '  Nota tulisan tangan OCM ini punya ciri khas: kadang ADA BEBERAPA ANGKA QTY ditulis',
    '  berdampingan/bertumpuk untuk 1 nama barang (contoh "25.10 25.10 24.90 24.90" di atas 1 nama',
    '  barang) - artinya barang itu terdiri dari BEBERAPA ROL FISIK TERPISAH. Kalau ketemu pola',
    '  begini, JANGAN dijumlah jadi satu qty - buat ITEM/ENTRY TERPISAH untuk MASING-MASING angka',
    '  qty (jenisKain, warna, harga, diskon SAMA persis buat semua entry itu, cuma "qty"-nya beda',
    '  sesuai angka masing-masing). Contoh: kalau ada 4 angka qty buat 1 nama barang, hasilnya 4',
    '  object item terpisah di array "items", bukan 1 object dengan qty dijumlah.',
    '  Tulisan tangannya kadang ambigu (angka "4" bisa kelihatan mirip huruf "u", desimal kadang',
    '  gak jelas titik/komanya) - kalau ragu, VALIDASI SILANG pakai kolom "Jumlah" (Jumlah = qty x',
    '  Harga per rol, dijumlahkan semua rol dalam 1 nama barang) buat mengoreksi angka qty/harga',
    '  yang salah baca. Nota tulisan tangan (terutama OCM) kadang ADA CORETAN/PERBAIKAN (angka',
    '  dicoret lalu ditulis ulang di sebelahnya/di atasnya) - pakai angka HASIL PERBAIKAN yang',
    '  jelas dimaksud sebagai koreksi terakhir, ABAIKAN yang dicoret. Bentuk huruf/angka BISA GAK',
    '  KONSISTEN antar baris dalam 1 nota yang sama (beda pulpen, beda buru-buru nulisnya) - baca',
    '  TIAP ANGKA satu per satu dengan teliti, JANGAN asumsikan pola dari baris sebelumnya. Kalau',
    '  ada angka yang tetap gak yakin walau sudah dicoba validasi silang, tetap isi dengan tebakan',
    '  TERBAIK (jangan dikosongkan) - hasil bacaan ini akan ditinjau ulang manual sebelum benaran',
    '  disimpan, jadi salah baca masih bisa dikoreksi/dibatalkan di tahap itu.'
  ].join('\n');

  const payload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
        { type: 'text', text: promptTeks }
      ]
    }]
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.error) {
      return { ok: false, error: data.error.message || 'Claude API error.' };
    }
    const blokTeks = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
    const bersih = blokTeks.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(bersih);
    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: 'Gagal membaca/parsing hasil AI: ' + e.message };
  }
}

// Terapkan aturan bisnis Denny ke hasil mentah dari AI: skip baris RIB, mapping warna lewat
// KAMUS SINONIM WARNA (peta dari ambilPetaWarnaKanonik_), format Kode Roll 4 digit.
function prosesItemNota_(petaKanonik, parsedAI, supplierOverride) {
  const tglBeliDate = parseTanggalNota_(parsedAI.tanggal);
  const tglBeli = formatTanggalIndoSimpel_(tglBeliDate);
  const tglBeliIso = tanggalKeIso_(tglBeliDate);

  // supplierOverride datang dari CAPTION foto (kalau diisi) - lebih diutamakan daripada tebakan
  // AI, soalnya gak semua nota nampilin nama supplier dengan jelas di gambarnya.
  const supplier = (supplierOverride && supplierOverride.trim())
    ? supplierOverride.trim().toUpperCase()
    : (String(parsedAI.supplier || '').trim().toUpperCase() || 'TIDAK DIKETAHUI');

  const rows = [];
  let jumlahDilewati = 0;

  (parsedAI.items || []).forEach(function (item) {
    const jenisKainUpper = String(item.jenisKain || '').toUpperCase();
    if (jenisKainUpper.indexOf('RIB') !== -1) {
      jumlahDilewati++;
      return; // rule: baris RIB jangan dimasukkan dulu
    }

    const warnaRaw = String(item.warna || '').trim().toUpperCase();
    const warnaTampil = petaKanonik[warnaRaw] || warnaRaw;
    const kodeRoll = ekstrakKodeRoll4Digit_(item.kodeRoll);
    const kg = parseFloat(item.qty) || 0;
    const harga = parseFloat(item.harga) || 0;
    const diskon = (item.diskon !== undefined && item.diskon !== null) ? (parseFloat(item.diskon) || 0) : 0;

    rows.push({ warna: warnaTampil, kg: kg, kodeRoll: kodeRoll, harga: harga, diskon: diskon });
  });

  return { supplier: supplier, tglBeli: tglBeli, tglBeliIso: tglBeliIso, rows: rows, jumlahDilewati: jumlahDilewati };
}

// Format ulang TOTAL sesuai contoh Denny - gaya beda buat 1 rol vs banyak rol.
function bangunTeksPreviewNota_(hasil) {
  const jumlah = hasil.rows.length;
  let teks = htmlEscape_(hasil.tglBeli) + '\n';
  teks += 'Masuk kain ' + htmlEscape_(hasil.supplier) + (jumlah > 1 ? ' :' : '') + '\n\n';
  hasil.rows.forEach(function (r, i) {
    const kodeKg = r.kg + ' / ' + r.kodeRoll;
    teks += (i + 1) + '. ' + htmlEscape_(r.warna) + ' ' + (jumlah > 1 ? '(' + kodeKg + ')' : kodeKg) + '\n';
  });
  teks += (jumlah > 1 ? '\n' : '') + '\nTOTAL ' + jumlah + ' ROL';
  return teks;
}

async function kirimPesanTelegramLengkap_(env, chatId, teks, opsi) {
  opsi = opsi || {};
  const payload = Object.assign({ chat_id: chatId, text: teks }, opsi);
  try {
    const res = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'post', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await res.json();
    return (data.ok && data.result) ? data.result.message_id : null;
  } catch (e) {
    return null;
  }
}

async function hapusPesanTelegram_(env, chatId, messageId) {
  if (!messageId) return;
  try {
    await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/deleteMessage', {
      method: 'post', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId })
    });
  } catch (e) { /* gak fatal kalau gagal dihapus */ }
}

async function ubahTeksPesanTelegram_(env, chatId, messageId, teksBaru) {
  try {
    await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/editMessageText', {
      method: 'post', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: teksBaru, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
    });
  } catch (e) { /* gak fatal */ }
}

async function jawabCallbackQueryTelegram_(env, callbackQueryId, teks, showAlert) {
  try {
    await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/answerCallbackQuery', {
      method: 'post', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: teks || '', show_alert: !!showAlert })
    });
  } catch (e) { /* gak fatal */ }
}

// HANDLER UTAMA foto nota - dipanggil dari handleTelegramWebhook_ kalau ada foto dengan caption
// mengandung kata "nota" (gak peduli besar/kecil huruf).
async function handleFotoNota_(env, message) {
  const chatId = message.chat.id;
  const fileId = message.photo[message.photo.length - 1].file_id; // resolusi PALING BESAR

  const notifMsgId = await kirimPesanTelegramLengkap_(env, chatId, '🔍 Membaca nota, mohon tunggu...');

  try {
    const getFileRes = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/getFile?file_id=' + fileId);
    const getFileData = await getFileRes.json();
    if (!getFileData.ok) throw new Error('Gagal ambil file dari Telegram: ' + (getFileData.description || '?'));

    const filePath = getFileData.result.file_path;
    const fileRes = await fetch('https://api.telegram.org/file/bot' + env.TELEGRAM_BOT_TOKEN + '/' + filePath);
    const fileBuffer = await fileRes.arrayBuffer();
    const base64Image = arrayBufferKeBase64_(fileBuffer);

    const hasilAI = await parseNotaKainDenganAI_(env, base64Image, 'image/jpeg');
    if (!hasilAI.ok) throw new Error(hasilAI.error);

    const petaKanonik = await ambilPetaWarnaKanonik_(env);
    const hasil = prosesItemNota_(petaKanonik, hasilAI.data, message.caption);

    if (hasil.rows.length === 0) {
      await kirimPesanTelegramLengkap_(env, chatId, '⚠️ Tidak ada baris yang bisa dibaca dari foto ini (atau semuanya RIB).');
      await hapusPesanTelegram_(env, chatId, notifMsgId);
      return jsonResponse({ ok: true, pesan: 'nota kosong' });
    }

    const token = crypto.randomUUID();
    await env.TIM_POTONG_KV.put('notaMasuk_' + token, JSON.stringify(hasil), { expirationTtl: 1800 });

    const teksPreview = bangunTeksPreviewNota_(hasil);
    await kirimPesanTelegramLengkap_(env, chatId, teksPreview, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Simpan stok', callback_data: 'simpanNota:' + token },
          { text: '❌ Batal', callback_data: 'batalNota:' + token }
        ]]
      }
    });
    await hapusPesanTelegram_(env, chatId, notifMsgId);

    console.log('Nota difoto & dibaca AI via Worker:', hasil.rows.length, 'baris (' + hasil.jumlahDilewati + ' RIB dilewati)');
    return jsonResponse({ ok: true, jumlahBaris: hasil.rows.length });
  } catch (err) {
    await kirimPesanTelegramLengkap_(env, chatId, '⚠️ Gagal membaca nota: ' + err.message);
    await hapusPesanTelegram_(env, chatId, notifMsgId);
    return jsonResponse({ ok: false, error: err.message });
  }
}

// HANDLER tombol konfirmasi/batal - dipanggil dari handleTelegramWebhook_ kalau callback_query
// data-nya diawali "simpanNota:" atau "batalNota:".
async function handleCallbackQueryNota_(env, callbackQuery) {
  const data = String(callbackQuery.data || '');
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  const allowedUserId = env.ALLOWED_USER_ID;
  const senderId = callbackQuery.from ? String(callbackQuery.from.id) : null;
  if (allowedUserId && senderId !== String(allowedUserId)) {
    await jawabCallbackQueryTelegram_(env, callbackQuery.id, 'Bukan user yang diizinkan.', true);
    return jsonResponse({ ok: true, pesan: 'callback ditolak (bukan user diizinkan)' });
  }

  const idxTitik = data.indexOf(':');
  const aksi = idxTitik === -1 ? data : data.substring(0, idxTitik);
  const token = idxTitik === -1 ? '' : data.substring(idxTitik + 1);
  const kvKey = 'notaMasuk_' + token;

  if (aksi === 'batalNota') {
    await env.TIM_POTONG_KV.delete(kvKey);
    await jawabCallbackQueryTelegram_(env, callbackQuery.id, 'Dibatalkan.');
    await ubahTeksPesanTelegram_(env, chatId, messageId, '❌ <b>Dibatalkan</b> - data nota tidak disimpan.');
    return jsonResponse({ ok: true, pesan: 'nota dibatalkan' });
  }

  let rawKv = null;
  try {
    const kvResult = await env.TIM_POTONG_KV.get(kvKey);
    rawKv = kvResult;
  } catch (e) {
    rawKv = null;
  }

  if (!rawKv) {
    await jawabCallbackQueryTelegram_(env, callbackQuery.id, 'Data sudah kadaluarsa (lewat 30 menit), kirim ulang fotonya.', true);
    await ubahTeksPesanTelegram_(env, chatId, messageId, '⚠️ <b>Kadaluarsa</b> - kirim ulang fotonya, data preview cuma disimpan 30 menit.');
    return jsonResponse({ ok: true, pesan: 'nota kadaluarsa' });
  }

  // v.38: toast langsung ditembak DULUAN (sebelum tulis Supabase) - biar user langsung lihat
  // respon instan pas tap tombol, gak nunggu proses simpan selesai dulu.
  await jawabCallbackQueryTelegram_(env, callbackQuery.id, 'Menyimpan ke Stok Kain...');

  try {
    const hasil = JSON.parse(rawKv);
    for (const r of hasil.rows) {
      await tambahStokKainMasukSupabase_(env, {
        warna: r.warna, kg: r.kg, kodeRoll: r.kodeRoll, supplier: hasil.supplier,
        tglBeli: hasil.tglBeliIso, harga: r.harga, diskon: r.diskon
      });
    }
    await env.TIM_POTONG_KV.delete(kvKey);
    await ubahTeksPesanTelegram_(env, chatId, messageId, '✅ <b>Tersimpan</b> - ' + hasil.rows.length + ' baris ditambahkan ke STOK KAIN (' + htmlEscape_(hasil.supplier) + ', ' + htmlEscape_(hasil.tglBeli) + ').');
    console.log('Nota disimpan ke Stok Kain via Worker:', hasil.rows.length, 'baris, supplier', hasil.supplier);
    return jsonResponse({ ok: true, jumlahBaris: hasil.rows.length });
  } catch (err) {
    await ubahTeksPesanTelegram_(env, chatId, messageId, '⚠️ <b>Gagal menyimpan</b>: ' + htmlEscape_(err.message));
    return jsonResponse({ ok: false, error: err.message });
  }
}

async function handleTelegramWebhook_(request, env) {
  const rawBodyText = await request.text();
  let update;
  try {
    update = JSON.parse(rawBodyText);
  } catch (e) {
    return jsonResponse({ ok: true }); // body aneh, jangan sampai Telegram terus-terusan retry
  }

  // v.38: tombol konfirmasi/batal nota (baca nota AI) - dicegat di sini, SEBELUM callback_query
  // lain (kalau ada) diteruskan ke Apps Script.
  if (update.callback_query) {
    const dataCb = String(update.callback_query.data || '');
    if (dataCb.indexOf('simpanNota:') === 0 || dataCb.indexOf('batalNota:') === 0) {
      return await handleCallbackQueryNota_(env, update.callback_query);
    }
    return await proxyKeAppsScript_(rawBodyText, env);
  }

  const message = update.message;

  // v.38: foto nota (fitur baca nota kain otomatis) - dicegat di sini, SEBELUM pengecekan
  // message.text di bawah (foto gak punya field .text sama sekali). WAJIB ada kata "nota" di
  // CAPTION foto (gak peduli besar/kecil huruf) baru diproses sebagai nota - foto tanpa
  // caption/gak ada kata "nota" DIABAIKAN DIAM-DIAM, sama seperti perilaku lama.
  if (message && message.photo && message.photo.length > 0) {
    const captionFoto = (message.caption || '').toLowerCase();
    if (captionFoto.indexOf('nota') === -1) {
      return jsonResponse({ ok: true, pesan: 'foto tanpa caption nota, diabaikan' });
    }
    return await handleFotoNota_(env, message);
  }

  if (message && message.text) {
    const teksTrim = message.text.trim().toLowerCase().split('@')[0];
    if (teksTrim === '/produksi' || teksTrim === '/isiproduksi') {
      return await tanganiCommandCepat_(env, message, 'produksi');
    }
    if (teksTrim === '/stok' || teksTrim === '/dashboard') {
      return await tanganiCommandCepat_(env, message, 'stok');
    }
    // v.37: laporan "Masuk ..." (stok kain baru datang) sekarang diparsing & ditulis ke
    // Supabase LANGSUNG di sini - migrasi dari Apps Script, lihat banner di
    // tanganiPesanMasuk_ buat detail lengkapnya.
    if (isBarisMasuk_(message.text.trim().split('\n')[0])) {
      return await tanganiPesanMasuk_(env, message);
    }
  }

  // v.39: pesan teks lain (obrolan biasa, dll di grup) - DIABAIKAN DIAM-DIAM, TIDAK diproxy ke
  // Apps Script lagi. Sebelumnya diteruskan ke Apps Script yang otomatis membalas pengingat
  // "input manual dihentikan" untuk SEMUA teks yang gak dikenali, termasuk obrolan biasa yang
  // gak ada hubungannya sama input produksi - berisik di grup. Dimatikan atas permintaan Denny
  // (9 Agustus 2026). Lihat banner di atas kalau mau diaktifkan lagi.
  return jsonResponse({ ok: true, pesan: 'pesan teks tidak dikenali, diabaikan' });
}

async function proxyKeAppsScript_(rawBodyText, env) {
  try {
    const res = await fetch(env.APPS_SCRIPT_WEBHOOK_URL, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: rawBodyText
    });
    return new Response(await res.text(), { status: 200 });
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Gagal terusin ke Apps Script: ' + e.message }, 500);
  }
}

async function tanganiCommandCepat_(env, message, jenis) {
  const chatId = message.chat.id;
  // Hapus pesan lama & kirim tombol baru gak saling bergantung - jalanin PARALEL (bukan
  // berurutan kayak sebelumnya) biar user gak nunggu 2x round-trip ke Telegram, cukup 1x
  // (nunggu yang paling lama dari dua-duanya, bukan jumlah dua-duanya).
  const hasil = await Promise.all([
    hapusPasanganSebelumnya_(env, jenis, chatId),
    (jenis === 'produksi') ? kirimTombolMiniApp_(env, chatId) : kirimTombolDashboard_(env, chatId)
  ]);
  const botMsgId = hasil[1];
  await simpanPasanganTerakhir_(env, jenis, chatId, message.message_id, botMsgId);
  return jsonResponse({ ok: true });
}

function kvKeyPasangan_(jenis, chatId) {
  return 'pasangan_' + jenis + '_' + chatId;
}

async function hapusPasanganSebelumnya_(env, jenis, chatId) {
  try {
    const raw = await env.TIM_POTONG_KV.get(kvKeyPasangan_(jenis, chatId));
    if (!raw) return;
    const data = JSON.parse(raw);
    const botToken = env.TELEGRAM_BOT_TOKEN;
    const daftarHapus = [data.userMsgId, data.botMsgId].filter(Boolean);
    await Promise.all(daftarHapus.map(function (msgId) {
      return fetch('https://api.telegram.org/bot' + botToken + '/deleteMessage', {
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: msgId })
      }).catch(function () { });
    }));
  } catch (e) {
    // gagal hapus (pesan sudah lama/bot bukan admin) - gak fatal, tombol baru tetap dikirim
  }
}

async function simpanPasanganTerakhir_(env, jenis, chatId, userMsgId, botMsgId) {
  try {
    await env.TIM_POTONG_KV.put(kvKeyPasangan_(jenis, chatId), JSON.stringify({ userMsgId: userMsgId, botMsgId: botMsgId }));
  } catch (e) { }
}

async function kirimTombolMiniApp_(env, chatId) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const botUsername = String(env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
  const shortName = env.MINIAPP_SHORT_NAME;
  if (!botUsername || !shortName) return null;
  const link = 'https://t.me/' + botUsername + '/' + shortName;
  const payload = {
    chat_id: chatId,
    text: '📝 Tap tombol di bawah buat isi data produksi:',
    reply_markup: { inline_keyboard: [[{ text: '📝 Isi Produksi', url: link }]] }
  };
  try {
    const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
      method: 'post', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await res.json();
    return (data.ok && data.result) ? data.result.message_id : null;
  } catch (e) {
    return null;
  }
}

async function kirimTombolDashboard_(env, chatId) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const botUsername = String(env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
  const dashShortName = env.DASHBOARD_MINIAPP_SHORT_NAME;
  const dashboardUrl = env.DASHBOARD_URL;
  const link = (botUsername && dashShortName) ? ('https://t.me/' + botUsername + '/' + dashShortName) : dashboardUrl;
  if (!link) return null;
  const payload = {
    chat_id: chatId,
    text: '📊 Tap tombol di bawah buat lihat ringkasan stok kain:',
    reply_markup: { inline_keyboard: [[{ text: '📊 Lihat Dashboard', url: link }]] }
  };
  try {
    const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
      method: 'post', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await res.json();
    return (data.ok && data.result) ? data.result.message_id : null;
  } catch (e) {
    return null;
  }
}
