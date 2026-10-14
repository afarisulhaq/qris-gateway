# QRIS Gateway

Platform invoice QRIS multi-merchant dengan **ElysiaJS + Bun**, SQLite persisten, dan Svelte 5/Vite. UI Indonesia memakai Neo-Brutalism cream/ink/lime. Dana pembayaran produksi masuk ke akun merchant provider, bukan saldo yang ditampung aplikasi.

**Program GitHub benar-benar dibundel dan dijalankan**, bukan hanya adapter ke domain/API key yang dimasukkan merchant. Setiap dompet memiliki proses Node, konfigurasi, QRIS, dan direktori sesi sendiri. API key private gateway dibuat oleh platform dan tidak diberikan kepada pelanggan.

## Cakupan

- Banyak akun merchant; beberapa dompet GoPay/ShopeePay per akun, termasuk beberapa dompet provider yang sama.
- QRIS statis dari teks, gambar, atau kamera; decoder gambar berjalan lokal, kamera memerlukan HTTPS/localhost dan izin perangkat.
- GoPay: program login OTP asli, import sesi JSON, refresh sesi asli/otomatis upstream, status token, mutasi terbaru/rentang/bulan, QR, dan log.
- ShopeePay: token Partner Portal, pengujian/rotasi token, mutasi terbaru/bulan/issuer, QR, log, serta Telegram opsional yang didukung upstream. Tidak ada login OTP ShopeePay yang dikarang.
- Invoice, checkout publik, QR PNG lokal, pemeriksaan pembayaran, pembatalan, referensi idempoten, filter, pencarian, dan CSV.
- Gratis berkelanjutan: **5 invoice produksi per hari WIB**, reset 00.00 WIB. Sewa **7/30 hari** menghapus batas harian selama aktif. Sandbox tidak memakai kuota.
- Sandbox terpisah untuk invoice, API key, webhook, dan total; simulator paid/failed/expired tanpa provider atau uang nyata.
- API key sekali tampil dan pencabutan; webhook HMAC, outbox persisten, riwayat, serta pengiriman ulang.
- Admin: harga, dompet operator penerima sewa, persetujuan manual, masa aktif, dan audit. Sandbox tidak dapat mengaktifkan sewa nyata.

Ini platform **software QRIS**, bukan seluruh kanal Midtrans/Xendit: tidak ada VA/kartu, penitipan saldo, payout, atau refund otomatis. Tidak mengklaim status PJP, sertifikasi, atau dukungan resmi GoPay/ShopeePay. Operator harus memeriksa ketentuan akun merchant dan kewajiban regulasi sebelum menawarkan layanan publik.

## Instalasi lokal

Diperlukan **Bun**, **Node.js >=18**, dan **npm**. Aplikasi utama memakai Bun; program upstream aslinya memakai Node.

```sh
bun install --frozen-lockfile
bun run gateways:install
bun run setup
bun run dev
```

UI: **http://localhost:5173**. API: `127.0.0.1:3100`.

`gateways:install` memasang dependencies terkunci masing-masing provider dengan `npm ci --omit=dev --ignore-scripts`. Tidak ada download source/dependencies saat merchant membuat invoice. Installer gagal bila Node/npm tidak tersedia.

`setup` membuat `.env` dengan SETUP_TOKEN dan ENCRYPTION_KEY acak, izin 0600, serta menolak menimpa file yang sudah ada. **Pada workspace ini `.env` sudah tersedia; jangan menjalankan setup untuk mengganti rahasia.** Simpan ENCRYPTION_KEY tetap: penggantian membuat kredensial tersimpan tidak dapat didekripsi.

1. Pada instalasi kosong, baca SETUP_TOKEN lokal dari `.env` dan gunakan untuk membuat admin pertama. Tidak ada password/akun bawaan.
2. Admin menetapkan harga sewa 7/30 hari. Harga awal kosong agar tidak ada harga fiktif.
3. Merchant mendaftar; paket gratis langsung tersedia tanpa sewa atau trial tersembunyi.
4. Tambahkan dompet sendiri, lakukan login/import atau uji token, lalu uji transaksi kecil nyata sebelum menerima pelanggan.
5. Untuk mencoba tanpa kredensial provider, pilih **Sandbox** dan gunakan simulator.

