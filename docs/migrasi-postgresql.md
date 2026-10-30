# Update server dari SQLite ke PostgreSQL

Panduan ini untuk server yang **masih menjalankan versi SQLite**. Migrasi dilakukan sekali saat maintenance. Update berikutnya yang sudah memakai PostgreSQL tidak perlu mengimpor SQLite lagi.

Perintah dijalankan di folder proyek pada server yang benar. Contoh memakai Bash dan Docker Compose v2 (`docker compose`). Sesuaikan domain, lokasi proyek, lokasi data, dan nama service dengan deployment Anda. Panduan tidak menjalankan update server secara otomatis.

## Yang perlu disiapkan

- Docker Engine dan plugin Docker Compose yang sudah terpasang dan bisa digunakan operator.
- Akses SSH, repository/release yang berisi versi PostgreSQL, serta ruang disk untuk image, database baru, dan backup lengkap.
- Domain HTTPS dan reverse proxy yang meneruskan aplikasi ke `127.0.0.1:3100`. Konfigurasi proxy lama dapat dipertahankan jika port aplikasi sama.
- `.env` lama, terutama **ENCRYPTION_KEY**, dan seluruh direktori wallet/sesi. Jangan menjalankan `bun run setup` untuk mengganti konfigurasi instalasi lama.
- Waktu maintenance dan backup yang juga disalin ke media privat di luar server.

Kebutuhan RAM bergantung jumlah dompet aktif: setiap dompet dapat menjalankan proses Node sendiri. Periksa ruang dan beban server aktual sebelum migrasi; tidak ada angka kapasitas merchant yang dijamin oleh panduan ini.

```bash
docker version
docker compose version
df -h .
free -h
```

Service `app` memakai network eksternal `web` untuk reverse proxy Docker; proxy pada network tersebut dapat memakai upstream `app:3100`. Database tetap hanya terhubung ke network default proyek. Network `web` harus dibuat sekali sebelum menjalankan aplikasi.

Compose menyediakan PostgreSQL 18 dengan volume `qris-postgres`. Volume `qris-data` tetap menyimpan wallet. Jangan menjalankan `docker compose down -v`: opsi `-v` menghapus volume data.

## A. Server lama sudah memakai Docker Compose

Alur ini mengasumsikan service lama bernama `app`, data ada di `/app/data`, SQLite ada di `/app/data/qris.sqlite`, dan wallet ada di `/app/data/wallets`. Jika memakai lokasi berbeda, sesuaikan semua path di bawah. Data Docker bisa berbeda dengan folder `./data` pada host; impor database yang benar-benar dipakai aplikasi lama.

### 1. Catat deployment dan simpan image lama

Lakukan **sebelum mengganti compose.yaml atau image aplikasi**. Tetap gunakan folder dan nama project Compose yang sama agar volume lama tidak berganti.

```bash
cd /lokasi/Qris-Gateway
umask 077
BACKUP_DIR="$PWD/backups/sqlite-to-postgres-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
APP_CONTAINER="$(docker compose ps -q app)"
test -n "$APP_CONTAINER"
export COMPOSE_PROJECT_NAME="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$APP_CONTAINER")"
ROLLBACK_IMAGE="qris-gateway:sqlite-before-$(date +%Y%m%d%H%M%S)"
docker image tag "$(docker inspect --format '{{.Image}}' "$APP_CONTAINER")" "$ROLLBACK_IMAGE"
cp -p .env "$BACKUP_DIR/env.sqlite"
cp -p compose.yaml "$BACKUP_DIR/compose.sqlite.yaml"
printf 'services:\n  app:\n    image: %s\n' "$ROLLBACK_IMAGE" > "$BACKUP_DIR/rollback-image.yaml"
printf '%s\n' "$COMPOSE_PROJECT_NAME" > "$BACKUP_DIR/compose-project.txt"
chmod 600 "$BACKUP_DIR/env.sqlite"
```

Periksa mount data tanpa mencetak environment yang berisi rahasia:

```bash
docker inspect --format '{{range .Mounts}}{{println .Destination .Type .Name .Source}}{{end}}' "$APP_CONTAINER"
```

