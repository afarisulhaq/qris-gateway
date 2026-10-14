import { afterAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import type { Environment, InvoiceRow, UserRow } from './db';

const originalEnvironment = { ...process.env };
process.env.DATABASE_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.APP_URL = 'http://localhost:3100';
process.env.NODE_ENV = 'test';
// The environment must be selected before SQLite and the application are imported.
const { db, id, now } = await import('./db');
const {
  recordPaid, activateRental, createRental, createMerchantInvoice, accessPublic, cancelInvoice, simulateInvoice,
  merchantInvoices, ownedInvoice, checkoutInvoice, invoicePublic, checkInvoice, expireInvoices, rentalPaymentMode,
} = await import('./domain');
const { encrypt, hashSecret, newSecret } = await import('./security');
const { isPublicAddress, validateWebhookUrl, webhookData, retryWebhook, deleteWebhook } = await import('./webhooks');
const providers = await import('./providers');
const { app } = await import('./index');

beforeEach(() => {
  for (const table of ['admin_audit', 'webhook_deliveries', 'webhooks', 'transaction_claim', 'invoices', 'rentals', 'api_keys', 'sessions', 'connections', 'users']) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec('UPDATE plans SET price = NULL');
  delete process.env.OPERATOR_GATEWAY_PROVIDER;
  delete process.env.OPERATOR_GATEWAY_URL;
  delete process.env.OPERATOR_GATEWAY_API_KEY;
  delete process.env.OPERATOR_GATEWAY_SHOPEE_TOKEN;
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  db.close();
});

function merchant(name = 'Merchant', subscriptionExpiresAt: string | null = new Date(Date.now() + 86400_000).toISOString()) {
  const userId = id();
  db.query("INSERT INTO users(id, name, email, password_hash, role, created_at, subscription_expires_at) VALUES (?, ?, ?, 'unused-test-hash', 'merchant', ?, ?)")
    .run(userId, name, `${userId}@example.test`, now(), subscriptionExpiresAt);
  return userId;
}

function connection(userId: string, providerName: 'gopay' | 'shopeepay' = 'gopay', managed = false) {
  const connectionId = id();
  db.query('INSERT INTO connections(id, user_id, provider, base_url, encrypted_secrets, label, managed) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(connectionId, userId, providerName, 'http://localhost:3000', encrypt(JSON.stringify({ api_key: 'gateway-test-secret' })), `${providerName} wallet`, managed ? 1 : 0);
  return connectionId;
}

function invoice(userId: string, connectionId: string, amount = 10000, rentalId: string | null = null): InvoiceRow {
  const invoiceId = id();
  db.query(`INSERT INTO invoices(id, user_id, connection_id, rental_id, description, amount, payable_amount, provider,
    status, creation_state, reference, created_at, expires_at, checkout_token)
    VALUES (?, ?, ?, ?, 'Test invoice', ?, ?, 'gopay', 'pending', 'ready', 'test-reference', ?, ?, ?)`)
    .run(invoiceId, userId, connectionId, rentalId, amount, amount, new Date(Date.now() - 1000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(), newSecret());
  return db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = ?').get(invoiceId)!;
}

function rental(userId: string, status = 'pending') {
  const rentalId = id();
  db.query('INSERT INTO rentals(id, user_id, days, price, status, created_at, payment_reference) VALUES (?, ?, 7, 10000, ?, ?, ?)')
    .run(rentalId, userId, status, now(), status === 'requested' ? 'manual-reference' : null);
  return rentalId;
}

function proof(amount: number, transactionId = 'transaction-1') {
  return { amount, transaction_id: transactionId, paid_at: now() };
}

function apiKey(userId: string, environment: Environment = 'production') {
  const key = `qris_${newSecret()}`;
  db.query('INSERT INTO api_keys(id, user_id, environment, label, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id(), userId, environment, 'Test key', key.slice(0, 13), hashSecret(key), now());
  return key;
}

describe('durable payment claims and subscriptions', () => {
  test('one transaction cannot pay a second invoice on the same connection', () => {
    const user = merchant();
    const gateway = connection(user);
    const first = invoice(user, gateway);
    recordPaid(first.id, proof(first.payable_amount));
    const second = invoice(user, gateway);
    expect(() => recordPaid(second.id, proof(second.payable_amount))).toThrow('sudah digunakan');
    expect(db.query<{ status: string }, [string]>('SELECT status FROM invoices WHERE id = ?').get(second.id)?.status).toBe('pending');
    expect(db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM transaction_claim').get()?.total).toBe(1);
  });

  test('transaction IDs are scoped to the gateway connection', () => {
    const firstUser = merchant();
    const secondUser = merchant();
    const first = invoice(firstUser, connection(firstUser));
    const second = invoice(secondUser, connection(secondUser));
    expect(recordPaid(first.id, proof(first.amount)).status).toBe('paid');
    expect(recordPaid(second.id, proof(second.amount)).status).toBe('paid');
  });

  test('rental payment and replay activate and extend only once', () => {
    const user = merchant();
    const rentalId = rental(user);
    const payment = invoice(user, connection(user), 10000, rentalId);
    const before = db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = ?').get(user)!.subscription_expires_at;
    recordPaid(payment.id, proof(payment.amount));
    const after = db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = ?').get(user)!.subscription_expires_at;
    recordPaid(payment.id, proof(payment.amount));
    expect(activateRental(rentalId)).toBe(false);
    expect(new Date(after).getTime() - new Date(before).getTime()).toBe(7 * 86400_000);
    expect(db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = ?').get(user)!.subscription_expires_at).toBe(after);
  });

  test('a reused gateway claim cannot activate a second rental', () => {
    const user = merchant();
    const gateway = connection(user);
    const first = invoice(user, gateway);
    recordPaid(first.id, proof(first.amount));
    const rentalId = rental(user);
    const payment = invoice(user, gateway, first.amount, rentalId);
    const expiry = db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = ?').get(user)!.subscription_expires_at;
    expect(() => recordPaid(payment.id, proof(payment.amount))).toThrow('sudah digunakan');
    expect(() => activateRental(rentalId)).toThrow('belum diverifikasi');
    expect(db.query<{ status: string }, [string]>('SELECT status FROM invoices WHERE id = ?').get(payment.id)?.status).toBe('pending');
    expect(db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = ?').get(rentalId)?.status).toBe('pending');
    expect(db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = ?').get(user)!.subscription_expires_at).toBe(expiry);
  });

  test('manual approval is idempotent and rejected rentals cannot activate', () => {
    const user = merchant();
    const request = rental(user, 'requested');
    expect(activateRental(request)).toBe(true);
    const expiry = db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = ?').get(user)!.subscription_expires_at;
    expect(activateRental(request)).toBe(false);
    expect(db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = ?').get(user)!.subscription_expires_at).toBe(expiry);
    expect(() => activateRental(rental(user, 'rejected'))).toThrow('ditolak');
  });

  test('invalid or expired proof does not create a claim or extend a rental', () => {
    const user = merchant();
    const rentalId = rental(user);
    const payment = invoice(user, connection(user), 10000, rentalId);
    expect(() => recordPaid(payment.id, proof(9999))).toThrow('tidak sesuai');
    db.query('UPDATE invoices SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1).toISOString(), payment.id);
    expireInvoices();
    expect(() => recordPaid(payment.id, proof(payment.amount))).toThrow();
    expect(db.query<{ status: string }, [string]>('SELECT status FROM invoices WHERE id = ?').get(payment.id)?.status).toBe('expired');
    expect(db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM transaction_claim').get()?.total).toBe(0);
    expect(db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = ?').get(rentalId)?.status).not.toBe('active');
  });

  test('verification after expiry accepts an on-time receipt and activates its automatic rental only once', async () => {
    const start = Date.parse('2026-10-08T10:39:44.000Z');
    setSystemTime(start);
    const checks = spyOn(providers, 'checkPayment');
    try {
      const user = merchant();
      const rentalId = rental(user);
      const payment = invoice(user, connection(user), 1000, rentalId);
      const before = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(user)!.subscription_expires_at!;
      const receipt = { paid: true, transaction_id: 'on-time-receipt', amount: 1000, paid_at: new Date(start + 10000).toISOString() };
      checks.mockResolvedValue(receipt);
      setSystemTime(start + 120000);
      expireInvoices();
      expect(db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = ?').get(rentalId)?.status).toBe('rejected');
      const [first, concurrent] = await Promise.all([checkInvoice(payment), checkInvoice(payment)]);
      expect(first.status).toBe('paid');
      expect(concurrent.paid_at).toBe(receipt.paid_at);
      expect(db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = ?').get(rentalId)?.status).toBe('active');
      const after = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(user)!.subscription_expires_at!;
      expect(Date.parse(after) - Date.parse(before)).toBe(7 * 86400_000);
      recordPaid(payment.id, receipt);
      expect(db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(user)!.subscription_expires_at).toBe(after);
      expect(db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM transaction_claim').get()?.total).toBe(1);
    } finally {
      checks.mockRestore();
      setSystemTime();
    }
  });

  test('late receipts and cancelled invoices cannot be reconciled into paid invoices', () => {
    const start = Date.parse('2026-10-08T10:39:44.000Z');
    setSystemTime(start);
    try {
      const user = merchant();
      const gateway = connection(user);
      const expired = invoice(user, gateway);
      const cancelled = invoice(user, gateway, 11000);
      cancelInvoice(user, cancelled.id, 'production');
      setSystemTime(start + 120000);
      expireInvoices();
      const late = { transaction_id: 'late-receipt', amount: expired.payable_amount, paid_at: new Date(start + 61000).toISOString() };
      expect(() => recordPaid(expired.id, late)).toThrow();
      const onTime = { ...late, amount: cancelled.payable_amount, paid_at: new Date(start + 10000).toISOString() };
      expect(recordPaid(cancelled.id, onTime).status).toBe('cancelled');
      expect(db.query<{ status: string }, [string]>('SELECT status FROM invoices WHERE id = ?').get(expired.id)?.status).toBe('expired');
      expect(db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM transaction_claim').get()?.total).toBe(0);
    } finally { setSystemTime(); }
  });

  test('a paid event is durably queued once with an exact, credential-free body', () => {
    const user = merchant();
    const payment = invoice(user, connection(user));
    db.query('INSERT INTO webhooks(user_id, url, encrypted_secret) VALUES (?, ?, ?)')
      .run(user, 'https://example.com/hook', encrypt('test-signing-secret'));
    recordPaid(payment.id, proof(payment.amount));
    recordPaid(payment.id, proof(payment.amount));
    const deliveries = db.query<{ payload: string; id: string }, []>('SELECT id, payload FROM webhook_deliveries').all();
    expect(deliveries).toHaveLength(1);
    const event = JSON.parse(deliveries[0]!.payload);
    expect(event.id).toBe(deliveries[0]!.id);
    expect(event.event).toBe('invoice.paid');
    expect(event.data.id).toBe(payment.id);
    expect(event.data.status).toBe('paid');
    expect(deliveries[0]!.payload).not.toContain('gateway-test-secret');
    expect(deliveries[0]!.payload).not.toContain('test-signing-secret');
  });
});

describe('tenant authorization', () => {
  test('API key cannot list, read, or check another merchant invoice', async () => {
    const first = merchant('First');
    const second = merchant('Second');
    const payment = invoice(first, connection(first));
    const key = apiKey(second);
    const headers = { 'X-API-Key': key, 'Content-Type': 'application/json' };
    const list = await app.handle(new Request('http://localhost/v1/invoices', { headers }));
    expect(await list.json()).toEqual([]);
    expect((await app.handle(new Request(`http://localhost/v1/invoices/${payment.id}`, { headers }))).status).toBe(404);
    expect((await app.handle(new Request(`http://localhost/v1/invoices/${payment.id}/check`, { method: 'POST', headers, body: '{}' }))).status).toBe(404);
  });

  test('API keys do not authenticate cookie routes but free accounts can read v1', async () => {
    const user = merchant();
    const key = apiKey(user);
    expect((await app.handle(new Request('http://localhost/api/me', { headers: { 'X-API-Key': key } }))).status).toBe(401);
    db.query('UPDATE users SET subscription_expires_at = NULL WHERE id = ?').run(user);
    expect((await app.handle(new Request('http://localhost/v1/invoices', { headers: { 'X-API-Key': key } }))).status).toBe(200);
  });

  test('checkout exposes no merchant email or gateway API key', async () => {
    const user = merchant();
    const payment = invoice(user, connection(user));
    const response = await app.handle(new Request(`http://localhost/api/checkout/${payment.checkout_token}`));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain('@example.test');
    expect(body).not.toContain('gateway-test-secret');
    expect(body).not.toContain('encrypted_secrets');
  });
});

test('automatic operator rentals share nominal reservations and external IDs coalesce merchant creation', async () => {
  const admin = merchant('Operator');
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin);
  const operator = connection(admin, 'gopay', true);
  db.query("UPDATE connections SET kind = 'operator' WHERE id = ?").run(operator);
  const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
    reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
  }));
  try {
    db.exec('UPDATE plans SET price = 10000');
    const first = merchant();
    const second = merchant();
    await Promise.all([createRental(first, { days: 7 }), createRental(second, { days: 7 })]);
    const payments = db.query<{ payable_amount: number; connection_id: string }, []>('SELECT payable_amount, connection_id FROM invoices ORDER BY payable_amount').all();
    expect(payments.map(payment => payment.payable_amount)).toEqual([10000, 10001]);
    expect(payments[0]!.connection_id).toBe(payments[1]!.connection_id);
    const wallet = connection(first, 'gopay', true);
    const input = { amount: 50000, description: 'Same merchant order', connection_id: wallet, provider: 'gopay', external_id: 'order-1' };
    const [a, b] = await Promise.all([createMerchantInvoice(first, input, 'production'), createMerchantInvoice(first, input, 'production')]);
    expect(a.id).toBe(b.id);
    expect(creation).toHaveBeenCalledTimes(3);
    for (let offset = 2; offset < 100; offset++) invoice(first, payments[0]!.connection_id, 10000 + offset);
    const rentalCount = db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM rentals').get()!.total;
    await expect(createRental(first, { days: 7 })).rejects.toThrow('Semua nominal unik');
    expect(creation).toHaveBeenCalledTimes(3);
    expect(db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM rentals').get()!.total).toBe(rentalCount);
  } finally { creation.mockRestore(); }
});

test('webhook validation rejects private, mapped, metadata, and non-HTTPS targets', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2002:7f00:1::']) {
    expect(isPublicAddress(address)).toBe(false);
  }
  expect(isPublicAddress('1.1.1.1')).toBe(true);
  expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  await expect(validateWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow('IP publik');
  await expect(validateWebhookUrl('http://example.com/hook')).rejects.toThrow('HTTPS publik');
});

test('production API misses return JSON 404 rather than the frontend HTML', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const apiMiss = await app.handle(new Request('http://localhost/api/does-not-exist'));
    expect(apiMiss.status).toBe(404);
    expect(apiMiss.headers.get('content-type')).toContain('application/json');
    const keyApiMiss = await app.handle(new Request('http://localhost/v1/does-not-exist'));
    expect(keyApiMiss.status).toBe(404);
    expect(keyApiMiss.headers.get('content-type')).toContain('application/json');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

describe('free production invoice allowance', () => {
  test('concurrent creations share five account slots across providers and wallets, and replays cost nothing', async () => {
    const userId = merchant('Free merchant', null);
    const wallets = [connection(userId, 'gopay', true), connection(userId, 'gopay', true), connection(userId, 'shopeepay', true)];
    const user = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(userId)!;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const creation = spyOn(providers, 'createPayment').mockImplementation(async () => {
      await pending;
      return { reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString() };
    });
    try {
      const inputs = Array.from({ length: 8 }, (_, index) => ({
        amount: 10000, description: `Order ${index}`, external_id: `order-${index}`, connection_id: wallets[index % wallets.length],
      }));
      const requests = inputs.map(input => createMerchantInvoice(userId, input, 'production'));
      const settled = Promise.allSettled(requests);
      const replay = createMerchantInvoice(userId, inputs[0]!, 'production');
      expect(accessPublic(user, 'production').daily_remaining).toBe(0);
      release();
      const outcomes = await settled;
      const created = outcomes.filter((outcome): outcome is PromiseFulfilledResult<InvoiceRow> => outcome.status === 'fulfilled').map(outcome => outcome.value);
      expect(created).toHaveLength(5);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(3);
      expect(new Set(created.map(payment => payment.id)).size).toBe(5);
      expect((await replay).id).toBe(created[0]!.id);
      expect((await createMerchantInvoice(userId, inputs[0]!, 'production')).id).toBe(created[0]!.id);
      expect(creation).toHaveBeenCalledTimes(5);
      recordPaid(created[0]!.id, proof(created[0]!.payable_amount, 'free-payment'));
      const cancelled = cancelInvoice(userId, created[1]!.id, 'production');
      expect(invoicePublic(cancelled).qr_code).toBeNull();
      expect(invoicePublic(cancelled).payment_warning).toContain('tidak membatalkan');
      db.query('UPDATE invoices SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1).toISOString(), created[2]!.id);
      expireInvoices();
      expect(accessPublic(user, 'production').daily_used).toBe(5);
      await expect(createMerchantInvoice(userId, { ...inputs[0], external_id: 'sixth-success' }, 'production')).rejects.toThrow('Batas gratis');
    } finally { release(); creation.mockRestore(); }
  });

  test('an upstream creation failure releases its reservation, not a successful cancellation', async () => {
    const userId = merchant('Free merchant', null);
    const wallet = connection(userId, 'gopay', true);
    const user = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(userId)!;
    const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
      reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
    })).mockRejectedValueOnce(new Error('Upstream unavailable'));
    try {
      const input = { amount: 10000, description: 'Order', connection_id: wallet };
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'failed-order' }, 'production')).rejects.toThrow('Upstream unavailable');
      expect(accessPublic(user, 'production').daily_remaining).toBe(5);
      expect(merchantInvoices(userId, 'production')[0]!.status).toBe('failed');
      const created = await Promise.all(Array.from({ length: 5 }, (_, index) =>
        createMerchantInvoice(userId, { ...input, external_id: `successful-${index}` }, 'production')));
      cancelInvoice(userId, created[0]!.id, 'production');
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'overflow' }, 'production')).rejects.toThrow('Batas gratis');
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'failed-order' }, 'production')).rejects.toThrow('external_id ini gagal');
      expect(accessPublic(user, 'production').daily_used).toBe(5);
    } finally { creation.mockRestore(); }
  });

  test('WIB midnight restores five slots and replaying yesterday does not use today', async () => {
    setSystemTime(new Date('2026-10-08T16:59:59.000Z'));
    const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
      reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
    }));
    try {
      const userId = merchant('Midnight merchant', null);
      const user = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(userId)!;
      const input = { amount: 10000, description: 'Midnight order', connection_id: connection(userId, 'gopay', true) };
      const yesterday = await Promise.all(Array.from({ length: 5 }, (_, index) =>
        createMerchantInvoice(userId, { ...input, external_id: `yesterday-${index}` }, 'production')));
      expect(accessPublic(user, 'production').resets_at).toBe('2026-10-08T17:00:00.000Z');
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'before-midnight' }, 'production')).rejects.toThrow('Batas gratis');
      setSystemTime(new Date('2026-10-08T17:00:00.000Z'));
      expect(accessPublic(user, 'production').daily_remaining).toBe(5);
      expect((await createMerchantInvoice(userId, { ...input, external_id: 'yesterday-0' }, 'production')).id).toBe(yesterday[0]!.id);
      expect(accessPublic(user, 'production').daily_used).toBe(0);
      await createMerchantInvoice(userId, { ...input, external_id: 'today' }, 'production');
      expect(accessPublic(user, 'production').daily_remaining).toBe(4);
    } finally { creation.mockRestore(); setSystemTime(); }
  });

  test('active rentals and admins have no creation limit, while expired rentals use free access', async () => {
    const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
      reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
    }));
    try {
      const paid = merchant('Paid');
      const admin = merchant('Admin', null);
      db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin);
      const expired = merchant('Expired', new Date(Date.now() - 1).toISOString());
      for (const userId of [paid, admin]) {
        const wallet = connection(userId, 'gopay', true);
        await Promise.all(Array.from({ length: 7 }, () => createMerchantInvoice(userId, { amount: 10000, description: 'Order', connection_id: wallet }, 'production')));
        const user = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(userId)!;
        expect(accessPublic(user, 'production').daily_limit).toBeNull();
      }
      const input = { amount: 10000, description: 'Expired rental order', connection_id: connection(expired, 'gopay', true) };
      await createMerchantInvoice(expired, input, 'production');
      const user = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(expired)!;
      expect(accessPublic(user, 'production').access_tier).toBe('free');
      expect(accessPublic(user, 'production').daily_remaining).toBe(4);
    } finally { creation.mockRestore(); }
  });
});

