import { SQL } from 'bun';
import { readdir } from 'node:fs/promises';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error('Set TEST_DATABASE_URL ke PostgreSQL khusus pengujian (role memerlukan CREATEDB).');
const admin = new SQL(url, { max: 1 });
try {
  for (const file of (await readdir('server')).filter(file => file.endsWith('.test.ts')).sort()) {
    const name = `qris_test_${crypto.randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    try {
      const target = new URL(url); target.pathname = '/' + name;
      const child = Bun.spawn(['bun', 'test', `server/${file}`], {
        env: { ...process.env, DATABASE_URL: target.toString(), QRIS_TEST_DATABASE: '1' },
        stdout: 'inherit', stderr: 'inherit',
      });
      const code = await child.exited;
      if (code) { process.exitCode = code; break; }
    } finally { await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`); }
  }
} finally { await admin.close(); }