Pastikan mount `/app/data` menunjuk volume/bind mount lama yang benar. Jangan menyalin `.env` atau backup sesi ke Git. Simpan `BACKUP_DIR` dan nama image rollback; jika membuka sesi SSH baru, isi ulang `BACKUP_DIR` dengan path backup tadi dan ekspor nama project dari `compose-project.txt`.

### 2. Pasang release baru dan atur database

Ambil release PostgreSQL yang sudah Anda review, melalui proses Git/deploy yang biasa dipakai server. Hindari menimpa perubahan lokal, `.env`, atau direktori data. Folder proyek dan `COMPOSE_PROJECT_NAME` tetap sama.

Buat password acak:

```bash
openssl rand -hex 32
```

Masukkan hasilnya ke `.env` menggunakan editor lokal pada server. Tambahkan atau ubah baris berikut, tanpa mengganti nilai rahasia lama:

```dotenv
APP_URL=https://qris.domain-anda.id
POSTGRES_PASSWORD=GANTI_DENGAN_HASIL_RANDOM
POSTGRES_PORT=5432
DATABASE_URL=postgresql://qris:GANTI_DENGAN_HASIL_RANDOM@127.0.0.1:5432/qris
```

Gunakan hasil hex yang sama pada kedua baris password. `POSTGRES_PASSWORD` berisi password asli; password dalam `DATABASE_URL` harus di-URL-encode bila menggunakan karakter khusus. Password hex tidak perlu encoding tambahan.

Di dalam Compose, URL aplikasi otomatis menjadi `postgresql://qris:...@database:5432/qris`. `DATABASE_URL` loopback di `.env` digunakan jika menjalankan alat dari host. Jika port host 5432 sudah dipakai, pilih port kosong, misalnya 55433, lalu ubah **POSTGRES_PORT dan port DATABASE_URL host**. Port internal service tetap 5432.

```bash
chmod 600 .env
docker network inspect web >/dev/null 2>&1 || docker network create web
docker compose config --quiet
docker compose build app
docker compose up -d --wait --wait-timeout 60 database
```

Pada tahap ini aplikasi lama masih berjalan. Jangan menjalankan `up app` atau `up --build` untuk seluruh stack sebelum backup dan impor selesai. Password Compose dipakai saat volume PostgreSQL pertama kali diinisialisasi; mengedit `.env` saja tidak mengganti password role pada volume database yang sudah ada.

### 3. Aktifkan maintenance, hentikan penulis lama, dan backup data

Aktifkan halaman maintenance pada reverse proxy sesuai konfigurasi server Anda. Hentikan seluruh replika aplikasi, cron, dan worker lama yang menulis database. Untuk satu service aplikasi Compose:

```bash
docker compose stop app
mkdir -p "$BACKUP_DIR/data"
docker cp "$APP_CONTAINER":/app/data/. "$BACKUP_DIR/data/"
chmod -R go-rwx "$BACKUP_DIR"
test -s "$BACKUP_DIR/data/qris.sqlite"
```

Salinan seluruh data setelah penulis berhenti mencakup SQLite, file `-wal`/`-shm` bila masih ada, serta wallet. Jangan mengambil file `.sqlite` saja dari aplikasi yang sedang berjalan. Jika wallet memakai mount terpisah di luar `/app/data`, backup mount tersebut juga. Salin backup ini ke penyimpanan privat di luar server sebelum lanjut.

### 4. Impor ke PostgreSQL kosong

Perintah berikut menggunakan image baru dan volume data lama, tanpa menyalakan server aplikasi:

```bash
docker compose run --rm --no-deps app \
  bun run db:import:sqlite /app/data/qris.sqlite
```

Tunggu sampai muncul `Impor selesai` dan JSON jumlah record per tabel. Simpan jumlah tersebut untuk verifikasi. Jangan lanjut jika exit code bukan 0.

Importer membuka SQLite read-only, memeriksa foreign key, dan memasukkan data dalam satu transaksi. ID, password hash, ciphertext kredensial, receipt claim, API key, webhook, dan byte payload outbox dipertahankan. Data legacy tanpa environment menjadi `production`. Direktori sesi tidak diimpor ke database: volume wallet lama tetap harus tersedia.