describe('production and sandbox isolation', () => {
  test('sandbox invoices use test links without gateway calls, quota charges, claims, or rental activation', async () => {
    const userId = merchant('Free merchant', null);
    const key = apiKey(userId, 'sandbox');
    const user = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(userId)!;
    const creation = spyOn(providers, 'createPayment');
    const checks = spyOn(providers, 'checkPayment');
    try {
      const input = { amount: 10000, description: 'Sandbox order', provider: 'gopay', external_id: 'test-order' };
      const sandbox = await createMerchantInvoice(userId, input, 'sandbox');
      expect(sandbox.connection_id).toBeNull();
      expect(invoicePublic(sandbox).qr_code).toBe(invoicePublic(sandbox).checkout_url);
      expect(invoicePublic(sandbox).qr_code).not.toStartWith('000201');
      expect(invoicePublic(sandbox).payment_warning).toContain('bukan QRIS pembayaran nyata');
      await checkInvoice(sandbox);
      const [first, replay] = await Promise.all([
        Promise.resolve().then(() => simulateInvoice(userId, sandbox.id, 'paid', 'sandbox')),
        Promise.resolve().then(() => simulateInvoice(userId, sandbox.id, 'paid', 'sandbox')),
      ]);
      expect(first.status).toBe('paid');
      expect(replay.paid_at).toBe(first.paid_at);
      expect(first.reference).toStartWith('sandbox:');
      expect(() => simulateInvoice(userId, sandbox.id, 'failed', 'sandbox')).toThrow('sudah selesai');
      expect(() => recordPaid(sandbox.id, proof(sandbox.amount))).toThrow('simulator sandbox');
      expect(accessPublic(user, 'production').daily_used).toBe(0);
      expect(db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM transaction_claim').get()!.total).toBe(0);
      expect(db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(userId)!.subscription_expires_at).toBeNull();
      expect(creation).not.toHaveBeenCalled();
      expect(checks).not.toHaveBeenCalled();
      const response = await app.handle(new Request('http://localhost/v1/invoices', { headers: { 'X-API-Key': key } }));
      expect((await response.json() as { id: string }[]).map(payment => payment.id)).toEqual([sandbox.id]);
      const mismatch = await app.handle(new Request('http://localhost/v1/invoices?environment=production', { headers: { 'X-API-Key': key } }));
      expect(mismatch.status).toBe(400);
      const wrongBody = await app.handle(new Request('http://localhost/v1/invoices', {
        method: 'POST', headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, external_id: 'wrong-body', environment: 'production' }),
      }));
      expect(wrongBody.status).toBe(400);
      expect(merchantInvoices(userId, 'production')).toHaveLength(0);
      await expect(createRental(userId, { days: 7, environment: 'sandbox', payment_reference: 'test' })).rejects.toThrow('tidak dapat dipesan dari sandbox');
    } finally { creation.mockRestore(); checks.mockRestore(); }
  });

  test('environment-specific keys and checkout tokens cannot read or simulate production invoices', async () => {
    const userId = merchant('Merchant', null);
    const production = invoice(userId, connection(userId));
    const sandboxKey = apiKey(userId, 'sandbox');
    const headers = { 'X-API-Key': sandboxKey, 'Content-Type': 'application/json' };
    expect((await app.handle(new Request(`http://localhost/v1/invoices/${production.id}`, { headers }))).status).toBe(404);
    expect(() => ownedInvoice(userId, production.id, 'sandbox')).toThrow('tidak ditemukan');
    expect(() => simulateInvoice(userId, production.id, 'paid', 'production')).toThrow('hanya tersedia di sandbox');
    const response = await app.handle(new Request(`http://localhost/api/checkout/${production.checkout_token}/simulate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'paid' }),
    }));
    expect(response.status).toBe(403);
    expect(checkoutInvoice(production.checkout_token).status).toBe('pending');
    expect(() => recordPaid(production.id, proof(production.amount, 'sandbox:fake'))).toThrow('tidak sesuai');
  });

  test('idempotency is environment-scoped and explicit mismatches cannot create real payments', async () => {
    const userId = merchant('Merchant', null);
    const wallet = connection(userId, 'gopay', true);
    const input = { amount: 10000, description: 'Same order', provider: 'gopay', external_id: 'shared-order', connection_id: wallet };
    const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
      reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
    }));
    try {
      const real = await createMerchantInvoice(userId, input, 'production');
      const sandbox = await createMerchantInvoice(userId, input, 'sandbox');
      expect(real.id).not.toBe(sandbox.id);
      expect(merchantInvoices(userId, 'production').map(payment => payment.id)).toEqual([real.id]);
      expect(merchantInvoices(userId, 'sandbox').map(payment => payment.id)).toEqual([sandbox.id]);
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'wrong-env', environment: 'sandbox' }, 'production')).rejects.toThrow('Environment invoice');
      expect(creation).toHaveBeenCalledTimes(1);
      const other = merchant('Other');
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'foreign-wallet', connection_id: connection(other, 'gopay', true) }, 'production')).rejects.toThrow('Dompet tidak ditemukan');
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'legacy-wallet', connection_id: connection(userId) }, 'production')).rejects.toThrow('dompet terkelola');
    } finally { creation.mockRestore(); }
  });

  test('simulations and retries use only their environment webhook and queue each transition once', async () => {
    const userId = merchant('Merchant', null);
    const production = invoice(userId, connection(userId));
    for (const environment of ['production', 'sandbox'] as const) {
      db.query('INSERT INTO webhooks(user_id, environment, url, encrypted_secret) VALUES (?, ?, ?, ?)')
        .run(userId, environment, `https://example.com/${environment}`, encrypt(`${environment}-secret`));
    }
    const sandbox = await createMerchantInvoice(userId, { amount: 10000, description: 'Test', provider: 'gopay' }, 'sandbox');
    const failed = await createMerchantInvoice(userId, { amount: 10000, description: 'Failed test', provider: 'shopeepay' }, 'sandbox');
    simulateInvoice(userId, sandbox.id, 'paid', 'sandbox');
    simulateInvoice(userId, sandbox.id, 'paid', 'sandbox');
    simulateInvoice(userId, failed.id, 'failed', 'sandbox');
    simulateInvoice(userId, failed.id, 'failed', 'sandbox');
    recordPaid(production.id, proof(production.amount));
    const sandboxDeliveries = webhookData(userId, 'sandbox').deliveries;
    const productionDeliveries = webhookData(userId, 'production').deliveries;
    expect(sandboxDeliveries).toHaveLength(2);
    expect(productionDeliveries).toHaveLength(1);
    expect(() => retryWebhook(userId, sandboxDeliveries[0]!.id, 'production')).toThrow('Pengiriman webhook tidak ditemukan');
    const persisted = db.query<{ environment: Environment; payload: string; url: string }, []>('SELECT environment, payload, url FROM webhook_deliveries').all();
    for (const event of persisted) {
      expect(JSON.parse(event.payload).data.environment).toBe(event.environment);
      expect(event.url).toBe(`https://example.com/${event.environment}`);
    }
    deleteWebhook(userId, 'sandbox');
    expect(webhookData(userId, 'production').configured).toBe(true);
    expect(() => retryWebhook(userId, sandboxDeliveries[0]!.id, 'sandbox')).toThrow('Aktifkan webhook');
  });
});

