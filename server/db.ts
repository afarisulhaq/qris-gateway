import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databasePath = process.env.DATABASE_PATH || resolve(process.env.DATA_DIR || 'data', 'qris.sqlite');
if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
export const db = new Database(databasePath, { create: true, strict: true });
if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);

const connectionColumns = `
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('gopay', 'shopeepay')),
  base_url TEXT NOT NULL,
  encrypted_secrets TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'merchant' CHECK(kind IN ('merchant', 'operator')),
  label TEXT NOT NULL DEFAULT '',
  managed INTEGER NOT NULL DEFAULT 0 CHECK(managed IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))`;
const invoiceColumns = `
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  connection_id TEXT REFERENCES connections(id),
  rental_id TEXT UNIQUE REFERENCES rentals(id),
  environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('production', 'sandbox')),
  external_id TEXT,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  payable_amount INTEGER NOT NULL CHECK(payable_amount > 0),
  provider TEXT NOT NULL CHECK(provider IN ('gopay', 'shopeepay')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'paid', 'expired', 'cancelled', 'failed')),
  creation_state TEXT NOT NULL CHECK(creation_state IN ('creating', 'ready', 'failed')),
  reference TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  checkout_token TEXT NOT NULL UNIQUE,
  qr_code TEXT,
  qr_url TEXT,
  last_checked_at TEXT,
  CHECK(environment = 'sandbox' OR connection_id IS NOT NULL),
  CHECK(environment = 'production' OR rental_id IS NULL),
  UNIQUE(user_id, environment, external_id)`;
