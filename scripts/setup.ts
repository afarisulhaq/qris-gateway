import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const databasePassword = randomBytes(32).toString('hex');
const values = {
  PORT: '3100',
  HOST: '127.0.0.1',
  APP_URL: 'http://localhost:5173',
  DATA_DIR: './data',
  POSTGRES_PASSWORD: databasePassword,
  DATABASE_URL: `postgresql://qris:${databasePassword}@127.0.0.1:5432/qris`,
  SETUP_TOKEN: randomBytes(24).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  GATEWAY_ALLOWED_HOSTS: 'localhost:3000,localhost:3001,127.0.0.1:3000,127.0.0.1:3001'
};
try {
  await writeFile('.env', Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('.env dibuat dengan rahasia acak dan izin 0600. Pasang gateway dengan bun run gateways:install (Node >=18 dan npm diperlukan), jalankan docker compose up -d database, lalu bun run dev. Gunakan SETUP_TOKEN dari .env untuk membuat admin pertama.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
    console.error('.env sudah ada. Konfigurasi tidak ditimpa.');
  } else {
    console.error('Gagal membuat .env:', (error as Error).message);
  }
  process.exitCode = 1;
}
