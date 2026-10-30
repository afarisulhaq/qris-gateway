import { db, atomic, id, now } from './db';
import type { Environment, UserRow, ConnectionRow, InvoiceRow, RentalRow } from './db';
import { BusinessError, decrypt, newSecret, provider, money, duration, text, publicUser } from './security';
import { createPayment, checkPayment } from './providers';
import type { GatewayConnection } from './providers';

export function environmentInput(value: unknown): Environment {
  if (value === undefined) return 'production';
  if (value !== 'production' && value !== 'sandbox') throw new BusinessError(400, 'Environment harus production atau sandbox.');
  return value;
}

function wibDay() {
  const time = Date.now();
  const offset = 7 * 60 * 60_000;
  const start = Math.floor((time + offset) / 86400_000) * 86400_000 - offset;
  return { start: new Date(start).toISOString(), end: new Date(start + 86400_000).toISOString() };
}

export async function accessPublic(user: UserRow, environment: Environment): Promise<{
  environment: Environment; access_tier: 'free' | 'paid' | 'admin' | 'sandbox'; daily_limit: number | null;
  daily_used: number; daily_remaining: number | null; resets_at: string | null;
}> {
  environmentInput(environment);
  const day = wibDay();
  const used = environment === 'production' ? (await db.query<{ total: number }, [string, string, string]>(`
    SELECT COUNT(*)::integer AS total FROM invoices WHERE user_id = $1 AND environment = 'production'
      AND rental_id IS NULL AND creation_state IN ('creating', 'ready') AND created_at >= $2 AND created_at < $3
  `).get(user.id, day.start, day.end))!.total : 0;
  const tier = environment === 'sandbox' ? 'sandbox' : user.role === 'admin' ? 'admin'
    : publicUser(user).subscription_active ? 'paid' : 'free';
  return {
    environment, access_tier: tier, daily_limit: tier === 'free' ? 5 : null, daily_used: used,
    daily_remaining: tier === 'free' ? Math.max(0, 5 - used) : null, resets_at: tier === 'free' ? day.end : null,
  };
}

export function connectionSecret(connection: ConnectionRow): GatewayConnection {
  const secrets = JSON.parse(decrypt(connection.encrypted_secrets)) as { api_key: string; shopee_token?: string };
  return {
    id: connection.id, provider: connection.provider, base_url: connection.base_url,
    api_key: secrets.api_key, shopee_token: secrets.shopee_token, managed: Boolean(connection.managed),
  };
}

export function connectionPublic(connection: ConnectionRow) {
  return {
    id: connection.id, provider: connection.provider, label: connection.label || connection.provider,
    managed: Boolean(connection.managed), active: Boolean(connection.active), configured: Boolean(connection.managed),
  };
}

export async function invoicePublic(invoice: InvoiceRow) {
  const connection = invoice.connection_id
    ? await db.query<{ label: string; provider: string }, [string]>('SELECT label, provider FROM connections WHERE id = $1').get(invoice.connection_id)
    : null;
  return {
    id: invoice.id, external_id: invoice.external_id, description: invoice.description,
    environment: invoice.environment, connection_id: invoice.connection_id,
    connection_label: connection ? connection.label || connection.provider : null,
    amount: invoice.amount, payable_amount: invoice.payable_amount, provider: invoice.provider,
    status: invoice.status, created_at: invoice.created_at, expires_at: invoice.expires_at,
    paid_at: invoice.paid_at,
    checkout_url: `${(process.env.APP_URL || 'http://127.0.0.1:3100').replace(/\/$/, '')}/pay/${invoice.checkout_token}`,
    qr_code: invoice.status === 'pending' ? invoice.qr_code : null,
    qr_url: invoice.status === 'pending' ? invoice.qr_url : null,
    payment_warning: invoice.environment === 'sandbox' ? 'SANDBOX: Ini tautan pengujian, bukan QRIS pembayaran nyata. Jangan bayar dengan aplikasi bank atau dompet.'
      : invoice.status === 'cancelled' ? 'Invoice dibatalkan. Pembatalan tidak membatalkan atau mengembalikan transfer yang sudah dilakukan ke dompet merchant.' : null,
  };
}