test('selected managed operator rentals remain production and require a real payment claim', async () => {
  const admin = merchant('Operator');
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin);
  const operator = connection(admin, 'gopay', true);
  db.query("UPDATE connections SET kind = 'operator' WHERE id = ?").run(operator);
  db.exec('UPDATE plans SET price = 10000');
  const user = merchant('Free tenant', null);
  const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
    reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
  }));
  try {
    expect(rentalPaymentMode()).toBe('automatic');
    const request = await createRental(user, { days: 7 });
    const payment = db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE rental_id = ?').get(request.id)!;
    expect(payment.environment).toBe('production');
    expect(payment.connection_id).toBe(operator);
    expect(() => simulateInvoice(user, payment.id, 'paid', 'sandbox')).toThrow('Invoice tidak ditemukan');
    expect(() => activateRental(request.id)).toThrow('belum diverifikasi');
    recordPaid(payment.id, proof(payment.payable_amount, 'real-rental-payment'));
    recordPaid(payment.id, proof(payment.payable_amount, 'real-rental-payment'));
    expect(db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = ?').get(request.id)!.status).toBe('active');
    const account = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(user)!;
    expect(accessPublic(account, 'production').access_tier).toBe('paid');
    expect(accessPublic(account, 'production').daily_used).toBe(0);
  } finally { creation.mockRestore(); }
});

