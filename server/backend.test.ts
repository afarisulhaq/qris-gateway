import { afterAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import type { Environment, InvoiceRow, UserRow } from './db';

const originalEnvironment = { ...process.env };
if (process.env.QRIS_TEST_DATABASE !== '1') throw new Error('Jalankan bun run test dengan TEST_DATABASE_URL.');
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.APP_URL = 'http://localhost:3100';
process.env.NODE_ENV = 'test';
// Test runner supplies a fresh PostgreSQL database before importing the application.
const { db, id, now } = await import('./db');
const {
  recordPaid, activateRental, createRental, createMerchantInvoice, accessPublic, cancelInvoice, simulateInvoice,
  merchantInvoices, ownedInvoice, checkoutInvoice, invoicePublic, checkInvoice, expireInvoices, rentalPaymentMode,
} = await import('./domain');
const { encrypt, hashSecret, newSecret } = await import('./security');
const { isPublicAddress, validateWebhookUrl, webhookData, retryWebhook, deleteWebhook } = await import('./webhooks');
const providers = await import('./providers');
const { app } = await import('./index');

beforeEach(async () => {
  for (const table of ['admin_audit', 'webhook_deliveries', 'webhooks', 'transaction_claim', 'invoices', 'rentals', 'api_keys', 'sessions', 'connections', 'users']) {
    await db.exec(`DELETE FROM ${table}`);
  }
  await db.exec('UPDATE plans SET price = NULL');
  delete process.env.OPERATOR_GATEWAY_PROVIDER;
  delete process.env.OPERATOR_GATEWAY_URL;
  delete process.env.OPERATOR_GATEWAY_API_KEY;
  delete process.env.OPERATOR_GATEWAY_SHOPEE_TOKEN;
});

afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  await db.close();
});

async function merchant(name = 'Merchant', subscriptionExpiresAt: string | null = new Date(Date.now() + 86400_000).toISOString()) {
  const userId = id();
  await db.query("INSERT INTO users(id, name, email, password_hash, role, created_at, subscription_expires_at) VALUES ($1, $2, $3, 'unused-test-hash', 'merchant', $4, $5)")
    .run(userId, name, `${userId}@example.test`, now(), subscriptionExpiresAt);
  return userId;
}

async function connection(userId: string, providerName: 'gopay' | 'shopeepay' = 'gopay', managed = false) {
  const connectionId = id();
  await db.query('INSERT INTO connections(id, user_id, provider, base_url, encrypted_secrets, label, managed) VALUES ($1, $2, $3, $4, $5, $6, $7)')
    .run(connectionId, userId, providerName, 'http://localhost:3000', encrypt(JSON.stringify({ api_key: 'gateway-test-secret' })), `${providerName} wallet`, managed ? 1 : 0);
  return connectionId;
}