## Source upstream dan lisensi

| Provider | Source tersemat | Revision |
|---|---|---|
| GoPay | [gopay-api-gateaway](https://github.com/ahmadzakiyox/gopay-api-gateaway) | `c753b8c23daf5ced58febe650bcd229b6b2b7dec` |
| ShopeePay | [shoppepay-api-gateway](https://github.com/ahmadzakiyox/shoppepay-api-gateway) | `4fbcbd0ad380cc232890e563bcabfec0ad313faa` |

Berkas ada di `server/vendor/`. GoPay berlisensi MIT; copyright/LICENSE dipertahankan. ShopeePay proprietary: pemilik platform menyatakan memiliki izin tertulis untuk integrasi multi-merchant/sewa ini. **Deploy/redistribusi harus tetap sesuai izin tersebut**; repository publik bukan izin resale. Source ShopeePay tidak dideobfuscate atau dimodifikasi.

Koreksi integrasi yang terdokumentasi pada `server/vendor/NOTICE`:

- Server GoPay MIT membuang hanya field CRC terakhir, bukan substring `6304` di dalam nama/data merchant.
- Source ShopeePay memasukkan nominal tetapi mempertahankan marker statis `01=11`. Adapter memvalidasi CRC, identitas QRIS, dan nominal nyata dari upstream, lalu mengubah marker ke `12` serta menghitung ulang CRC. Akun, merchant, dan nominal tidak diganti.
- package.json tetap dari upstream; lockfile dependencies memperoleh pembaruan keamanan kompatibel. Jangan memakai `npm audit fix --force` tanpa pemeriksaan kompatibilitas.
- `.env.example` upstream yang mengandung apparent credentials tidak disertakan atau dimuat.

## Onboarding multi-dompet

### QRIS merchant

Pada **Dompet QRIS > Tambah dompet**, pilih provider dan label. Masukkan QRIS statis resmi akun tersebut melalui payload, unggah gambar, atau kamera. Server memeriksa TLV, CRC, IDR, negara Indonesia, MCC, serta identitas QRIS. Preview menampilkan nama/city dari payload; ini bukan bukti bahwa token dan QRIS milik akun yang sama.

Gunakan QRIS, ID merchant, dan sesi/token **akun yang sama**. Jangan mendaftarkan ulang akun provider yang sama sebagai dompet berbeda atau membagikan kredensial antar-merchant. Satu dompet untuk satu akun penerima yang berbeda. Sistem bukan pengganti verifikasi kepemilikan merchant oleh provider.

### GoPay

1. Gunakan akun GoBiz/GoFood Merchant aktif. Isi ID merchant upstream `GOPAY_MERCHANT_ID`, bukan nomor telepon dan bukan otomatis NMID dari QR.
2. Jika perlu, temukan ID yang benar pada parameter `merchant_ids` request transaksi dari sesi GoBiz milik Anda.
3. Simpan dompet, buka **Kelola & uji > Mulai login GoPay**.
4. Ikuti prompt program login asli. Kirim nomor, pilihan metode, atau OTP hanya ketika diminta; satu baris per jawaban. Pengiriman OTP bukan bukti login berhasil.
5. Proses dibatasi 5 menit. Setelah sesi tersedia, **Uji status token/sesi**. Jika refresh gagal, login ulang.
6. Alternatif: import objek JSON asli `.GOPAY_SESI_JANGAN_DIHAPUS.json` yang dihasilkan upstream. Import diuji terhadap program asli; kegagalan mempertahankan sesi terdahulu.

Jika versi sebelumnya tetap menampilkan **Login OTP sedang berjalan** setelah program melaporkan login berhasil dan sesi tersimpan, hentikan `bun run dev` dengan Ctrl+C, lalu jalankan kembali `bun run dev`. Refresh browser, buka **Kelola & uji**, lalu klik **Uji status token/sesi**. Jangan mengulang OTP atau menghapus sesi yang sudah tersimpan. Restart dengan `.env` dan lokasi data yang sama mempertahankan sesi dan database.

Wrapper melepas referensi IPC dan stdin yang sudah dijeda oleh program login, sehingga CLI dapat keluar normal setelah pekerjaannya selesai. Stdin tetap aktif saat menunggu jawaban; pemutusan koneksi aplikasi tetap menghentikan child. Banner sukses saja tidak menentukan validitas sesi: gunakan uji status upstream.

GoPay menyediakan mutasi terbaru, bulan berjalan, dan rentang khusus. Rentang diteruskan sebagai Unix **detik**, bukan milidetik atau ISO. Upstream mengembalikan maksimal **100 transaksi**, bukan semua histori tanpa batas.

### ShopeePay

1. Login ke [ShopeePay Partner Portal](https://partner.shopee.co.id/) milik merchant.
2. Buka Developer Tools > Network > Fetch/XHR; muat ulang daftar transaksi.
3. Pilih request `get-transaction-list`; ambil Request Payload `data.metadata.token` akun tersebut, biasanya diawali `B:`.
4. Simpan token bersama QRIS akun yang sama, lalu uji melalui Kelola.
5. Token invalid/force logout: ambil ulang dari portal, lalu gunakan **Rotasi token** untuk akun yang sama.

Rotasi token ShopeePay, import sesi, perubahan akun/QRIS, dan deaktivasi ditolak selama invoice produksi pending. Identitas akun pengganti tidak dapat dibuktikan otomatis; selesaikan/batalkan/tunggu invoice berakhir dan rekonsiliasi transfer terlambat di portal.

Mutasi terbaru dan bulan berjalan mengikuti endpoint asli. Tidak ada filter tanggal ShopeePay yang ditebak. Token bot dan chat ID Telegram opsional diisi bersama; Telegram menerima notifikasi jika diaktifkan. Jumlah nominal baris mutasi bukan saldo atau settlement bersih.

## Invoice dan kuota

Produksi memerlukan `connection_id` dompet terkelola, aktif, milik merchant, dan bukan dompet khusus operator sewa. Provider harus sesuai dompet. Pelanggan membayar QR melalui bank/dompet mereka setelah memeriksa nama penerima.

`amount` adalah nominal pesanan. `payable_amount` dapat ditambah kode unik Rp0 hingga Rp99 untuk membedakan invoice pending pada dompet yang sama. **Bayar tepat payable_amount**. Nominal aktif dipesan atomik sebelum I/O upstream. Batas amount integer: 1 sampai 1.000.000.000 IDR; tidak menerima nominal pecahan.

- Kuota gratis berlaku **bersama seluruh dompet akun**, bukan 5 per provider/dompet.
- Invoice produksi yang berhasil dibuat tetap dihitung walau paid/expired/cancelled. Pembuatan gagal melepas reservasi kuota.
- Permintaan bersamaan tidak dapat melewati lima slot; kuota tersimpan di SQLite dan bertahan restart.
- Reset mengikuti kalender WIB, tidak mengikuti waktu browser atau 24 jam sejak pendaftaran.
- Pengulangan external_id identik dalam environment yang sama mengembalikan invoice sebelumnya tanpa menambah kuota. Data berbeda menghasilkan 409. Jika pembuatan reference itu gagal, gunakan reference baru setelah rekonsiliasi.
- Paid/admin tidak memakai batas gratis harian. Setelah sewa berakhir, merchant kembali gratis.
- Kuota habis/sewa berakhir tidak memblokir pemeriksaan invoice lama.

Status: pending, paid, expired, cancelled, failed. Produksi ditandai paid hanya dengan bukti gateway sesuai ID, nominal, waktu, dan status. GoPay memerlukan QRIS dan capture/settlement; transaksi kartu/refund ditolak. Klaim bukti pembayaran disimpan agar receipt pada dompet yang sama tidak dipakai dua invoice.

Merchant Analytics GoPay mengirim nominal dalam satuan 1/100 rupiah: `100000` berarti Rp1.000. Gateway mengonversi nominal mutasi dan bukti pembayaran menjadi rupiah, sedangkan nominal QRIS/invoice tetap rupiah. Pecahan yang tidak dapat dinyatakan sebagai rupiah bulat ditolak, bukan dibulatkan.

Checkout menyediakan download PNG lokal dan pemeriksaan status, dengan jeda 15 detik. QR GoPay mengikuti kedaluwarsa upstream sekitar 5 menit; ShopeePay sekitar 15 menit. **Cancel bukan refund**: menyembunyikan QR dan membebaskan nominal pending, tetapi tidak menarik kembali transfer. Pembayaran terlambat perlu rekonsiliasi manual melalui mutasi provider dan bukti pelanggan.

Jika pelanggan sudah membayar sebelum batas invoice tetapi verifikasi terlambat, gunakan **Cek pembayaran sebelumnya** pada checkout produksi yang kedaluwarsa, atau endpoint `/check` invoice. Bukti tetap harus cocok dengan ID, nominal, rentang waktu invoice, QRIS capture/settlement atau ShopeePay success, serta klaim transaksi yang belum dipakai invoice lain. Invoice dibatalkan/gagal tidak dibuka kembali; pembayaran setelah batas tetap memerlukan rekonsiliasi manual. Pembayaran sewa otomatis yang terbukti tepat waktu mengaktifkan paket hanya sekali.

## Sandbox

Pilih Sandbox pada header. Invoice, API key, webhook, pengiriman, dan statistik terpisah dari produksi. Akun, dompet, dan riwayat sewa tetap akun nyata; pembelian sewa/perubahan admin diblokir dalam Sandbox.

Sandbox tidak memerlukan dompet atau sewa. QR sandbox berisi **tautan checkout uji**, bukan QRIS bank. Simulator hanya mengubah pending menjadi paid, failed, atau expired. Status terminal tidak dapat diubah kembali. Tidak memanggil provider, menerima uang, menghabiskan kuota, mencatat receipt produksi, atau mengaktifkan sewa.

Tautan checkout sandbox dapat disimulasikan orang yang menerima tautannya. Jangan memakai callback sandbox untuk memenuhi pesanan produksi. Pisahkan receiver dan secret untuk tiap lingkungan.

## API developer

Panduan end-to-end: [Integrasi ke website lain](docs/integrasi-website.md), termasuk backend toko yang dapat dijalankan, redirect pelanggan, webhook HMAC, idempotensi, sandbox, checklist produksi, dan usulan checkout ala Snap. Saat ini checkout memakai `checkout_url`; belum ada SDK/token Snap, popup embedded/iframe, atau redirect kembali otomatis.

Buat key pada **API & webhook** di lingkungan yang benar. Secret hanya tampil sekali; simpan di server Anda, bukan frontend, URL query, atau repository. Autentikasi: `X-API-Key`. Environment ditentukan key; query/body environment berbeda ditolak.

| Metode | Endpoint | Perilaku |
|---|---|---|
| GET | `/v1/connections` | Dompet merchant terkelola aktif milik key produksi; sandbox `[]` |
| GET | `/v1/invoices` | Invoice akun pada environment key |
| POST | `/v1/invoices` | Buat invoice, kuota/idempotensi berlaku |
| GET | `/v1/invoices/:id` | Detail milik akun/environment key |
| POST | `/v1/invoices/:id/check` | Periksa pembayaran/status |
| POST | `/v1/invoices/:id/cancel` | Batalkan pending, bukan refund |
| POST | `/v1/invoices/:id/simulate` | Sandbox saja, action paid/failed/expired |

Contoh produksi; ganti host, key, ID dompet, dan referensi:

```sh
curl -X POST 'https://HOST_ANDA/v1/invoices' \
  -H 'X-API-Key: KEY_PRODUKSI_ANDA' \
  -H 'Content-Type: application/json' \
  -d '{"connection_id":"ID_DOMPET_ANDA","provider":"gopay","amount":50000,"description":"Pembayaran pesanan","external_id":"PESANAN_UNIK"}'
```

Sandbox, tanpa connection_id:

```sh
curl -X POST 'https://HOST_ANDA/v1/invoices' \
  -H 'X-API-Key: KEY_SANDBOX_ANDA' \
  -H 'Content-Type: application/json' \
  -d '{"provider":"shopeepay","amount":50000,"description":"Uji sandbox","external_id":"PESANAN_UJI"}'

curl -X POST 'https://HOST_ANDA/v1/invoices/ID_INVOICE_UJI/simulate' \
  -H 'X-API-Key: KEY_SANDBOX_ANDA' \
  -H 'Content-Type: application/json' \
  -d '{"action":"paid"}'
```

Respons sukses berupa objek Invoice langsung, bukan wrapper data. Metadata: id, environment, connection_id, connection_label, external_id, description, amount, payable_amount, provider, status, created_at, expires_at, paid_at, checkout_url, qr_code, qr_url, payment_warning. QR disembunyikan bila invoice tidak pending. Arahkan pelanggan ke checkout_url; timestamp API ISO UTC.

Error berupa JSON `{ "message": "Penjelasan" }`: 400 input/environment, 401 autentikasi, 403/404 akses/scope, 409 state/idempotensi, 429 kuota/rate, 502/503/504 upstream/dependency/timeout. Jangan menandai lunas dari HTTP gagal.

UI/session API memakai `/api` dan cookie HttpOnly. Scope data: `/api/me`, dashboard, invoices, keys, webhook memakai `?environment=production|sandbox`. Wallet/admin/rental tetap milik akun nyata. Mutasi admin/rental dengan environment sandbox ditolak.

Endpoint wallet sesi: GET/POST `/api/connections`, PUT/DELETE `/api/connections/:id`, POST `:id/test`, GET `:id/transactions` dan `:id/logs`, POST `:id/login/start`, POST `:id/login/input` `{value}`, GET `:id/login`, POST `:id/session` `{session}`, POST `:id/refresh`, POST `:id/token` `{shopee_token}`. Semua memerlukan kepemilikan wallet; merchant tidak mengatur private URL/API key.

## Webhook

Konfigurasi pada environment terkait. Endpoint wajib HTTPS publik, tanpa redirect; localhost/IP private ditolak. DNS dipasang ke alamat publik yang sudah divalidasi saat pengiriman. Menyimpan webhook merotasi secret; event lama tetap memakai **byte payload, URL, dan secret saat event dibuat**. Migration tidak mengubah byte outbox lama yang telah ditandatangani.

Event invoice.paid, invoice.cancelled, invoice.expired, invoice.failed mengikuti transisi. Body `{id,event,created_at,data:Invoice}`; header `X-QRIS-Event-Id` dan `X-QRIS-Signature: sha256=<hex>`.

Contoh verifikasi Node/Bun:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: Buffer, signature: string, secret: string) {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const received = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(received, expected);
}
```

Periksa **raw bytes sebelum parsing/serialize ulang**. Cocokkan data.environment, deduplikasi event.id dalam transaksi penyimpanan, lalu balas 2xx. Pengiriman at-least-once dapat berulang. Maksimal enam percobaan otomatis dengan backoff; pengiriman ulang manual tersedia pada environment yang sama. Webhook dinonaktifkan menghentikan kiriman/retry, bukan menghapus histori.

## Sewa dan operator

Admin menetapkan harga 7/30 hari dan menghubungkan dompetnya sendiri pada Dompet QRIS. Pilih dompet itu di **Admin > Dompet pembayaran sewa operator** untuk mode otomatis; kosongkan untuk persetujuan manual. Operator dipilih dari data terkelola, bukan domain/API key/env gateway eksternal.

- Manual: merchant menerima instruksi pembayaran dari operator, mengajukan durasi/referensi, admin memverifikasi bukti sebelum menyetujui.
- Otomatis: invoice QRIS produksi dompet operator dibuat; masa sewa bertambah hanya setelah receipt nyata terverifikasi. Admin tidak dapat mengesahkan pending otomatis tanpa bukti.
- Perpanjangan menambah akhir masa aktif atau mulai saat aktivasi jika sudah berakhir. Aktivasi ulang receipt yang sama tidak menambah hari dua kali.
- Operator tidak dapat diganti saat invoice sewa pending. Simulasi produksi/sewa ditolak.
- Identitas usaha, kontak dukungan, kebijakan refund biaya sewa, dan instruksi manual harus diberikan operator kepada merchant sebelum pembayaran; perangkat lunak tidak mengarangnya.

## Produksi dan Docker

```sh
bun run build
# Atur APP_URL ke origin HTTPS publik, HOST/PORT sesuai reverse proxy.
bun run start
```

```sh
docker compose up -d --build
```

`compose.yaml` mengikat port ke `127.0.0.1:3100`; terminasi HTTPS melalui reverse proxy Anda. Image memuat Bun dan Node 22, memasang vendor dependencies saat build, dan berjalan sebagai user node. Volume `qris-data` menyimpan SQLite **dan** direktori dompet/sesi `/app/data/wallets`. Tidak perlu membuka port child gateway; semuanya IPv4 loopback dengan port OS-assigned.

Konfigurasi `.env.example`: APP_URL, HOST, PORT, DATA_DIR, SETUP_TOKEN, ENCRYPTION_KEY. DATABASE_PATH opsional untuk lokasi SQLite, GATEWAY_DATA_DIR untuk lokasi private wallet, GATEWAY_NODE_BINARY untuk executable Node operator. GATEWAY_ALLOWED_HOSTS hanya untuk rekonsiliasi **invoice lama** dari adapter eksternal; tidak dipakai onboarding dompet baru.

Proses per dompet mengisolasi konfigurasi dan state upstream, **bukan sandbox keamanan OS terhadap kode vendor yang berbahaya**. Jalankan source/vendor tepercaya dan lindungi akses lokal server. Process dimulai on-demand; kapasitas RAM server harus disesuaikan jumlah dompet aktif.

## Backup, upgrade, dan rekonsiliasi

- Backup SQLite secara konsisten dengan SQLite backup/serialize atau hentikan server sebelum menyalin database beserta WAL. Jangan hanya menyalin sqlite yang sedang ditulis.
- Backup ENCRYPTION_KEY dan direktori wallet bersama-sama, pada media private. Rahasia konfigurasi terenkripsi AES-256-GCM di SQLite; **file sesi GoPay format asli tidak dienkripsi**, berizin 0600 dalam direktori 0700.
- Jangan menyimpan `.env`, database, sesi, token, atau vendor node_modules ke Git. Jangan menimpa .env saat upgrade.
- Migrasi mempertahankan ID, FK, receipt claims, rentals, kunci, webhook, byte outbox, serta trigger/index eksplisit. Record lama menjadi production.
- Koneksi eksternal lama hanya untuk invoice historis, tidak dapat membuat invoice produksi baru. Onboarding dompet terkelola baru; selesaikan invoice lama sebelum menonaktifkan koneksi.
- Jangan mengubah akun/QRIS/sesi di balik invoice pending. Jika upstream tidak dapat diperiksa, gunakan mutasi portal dan bukti pelanggan; kegagalan API bukan bukti dana belum diterima.

## Verifikasi yang sudah dijalankan

- `bun run check`: 0 error; 7 warning Svelte terkait tabindex pada region tabel scroll. Region sengaja dapat difokuskan untuk scroll keyboard; perilaku ArrowRight diuji di browser, warning tidak disembunyikan.
- `bun test`: **41 pass, 0 fail**, 212 assertion dalam lima file. Termasuk migrasi legacy/restart, byte outbox tetap, isolasi proses gateway nyata, penyelesaian CLI interaktif, konversi nominal analytics GoPay melalui server asli, batas akhir bukti pembayaran, rekonsiliasi setelah expiry, aktivasi sewa satu kali, CRC/nominal QR, tenant/key scope, WIB/concurrency quota, pembayaran, dan sandbox.
- `bun run build`: berhasil. Decoder QR dimuat sebagai chunk terpisah saat scan/import diperlukan.
- Smoke HTTP pada database QA terpisah: tiga wallet termasuk dua GoPay, QR asli GoPay/ShopeePay dengan nama/nominal benar, invoice keenam 429, replay idempotent, kuota bertahan restart, sandbox paid/failed/expired, cross-scope ditolak, log kedua provider, prompt asli CLI GoPay, sewa manual/otomatis, dan guard simulator sewa.
- Smoke lifecycle login terisolasi: CLI selesai keluar dengan kode 0; pemutusan IPC parent menghentikan child yang menunggu input. Program GoPay asli tetap menunggu nomor HP, pembatalan membebaskan wallet, health gateway mengembalikan 200, dan refresh tanpa sesi mendapat penolakan upstream 502 melalui IPC, bukan timeout.
- Pembayaran GoPay produksi Rp1.000 yang dilaporkan pengguna diverifikasi dari QRIS settlement nyata. Tombol rekonsiliasi mengubah invoice expired menjadi paid melalui gateway dan menyimpan satu klaim transaksi; status bertahan setelah reload tanpa QR untuk dibayar ulang. Tombol diaktifkan lewat Enter; layar 320/390px tidak overflow, target sentuh 66px pada 320px, kontras teks tombol 19.24:1, tanpa error browser pada alur ini.
- Panduan rekonsiliasi diperiksa pada build produksi terisolasi dengan akun QA dan SQLite in-memory: penjelasan pembayaran tepat waktu/terlambat tampil di layar 390px tanpa overflow atau error browser. Layanan QA dihentikan dan skrip sementara dihapus setelah pemeriksaan.
- Browser nyata: login, onboarding, decode PNG lokal, modal/Escape, simulator lunas, panduan/copy HMAC, menu mobile, tabel ArrowRight, admin hanya-baca sandbox dan harga produksi. Enam halaman pada 390/320px tidak overflow horizontal; zoom 200% diperiksa. Tidak ada error JavaScript pada alur yang diperiksa.
- Kontras 47 node teks halaman admin: minimum 5.56:1, tanpa pelanggaran AA pada sampel terukur.
- Docker build dan container aktual: signup serta invoice GoPay memulai Node gateway di dalam image Bun; nama merchant dipertahankan.
- `npm audit --omit=dev` kedua gateway setelah pembaruan lockfile: **0 vulnerability yang dilaporkan**. Ini hasil audit saat verifikasi, bukan jaminan keamanan masa depan.

**Batas bukti:** pengguna melaporkan OTP GoPay berhasil dan sesi tersimpan. Pengujian lifecycle tidak mengulang OTP. Diagnosis pembayaran memakai sesi tersimpan melalui session manager asli untuk membaca mutasi dan memverifikasi QRIS settlement Rp1.000 yang dibayar pengguna; token tidak ditampilkan dan status paid berasal dari bukti gateway. Refresh autentikasi valid, pembayaran ShopeePay nyata, Telegram, receiver webhook publik, dan kamera fisik belum diverifikasi. QR QA memakai identitas TEST-ONLY yang tidak untuk dibayar. Uji provider dan penerima webhook milik Anda sebelum menawarkan produksi. Kamera pada browser QA berada pada tahap izin; decode PNG terbukti.

## Desain dan delivery gate

Direction: konsol operasional merchant Neo-Brutalism, **ENERGY 3 / RHYTHM 2 / MOTION 1**. Cream untuk kasir/daylight, ink untuk angka/teks, lime untuk nominal/tindakan utama. Heading besar dan garis tegas memberi identitas; shadow keras hanya CTA/dialog, bukan semua panel. Angka dan provider diutamakan, tanpa grafik/testimonial/saldo fiktif. Font sistem mempercepat render; monospace hanya data/API. Tema light tetap, tidak ada toggle palsu.

- R-02 PASS: copy produk tidak memakai em dash dekoratif.
- R-03 PASS: enam halaman diuji 320/390px tanpa overflow; zoom 200% tidak melebar.
- R-17 PASS: nominal/kuota/status berasal dari API akun; sandbox ditandai simulasi.
- R-18 PASS: tidak ada testimonial atau avatar pelanggan fiktif.
- R-23 PASS: direction Neo-Brutalism dari permintaan pengguna; QR dibuat dari payload source nyata atau tautan sandbox berlabel.
- R-24 PASS: navigasi enam halaman, admin, checkout, dan legal mempunyai tujuan nyata.
- R-25 PASS: sampel kontras teks aktual minimum 5.56:1; palette cream/ink/muted konsisten.
- R-26 PASS: kontrol onboarding, API, invoice, simulasi, sewa, dan admin terhubung ke handler nyata; kegagalan kredensial ditampilkan, bukan fake success.
- R-27 PASS: loading/empty/error tersedia; browser memperlihatkan error refresh/sesi tanpa kredensial.
- R-28 PASS: panduan membahas alur provider/API konkret; tidak ada FAQ generik.
- R-32 PASS: Escape modal/menu, fokus, dan ArrowRight tabel diperiksa.
- R-33 PASS: perubahan UI ditulis pada source/CSS, bukan script patch runtime.
- R-34 PASS: satu tema light disengaja; tidak ada mode gelap/toggle yang belum diterapkan.
- R-35 PASS: build, runtime HTTP, browser click-through dan rekaman wallet/panduan dilakukan; batas perangkat/akun nyata dinyatakan.
- R-36 PASS: tidak mengklaim afiliasi, kepatuhan, sertifikasi, uptime, atau real settlement yang belum dibuktikan.
- R-37 PASS: direction/dials eksplisit, bukan draft tanpa arah.
- R-38 PASS: data QA terisolasi dan berlabel; tidak dimasukkan ke database pengguna.
- R-01 PASS: tidak ada gradient/glow dekoratif.
- R-04 PASS: tanpa icon library/generic sparkle; tindakan memakai label.
- R-06 PASS: font sistem untuk render cepat, uppercase kecil hanya kategori, monospace hanya payload/API.
- R-07 PASS: tanpa background grid/blueprint dekoratif.
- R-08 PASS: panah pada panduan menyatakan jalur payload, bukan dekorasi CTA.
- R-09 PASS: badge menyatakan status/environment nyata, bukan marketing.
- R-10 PASS: tanpa glassmorphism.
- R-12 PASS: shadow keras membedakan CTA/dialog; panel operasional datar.
- R-13 PASS: tanpa glow.
- R-14 PASS: kartu wallet berulang untuk entitas sejenis; ringkasan/checkout/tabel/panduan memiliki hierarki berbeda.
- R-19 PASS: motion rendah untuk fokus dan perubahan status; tidak ada animasi template.
- R-22 PASS: tanpa ilustrasi generik.
- Liveliness dials PASS: ENERGY 3/RHYTHM 2/MOTION 1 dinyatakan dan terlihat pada screenshot.
- Liveliness focal point PASS: invoice/nominal atau CTA tugas utama menjadi fokus tiap layar.
- Liveliness whitespace PASS: jarak memisahkan tugas, data, serta petunjuk.
- Liveliness accent PASS: lime untuk tindakan/nominal utama, bukan seluruh elemen.
- Liveliness motif PASS: heading rapat, garis ink, bentuk tegas, shadow offset selektif.
- Design Read PASS: direction konsol merchant dan Neo-Brutalism dipilih sebelum implementasi UI.
- C-1 PASS: alasan palette, font, hierarchy, dan motion tertulis di atas.
- C-2 PASS: kontrol nyata atau disabled dengan prasyarat/state, tidak ada stub fitur.
- C-3 PASS: section berasal dari dompet/invoice/API/sewa/tutorial yang diminta, bukan landing template.
- C-4 PASS: mobile, zoom, keyboard, empty/loading/error, dan light theme diperiksa.
- C-5 PASS: sumber data dan batas verifikasi disebutkan, tanpa klaim fabricated.
- R-05 PASS: konsol memakai tabel/panel/form sesuai data; tidak memakai hero/features/testimonials template.
- R-11 PASS: radius kecil konsisten, bukan semua elemen pill.
- R-15 PASS: CTA konkret seperti Tambah dompet, Buat invoice, dan Simulasikan lunas.
- R-16 PASS: tanpa buzzword pemasaran AI.
- R-20 PASS: identitas tegas cream/ink/lime dan tipografi operasional, bukan white-card default.
- R-21 PASS: light dipilih untuk kasir/daylight, bukan dark tech default.
- R-29 PASS: cream/ink dengan lime accent; warna feedback hanya semantik.
- R-30 PASS: tidak menyalin visual Midtrans/Xendit; referensi hanya cakupan alur QRIS.
- R-31 PASS: setiap keputusan utama memiliki alasan satu baris di bagian direction.
