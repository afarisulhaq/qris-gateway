if (process.env.QRIS_TEST_DATABASE !== '1') throw new Error('Jalankan bun run test dengan TEST_DATABASE_URL.');
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('migrates legacy financial records without changing signed outbox bytes or breaking relationships', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qris-migration-'));
  const path = join(directory, 'legacy.sqlite');
  const originalPayload = '{"id":"legacy-event", "data":{"status":"paid"}}';
  const legacy = new Database(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT UNIQUE,password_hash TEXT,role TEXT,subscription_expires_at TEXT,created_at TEXT);
    CREATE TABLE connections(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),provider TEXT,base_url TEXT,encrypted_secrets TEXT,kind TEXT,UNIQUE(user_id,provider));
    CREATE TABLE rentals(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),days INTEGER,price INTEGER,status TEXT,payment_reference TEXT,created_at TEXT,activated_at TEXT);
    CREATE TABLE invoices(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),connection_id TEXT NOT NULL REFERENCES connections(id),rental_id TEXT UNIQUE REFERENCES rentals(id),external_id TEXT,description TEXT,amount INTEGER,payable_amount INTEGER,provider TEXT,status TEXT,creation_state TEXT,reference TEXT,created_at TEXT,expires_at TEXT,paid_at TEXT,checkout_token TEXT UNIQUE,qr_code TEXT,qr_url TEXT,last_checked_at TEXT,UNIQUE(user_id,external_id));
    CREATE TABLE transaction_claim(connection_id TEXT REFERENCES connections(id),transaction_id TEXT,invoice_id TEXT UNIQUE REFERENCES invoices(id),paid_at TEXT,PRIMARY KEY(connection_id,transaction_id));
    CREATE TABLE api_keys(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),label TEXT,prefix TEXT,key_hash TEXT UNIQUE,created_at TEXT);
    CREATE TABLE webhooks(user_id TEXT PRIMARY KEY REFERENCES users(id),url TEXT,encrypted_secret TEXT);
    CREATE TABLE webhook_deliveries(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),invoice_id TEXT REFERENCES invoices(id),event TEXT,payload TEXT,url TEXT,encrypted_secret TEXT,status INTEGER,error TEXT,attempts INTEGER,created_at TEXT,next_attempt_at TEXT,lease_until TEXT,delivered_at TEXT,UNIQUE(invoice_id,event));
    INSERT INTO users VALUES ('merchant','Legacy merchant','legacy@example.test','old-hash','merchant',NULL,'2026-01-01T00:00:00Z');
    INSERT INTO connections VALUES ('wallet','merchant','gopay','http://localhost:3000','preserved-ciphertext','merchant');
    INSERT INTO rentals VALUES ('rental','merchant',7,10000,'active',NULL,'2026-01-01T00:00:00Z','2026-01-01T00:01:00Z');
    INSERT INTO invoices VALUES ('invoice','merchant','wallet','rental','order-1','Legacy invoice',10000,10000,'gopay','paid','ready','receipt','2026-01-01T00:00:00Z','2026-01-01T00:05:00Z','2026-01-01T00:01:00Z','legacy-checkout-token','old-qr',NULL,NULL);
    INSERT INTO transaction_claim VALUES ('wallet','receipt','invoice','2026-01-01T00:01:00Z');
    INSERT INTO api_keys VALUES ('key','merchant','old key','prefix','old-key-hash','2026-01-01T00:00:00Z');
    INSERT INTO webhooks VALUES ('merchant','https://example.test/hook','old-webhook-ciphertext');
  `);
  legacy.query("INSERT INTO webhook_deliveries VALUES ('delivery','merchant','invoice','invoice.paid',?,'https://example.test/hook','old-webhook-ciphertext',200,NULL,1,'2026-01-01T00:01:00Z',NULL,NULL,'2026-01-01T00:01:01Z')").run(originalPayload);
  legacy.close();
  try {
    const { importSqlite } = await import('../scripts/migrate-sqlite');
    const { db } = await import('./db');
    const before = new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
    const counts = await importSqlite(path);
    expect(counts.users).toBe(1);
    expect(counts.invoices).toBe(1);
    expect(await db.query('SELECT * FROM invoices WHERE id = $1').get('invoice')).toMatchObject({
      id: 'invoice', status: 'paid', rental_id: 'rental', connection_id: 'wallet', environment: 'production', payable_amount: 10000, checkout_token: 'legacy-checkout-token',
    });
    expect(await db.query('SELECT * FROM transaction_claim').get()).toMatchObject({ invoice_id: 'invoice', transaction_id: 'receipt' });
    expect(await db.query<{ payload: string }>('SELECT payload FROM webhook_deliveries').get()).toEqual({ payload: originalPayload });
    expect(await db.query('SELECT * FROM connections WHERE id = $1').get('wallet')).toMatchObject({ encrypted_secrets: 'preserved-ciphertext', managed: 0, active: 1 });
    expect(await db.query('SELECT environment FROM api_keys').get()).toEqual({ environment: 'production' });
    expect(new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex')).toBe(before);
    await expect(importSqlite(path)).rejects.toThrow('harus kosong');
    await expect(db.query("INSERT INTO transaction_claim VALUES ('missing','receipt-2','invoice','2026-01-01')").run()).rejects.toThrow();
    const child = Bun.spawn(['bun', '-e', `const {db}=await import('./server/db.ts');console.log(JSON.stringify(await db.query('SELECT payload FROM webhook_deliveries').get()));await db.close();`], {
      cwd: resolve(import.meta.dir, '..'), env: process.env, stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = await new Response(child.stdout).text();
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ payload: originalPayload });

    await db.exec('TRUNCATE users, sessions, connections, api_keys, rentals, invoices, transaction_claim, webhooks, webhook_deliveries, admin_audit');
    const invalid = new Database(path);
    invalid.exec('UPDATE invoices SET amount = -1');
    invalid.close();
    await expect(importSqlite(path)).rejects.toThrow();
    expect(await db.query('SELECT COUNT(*)::integer AS total FROM users').get()).toEqual({ total: 0 });
    expect(await db.query('SELECT COUNT(*)::integer AS total FROM invoices').get()).toEqual({ total: 0 });
    await db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15000);
