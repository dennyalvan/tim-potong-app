# Shopee Order Sync Worker

Backend Cloudflare Worker buat narik data order Shopee langsung lewat API,
gantiin proses export Excel manual. **Terpisah total** dari worker
`tim-potong-api` yang sudah jalan — tidak saling ganggu.

## Status

🚧 Skeleton siap pakai, tapi **belum bisa jalan** sampai kamu:
1. Punya Partner ID + Partner Key dari Shopee Open Platform (masih proses daftar)
2. Isi 3 secret di bawah
3. Deploy

## 1. Daftar Shopee Open Platform (kamu yang urus)

Buka [open.shopee.com](https://open.shopee.com) → daftar sebagai Partner →
pilih tipe **Shop API**. Approval butuh verifikasi bisnis, bisa beberapa hari.
Setelah approved kamu dapat:
- **Partner ID**
- **Partner Key**
- Console buat daftarin **Redirect URL** (harus persis sama dengan yang di secret `SHOPEE_REDIRECT_URL`)

## 2. Setup

```bash
npm install -g wrangler   # kalau belum ada
wrangler login

# Bikin KV namespace buat nyimpen token
wrangler kv namespace create SHOPEE_KV
# -> copy "id" hasilnya, tempel ke wrangler.toml (ganti PLACEHOLDER)

# Set secrets (nilai didapat dari step 1)
wrangler secret put SHOPEE_PARTNER_ID
wrangler secret put SHOPEE_PARTNER_KEY
wrangler secret put SHOPEE_REDIRECT_URL
# contoh redirect URL: https://shopee-order-sync.<subdomain-kamu>.workers.dev/auth/callback

# Deploy
wrangler deploy
```

## 3. Authorize toko rafkidscloth (sekali di awal)

Buka di browser (sambil login sebagai admin toko Shopee):
```
https://shopee-order-sync.<subdomain-kamu>.workers.dev/auth/authorize
```
Approve akses → Shopee redirect balik ke `/auth/callback` → token otomatis
tersimpan di KV. Kamu akan lihat response JSON konfirmasi berisi `shop_id`.

## 4. Pakai

```
GET /api/orders?shop_id=<shop_id>&status=READY_TO_SHIP
```
Balikin JSON daftar order dari Shopee langsung, ringkasan aja (order_sn +
status), setara "Perlu Dikirim" di export Excel. Token direfresh otomatis
kalau sudah mau expired — gak perlu authorize ulang tiap 4 jam.

```
GET /api/order-detail?shop_id=<shop_id>&order_sn_list=SN1,SN2,...
```
Detail mentah per order (max 50 order_sn per panggilan, batas dari Shopee),
termasuk `item_list` (SKU/qty per varian). Buat kebutuhan debugging atau
custom di luar `/api/orders-full`.

```
GET /api/orders-full?shop_id=<shop_id>&status=READY_TO_SHIP&days=30
```
Gabungan `get_order_list` (auto-paginate sampai habis) + `get_order_detail`,
sudah diratain jadi baris siap pakai (bentuknya persis sama kayak hasil parse
Excel di `rekap-order/index.html`): `sku, variasi, produk, qty, pesanan, resi,
isBatal, waktuKirim, waktuBayar`. Ini yang dipanggil tombol **"Sync dari
Shopee"** di app rekap-order. `resi` selalu kosong dari endpoint ini (nomor
resi baru ada setelah label dicetak, butuh endpoint logistics terpisah).

## 5. Sync dari app rekap-order

Di `rekap-order/index.html` sudah ada tombol **"🔄 Sync dari Shopee"** di
sebelah upload zone, plus tombol ⚙️ buat isi URL worker (hasil deploy kamu,
mis. `https://shopee-order-sync.<subdomain>.workers.dev`) dan Shop ID —
disimpan di `localStorage` browser, sekali isi aja. Setelah itu klik Sync
langsung narik data lewat `/api/orders-full` dan masuk ke tab Varian/
Karakter/Resi kayak habis upload file.

## 6. Auto-sync terjadwal (Cron Trigger)

`wrangler.toml` sudah punya `[triggers] crons = ["*/30 * * * *"]` — tiap 30
menit, `scheduled()` di `worker/index.js` narik ulang `/api/orders-full` buat
semua toko yang pernah authorize (dicatat otomatis di KV pas `/auth/callback`
sukses) dan simpan ke cache KV. Efek sampingnya: token juga ikut kesegerin
otomatis walau app-nya lagi gak dibuka. Ganti jadwal cron di `wrangler.toml`
kalau mau lebih sering/jarang.

## Langkah selanjutnya (belum diimplementasi)

- Nomor resi (tracking number) — butuh `/api/v2/logistics/get_tracking_number`
  terpisah, baru kepanggil setelah status order lewat dari READY_TO_SHIP
- Field `response_optional_fields` di `getOrderDetail()` (terutama
  `ship_by_date`) belum pernah dites ke API asli — begitu approval Shopee
  kelar dan bisa testing beneran, cek dulu responsnya cocok apa nggak,
  sebelum dipakai serius

## Catatan keamanan

- Partner Key **tidak pernah** boleh ada di kode frontend/browser — makanya
  semua signing terjadi di Worker (server-side), bukan di app HTML
- `Access-Control-Allow-Origin: *` di kode saat ini masih longgar (untuk
  testing) — sebaiknya dipersempit ke domain `dennyalvan.github.io` saja
  sebelum dipakai produksi