Tujuan yang berisi data ditolak. Jika impor gagal di tengah, perubahan transaksi dibatalkan. Tabel/trigger SQLite kustom perlu dipindahkan manual. Jika pesan menyebut tujuan tidak kosong setelah percobaan sebelumnya, periksa apakah impor sebenarnya sudah berhasil; jangan menghapus tabel atau volume untuk mencoba ulang secara membabi buta.

### 5. Verifikasi data dan hidupkan aplikasi

Bandingkan jumlah dengan hasil importer:

```bash
docker compose exec -T database psql -U qris -d qris -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'users' AS tabel, COUNT(*) FROM users
UNION ALL SELECT 'connections', COUNT(*) FROM connections
UNION ALL SELECT 'invoices', COUNT(*) FROM invoices
UNION ALL SELECT 'transaction_claim', COUNT(*) FROM transaction_claim
UNION ALL SELECT 'rentals', COUNT(*) FROM rentals
UNION ALL SELECT 'webhook_deliveries', COUNT(*) FROM webhook_deliveries;
SQL

docker compose up -d --no-build --wait --wait-timeout 60 app
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:3100/api/health
```

Kedua service harus `healthy`; health aplikasi juga memeriksa akses database. Jika gagal, periksa log secara lokal dan jangan membagikan output yang mengandung informasi akun:

```bash
docker compose logs --tail=100 app database
```

Sebelum melepas maintenance:

- Login dengan akun lama; pastikan tidak muncul permintaan membuat admin baru.
- Cocokkan invoice historis, nominal, status paid, dan masa langganan.
- Buka checkout invoice lama dan halaman dompet. Pastikan sesi yang tersimpan masih tersedia. Jangan mengulang OTP atau merotasi token hanya karena database dipindahkan.
- Periksa pengaturan API key dan webhook. Worker versi baru dapat melanjutkan retry webhook yang tertunda setelah aplikasi hidup.
- Lakukan uji provider sesuai prosedur operasional Anda; health database sendiri tidak membuktikan autentikasi upstream berhasil.

Setelah hasil sesuai, nonaktifkan maintenance. Simpan SQLite lama dan backup sampai masa observasi selesai. Aplikasi versi baru hanya memakai PostgreSQL; SQLite lama tidak ikut diperbarui.

## B. Server lama menjalankan Bun langsung di host

Jalankan versi baru dengan Bun >=1.3, Node.js >=18, npm, dan PostgreSQL. Anda dapat memakai service `database` Compose dari panduan A atau PostgreSQL yang sudah dikelola sendiri. Jangan menyalakan service `app` Docker jika ingin tetap menjalankan aplikasi di host.

1. Simpan release/kode lama untuk rollback. Aktifkan maintenance dan hentikan service Bun beserta worker melalui process manager yang dipakai server. Pastikan tidak ada instance lain yang menulis SQLite.
2. Backup `.env`, seluruh DATA_DIR, lokasi DATABASE_PATH bila berbeda, dan GATEWAY_DATA_DIR bila berada di luar DATA_DIR. Saat menyalin SQLite yang sudah berhenti, pertahankan file WAL/SHM yang masih ada. Jangan mengganti ENCRYPTION_KEY.
3. Pasang release baru. Isi DATABASE_URL dengan database PostgreSQL kosong. Jika menggunakan database Compose, isi POSTGRES_PASSWORD dan POSTGRES_PORT seperti panduan A, lalu jalankan `docker compose up -d --wait database`.
4. Dari folder proyek, jalankan:

   ```bash
   bun install --frozen-lockfile
   bun run gateways:install
   bun run check
   bun run build
   bun run db:import:sqlite /path/aktual/qris.sqlite
   ```

5. Pertahankan DATA_DIR/GATEWAY_DATA_DIR lama agar file sesi tetap terbaca. Jika wallet sebelumnya mengandalkan lokasi DATABASE_PATH sebagai default, atur GATEWAY_DATA_DIR secara eksplisit ke folder wallet lama: versi baru tidak menggunakan DATABASE_PATH.
6. Atur APP_URL ke origin HTTPS publik dan HOST/PORT sesuai proxy, lalu mulai kembali service production melalui process manager. Perintah aplikasi: `bun run start`.
7. Jalankan pemeriksaan HTTP dan akun/data seperti langkah A.5, lalu lepas maintenance.

