# Changelog

## Dokumentasi integrasi website

- Panduan `docs/integrasi-website.md` menjelaskan integrasi website lain melalui API backend, checkout publik, webhook HMAC, idempotensi, pemetaan pesanan, sandbox, retry/rekonsiliasi, dan checklist produksi.
- Contoh layanan Bun/SQLite dapat dijalankan dengan harga pesanan server-side, mapping invoice persisten, validasi event, deduplikasi atomik, serta perlindungan status paid terhadap event lama.
- Checkout saat ini berbasis `checkout_url`, bukan SDK/token Snap; popup embedded, iframe, dan redirect kembali otomatis belum tersedia. Arah checkout ala Snap dicatat sebagai usulan, tanpa janji jadwal atau kompatibilitas Midtrans.
- Smoke HTTP memakai blok contoh tanpa perubahan terhadap gateway sandbox asli: create bersamaan idempoten, raw-body signature, isolasi environment/nominal, paid/failed/expired/cancelled, race webhook sebelum mapping, event terlambat, dan persistensi setelah restart berhasil. Webhook direplay lokal dari outbox nyata; pengiriman HTTPS publik dan pembayaran produksi tidak diuji pada pekerjaan ini.

## Perbaikan nominal dan rekonsiliasi GoPay

- Nominal Merchant Analytics yang memakai satuan 1/100 rupiah dikonversi pada mutasi dan pencocokan pembayaran, tanpa mengubah nominal QRIS/invoice atau source autentikasi.
- Pemeriksaan GoPay meneruskan batas akhir invoice dan menolak kandidat sesudah batas tersebut, termasuk ketika kandidat terlambat muncul sebelum receipt yang sah.
- Invoice expired dapat menjadi paid hanya dengan bukti pembayaran tepat waktu. Klaim transaksi tetap unik; invoice cancelled/failed dan pembayaran terlambat tidak dipaksa lunas. Sewa otomatis dengan bukti tepat waktu tetap aktif hanya sekali.
- Checkout produksi menyediakan Cek pembayaran sebelumnya; panduan aplikasi dan README menjelaskan rekonsiliasi.
- 41 tes lulus, check tanpa error dengan tujuh warning Svelte yang sudah ada, dan build berhasil. Pembayaran pengguna Rp1.000 terbukti QRIS settlement dan invoice menjadi paid melalui tombol checkout, dengan satu klaim tersimpan dan status bertahan setelah reload. Keyboard Enter, layar 320/390px, kontras tombol, dan error browser diperiksa.

## Perbaikan proses login GoPay

- Wrapper tidak lagi mempertahankan CLI yang selesai hanya karena IPC parent masih terbuka. Stdin socket dari Bun melepas referensi saat program login menjedanya dan kembali aktif saat menunggu input.
- Source autentikasi upstream, isi sesi, dan database tidak diubah. Versi lama yang sudah stuck dapat dipulihkan dengan restart aplikasi lalu uji sesi tersimpan, tanpa mengulang OTP.
- Regresi CLI interaktif dengan stdin/IPC tetap terbuka; 38 tes lulus, check tanpa error dengan tujuh warning Svelte yang sudah ada, dan build berhasil.
- Smoke program GoPay asli sampai prompt nomor, pembatalan login, health gateway 200, penolakan refresh tanpa sesi melalui IPC 502, serta penghentian child saat parent disconnect. OTP sukses dilaporkan pengguna; pengujian ini tidak memakai kredensial nyata.

## Gateway terkelola, multi-dompet, dan sandbox

- Source gateway GoPay/ShopeePay tersemat pada revision tetap, dijalankan oleh Node per dompet dari aplikasi Bun/Elysia; merchant tidak perlu mengisi domain/API key gateway.
- Multi-merchant dan beberapa wallet provider yang sama, OTP GoPay asli/import sesi/refresh, token ShopeePay/rotasi, mutasi, log disensor, serta QRIS dari teks/gambar/kamera.
- Gratis berkelanjutan lima invoice produksi per kalender WIB; reservasi atomik, idempotensi per lingkungan, dan kuota persisten. Sewa 7/30 hari menghapus batas gratis selama aktif.
- Lingkungan produksi/sandbox terpisah untuk invoice, key, webhook, dan total; simulator paid/failed/expired tidak menerima uang atau mengaktifkan sewa.
- Pembatalan invoice, operator sewa terkelola, admin hanya-baca sandbox, tutorial onboarding/API/HMAC, dan ketentuan/privasi sesuai file sesi upstream.
- Migrasi menjaga ID/FK/claims/rentals dan byte outbox lama; koneksi eksternal hanya untuk rekonsiliasi historis.
- Perbaikan CRC GoPay bila data merchant memuat 6304; normalisasi marker dinamis pada payload ShopeePay tanpa mengubah program proprietary.
- Pembaruan lockfile dependency kompatibel menghilangkan advisory yang dilaporkan audit produksi saat verifikasi.
- Image Bun + Node 22 dan volume data/sesi; regresi source gateway nyata, migrasi/restart, validasi QR, quota, serta scope sandbox.

Verifikasi: 37 tes lulus, typecheck tanpa error, build/container dan smoke HTTP/browser berhasil. Tujuh warning region scroll Svelte tetap terlihat; scroll keyboard diperiksa. Settlement, OTP sukses, mutasi akun nyata, Telegram, webhook receiver publik, dan kamera fisik memerlukan kredensial/perangkat operator untuk uji produksi. Detail dan batas bukti ada di README.

## Rilis awal

- ElysiaJS + Bun dengan SQLite persisten dan Svelte 5/Vite, UI Neo-Brutalism berbahasa Indonesia.
- Akun merchant/admin terpisah, setup admin berbasis token, sesi cookie, API key, enkripsi kredensial gateway, dan pembatasan autentikasi.
- Adapter HTTP GoPay/ShopeePay, invoice idempoten, nominal unik, checkout QR PNG, status pembayaran, pencarian, filter, dan CSV.
- Sewa 7/30 hari, harga operator, persetujuan manual, QRIS operator otomatis, dan perpanjangan atomik.
- Webhook HTTPS publik dengan HMAC, outbox persisten, riwayat kegagalan, dan retry.
- Penolakan bukti GoPay non-QRIS/refund; konfirmasi capture/settlement dari riwayat sebelum invoice ditandai lunas.
- Endpoint API produksi yang tidak dikenal mengembalikan JSON 404, tidak jatuh ke HTML SPA.
- Menu mobile Escape/fokus kembali, tabel keyboard, layout 320px dengan teks 200%, dan penghentian checkout ketika timer kedaluwarsa.
- Setup `.env` aman, build produksi, Docker/Compose, panduan API dalam aplikasi, serta dokumentasi batas gateway dan lisensi upstream.

Bukti verifikasi dan prasyarat deployment ada di README. Integrasi tidak memberikan lisensi komersial upstream maupun status penyelenggara pembayaran resmi.
