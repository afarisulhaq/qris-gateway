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


export const schema = `
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
  INSERT INTO plans(days, price) VALUES (7, NULL), (30, NULL) ON CONFLICT DO NOTHING;
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
  CREATE UNIQUE INDEX IF NOT EXISTS one_operator_connection ON connections(kind) WHERE kind = 'operator';
  CREATE UNIQUE INDEX IF NOT EXISTS pending_payable_amount ON invoices(connection_id, payable_amount)
    WHERE status = 'pending' AND environment = 'production';
  CREATE INDEX IF NOT EXISTS merchant_invoices ON invoices(user_id, created_at);
  CREATE INDEX IF NOT EXISTS environment_invoice_usage ON invoices(user_id, environment, created_at);
  CREATE INDEX IF NOT EXISTS pending_invoice_expiration ON invoices(status, expires_at);
  CREATE INDEX IF NOT EXISTS due_webhooks ON webhook_deliveries(next_attempt_at, lease_until);
`;
