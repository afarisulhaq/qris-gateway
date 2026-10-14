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

export function accessPublic(user: UserRow, environment: Environment): {
  environment: Environment; access_tier: 'free' | 'paid' | 'admin' | 'sandbox'; daily_limit: number | null;
  daily_used: number; daily_remaining: number | null; resets_at: string | null;
} {
  environmentInput(environment);
  const day = wibDay();
  const used = environment === 'production' ? db.query<{ total: number }, [string, string, string]>(`
    SELECT COUNT(*) AS total FROM invoices WHERE user_id = ? AND environment = 'production'
      AND rental_id IS NULL AND creation_state IN ('creating', 'ready') AND created_at >= ? AND created_at < ?
  `).get(user.id, day.start, day.end)!.total : 0;
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

export function invoicePublic(invoice: InvoiceRow) {
  const connection = invoice.connection_id
    ? db.query<{ label: string; provider: string }, [string]>('SELECT label, provider FROM connections WHERE id = ?').get(invoice.connection_id)
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

function queueInvoiceEvent(invoice: InvoiceRow): void {
  if (invoice.rental_id) return;
  const webhook = db.query<{ url: string; encrypted_secret: string }, [string, Environment]>(
    'SELECT url, encrypted_secret FROM webhooks WHERE user_id = ? AND environment = ?').get(invoice.user_id, invoice.environment);
  if (!webhook) return;
  const eventId = id();
  const timestamp = now();
  const event = `invoice.${invoice.status}`;
  const payload = JSON.stringify({ id: eventId, event, created_at: timestamp, data: invoicePublic(invoice) });
  db.query(`INSERT OR IGNORE INTO webhook_deliveries(id, user_id, invoice_id, environment, event, payload, url,
    encrypted_secret, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, invoice.user_id, invoice.id, invoice.environment, event, payload, webhook.url, webhook.encrypted_secret, timestamp, timestamp);
}

export function rentalPublic(rental: RentalRow) {
  const invoice = db.query<InvoiceRow, [string, string]>('SELECT * FROM invoices WHERE rental_id = ? AND creation_state = ?').get(rental.id, 'ready');
  return {
    id: rental.id, days: rental.days, price: rental.price, status: rental.status,
    created_at: rental.created_at, checkout_url: invoice ? invoicePublic(invoice).checkout_url : null,
  };
}

export function expireInvoices(): void {
  atomic(() => {
    const time = now();
    const expired = db.query<InvoiceRow, [string]>("SELECT * FROM invoices WHERE status = 'pending' AND expires_at <= ?").all(time);
    for (const invoice of expired) {
      db.query("UPDATE invoices SET status = 'expired' WHERE id = ? AND status = 'pending'").run(invoice.id);
      if (invoice.rental_id) db.query("UPDATE rentals SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(invoice.rental_id);
      if (invoice.creation_state === 'ready') queueInvoiceEvent({ ...invoice, status: 'expired' });
    }
    db.query('DELETE FROM sessions WHERE expires_at <= ?').run(time);
  });
}

export function merchantInvoices(userId: string, environment: Environment): InvoiceRow[] {
  environmentInput(environment);
  expireInvoices();
  return db.query<InvoiceRow, [string, Environment]>(`SELECT * FROM invoices WHERE user_id = ? AND environment = ?
    AND rental_id IS NULL AND creation_state IN ('ready', 'failed') ORDER BY created_at DESC`).all(userId, environment);
}

export function ownedInvoice(userId: string, invoiceId: string, environment: Environment): InvoiceRow {
  environmentInput(environment);
  expireInvoices();
  const invoice = db.query<InvoiceRow, [string, string, Environment]>(
    'SELECT * FROM invoices WHERE id = ? AND user_id = ? AND environment = ? AND rental_id IS NULL').get(invoiceId, userId, environment);
  if (!invoice) throw new BusinessError(404, 'Invoice tidak ditemukan.');
  if (invoice.creation_state === 'creating') throw new BusinessError(409, 'Pembuatan QRIS invoice ini belum selesai.');
  return invoice;
}

export function checkoutInvoice(token: string): InvoiceRow {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BusinessError(404, 'Checkout tidak ditemukan.');
  expireInvoices();
  const invoice = db.query<InvoiceRow, [string]>(`SELECT * FROM invoices WHERE checkout_token = ? AND creation_state = 'ready'`).get(token);
  if (!invoice) throw new BusinessError(404, 'Checkout tidak ditemukan.');
  return invoice;
}

export function checkoutPublic(invoice: InvoiceRow) {
  const merchant = db.query<{ name: string }, [string]>('SELECT name FROM users WHERE id = ?').get(invoice.user_id);
  return { invoice: invoicePublic(invoice), merchant_name: invoice.rental_id ? 'QRIS Gateway' : merchant?.name || 'Merchant' };
}


export function rentalPaymentMode(): 'manual' | 'automatic' {
  return db.query("SELECT id FROM connections WHERE kind = 'operator' AND managed = 1 AND active = 1").get() ? 'automatic' : 'manual';
}

export function operatorConnection(): ConnectionRow {
  const connection = db.query<ConnectionRow, []>("SELECT * FROM connections WHERE kind = 'operator' AND managed = 1 AND active = 1").get();
  if (!connection) throw new BusinessError(503, 'Pilih dompet operator terkelola yang aktif melalui admin sebelum menerima pembayaran otomatis.');
  return connection;
}

type InvoiceInput = { amount: number; description: string; external_id: string | null; provider: 'gopay' | 'shopeepay' };

function reserveInvoice(userId: string, connection: ConnectionRow | null, input: InvoiceInput, rentalId: string | null, environment: Environment): InvoiceRow {
  return atomic(() => {
    expireInvoices();
    if (input.external_id && db.query('SELECT id FROM invoices WHERE user_id = ? AND environment = ? AND external_id = ?').get(userId, environment, input.external_id)) {
      throw new BusinessError(409, 'external_id sedang diproses oleh permintaan lain. Coba lagi dengan external_id yang sama.');
    }
    const user = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new BusinessError(404, 'Merchant tidak ditemukan.');
    if (rentalId && (!connection || !db.query("SELECT id FROM connections WHERE id = ? AND kind = 'operator' AND active = 1").get(connection.id))) {
      throw new BusinessError(409, 'Dompet operator berubah. Pesan ulang langganan dengan dompet operator yang aktif.');
    }
    if (!rentalId && environment === 'production') {
      const current = connection ? db.query<ConnectionRow, [string, string]>(
        "SELECT * FROM connections WHERE id = ? AND user_id = ? AND kind = 'merchant' AND active = 1 AND managed = 1").get(connection.id, userId) : null;
      if (!current) throw new BusinessError(400, 'Pilih dompet terkelola yang aktif milik akun Anda.');
      if (!publicUser(user).subscription_active) {
        const access = accessPublic(user, environment);
        if (access.daily_remaining === 0) throw new BusinessError(429, `Batas gratis 5 invoice produksi hari ini sudah terpakai. Kuota diperbarui pukul 00.00 WIB (${access.resets_at}).`);
      }
    }
    const timestamp = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    const occupied = connection && environment === 'production'
      ? db.query<{ payable_amount: number }, [string]>(
        "SELECT payable_amount FROM invoices WHERE connection_id = ? AND environment = 'production' AND status = 'pending'").all(connection.id) : [];
    const amounts = new Set(occupied.map(row => row.payable_amount));
    let payableAmount: number | null = null;
    for (let offset = 0; offset < 100; offset++) {
      const candidate = input.amount + offset;
      if (candidate <= 1_000_000_000 && !amounts.has(candidate)) { payableAmount = candidate; break; }
    }
    if (payableAmount === null) throw new BusinessError(409, 'Semua nominal unik untuk pembayaran ini sedang digunakan. Tunggu invoice sebelumnya selesai atau kedaluwarsa.');
    const invoiceId = id();
    // Reserve before gateway I/O, matching the gateways' second-precision receipt timestamps.
    db.query(`INSERT INTO invoices(id, user_id, connection_id, rental_id, environment, external_id, description, amount,
      payable_amount, provider, status, creation_state, created_at, expires_at, checkout_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'creating', ?, ?, ?)`)
      .run(invoiceId, userId, connection?.id || null, rentalId, environment, input.external_id, input.description, input.amount,
        payableAmount, input.provider, timestamp, new Date(Date.now() + 30 * 60_000).toISOString(), newSecret());
    return db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = ?').get(invoiceId)!;
  });
}

async function initializeInvoice(invoice: InvoiceRow, connection: ConnectionRow | null): Promise<InvoiceRow> {
  try {
    const payment = invoice.environment === 'sandbox'
      ? { reference: `sandbox:${invoice.id}`, qr_code: invoicePublic(invoice).checkout_url, qr_url: null, expires_at: invoice.expires_at }
      : await createPayment(connectionSecret(connection!), invoice.payable_amount);
    return atomic(() => {
      const current = db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = ?').get(invoice.id)!;
      if (current.status !== 'pending') throw new BusinessError(409, 'Pembuatan QRIS melewati batas waktu. Buat invoice baru.');
      db.query(`UPDATE invoices SET creation_state = 'ready', reference = ?, qr_code = ?, qr_url = ?, expires_at = ? WHERE id = ?`)
        .run(payment.reference, payment.qr_code, payment.qr_url, payment.expires_at, invoice.id);
      return db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = ?').get(invoice.id)!;
    });
  } catch (error) {
    atomic(() => {
      db.query("UPDATE invoices SET status = 'failed', creation_state = 'failed' WHERE id = ? AND creation_state = 'creating'").run(invoice.id);
      if (invoice.rental_id) db.query("UPDATE rentals SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(invoice.rental_id);
    });
    throw error;
  }
}

const creations = new Map<string, Promise<InvoiceRow>>();
export async function createMerchantInvoice(userId: string, body: Record<string, unknown>, environment: Environment): Promise<InvoiceRow> {
  environmentInput(environment);
  if (body.environment !== undefined && body.environment !== environment) throw new BusinessError(400, 'Environment invoice tidak sesuai dengan permintaan.');
  const amount = money(body.amount);
  const description = text(body, 'description', 1000);
  const connectionId = text(body, 'connection_id', 100, environment === 'production') || null;
  const connection = connectionId ? db.query<ConnectionRow, [string, string]>(
    "SELECT * FROM connections WHERE id = ? AND user_id = ? AND kind = 'merchant'").get(connectionId, userId) : null;
  if (connectionId && !connection) throw new BusinessError(404, 'Dompet tidak ditemukan.');
  const name = body.provider === undefined && connection ? connection.provider : provider(body.provider);
  if (connection && connection.provider !== name) throw new BusinessError(400, 'Provider invoice tidak sesuai dompet yang dipilih.');
  const externalId = text(body, 'external_id', 200, false) || null;
  const existing = externalId ? db.query<InvoiceRow, [string, Environment, string]>(
    'SELECT * FROM invoices WHERE user_id = ? AND environment = ? AND external_id = ?').get(userId, environment, externalId) : null;
  if (existing) {
    if (existing.amount !== amount || existing.description !== description || existing.provider !== name || existing.connection_id !== connectionId) {
      throw new BusinessError(409, 'external_id sudah digunakan untuk invoice dengan data berbeda.');
    }
    const inFlight = creations.get(existing.id);
    if (inFlight) return inFlight;
    if (existing.creation_state === 'failed') throw new BusinessError(409, 'Pembuatan QRIS untuk external_id ini gagal. Gunakan external_id baru setelah memeriksa transaksi Anda.');
    if (existing.creation_state === 'creating') throw new BusinessError(409, 'QRIS untuk external_id ini masih diproses. Coba lagi setelah batas waktu invoice.');
    expireInvoices();
    return db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = ?').get(existing.id)!;
  }
  const invoice = reserveInvoice(userId, connection, { amount, description, external_id: externalId, provider: name }, null, environment);
  const operation = initializeInvoice(invoice, connection);
  creations.set(invoice.id, operation);
  try { return await operation; } finally { creations.delete(invoice.id); }
}

export function extendSubscription(userId: string, days: 7 | 30): string {
  return atomic(() => {
    const user = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new BusinessError(404, 'Merchant tidak ditemukan.');
    const base = Math.max(Date.now(), user.subscription_expires_at ? new Date(user.subscription_expires_at).getTime() : 0);
    const expiry = new Date(base + days * 24 * 60 * 60_000).toISOString();
    db.query('UPDATE users SET subscription_expires_at = ? WHERE id = ?').run(expiry, userId);
    return expiry;
  });
}

export function activateRental(rentalId: string): boolean {
  return atomic(() => {
    const rental = db.query<RentalRow, [string]>('SELECT * FROM rentals WHERE id = ?').get(rentalId);
    if (!rental) throw new BusinessError(404, 'Pengajuan langganan tidak ditemukan.');
    if (rental.status === 'active') return false;
    if (rental.status === 'rejected') throw new BusinessError(409, 'Pengajuan yang ditolak tidak dapat diaktifkan.');
    if (rental.status === 'pending' && !db.query(`SELECT invoices.id FROM invoices JOIN transaction_claim ON transaction_claim.invoice_id = invoices.id
      WHERE invoices.rental_id = ? AND invoices.status = 'paid' AND invoices.environment = 'production'`).get(rentalId)) {
      throw new BusinessError(409, 'Pembayaran langganan otomatis belum diverifikasi gateway.');
    }
    db.query("UPDATE rentals SET status = 'active', activated_at = ? WHERE id = ? AND status IN ('requested', 'pending')").run(now(), rentalId);
    extendSubscription(rental.user_id, rental.days);
    return true;
  });
}

export function recordPaid(invoiceId: string, proof: { transaction_id?: string; amount?: number; paid_at?: string }): InvoiceRow {
  return atomic(() => {
    expireInvoices();
    const invoice = db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
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
    const claimed = db.query<{ invoice_id: string }, [string, string]>('SELECT invoice_id FROM transaction_claim WHERE connection_id = ? AND transaction_id = ?')
      .get(invoice.connection_id, proof.transaction_id);
    if (claimed && claimed.invoice_id !== invoice.id) throw new BusinessError(409, 'Transaksi gateway ini sudah digunakan untuk invoice lain. Invoice belum ditandai lunas.');
    const paidAt = new Date(paidTime).toISOString();
    db.query('INSERT INTO transaction_claim(connection_id, transaction_id, invoice_id, paid_at) VALUES (?, ?, ?, ?)')
      .run(invoice.connection_id, proof.transaction_id, invoice.id, paidAt);
    db.query("UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?").run(paidAt, invoice.id);
    const paid = db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = ?').get(invoice.id)!;
    if (paid.rental_id) {
      // Expiry rejects automatic rentals; an on-time receipt restores only its linked application.
      if (invoice.status === 'expired') db.query("UPDATE rentals SET status = 'pending' WHERE id = ? AND status = 'rejected' AND payment_reference IS NULL").run(paid.rental_id);
      activateRental(paid.rental_id);
    } else queueInvoiceEvent(paid);
    return paid;
  });
}

export function cancelInvoice(userId: string, invoiceId: string, environment: Environment): InvoiceRow {
  return atomic(() => {
    const invoice = ownedInvoice(userId, invoiceId, environment);
    if (invoice.status === 'cancelled') return invoice;
    if (invoice.status !== 'pending') throw new BusinessError(409, 'Hanya invoice yang masih menunggu pembayaran dapat dibatalkan.');
    db.query("UPDATE invoices SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(invoice.id);
    const cancelled = { ...invoice, status: 'cancelled' as const };
    queueInvoiceEvent(cancelled);
    return cancelled;
  });
}

export function simulateInvoice(userId: string, invoiceId: string, action: unknown, environment: Environment): InvoiceRow {
  if (environmentInput(environment) !== 'sandbox') throw new BusinessError(403, 'Simulasi pembayaran hanya tersedia di sandbox.');
  if (action !== 'paid' && action !== 'failed' && action !== 'expired') throw new BusinessError(400, 'Pilih simulasi paid, failed, atau expired.');
  return atomic(() => {
    const invoice = ownedInvoice(userId, invoiceId, 'sandbox');
    if (invoice.environment !== 'sandbox' || invoice.rental_id) throw new BusinessError(403, 'Simulasi tidak dapat mengaktifkan langganan nyata.');
    if (invoice.status === action) return invoice;
    if (invoice.status !== 'pending') throw new BusinessError(409, 'Invoice ini sudah selesai dan tidak dapat diubah melalui simulasi.');
    const paidAt = action === 'paid' ? now() : null;
    db.query("UPDATE invoices SET status = ?, paid_at = ?, reference = ? WHERE id = ? AND environment = 'sandbox' AND status = 'pending'")
      .run(action, paidAt, `sandbox:${invoice.id}`, invoice.id);
    const simulated: InvoiceRow = { ...invoice, status: action, paid_at: paidAt, reference: `sandbox:${invoice.id}` };
    queueInvoiceEvent(simulated);
    return simulated;
  });
}

const checks = new Map<string, Promise<InvoiceRow>>();
export async function checkInvoice(invoice: InvoiceRow): Promise<InvoiceRow> {
  const coalesced = checks.get(invoice.id);
  if (coalesced) return coalesced;
  expireInvoices();
  const current = db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = ?').get(invoice.id)!;
  if (!current) throw new BusinessError(404, 'Invoice tidak ditemukan.');
  if (current.environment === 'sandbox') return current;
  if (current.status !== 'pending' && current.status !== 'expired') return current;
  if (!current.reference || current.creation_state !== 'ready') throw new BusinessError(409, 'QRIS invoice ini belum tersedia.');
  const permitted = db.query(`UPDATE invoices SET last_checked_at = ? WHERE id = ? AND status IN ('pending', 'expired')
    AND (last_checked_at IS NULL OR last_checked_at <= ?)`)
    .run(now(), current.id, new Date(Date.now() - 15_000).toISOString()).changes;
  if (!permitted) return current;
  if (!current.connection_id) throw new BusinessError(409, 'Dompet invoice tidak tersedia.');
  const connection = db.query<ConnectionRow, [string]>('SELECT * FROM connections WHERE id = ?').get(current.connection_id);
  if (!connection) throw new BusinessError(409, 'Dompet invoice tidak tersedia.');
  const operation = (async () => {
    const proof = await checkPayment(connectionSecret(connection), {
      reference: current.reference!, amount: current.payable_amount, created_at: current.created_at, expires_at: current.expires_at,
    });
    if (proof.paid) return recordPaid(current.id, proof);
    expireInvoices();
    return db.query<InvoiceRow, [string]>('SELECT * FROM invoices WHERE id = ?').get(current.id)!;
  })();
  checks.set(current.id, operation);
  try { return await operation; } finally { checks.delete(current.id); }
}

export async function createRental(userId: string, body: Record<string, unknown>): Promise<RentalRow> {
  if (body.environment !== undefined && body.environment !== 'production') throw new BusinessError(403, 'Langganan nyata tidak dapat dipesan dari sandbox.');
  const days = duration(body.days);
  const paymentReference = text(body, 'payment_reference', 500, false) || null;
  const plan = db.query<{ price: number | null }, [number]>('SELECT price FROM plans WHERE days = ?').get(days);
  if (!plan?.price) throw new BusinessError(409, 'Harga paket belum ditetapkan admin. Paket ini belum dapat dipesan.');
  const automatic = rentalPaymentMode() === 'automatic';
  if (!automatic && !paymentReference) throw new BusinessError(400, 'Pembayaran manual memerlukan referensi pembayaran untuk diperiksa admin.');
  const connection = automatic ? operatorConnection() : null;
  const rentalId = id();
  const invoice = atomic(() => {
    db.query(`INSERT INTO rentals(id, user_id, days, price, status, payment_reference, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(rentalId, userId, days, plan.price!, automatic ? 'pending' : 'requested', paymentReference, now());
    return connection ? reserveInvoice(userId, connection, {
      amount: plan.price!, description: `Langganan QRIS Gateway ${days} hari`, external_id: null, provider: connection.provider,
    }, rentalId, 'production') : null;
  });
  if (invoice && connection) await initializeInvoice(invoice, connection);
  return db.query<RentalRow, [string]>('SELECT * FROM rentals WHERE id = ?').get(rentalId)!;
}

export function audit(actorId: string, action: string, targetId: string, details: Record<string, unknown>): void {
  db.query('INSERT INTO admin_audit(id, actor_id, action, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id(), actorId, action, targetId, JSON.stringify(details), now());
}

export function adminData() {
  expireInvoices();
  const merchants = db.query<UserRow, []>("SELECT * FROM users WHERE role = 'merchant' ORDER BY created_at DESC").all().map(publicUser);
  const rentals = db.query<RentalRow & { merchant_name: string; merchant_email: string }, []>(`SELECT rentals.*, users.name AS merchant_name, users.email AS merchant_email
    FROM rentals JOIN users ON users.id = rentals.user_id ORDER BY rentals.created_at DESC`).all();
  return {
    operator_connection_id: db.query<{ id: string }, []>("SELECT id FROM connections WHERE kind = 'operator' AND managed = 1 AND active = 1").get()?.id || null,
    merchants: merchants.map(({ id, name, email, subscription_expires_at, subscription_active }) => ({ id, name, email, subscription_expires_at, subscription_active })),
    rentals: rentals.map(rental => ({ ...rentalPublic(rental), merchant_name: rental.merchant_name, merchant_email: rental.merchant_email, payment_reference: rental.payment_reference })),
    plans: db.query<{ days: 7 | 30; price: number | null }, []>('SELECT days, price FROM plans ORDER BY days').all(),
  };
}