async function queueInvoiceEvent(invoice: InvoiceRow): Promise<void> {
  if (invoice.rental_id) return;
  const webhook = await db.query<{ url: string; encrypted_secret: string }, [string, Environment]>(
    'SELECT url, encrypted_secret FROM webhooks WHERE user_id = $1 AND environment = $2').get(invoice.user_id, invoice.environment);
  if (!webhook) return;
  const eventId = id();
  const timestamp = now();
  const event = `invoice.${invoice.status}`;
  const payload = JSON.stringify({ id: eventId, event, created_at: timestamp, data: await invoicePublic(invoice) });
  await db.query(`INSERT INTO webhook_deliveries(id, user_id, invoice_id, environment, event, payload, url,
    encrypted_secret, created_at, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (invoice_id, event) DO NOTHING`)
    .run(eventId, invoice.user_id, invoice.id, invoice.environment, event, payload, webhook.url, webhook.encrypted_secret, timestamp, timestamp);
}

export async function rentalPublic(rental: RentalRow) {
  const invoice = await db.query<InvoiceRow, [string, string]>('SELECT * FROM invoices WHERE rental_id = $1 AND creation_state = $2').get(rental.id, 'ready');
  return {
    id: rental.id, days: rental.days, price: rental.price, status: rental.status,
    created_at: rental.created_at, checkout_url: invoice ? (await invoicePublic(invoice)).checkout_url : null,
  };
}

export async function expireInvoices(): Promise<void> {
  await atomic(async () => {
    const time = now();
    const expired = await db.query<InvoiceRow, [string]>("SELECT * FROM invoices WHERE status = 'pending' AND expires_at <= $1").all(time);
    for (const invoice of expired) {
      await db.query("UPDATE invoices SET status = 'expired' WHERE id = $1 AND status = 'pending'").run(invoice.id);
      if (invoice.rental_id) await db.query("UPDATE rentals SET status = 'rejected' WHERE id = $1 AND status = 'pending'").run(invoice.rental_id);
      if (invoice.creation_state === 'ready') await queueInvoiceEvent({ ...invoice, status: 'expired' });
    }
    await db.query('DELETE FROM sessions WHERE expires_at <= $1').run(time);
  });
}

export async function merchantInvoices(userId: string, environment: Environment): Promise<InvoiceRow[]> {
  environmentInput(environment);
  await expireInvoices();
  return await db.query<InvoiceRow, [string, Environment]>(`SELECT * FROM invoices WHERE user_id = $1 AND environment = $2
    AND rental_id IS NULL AND creation_state IN ('ready', 'failed') ORDER BY created_at DESC`).all(userId, environment);
}

export async function ownedInvoice(userId: string, invoiceId: string, environment: Environment): Promise<InvoiceRow> {
  environmentInput(environment);
  await expireInvoices();
  const invoice = await db.query<InvoiceRow, [string, string, Environment]>(
    'SELECT * FROM invoices WHERE id = $1 AND user_id = $2 AND environment = $3 AND rental_id IS NULL').get(invoiceId, userId, environment);
  if (!invoice) throw new BusinessError(404, 'Invoice tidak ditemukan.');
  if (invoice.creation_state === 'creating') throw new BusinessError(409, 'Pembuatan QRIS invoice ini belum selesai.');
  return invoice;
}

export async function checkoutInvoice(token: string): Promise<InvoiceRow> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BusinessError(404, 'Checkout tidak ditemukan.');
  await expireInvoices();
  const invoice = await db.query<InvoiceRow, [string]>(`SELECT * FROM invoices WHERE checkout_token = $1 AND creation_state = 'ready'`).get(token);
  if (!invoice) throw new BusinessError(404, 'Checkout tidak ditemukan.');
  return invoice;
}