async function invoice(userId: string, connectionId: string, amount = 10000, rentalId: string | null = null): Promise<InvoiceRow> {
  const invoiceId = id();
  await db.query(`INSERT INTO invoices(id, user_id, connection_id, rental_id, description, amount, payable_amount, provider,
    status, creation_state, reference, created_at, expires_at, checkout_token)
    VALUES ($1, $2, $3, $4, 'Test invoice', $5, $6, 'gopay', 'pending', 'ready', 'test-reference', $7, $8, $9)`)
    .run(invoiceId, userId, connectionId, rentalId, amount, amount, new Date(Date.now() - 1000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(), newSecret());
  return (await db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = $1').get(invoiceId))!;
}

async function rental(userId: string, status = 'pending') {
  const rentalId = id();
  await db.query('INSERT INTO rentals(id, user_id, days, price, status, created_at, payment_reference) VALUES ($1, $2, 7, 10000, $3, $4, $5)')
    .run(rentalId, userId, status, now(), status === 'requested' ? 'manual-reference' : null);
  return rentalId;
}

function proof(amount: number, transactionId = 'transaction-1') {
  return { amount, transaction_id: transactionId, paid_at: now() };
}

async function apiKey(userId: string, environment: Environment = 'production') {
  const key = `qris_${newSecret()}`;
  await db.query('INSERT INTO api_keys(id, user_id, environment, label, prefix, key_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)')
    .run(id(), userId, environment, 'Test key', key.slice(0, 13), hashSecret(key), now());
  return key;
}

describe('durable payment claims and subscriptions', () => {
  test('one transaction cannot pay a second invoice on the same connection', async () => {
    const user = await merchant();
    const gateway = await connection(user);
    const first = await invoice(user, gateway);
    await recordPaid(first.id, proof(first.payable_amount));
    const second = await invoice(user, gateway);
    await expect((async () => await recordPaid(second.id, proof(second.payable_amount)))()).rejects.toThrow('sudah digunakan');
    expect((await db.query<{ status: string }, [string]>('SELECT status FROM invoices WHERE id = $1').get(second.id))?.status).toBe('pending');
    expect((await db.query<{ total: number }, []>('SELECT COUNT(*)::integer AS total FROM transaction_claim').get())?.total).toBe(1);
  });

  test('transaction IDs are scoped to the gateway connection', async () => {
    const firstUser = await merchant();
    const secondUser = await merchant();
    const first = await invoice(firstUser, await connection(firstUser));
    const second = await invoice(secondUser, await connection(secondUser));
    expect((await recordPaid(first.id, proof(first.amount))).status).toBe('paid');
    expect((await recordPaid(second.id, proof(second.amount))).status).toBe('paid');
  });

  test('rental payment and replay activate and extend only once', async () => {
    const user = await merchant();
    const rentalId = await rental(user);
    const payment = await invoice(user, await connection(user), 10000, rentalId);
    const before = (await db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = $1').get(user))!.subscription_expires_at;
    await recordPaid(payment.id, proof(payment.amount));
    const after = (await db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = $1').get(user))!.subscription_expires_at;
    await recordPaid(payment.id, proof(payment.amount));
    expect(await activateRental(rentalId)).toBe(false);
    expect(new Date(after).getTime() - new Date(before).getTime()).toBe(7 * 86400_000);
    expect((await db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = $1').get(user))!.subscription_expires_at).toBe(after);
  });

  test('a reused gateway claim cannot activate a second rental', async () => {
    const user = await merchant();
    const gateway = await connection(user);
    const first = await invoice(user, gateway);
    await recordPaid(first.id, proof(first.amount));
    const rentalId = await rental(user);
    const payment = await invoice(user, gateway, first.amount, rentalId);
    const expiry = (await db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = $1').get(user))!.subscription_expires_at;
    await expect((async () => await recordPaid(payment.id, proof(payment.amount)))()).rejects.toThrow('sudah digunakan');
    await expect((async () => await activateRental(rentalId))()).rejects.toThrow('belum diverifikasi');
    expect((await db.query<{ status: string }, [string]>('SELECT status FROM invoices WHERE id = $1').get(payment.id))?.status).toBe('pending');
    expect((await db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = $1').get(rentalId))?.status).toBe('pending');
    expect((await db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = $1').get(user))!.subscription_expires_at).toBe(expiry);
  });

  test('manual approval is idempotent and rejected rentals cannot activate', async () => {
    const user = await merchant();
    const request = await rental(user, 'requested');
    expect(await activateRental(request)).toBe(true);
    const expiry = (await db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = $1').get(user))!.subscription_expires_at;
    expect(await activateRental(request)).toBe(false);
    expect((await db.query<{ subscription_expires_at: string }, [string]>('SELECT subscription_expires_at FROM users WHERE id = $1').get(user))!.subscription_expires_at).toBe(expiry);
    await expect((async () => await activateRental(await rental(user, 'rejected')))()).rejects.toThrow('ditolak');
  });

  test('invalid or expired proof does not create a claim or extend a rental', async () => {
    const user = await merchant();
    const rentalId = await rental(user);
    const payment = await invoice(user, await connection(user), 10000, rentalId);
    await expect((async () => await recordPaid(payment.id, proof(9999)))()).rejects.toThrow('tidak sesuai');
    await db.query('UPDATE invoices SET expires_at = $1 WHERE id = $2').run(new Date(Date.now() - 1).toISOString(), payment.id);
    await expireInvoices();
    await expect((async () => await recordPaid(payment.id, proof(payment.amount)))()).rejects.toThrow();
    expect((await db.query<{ status: string }, [string]>('SELECT status FROM invoices WHERE id = $1').get(payment.id))?.status).toBe('expired');
    expect((await db.query<{ total: number }, []>('SELECT COUNT(*)::integer AS total FROM transaction_claim').get())?.total).toBe(0);
    expect((await db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = $1').get(rentalId))?.status).not.toBe('active');
  });

  test('verification after expiry accepts an on-time receipt and activates its automatic rental only once', async () => {
    const start = Date.parse('2026-10-08T10:39:44.000Z');
    setSystemTime(start);
    const checks = spyOn(providers, 'checkPayment');
    try {
      const user = await merchant();
      const rentalId = await rental(user);
      const payment = await invoice(user, await connection(user), 1000, rentalId);
      const before = (await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(user))!.subscription_expires_at!;
      const receipt = { paid: true, transaction_id: 'on-time-receipt', amount: 1000, paid_at: new Date(start + 10000).toISOString() };
      checks.mockResolvedValue(receipt);
      setSystemTime(start + 120000);
      await expireInvoices();
      expect((await db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = $1').get(rentalId))?.status).toBe('rejected');
      const [first, concurrent] = await Promise.all([await checkInvoice(payment), await checkInvoice(payment)]);
      expect(first.status).toBe('paid');
      expect(concurrent.paid_at).toBe(receipt.paid_at);
      expect((await db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = $1').get(rentalId))?.status).toBe('active');
      const after = (await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(user))!.subscription_expires_at!;
      expect(Date.parse(after) - Date.parse(before)).toBe(7 * 86400_000);
      await recordPaid(payment.id, receipt);
      expect((await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(user))!.subscription_expires_at).toBe(after);
      expect((await db.query<{ total: number }, []>('SELECT COUNT(*)::integer AS total FROM transaction_claim').get())?.total).toBe(1);
    } finally {
      checks.mockRestore();
      setSystemTime();
    }
  });

  test('late receipts and cancelled invoices cannot be reconciled into paid invoices', async () => {
    const start = Date.parse('2026-10-08T10:39:44.000Z');
    setSystemTime(start);
    try {
      const user = await merchant();
      const gateway = await connection(user);
      const expired = await invoice(user, gateway);
      const cancelled = await invoice(user, gateway, 11000);
      await cancelInvoice(user, cancelled.id, 'production');
      setSystemTime(start + 120000);
      await expireInvoices();
      const late = { transaction_id: 'late-receipt', amount: expired.payable_amount, paid_at: new Date(start + 61000).toISOString() };
      await expect((async () => await recordPaid(expired.id, late))()).rejects.toThrow();
      const onTime = { ...late, amount: cancelled.payable_amount, paid_at: new Date(start + 10000).toISOString() };
      expect((await recordPaid(cancelled.id, onTime)).status).toBe('cancelled');
      expect((await db.query<{ status: string }, [string]>('SELECT status FROM invoices WHERE id = $1').get(expired.id))?.status).toBe('expired');
      expect((await db.query<{ total: number }, []>('SELECT COUNT(*)::integer AS total FROM transaction_claim').get())?.total).toBe(0);
    } finally { setSystemTime(); }
  });

  test('a paid event is durably queued once with an exact, credential-free body', async () => {
    const user = await merchant();
    const payment = await invoice(user, await connection(user));
    await db.query('INSERT INTO webhooks(user_id, url, encrypted_secret) VALUES ($1, $2, $3)')
      .run(user, 'https://example.com/hook', encrypt('test-signing-secret'));
    await recordPaid(payment.id, proof(payment.amount));
    await recordPaid(payment.id, proof(payment.amount));
    const deliveries = await db.query<{ payload: string; id: string }, []>('SELECT id, payload FROM webhook_deliveries').all();
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
    const first = await merchant('First');
    const second = await merchant('Second');
    const payment = await invoice(first, await connection(first));
    const key = await apiKey(second);
    const headers = { 'X-API-Key': key, 'Content-Type': 'application/json' };
    const list = await app.handle(new Request('http://localhost/v1/invoices', { headers }));
    expect(await list.json()).toEqual([]);
    expect((await app.handle(new Request(`http://localhost/v1/invoices/${payment.id}`, { headers }))).status).toBe(404);
    expect((await app.handle(new Request(`http://localhost/v1/invoices/${payment.id}/check`, { method: 'POST', headers, body: '{}' }))).status).toBe(404);
  });

  test('API keys do not authenticate cookie routes but free accounts can read v1', async () => {
    const user = await merchant();
    const key = await apiKey(user);
    expect((await app.handle(new Request('http://localhost/api/me', { headers: { 'X-API-Key': key } }))).status).toBe(401);
    await db.query('UPDATE users SET subscription_expires_at = NULL WHERE id = $1').run(user);
    expect((await app.handle(new Request('http://localhost/v1/invoices', { headers: { 'X-API-Key': key } }))).status).toBe(200);
  });

  test('checkout exposes no merchant email or gateway API key', async () => {
    const user = await merchant();
    const payment = await invoice(user, await connection(user));
    const response = await app.handle(new Request(`http://localhost/api/checkout/${payment.checkout_token}`));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain('@example.test');
    expect(body).not.toContain('gateway-test-secret');
    expect(body).not.toContain('encrypted_secrets');
  });
});

test('automatic operator rentals share nominal reservations and external IDs coalesce merchant creation', async () => {
  const admin = await merchant('Operator');
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1").run(admin);
  const operator = await connection(admin, 'gopay', true);
  await db.query("UPDATE connections SET kind = 'operator' WHERE id = $1").run(operator);
  const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
    reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
  }));
  try {
    await db.exec('UPDATE plans SET price = 10000');
    const first = await merchant();
    const second = await merchant();
    await Promise.all([createRental(first, { days: 7 }), createRental(second, { days: 7 })]);
    const payments = await db.query<{ payable_amount: number; connection_id: string }, []>('SELECT payable_amount, connection_id FROM invoices ORDER BY payable_amount').all();
    expect(payments.map(payment => payment.payable_amount)).toEqual([10000, 10001]);
    expect(payments[0]!.connection_id).toBe(payments[1]!.connection_id);
    const wallet = await connection(first, 'gopay', true);
    const input = { amount: 50000, description: 'Same merchant order', connection_id: wallet, provider: 'gopay', external_id: 'order-1' };
    const [a, b] = await Promise.all([createMerchantInvoice(first, input, 'production'), createMerchantInvoice(first, input, 'production')]);
    expect(a.id).toBe(b.id);
    expect(creation).toHaveBeenCalledTimes(3);
    for (let offset = 2; offset < 100; offset++) await invoice(first, payments[0]!.connection_id, 10000 + offset);
    const rentalCount = (await db.query<{ total: number }, []>('SELECT COUNT(*)::integer AS total FROM rentals').get())!.total;
    await expect(createRental(first, { days: 7 })).rejects.toThrow('Semua nominal unik');
    expect(creation).toHaveBeenCalledTimes(3);
    expect((await db.query<{ total: number }, []>('SELECT COUNT(*)::integer AS total FROM rentals').get())!.total).toBe(rentalCount);
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
    const userId = await merchant('Free merchant', null);
    const wallets = [await connection(userId, 'gopay', true), await connection(userId, 'gopay', true), await connection(userId, 'shopeepay', true)];
    const user = (await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(userId))!;
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
      const requests = inputs.map(async input => await createMerchantInvoice(userId, input, 'production'));
      const settled = Promise.allSettled(requests);
      const replay = createMerchantInvoice(userId, inputs[0]!, 'production');
      for (let attempt = 0; attempt < 100 && (await accessPublic(user, 'production')).daily_used < 5; attempt++) await Bun.sleep(5);
      expect((await accessPublic(user, 'production')).daily_remaining).toBe(0);
      release();
      const outcomes = await settled;
      const created = outcomes.filter((outcome): outcome is PromiseFulfilledResult<InvoiceRow> => outcome.status === 'fulfilled').map(outcome => outcome.value);
      expect(created).toHaveLength(5);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(3);
      expect(new Set(created.map(payment => payment.id)).size).toBe(5);
      expect((await replay).id).toBe(created[0]!.id);
      expect((await createMerchantInvoice(userId, inputs[0]!, 'production')).id).toBe(created[0]!.id);
      expect(creation).toHaveBeenCalledTimes(5);
      await recordPaid(created[0]!.id, proof(created[0]!.payable_amount, 'free-payment'));
      const cancelled = await cancelInvoice(userId, created[1]!.id, 'production');
      expect((await invoicePublic(cancelled)).qr_code).toBeNull();
      expect((await invoicePublic(cancelled)).payment_warning).toContain('tidak membatalkan');
      await db.query('UPDATE invoices SET expires_at = $1 WHERE id = $2').run(new Date(Date.now() - 1).toISOString(), created[2]!.id);
      await expireInvoices();
      expect((await accessPublic(user, 'production')).daily_used).toBe(5);
      await expect(createMerchantInvoice(userId, { ...inputs[0], external_id: 'sixth-success' }, 'production')).rejects.toThrow('Batas gratis');
    } finally { release(); creation.mockRestore(); }
  });

  test('an upstream creation failure releases its reservation, not a successful cancellation', async () => {
    const userId = await merchant('Free merchant', null);
    const wallet = await connection(userId, 'gopay', true);
    const user = (await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(userId))!;
    const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
      reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
    })).mockRejectedValueOnce(new Error('Upstream unavailable'));
    try {
      const input = { amount: 10000, description: 'Order', connection_id: wallet };
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'failed-order' }, 'production')).rejects.toThrow('Upstream unavailable');
      expect((await accessPublic(user, 'production')).daily_remaining).toBe(5);
      expect((await merchantInvoices(userId, 'production'))[0]!.status).toBe('failed');
      const created = await Promise.all(Array.from({ length: 5 }, async (_, index) =>
        await createMerchantInvoice(userId, { ...input, external_id: `successful-${index}` }, 'production')));
      await cancelInvoice(userId, created[0]!.id, 'production');
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'overflow' }, 'production')).rejects.toThrow('Batas gratis');
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'failed-order' }, 'production')).rejects.toThrow('external_id ini gagal');
      expect((await accessPublic(user, 'production')).daily_used).toBe(5);
    } finally { creation.mockRestore(); }
  });

  test('WIB midnight restores five slots and replaying yesterday does not use today', async () => {
    setSystemTime(new Date('2026-10-08T16:59:59.000Z'));
    const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
      reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
    }));
    try {
      const userId = await merchant('Midnight merchant', null);
      const user = (await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(userId))!;
      const input = { amount: 10000, description: 'Midnight order', connection_id: await connection(userId, 'gopay', true) };
      const yesterday = await Promise.all(Array.from({ length: 5 }, async (_, index) =>
        await createMerchantInvoice(userId, { ...input, external_id: `yesterday-${index}` }, 'production')));
      expect((await accessPublic(user, 'production')).resets_at).toBe('2026-10-08T17:00:00.000Z');
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'before-midnight' }, 'production')).rejects.toThrow('Batas gratis');
      setSystemTime(new Date('2026-10-08T17:00:00.000Z'));
      expect((await accessPublic(user, 'production')).daily_remaining).toBe(5);
      expect((await createMerchantInvoice(userId, { ...input, external_id: 'yesterday-0' }, 'production')).id).toBe(yesterday[0]!.id);
      expect((await accessPublic(user, 'production')).daily_used).toBe(0);
      await createMerchantInvoice(userId, { ...input, external_id: 'today' }, 'production');
      expect((await accessPublic(user, 'production')).daily_remaining).toBe(4);
    } finally { creation.mockRestore(); setSystemTime(); }
  });

  test('active rentals and admins have no creation limit, while expired rentals use free access', async () => {
    const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
      reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
    }));
    try {
      const paid = await merchant('Paid');
      const admin = await merchant('Admin', null);
      await db.query("UPDATE users SET role = 'admin' WHERE id = $1").run(admin);
      const expired = await merchant('Expired', new Date(Date.now() - 1).toISOString());
      for (const userId of [paid, admin]) {
        const wallet = await connection(userId, 'gopay', true);
        await Promise.all(Array.from({ length: 7 }, async () => await createMerchantInvoice(userId, { amount: 10000, description: 'Order', connection_id: wallet }, 'production')));
        const user = (await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(userId))!;
        expect((await accessPublic(user, 'production')).daily_limit).toBeNull();
      }
      const input = { amount: 10000, description: 'Expired rental order', connection_id: await connection(expired, 'gopay', true) };
      await createMerchantInvoice(expired, input, 'production');
      const user = (await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(expired))!;
      expect((await accessPublic(user, 'production')).access_tier).toBe('free');
      expect((await accessPublic(user, 'production')).daily_remaining).toBe(4);
    } finally { creation.mockRestore(); }
  });
});