test('cancellation releases the wallet nominal without undoing payments or charging a replay', async () => {
  const user = merchant('Paid merchant');
  const wallet = connection(user, 'gopay', true);
  const input = { amount: 10000, description: 'Order', connection_id: wallet };
  const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
    reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
  }));
  try {
    const first = await createMerchantInvoice(user, { ...input, external_id: 'cancelled-order' }, 'production');
    const second = await createMerchantInvoice(user, input, 'production');
    expect(second.payable_amount).toBe(first.payable_amount + 1);
    cancelInvoice(user, first.id, 'production');
    expect(cancelInvoice(user, first.id, 'production').status).toBe('cancelled');
    expect(checkoutInvoice(first.checkout_token).status).toBe('cancelled');
    expect(recordPaid(first.id, proof(first.payable_amount)).status).toBe('cancelled');
    const third = await createMerchantInvoice(user, input, 'production');
    expect(third.payable_amount).toBe(first.payable_amount);
    recordPaid(second.id, proof(second.payable_amount, 'second-payment'));
    expect(() => cancelInvoice(user, second.id, 'production')).toThrow('Hanya invoice');
    expect((await createMerchantInvoice(user, { ...input, external_id: 'cancelled-order' }, 'production')).id).toBe(first.id);
    expect(creation).toHaveBeenCalledTimes(3);
  } finally { creation.mockRestore(); }
});

test('legacy operator settings cannot create new rental invoices but existing payments still reconcile', async () => {
  process.env.OPERATOR_GATEWAY_PROVIDER = 'gopay';
  process.env.OPERATOR_GATEWAY_URL = 'http://localhost:3000';
  process.env.OPERATOR_GATEWAY_API_KEY = 'legacy-secret';
  db.exec('UPDATE plans SET price = 10000');
  const user = merchant('Legacy tenant', null);
  const operator = connection(user);
  db.query("UPDATE connections SET kind = 'operator' WHERE id = ?").run(operator);
  const existingRental = rental(user);
  const oldInvoice = invoice(user, operator, 10000, existingRental);
  const creation = spyOn(providers, 'createPayment');
  try {
    const manual = await createRental(user, { days: 7, payment_reference: 'manual-bank-reference' });
    expect(manual.status).toBe('requested');
    expect(db.query('SELECT id FROM invoices WHERE rental_id = ?').get(manual.id)).toBeNull();
    expect(creation).not.toHaveBeenCalled();
    recordPaid(oldInvoice.id, proof(oldInvoice.payable_amount, 'legacy-payment'));
    expect(db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = ?').get(existingRental)!.status).toBe('active');
  } finally { creation.mockRestore(); }
});
