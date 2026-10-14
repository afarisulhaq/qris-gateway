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
    CREATE TABLE legacy_audit(invoice_id TEXT);
    CREATE TRIGGER legacy_invoice_update AFTER UPDATE OF status ON invoices BEGIN INSERT INTO legacy_audit VALUES (NEW.id); END;
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
    for (let pass = 0; pass < 2; pass++) {
      const child = Bun.spawn(['bun', '-e', `const {db}=await import('./server/db.ts');console.log(JSON.stringify({foreignKeys:db.query('PRAGMA foreign_key_check').all(),invoice:db.query('SELECT * FROM invoices WHERE id="invoice"').get(),claim:db.query('SELECT * FROM transaction_claim').get(),payload:db.query('SELECT payload FROM webhook_deliveries').get().payload,connection:db.query('SELECT * FROM connections WHERE id="wallet"').get(),key:db.query('SELECT environment FROM api_keys').get()}));db.close();`], {
        cwd: resolve(import.meta.dir, '..'), env: { ...process.env, DATABASE_PATH: path }, stdout: 'pipe', stderr: 'pipe',
      });
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.foreignKeys).toEqual([]);
      expect(result.invoice).toMatchObject({ id: 'invoice', status: 'paid', rental_id: 'rental', connection_id: 'wallet', environment: 'production', payable_amount: 10000, checkout_token: 'legacy-checkout-token' });
      expect(result.claim).toMatchObject({ invoice_id: 'invoice', transaction_id: 'receipt' });
      expect(result.payload).toBe(originalPayload);
      expect(result.connection).toMatchObject({ encrypted_secrets: 'preserved-ciphertext', managed: 0, active: 1 });
      expect(result.key.environment).toBe('production');
    }
    const migrated = new Database(path);
    try {
      migrated.exec(`INSERT INTO connections(id,user_id,provider,base_url,encrypted_secrets) VALUES ('wallet-2','merchant','gopay','http://127.0.0.1:0','new-ciphertext');
        INSERT INTO invoices(id,user_id,environment,external_id,description,amount,payable_amount,provider,status,creation_state,created_at,expires_at,checkout_token) VALUES ('sandbox','merchant','sandbox','order-1','Sandbox invoice',10000,10000,'gopay','pending','ready','2026-01-01T00:00:00Z','2026-01-01T00:05:00Z','sandbox-checkout-token');
        UPDATE invoices SET status='expired' WHERE id='invoice';`);
      expect(migrated.query('SELECT invoice_id FROM legacy_audit').all()).toEqual([{ invoice_id: 'invoice' }]);
      expect(migrated.query('SELECT count(*) AS total FROM connections WHERE user_id="merchant"').get()).toEqual({ total: 2 });
      expect(migrated.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { migrated.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15000);