describe('production and sandbox isolation', () => {
  test('sandbox invoices use test links without gateway calls, quota charges, claims, or rental activation', async () => {
    const userId = await merchant('Free merchant', null);
    const key = await apiKey(userId, 'sandbox');
    const user = (await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(userId))!;
    const creation = spyOn(providers, 'createPayment');
    const checks = spyOn(providers, 'checkPayment');
    try {
      const input = { amount: 10000, description: 'Sandbox order', provider: 'gopay', external_id: 'test-order' };
      const sandbox = await createMerchantInvoice(userId, input, 'sandbox');
      expect(sandbox.connection_id).toBeNull();
      expect((await invoicePublic(sandbox)).qr_code).toBe((await invoicePublic(sandbox)).checkout_url);
      expect((await invoicePublic(sandbox)).qr_code).not.toStartWith('000201');
      expect((await invoicePublic(sandbox)).payment_warning).toContain('bukan QRIS pembayaran nyata');
      await checkInvoice(sandbox);
      const [first, replay] = await Promise.all([
        Promise.resolve().then(async () => await simulateInvoice(userId, sandbox.id, 'paid', 'sandbox')),
        Promise.resolve().then(async () => await simulateInvoice(userId, sandbox.id, 'paid', 'sandbox')),
      ]);
      expect(first.status).toBe('paid');
      expect(replay.paid_at).toBe(first.paid_at);
      expect(first.reference).toStartWith('sandbox:');
      await expect((async () => await simulateInvoice(userId, sandbox.id, 'failed', 'sandbox'))()).rejects.toThrow('sudah selesai');
      await expect((async () => await recordPaid(sandbox.id, proof(sandbox.amount)))()).rejects.toThrow('simulator sandbox');
      expect((await accessPublic(user, 'production')).daily_used).toBe(0);
      expect((await db.query<{ total: number }, []>('SELECT COUNT(*)::integer AS total FROM transaction_claim').get())!.total).toBe(0);
      expect((await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(userId))!.subscription_expires_at).toBeNull();
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
      expect(await merchantInvoices(userId, 'production')).toHaveLength(0);
      await expect(createRental(userId, { days: 7, environment: 'sandbox', payment_reference: 'test' })).rejects.toThrow('tidak dapat dipesan dari sandbox');
    } finally { creation.mockRestore(); checks.mockRestore(); }
  });

  test('environment-specific keys and checkout tokens cannot read or simulate production invoices', async () => {
    const userId = await merchant('Merchant', null);
    const production = await invoice(userId, await connection(userId));
    const sandboxKey = await apiKey(userId, 'sandbox');
    const headers = { 'X-API-Key': sandboxKey, 'Content-Type': 'application/json' };
    expect((await app.handle(new Request(`http://localhost/v1/invoices/${production.id}`, { headers }))).status).toBe(404);
    await expect((async () => await ownedInvoice(userId, production.id, 'sandbox'))()).rejects.toThrow('tidak ditemukan');
    await expect((async () => await simulateInvoice(userId, production.id, 'paid', 'production'))()).rejects.toThrow('hanya tersedia di sandbox');
    const response = await app.handle(new Request(`http://localhost/api/checkout/${production.checkout_token}/simulate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'paid' }),
    }));
    expect(response.status).toBe(403);
    expect((await checkoutInvoice(production.checkout_token)).status).toBe('pending');
    await expect((async () => await recordPaid(production.id, proof(production.amount, 'sandbox:fake')))()).rejects.toThrow('tidak sesuai');
  });

  test('idempotency is environment-scoped and explicit mismatches cannot create real payments', async () => {
    const userId = await merchant('Merchant', null);
    const wallet = await connection(userId, 'gopay', true);
    const input = { amount: 10000, description: 'Same order', provider: 'gopay', external_id: 'shared-order', connection_id: wallet };
    const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
      reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
    }));
    try {
      const real = await createMerchantInvoice(userId, input, 'production');
      const sandbox = await createMerchantInvoice(userId, input, 'sandbox');
      expect(real.id).not.toBe(sandbox.id);
      expect((await merchantInvoices(userId, 'production')).map(payment => payment.id)).toEqual([real.id]);
      expect((await merchantInvoices(userId, 'sandbox')).map(payment => payment.id)).toEqual([sandbox.id]);
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'wrong-env', environment: 'sandbox' }, 'production')).rejects.toThrow('Environment invoice');
      expect(creation).toHaveBeenCalledTimes(1);
      const other = await merchant('Other');
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'foreign-wallet', connection_id: await connection(other, 'gopay', true) }, 'production')).rejects.toThrow('Dompet tidak ditemukan');
      await expect(createMerchantInvoice(userId, { ...input, external_id: 'legacy-wallet', connection_id: await connection(userId) }, 'production')).rejects.toThrow('dompet terkelola');
    } finally { creation.mockRestore(); }
  });

  test('simulations and retries use only their environment webhook and queue each transition once', async () => {
    const userId = await merchant('Merchant', null);
    const production = await invoice(userId, await connection(userId));
    for (const environment of ['production', 'sandbox'] as const) {
      await db.query('INSERT INTO webhooks(user_id, environment, url, encrypted_secret) VALUES ($1, $2, $3, $4)')
        .run(userId, environment, `https://example.com/${environment}`, encrypt(`${environment}-secret`));
    }
    const sandbox = await createMerchantInvoice(userId, { amount: 10000, description: 'Test', provider: 'gopay' }, 'sandbox');
    const failed = await createMerchantInvoice(userId, { amount: 10000, description: 'Failed test', provider: 'shopeepay' }, 'sandbox');
    await simulateInvoice(userId, sandbox.id, 'paid', 'sandbox');
    await simulateInvoice(userId, sandbox.id, 'paid', 'sandbox');
    await simulateInvoice(userId, failed.id, 'failed', 'sandbox');
    await simulateInvoice(userId, failed.id, 'failed', 'sandbox');
    await recordPaid(production.id, proof(production.amount));
    const sandboxDeliveries = (await webhookData(userId, 'sandbox')).deliveries;
    const productionDeliveries = (await webhookData(userId, 'production')).deliveries;
    expect(sandboxDeliveries).toHaveLength(2);
    expect(productionDeliveries).toHaveLength(1);
    await expect((async () => await retryWebhook(userId, sandboxDeliveries[0]!.id, 'production'))()).rejects.toThrow('Pengiriman webhook tidak ditemukan');
    const persisted = await db.query<{ environment: Environment; payload: string; url: string }, []>('SELECT environment, payload, url FROM webhook_deliveries').all();
    for (const event of persisted) {
      expect(JSON.parse(event.payload).data.environment).toBe(event.environment);
      expect(event.url).toBe(`https://example.com/${event.environment}`);
    }
    await deleteWebhook(userId, 'sandbox');
    expect((await webhookData(userId, 'production')).configured).toBe(true);
    await expect((async () => await retryWebhook(userId, sandboxDeliveries[0]!.id, 'sandbox'))()).rejects.toThrow('Aktifkan webhook');
  });
});

test('selected managed operator rentals remain production and require a real payment claim', async () => {
  const admin = await merchant('Operator');
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1").run(admin);
  const operator = await connection(admin, 'gopay', true);
  await db.query("UPDATE connections SET kind = 'operator' WHERE id = $1").run(operator);
  await db.exec('UPDATE plans SET price = 10000');
  const user = await merchant('Free tenant', null);
  const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
    reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
  }));
  try {
    expect(await rentalPaymentMode()).toBe('automatic');
    const request = await createRental(user, { days: 7 });
    const payment = (await db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE rental_id = $1').get(request.id))!;
    expect(payment.environment).toBe('production');
    expect(payment.connection_id).toBe(operator);
    await expect((async () => await simulateInvoice(user, payment.id, 'paid', 'sandbox'))()).rejects.toThrow('Invoice tidak ditemukan');
    await expect((async () => await activateRental(request.id))()).rejects.toThrow('belum diverifikasi');
    await recordPaid(payment.id, proof(payment.payable_amount, 'real-rental-payment'));
    await recordPaid(payment.id, proof(payment.payable_amount, 'real-rental-payment'));
    expect((await db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = $1').get(request.id))!.status).toBe('active');
    const account = (await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(user))!;
    expect((await accessPublic(account, 'production')).access_tier).toBe('paid');
    expect((await accessPublic(account, 'production')).daily_used).toBe(0);
  } finally { creation.mockRestore(); }
});

test('cancellation releases the wallet nominal without undoing payments or charging a replay', async () => {
  const user = await merchant('Paid merchant');
  const wallet = await connection(user, 'gopay', true);
  const input = { amount: 10000, description: 'Order', connection_id: wallet };
  const creation = spyOn(providers, 'createPayment').mockImplementation(async () => ({
    reference: id(), qr_code: '000201test-fixture', qr_url: 'http://localhost/qr', expires_at: new Date(Date.now() + 600_000).toISOString(),
  }));
  try {
    const first = await createMerchantInvoice(user, { ...input, external_id: 'cancelled-order' }, 'production');
    const second = await createMerchantInvoice(user, input, 'production');
    expect(second.payable_amount).toBe(first.payable_amount + 1);
    await cancelInvoice(user, first.id, 'production');
    expect((await cancelInvoice(user, first.id, 'production')).status).toBe('cancelled');
    expect((await checkoutInvoice(first.checkout_token)).status).toBe('cancelled');
    expect((await recordPaid(first.id, proof(first.payable_amount))).status).toBe('cancelled');
    const third = await createMerchantInvoice(user, input, 'production');
    expect(third.payable_amount).toBe(first.payable_amount);
    await recordPaid(second.id, proof(second.payable_amount, 'second-payment'));
    await expect((async () => await cancelInvoice(user, second.id, 'production'))()).rejects.toThrow('Hanya invoice');
    expect((await createMerchantInvoice(user, { ...input, external_id: 'cancelled-order' }, 'production')).id).toBe(first.id);
    expect(creation).toHaveBeenCalledTimes(3);
  } finally { creation.mockRestore(); }
});

test('legacy operator settings cannot create new rental invoices but existing payments still reconcile', async () => {
  process.env.OPERATOR_GATEWAY_PROVIDER = 'gopay';
  process.env.OPERATOR_GATEWAY_URL = 'http://localhost:3000';
  process.env.OPERATOR_GATEWAY_API_KEY = 'legacy-secret';
  await db.exec('UPDATE plans SET price = 10000');
  const user = await merchant('Legacy tenant', null);
  const operator = await connection(user);
  await db.query("UPDATE connections SET kind = 'operator' WHERE id = $1").run(operator);
  const existingRental = await rental(user);
  const oldInvoice = await invoice(user, operator, 10000, existingRental);
  const creation = spyOn(providers, 'createPayment');
  try {
    const manual = await createRental(user, { days: 7, payment_reference: 'manual-bank-reference' });
    expect(manual.status).toBe('requested');
    expect(await db.query('SELECT id FROM invoices WHERE rental_id = $1').get(manual.id)).toBeNull();
    expect(creation).not.toHaveBeenCalled();
    await recordPaid(oldInvoice.id, proof(oldInvoice.payable_amount, 'legacy-payment'));
    expect((await db.query<{ status: string }, [string]>('SELECT status FROM rentals WHERE id = $1').get(existingRental))!.status).toBe('active');
  } finally { creation.mockRestore(); }
});