Untuk PostgreSQL eksternal, pastikan akses jaringan dan TLS mengikuti konfigurasi server database. Compose saat ini selalu mengarahkan service `app` ke service `database` internal; mengubah DATABASE_URL di `.env` saja tidak mengalihkan aplikasi Docker ke server eksternal. Sesuaikan override Compose jika memilih arsitektur tersebut.

## Rollback

Rollback ke SQLite paling aman dilakukan selama maintenance, **sebelum ada penulisan baru di PostgreSQL**. Setelah traffic, invoice, pembayaran, atau webhook baru berjalan, SQLite lama sudah tertinggal. Hentikan penulis baru dan rekonsiliasi perubahan terlebih dahulu; importer ini hanya satu arah, tidak menyediakan sinkronisasi PostgreSQL kembali ke SQLite.

Untuk deployment Docker dari bagian A, data SQLite lama masih ada pada volume lama. Setelah memastikan tidak ada perubahan bisnis baru yang perlu dipertahankan, jalankan dari folder proyek yang sama:

```bash
docker compose stop app
cp -p "$BACKUP_DIR/env.sqlite" .env
chmod 600 .env
export COMPOSE_PROJECT_NAME="$(cat "$BACKUP_DIR/compose-project.txt")"
docker compose --project-directory "$PWD" \
  -f "$BACKUP_DIR/compose.sqlite.yaml" \
  -f "$BACKUP_DIR/rollback-image.yaml" \
  up -d --no-build app
curl --fail --silent --show-error http://127.0.0.1:3100/api/health
```

Perintah ini memakai image dan compose lama tanpa membangun ulang dari source baru. PostgreSQL dan volumenya tetap disimpan untuk pemeriksaan. Jika volume SQLite/wallet ikut berubah atau rusak, pulihkan backup lengkap ke lokasi pemulihan terpisah dan periksa sebelum mengganti data aktif.

Untuk aplikasi host, kembalikan release dan `.env` lama, gunakan SQLite serta wallet lama, lalu mulai kembali service lama setelah rekonsiliasi. Jangan menjalankan kedua versi sebagai penulis aktif bersamaan.

## Backup rutin setelah migrasi

Untuk backup konsisten antara database dan file sesi, lakukan dalam jendela maintenance dengan aplikasi/worker dihentikan. Contoh Docker:

```bash
umask 077
PG_BACKUP_DIR="$PWD/backups/postgres-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$PG_BACKUP_DIR"
docker compose stop app
docker compose exec -T database pg_dump -U qris -d qris -Fc > "$PG_BACKUP_DIR/qris.dump"
test -s "$PG_BACKUP_DIR/qris.dump"
cp -p .env "$PG_BACKUP_DIR/env"
mkdir -p "$PG_BACKUP_DIR/data"
docker compose cp app:/app/data/. "$PG_BACKUP_DIR/data/"
docker compose up -d --no-build --wait --wait-timeout 60 app
```

Jalankan setiap langkah hanya jika langkah sebelumnya berhasil. Jika backup gagal, periksa penyebabnya dan hidupkan kembali aplikasi secara terkontrol. Salin dump, `.env`, dan data wallet ke media privat di luar server. Jangan mengandalkan volume Docker sebagai satu-satunya backup.

Uji dump pada database terpisah, tanpa menjalankan aplikasi/worker yang bisa mengirim webhook dari hasil restore:

```bash
docker compose exec -T database createdb -U qris qris_restore_check
docker compose exec -T database pg_restore -U qris -d qris_restore_check \
  --no-owner --no-privileges --exit-on-error < "$PG_BACKUP_DIR/qris.dump"
docker compose exec -T database psql -U qris -d qris_restore_check \
  -c 'SELECT COUNT(*) FROM invoices;'
```

Gunakan nama database pemeriksaan yang belum ada. Cocokkan jumlah dan relasi data dengan backup; hapus database pemeriksaan setelah review sesuai prosedur operator. Pengujian dump tidak menggantikan uji pemulihan `.env` dan sesi wallet pada lingkungan terisolasi.