export async function checkoutPublic(invoice: InvoiceRow) {
  const merchant = await db.query<{ name: string }, [string]>('SELECT name FROM users WHERE id = $1').get(invoice.user_id);
  return { invoice: await invoicePublic(invoice), merchant_name: invoice.rental_id ? 'QRIS Gateway' : merchant?.name || 'Merchant' };
}


export async function rentalPaymentMode(): Promise<'manual' | 'automatic'> {
  return await db.query("SELECT id FROM connections WHERE kind = 'operator' AND managed = 1 AND active = 1").get() ? 'automatic' : 'manual';
}

export async function operatorConnection(): Promise<ConnectionRow> {
  const connection = await db.query<ConnectionRow, []>("SELECT * FROM connections WHERE kind = 'operator' AND managed = 1 AND active = 1").get();
  if (!connection) throw new BusinessError(503, 'Pilih dompet operator terkelola yang aktif melalui admin sebelum menerima pembayaran otomatis.');
  return connection;
}

type InvoiceInput = { amount: number; description: string; external_id: string | null; provider: 'gopay' | 'shopeepay' };

async function reserveInvoice(userId: string, connection: ConnectionRow | null, input: InvoiceInput, rentalId: string | null, environment: Environment): Promise<InvoiceRow> {
  return await atomic(async () => {
    await expireInvoices();
    if (input.external_id && await db.query('SELECT id FROM invoices WHERE user_id = $1 AND environment = $2 AND external_id = $3').get(userId, environment, input.external_id)) {
      throw new BusinessError(409, 'external_id sedang diproses oleh permintaan lain. Coba lagi dengan external_id yang sama.');
    }
    const user = await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(userId);
    if (!user) throw new BusinessError(404, 'Merchant tidak ditemukan.');
    if (rentalId && (!connection || !(await db.query("SELECT id FROM connections WHERE id = $1 AND kind = 'operator' AND active = 1").get(connection.id)))) {
      throw new BusinessError(409, 'Dompet operator berubah. Pesan ulang langganan dengan dompet operator yang aktif.');
    }
    if (!rentalId && environment === 'production') {
      const current = connection ? await db.query<ConnectionRow, [string, string]>(
        "SELECT * FROM connections WHERE id = $1 AND user_id = $2 AND kind = 'merchant' AND active = 1 AND managed = 1").get(connection.id, userId) : null;
      if (!current) throw new BusinessError(400, 'Pilih dompet terkelola yang aktif milik akun Anda.');
      if (!publicUser(user).subscription_active) {
        const access = await accessPublic(user, environment);
        if (access.daily_remaining === 0) throw new BusinessError(429, `Batas gratis 5 invoice produksi hari ini sudah terpakai. Kuota diperbarui pukul 00.00 WIB (${access.resets_at}).`);
      }
    }
    const timestamp = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    const occupied = connection && environment === 'production'
      ? await db.query<{ payable_amount: number }, [string]>(
        "SELECT payable_amount FROM invoices WHERE connection_id = $1 AND environment = 'production' AND status = 'pending'").all(connection.id) : [];
    const amounts = new Set(occupied.map(row => row.payable_amount));
    let payableAmount: number | null = null;
    for (let offset = 0; offset < 100; offset++) {
      const candidate = input.amount + offset;
      if (candidate <= 1_000_000_000 && !amounts.has(candidate)) { payableAmount = candidate; break; }
    }
    if (payableAmount === null) throw new BusinessError(409, 'Semua nominal unik untuk pembayaran ini sedang digunakan. Tunggu invoice sebelumnya selesai atau kedaluwarsa.');
    const invoiceId = id();
    // Reserve before gateway I/O, matching the gateways' second-precision receipt timestamps.
    await db.query(`INSERT INTO invoices(id, user_id, connection_id, rental_id, environment, external_id, description, amount,
      payable_amount, provider, status, creation_state, created_at, expires_at, checkout_token)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'creating', $11, $12, $13)`)
      .run(invoiceId, userId, connection?.id || null, rentalId, environment, input.external_id, input.description, input.amount,
        payableAmount, input.provider, timestamp, new Date(Date.now() + 30 * 60_000).toISOString(), newSecret());
    return (await db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = $1').get(invoiceId))!;
  });
}

async function initializeInvoice(invoice: InvoiceRow, connection: ConnectionRow | null): Promise<InvoiceRow> {
  try {
    const payment = invoice.environment === 'sandbox'
      ? { reference: `sandbox:${invoice.id}`, qr_code: (await invoicePublic(invoice)).checkout_url, qr_url: null, expires_at: invoice.expires_at }
      : await createPayment(connectionSecret(connection!), invoice.payable_amount);
    return await atomic(async () => {
      const current = (await db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = $1').get(invoice.id))!;
      if (current.status !== 'pending') throw new BusinessError(409, 'Pembuatan QRIS melewati batas waktu. Buat invoice baru.');
      await db.query(`UPDATE invoices SET creation_state = 'ready', reference = $1, qr_code = $2, qr_url = $3, expires_at = $4 WHERE id = $5`)
        .run(payment.reference, payment.qr_code, payment.qr_url, payment.expires_at, invoice.id);
      return (await db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = $1').get(invoice.id))!;
    });
  } catch (error) {
    await atomic(async () => {
      await db.query("UPDATE invoices SET status = 'failed', creation_state = 'failed' WHERE id = $1 AND creation_state = 'creating'").run(invoice.id);
      if (invoice.rental_id) await db.query("UPDATE rentals SET status = 'rejected' WHERE id = $1 AND status = 'pending'").run(invoice.rental_id);
    });
    throw error;
  }
}

const creations = new Map<string, Promise<InvoiceRow>>();
const creationRequests = new Map<string, Promise<InvoiceRow>>();
export async function createMerchantInvoice(userId: string, body: Record<string, unknown>, environment: Environment): Promise<InvoiceRow> {
  const key = typeof body.external_id === 'string' && body.external_id ? JSON.stringify([userId, environment, body.external_id]) : null;
  if (!key) return createMerchantInvoiceInternal(userId, body, environment);
  const running = creationRequests.get(key);
  if (running) {
    await running;
    return createMerchantInvoiceInternal(userId, body, environment);
  }
  const operation = createMerchantInvoiceInternal(userId, body, environment);
  creationRequests.set(key, operation);
  try { return await operation; } finally { creationRequests.delete(key); }
}

async function createMerchantInvoiceInternal(userId: string, body: Record<string, unknown>, environment: Environment): Promise<InvoiceRow> {
  environmentInput(environment);
  if (body.environment !== undefined && body.environment !== environment) throw new BusinessError(400, 'Environment invoice tidak sesuai dengan permintaan.');
  const amount = money(body.amount);
  const description = text(body, 'description', 1000);
  const connectionId = text(body, 'connection_id', 100, environment === 'production') || null;
  const connection = connectionId ? await db.query<ConnectionRow, [string, string]>(
    "SELECT * FROM connections WHERE id = $1 AND user_id = $2 AND kind = 'merchant'").get(connectionId, userId) : null;
  if (connectionId && !connection) throw new BusinessError(404, 'Dompet tidak ditemukan.');
  const name = body.provider === undefined && connection ? connection.provider : provider(body.provider);
  if (connection && connection.provider !== name) throw new BusinessError(400, 'Provider invoice tidak sesuai dompet yang dipilih.');
  const externalId = text(body, 'external_id', 200, false) || null;
  const existing = externalId ? await db.query<InvoiceRow, [string, Environment, string]>(
    'SELECT * FROM invoices WHERE user_id = $1 AND environment = $2 AND external_id = $3').get(userId, environment, externalId) : null;
  if (existing) {
    if (existing.amount !== amount || existing.description !== description || existing.provider !== name || existing.connection_id !== connectionId) {
      throw new BusinessError(409, 'external_id sudah digunakan untuk invoice dengan data berbeda.');
    }
    const inFlight = creations.get(existing.id);
    if (inFlight) return inFlight;
    if (existing.creation_state === 'failed') throw new BusinessError(409, 'Pembuatan QRIS untuk external_id ini gagal. Gunakan external_id baru setelah memeriksa transaksi Anda.');
    if (existing.creation_state === 'creating') throw new BusinessError(409, 'QRIS untuk external_id ini masih diproses. Coba lagi setelah batas waktu invoice.');
    await expireInvoices();
    return (await db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = $1').get(existing.id))!;
  }
  const invoice = await reserveInvoice(userId, connection, { amount, description, external_id: externalId, provider: name }, null, environment);
  const operation = initializeInvoice(invoice, connection);
  creations.set(invoice.id, operation);
  try { return await operation; } finally { creations.delete(invoice.id); }
}

export async function extendSubscription(userId: string, days: 7 | 30): Promise<string> {
  return await atomic(async () => {
    const user = await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(userId);
    if (!user) throw new BusinessError(404, 'Merchant tidak ditemukan.');
    const base = Math.max(Date.now(), user.subscription_expires_at ? new Date(user.subscription_expires_at).getTime() : 0);
    const expiry = new Date(base + days * 24 * 60 * 60_000).toISOString();
    await db.query('UPDATE users SET subscription_expires_at = $1 WHERE id = $2').run(expiry, userId);
    return expiry;
  });
}

export async function activateRental(rentalId: string): Promise<boolean> {
  return await atomic(async () => {
    const rental = await db.query<RentalRow, [string]>('SELECT * FROM rentals WHERE id = $1').get(rentalId);
    if (!rental) throw new BusinessError(404, 'Pengajuan langganan tidak ditemukan.');
    if (rental.status === 'active') return false;
    if (rental.status === 'rejected') throw new BusinessError(409, 'Pengajuan yang ditolak tidak dapat diaktifkan.');
    if (rental.status === 'pending' && !(await db.query(`SELECT invoices.id FROM invoices JOIN transaction_claim ON transaction_claim.invoice_id = invoices.id
      WHERE invoices.rental_id = $1 AND invoices.status = 'paid' AND invoices.environment = 'production'`).get(rentalId))) {
      throw new BusinessError(409, 'Pembayaran langganan otomatis belum diverifikasi gateway.');
    }
    await db.query("UPDATE rentals SET status = 'active', activated_at = $1 WHERE id = $2 AND status IN ('requested', 'pending')").run(now(), rentalId);
    await extendSubscription(rental.user_id, rental.days);
    return true;
  });
}

export async function recordPaid(invoiceId: string, proof: { transaction_id?: string; amount?: number; paid_at?: string }): Promise<InvoiceRow> {
  return await atomic(async () => {
    await expireInvoices();
    const invoice = await db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = $1').get(invoiceId);
    if (!invoice) throw new BusinessError(404, 'Invoice tidak ditemukan.');
    if (invoice.environment !== 'production' || !invoice.connection_id) throw new BusinessError(403, 'Invoice sandbox hanya dapat dibayar melalui simulator sandbox.');
    if (invoice.status === 'paid') return invoice;
    if (invoice.status !== 'pending' && invoice.status !== 'expired') return invoice;
    if (invoice.creation_state !== 'ready' || !invoice.reference) throw new BusinessError(409, 'QRIS invoice ini belum tersedia.');
    const paidTime = proof.paid_at ? new Date(proof.paid_at).getTime() : NaN;
    if (!proof.transaction_id || proof.transaction_id.startsWith('sandbox:') || proof.transaction_id.length > 512 || proof.amount !== invoice.payable_amount || !Number.isFinite(paidTime)
      || paidTime < new Date(invoice.created_at).getTime() || paidTime > new Date(invoice.expires_at).getTime() || paidTime > Date.now()) {
      throw new BusinessError(502, 'Bukti pembayaran gateway tidak sesuai nominal atau rentang waktu invoice. Invoice belum ditandai lunas.');
    }
    const claimed = await db.query<{ invoice_id: string }, [string, string]>('SELECT invoice_id FROM transaction_claim WHERE connection_id = $1 AND transaction_id = $2')
      .get(invoice.connection_id, proof.transaction_id);
    if (claimed && claimed.invoice_id !== invoice.id) throw new BusinessError(409, 'Transaksi gateway ini sudah digunakan untuk invoice lain. Invoice belum ditandai lunas.');
    const paidAt = new Date(paidTime).toISOString();
    await db.query('INSERT INTO transaction_claim(connection_id, transaction_id, invoice_id, paid_at) VALUES ($1, $2, $3, $4)')
      .run(invoice.connection_id, proof.transaction_id, invoice.id, paidAt);
    await db.query("UPDATE invoices SET status = 'paid', paid_at = $1 WHERE id = $2").run(paidAt, invoice.id);
    const paid = (await db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = $1').get(invoice.id))!;
    if (paid.rental_id) {
      // Expiry rejects automatic rentals; an on-time receipt restores only its linked application.
      if (invoice.status === 'expired') await db.query("UPDATE rentals SET status = 'pending' WHERE id = $1 AND status = 'rejected' AND payment_reference IS NULL").run(paid.rental_id);
      await activateRental(paid.rental_id);
    } else await queueInvoiceEvent(paid);
    return paid;
  });
}

export async function cancelInvoice(userId: string, invoiceId: string, environment: Environment): Promise<InvoiceRow> {
  return await atomic(async () => {
    const invoice = await ownedInvoice(userId, invoiceId, environment);
    if (invoice.status === 'cancelled') return invoice;
    if (invoice.status !== 'pending') throw new BusinessError(409, 'Hanya invoice yang masih menunggu pembayaran dapat dibatalkan.');
    await db.query("UPDATE invoices SET status = 'cancelled' WHERE id = $1 AND status = 'pending'").run(invoice.id);
    const cancelled = { ...invoice, status: 'cancelled' as const };
    await queueInvoiceEvent(cancelled);
    return cancelled;
  });
}

export async function simulateInvoice(userId: string, invoiceId: string, action: unknown, environment: Environment): Promise<InvoiceRow> {
  if (environmentInput(environment) !== 'sandbox') throw new BusinessError(403, 'Simulasi pembayaran hanya tersedia di sandbox.');
  if (action !== 'paid' && action !== 'failed' && action !== 'expired') throw new BusinessError(400, 'Pilih simulasi paid, failed, atau expired.');
  return await atomic(async () => {
    const invoice = await ownedInvoice(userId, invoiceId, 'sandbox');
    if (invoice.environment !== 'sandbox' || invoice.rental_id) throw new BusinessError(403, 'Simulasi tidak dapat mengaktifkan langganan nyata.');
    if (invoice.status === action) return invoice;
    if (invoice.status !== 'pending') throw new BusinessError(409, 'Invoice ini sudah selesai dan tidak dapat diubah melalui simulasi.');
    const paidAt = action === 'paid' ? now() : null;
    await db.query("UPDATE invoices SET status = $1, paid_at = $2, reference = $3 WHERE id = $4 AND environment = 'sandbox' AND status = 'pending'")
      .run(action, paidAt, `sandbox:${invoice.id}`, invoice.id);
    const simulated: InvoiceRow = { ...invoice, status: action, paid_at: paidAt, reference: `sandbox:${invoice.id}` };
    await queueInvoiceEvent(simulated);
    return simulated;
  });
}

const checks = new Map<string, Promise<InvoiceRow>>();
export async function checkInvoice(invoice: InvoiceRow): Promise<InvoiceRow> {
  const coalesced = checks.get(invoice.id);
  if (coalesced) return coalesced;
  await expireInvoices();
  const current = (await db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = $1').get(invoice.id))!;
  if (!current) throw new BusinessError(404, 'Invoice tidak ditemukan.');
  if (current.environment === 'sandbox') return current;
  if (current.status !== 'pending' && current.status !== 'expired') return current;
  if (!current.reference || current.creation_state !== 'ready') throw new BusinessError(409, 'QRIS invoice ini belum tersedia.');
  const permitted = (await db.query(`UPDATE invoices SET last_checked_at = $1 WHERE id = $2 AND status IN ('pending', 'expired')
    AND (last_checked_at IS NULL OR last_checked_at <= $3)`)
    .run(now(), current.id, new Date(Date.now() - 15_000).toISOString())).changes;
  if (!permitted) return current;
  if (!current.connection_id) throw new BusinessError(409, 'Dompet invoice tidak tersedia.');
  const connection = await db.query<ConnectionRow, [string]>('SELECT * FROM connections WHERE id = $1').get(current.connection_id);
  if (!connection) throw new BusinessError(409, 'Dompet invoice tidak tersedia.');
  const operation = (async () => {
    const proof = await checkPayment(connectionSecret(connection), {
      reference: current.reference!, amount: current.payable_amount, created_at: current.created_at, expires_at: current.expires_at,
    });
    if (proof.paid) return await recordPaid(current.id, proof);
    await expireInvoices();
    return (await db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = $1').get(current.id))!;
  })();
  checks.set(current.id, operation);
  try { return await operation; } finally { checks.delete(current.id); }
}

export async function createRental(userId: string, body: Record<string, unknown>): Promise<RentalRow> {
  if (body.environment !== undefined && body.environment !== 'production') throw new BusinessError(403, 'Langganan nyata tidak dapat dipesan dari sandbox.');
  const days = duration(body.days);
  const paymentReference = text(body, 'payment_reference', 500, false) || null;
  const plan = await db.query<{ price: number | null }, [number]>('SELECT price FROM plans WHERE days = $1').get(days);
  if (!plan?.price) throw new BusinessError(409, 'Harga paket belum ditetapkan admin. Paket ini belum dapat dipesan.');
  const automatic = await rentalPaymentMode() === 'automatic';
  if (!automatic && !paymentReference) throw new BusinessError(400, 'Pembayaran manual memerlukan referensi pembayaran untuk diperiksa admin.');
  const connection = automatic ? await operatorConnection() : null;
  const rentalId = id();
  const invoice = await atomic(async () => {
    await db.query(`INSERT INTO rentals(id, user_id, days, price, status, payment_reference, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`)
      .run(rentalId, userId, days, plan.price!, automatic ? 'pending' : 'requested', paymentReference, now());
    return connection ? await reserveInvoice(userId, connection, {
      amount: plan.price!, description: `Langganan QRIS Gateway ${days} hari`, external_id: null, provider: connection.provider,
    }, rentalId, 'production') : null;
  });
  if (invoice && connection) await initializeInvoice(invoice, connection);
  return (await db.query<RentalRow, [string]>('SELECT * FROM rentals WHERE id = $1').get(rentalId))!;
}

export async function audit(actorId: string, action: string, targetId: string, details: Record<string, unknown>): Promise<void> {
  await db.query('INSERT INTO admin_audit(id, actor_id, action, target_id, details, created_at) VALUES ($1, $2, $3, $4, $5, $6)')
    .run(id(), actorId, action, targetId, JSON.stringify(details), now());
}

export async function adminData() {
  await expireInvoices();
  const merchants = (await db.query<UserRow, []>("SELECT * FROM users WHERE role = 'merchant' ORDER BY created_at DESC").all()).map(publicUser);
  const rentals = await db.query<RentalRow & { merchant_name: string; merchant_email: string }, []>(`SELECT rentals.*, users.name AS merchant_name, users.email AS merchant_email
    FROM rentals JOIN users ON users.id = rentals.user_id ORDER BY rentals.created_at DESC`).all();
  return {
    operator_connection_id: (await db.query<{ id: string }, []>("SELECT id FROM connections WHERE kind = 'operator' AND managed = 1 AND active = 1").get())?.id || null,
    merchants: merchants.map(({ id, name, email, subscription_expires_at, subscription_active }) => ({ id, name, email, subscription_expires_at, subscription_active })),
    rentals: await Promise.all(rentals.map(async rental => ({ ...await rentalPublic(rental), merchant_name: rental.merchant_name, merchant_email: rental.merchant_email, payment_reference: rental.payment_reference }))),
    plans: await db.query<{ days: 7 | 30; price: number | null }, []>('SELECT days, price FROM plans ORDER BY days').all(),
  };
}
