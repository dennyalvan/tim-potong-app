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
Balikin JSON daftar order dari Shopee langsung (setara "Perlu Dikirim" di
export Excel). Token direfresh otomatis kalau sudah mau expired — gak perlu
authorize ulang tiap 4 jam.

## Langkah selanjutnya (belum diimplementasi)

- `/api/v2/order/get_order_detail` untuk ambil detail SKU/qty per order
  (`get_order_list` cuma kasih ringkasan + order_sn)
- Ubah app rekap (`rekap-order/index.html`) supaya bisa fetch dari endpoint
  ini sebagai alternatif upload file — perlu ditambah tombol "Sync dari
  Shopee" di sebelah upload zone
- Auto-sync terjadwal (Cron Trigger di Cloudflare) kalau mau data selalu
  update tanpa buka app dulu

## Catatan keamanan

- Partner Key **tidak pernah** boleh ada di kode frontend/browser — makanya
  semua signing terjadi di Worker (server-side), bukan di app HTML
- `Access-Control-Allow-Origin: *` di kode saat ini masih longgar (untuk
  testing) — sebaiknya dipersempit ke domain `dennyalvan.github.io` saja
  sebelum dipakai produksi