const webhookColumns = `
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('production', 'sandbox')),
  url TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  PRIMARY KEY(user_id, environment)`;

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'merchant')),
    subscription_expires_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS connections (${connectionColumns});
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('production', 'sandbox')),
    label TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plans (
    days INTEGER PRIMARY KEY CHECK(days IN (7, 30)),
    price INTEGER CHECK(price > 0)
  );
  INSERT OR IGNORE INTO plans(days, price) VALUES (7, NULL), (30, NULL);
  CREATE TABLE IF NOT EXISTS rentals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    days INTEGER NOT NULL CHECK(days IN (7, 30)),
    price INTEGER NOT NULL CHECK(price > 0),
    status TEXT NOT NULL CHECK(status IN ('requested', 'pending', 'active', 'rejected')),
    payment_reference TEXT,
    created_at TEXT NOT NULL,
    activated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS invoices (${invoiceColumns});
  CREATE TABLE IF NOT EXISTS transaction_claim (
    connection_id TEXT NOT NULL REFERENCES connections(id),
    transaction_id TEXT NOT NULL,
    invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),
    paid_at TEXT NOT NULL,
    PRIMARY KEY(connection_id, transaction_id)
  );
  CREATE TABLE IF NOT EXISTS webhooks (${webhookColumns});
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    invoice_id TEXT NOT NULL REFERENCES invoices(id),
    environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('production', 'sandbox')),
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    url TEXT NOT NULL,
    encrypted_secret TEXT NOT NULL,
    status INTEGER,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    next_attempt_at TEXT,
    lease_until TEXT,
    delivered_at TEXT,
    UNIQUE(invoice_id, event)
  );
  CREATE TABLE IF NOT EXISTS admin_audit (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    target_id TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

function columns(table: string): Set<string> {
  return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function migrateManagedSchema(): void {
  const connectionFields = columns('connections');
  const invoiceFields = columns('invoices');
  const webhookFields = columns('webhooks');
  const keyFields = columns('api_keys');
  const deliveryFields = columns('webhook_deliveries');
  if (connectionFields.has('managed') && invoiceFields.has('environment') && webhookFields.has('environment')
    && keyFields.has('environment') && deliveryFields.has('environment')) return;

  // Rebuild without renaming the old table: SQLite must retain incoming foreign-key targets.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      const rebuild = (table: string, definition: string, names: string[], expressions: string[]) => {
        const objects = db.query<{ sql: string }, [string]>(`SELECT sql FROM sqlite_master
          WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all(table);
        db.exec(`CREATE TABLE ${table}_managed (${definition});
          INSERT INTO ${table}_managed (${names.join(', ')}) SELECT ${expressions.join(', ')} FROM ${table};
          DROP TABLE ${table};
          ALTER TABLE ${table}_managed RENAME TO ${table};`);
        for (const object of objects) {
          if (table === 'invoices' && object.sql.includes('pending_payable_amount')) continue;
          db.exec(object.sql);
        }
      };
      if (!connectionFields.has('managed')) {
        const names = ['id', 'user_id', 'provider', 'base_url', 'encrypted_secrets', 'kind', 'label', 'managed', 'active'];
        rebuild('connections', connectionColumns, names,
          names.map(name => connectionFields.has(name) ? name : name === 'label' ? 'provider' : name === 'active' ? '1' : '0'));
      }
      if (!invoiceFields.has('environment')) {
        const names = ['id', 'user_id', 'connection_id', 'rental_id', 'environment', 'external_id', 'description', 'amount',
          'payable_amount', 'provider', 'status', 'creation_state', 'reference', 'created_at', 'expires_at', 'paid_at',
          'checkout_token', 'qr_code', 'qr_url', 'last_checked_at'];
        rebuild('invoices', invoiceColumns, names, names.map(name => name === 'environment' ? "'production'" : name));
      }
      if (!webhookFields.has('environment')) {
        rebuild('webhooks', webhookColumns, ['user_id', 'environment', 'url', 'encrypted_secret'],
          ['user_id', "'production'", 'url', 'encrypted_secret']);
      }
      if (!keyFields.has('environment')) {
        db.exec("ALTER TABLE api_keys ADD COLUMN environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('production', 'sandbox'))");
      }
      if (!deliveryFields.has('environment')) {
        db.exec("ALTER TABLE webhook_deliveries ADD COLUMN environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('production', 'sandbox'))");
      }
      if (db.query('PRAGMA foreign_key_check').all().length) {
        throw new Error('Managed schema migration refused: existing foreign-key relationships are invalid.');
      }
    }).immediate();
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrateManagedSchema();
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS one_operator_connection ON connections(kind) WHERE kind = 'operator';
  CREATE UNIQUE INDEX IF NOT EXISTS pending_payable_amount ON invoices(connection_id, payable_amount)
    WHERE status = 'pending' AND environment = 'production';
  CREATE INDEX IF NOT EXISTS merchant_invoices ON invoices(user_id, created_at);
  CREATE INDEX IF NOT EXISTS environment_invoice_usage ON invoices(user_id, environment, created_at);
  CREATE INDEX IF NOT EXISTS pending_invoice_expiration ON invoices(status, expires_at);
  CREATE INDEX IF NOT EXISTS due_webhooks ON webhook_deliveries(next_attempt_at, lease_until);
`);

export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export const atomic = <T>(operation: () => T): T => db.transaction(operation).immediate();
export type Environment = 'production' | 'sandbox';
export type UserRow = {
  id: string; name: string; email: string; password_hash: string;
  role: 'admin' | 'merchant'; subscription_expires_at: string | null; created_at: string;
};
export type ConnectionRow = {
  id: string; user_id: string | null; provider: 'gopay' | 'shopeepay';
  base_url: string; encrypted_secrets: string; kind: 'merchant' | 'operator';
  label: string; managed: number; active: number;
};
export type InvoiceRow = {
  id: string; user_id: string; connection_id: string | null; rental_id: string | null; environment: Environment;
  external_id: string | null; description: string; amount: number; payable_amount: number;
  provider: 'gopay' | 'shopeepay'; status: 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed';
  creation_state: 'creating' | 'ready' | 'failed'; reference: string | null;
  created_at: string; expires_at: string; paid_at: string | null;
  checkout_token: string; qr_code: string | null; qr_url: string | null; last_checked_at: string | null;
};
export type RentalRow = {
  id: string; user_id: string; days: 7 | 30; price: number;
  status: 'requested' | 'pending' | 'active' | 'rejected';
  payment_reference: string | null; created_at: string; activated_at: string | null;
};
