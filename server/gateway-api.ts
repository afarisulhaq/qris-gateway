import { Elysia } from 'elysia';
import { atomic, db, id, type ConnectionRow } from './db';
import { BusinessError, encrypt, newSecret, objectBody, provider, rateLimit, sessionUser, text } from './security';
import { validateStaticQris } from './qris';
import { gatewayLogs, gatewayRequest, importSession, loginInput, loginStatus, refreshSession, sessionPresent, startLogin, stopGateway, stopLogin, testManagedWallet, walletSecrets, withWalletLock, type WalletSecrets } from './gateway-runtime';
import { expireInvoices } from './domain';

type WalletRow = ConnectionRow & { managed: number; active: number; label: string };
const tokenStatuses = new Map<string, 'valid' | 'invalid'>();

async function ownedWallet(userId: string, connectionId: string): Promise<WalletRow> {
  const row = await db.query<WalletRow, [string, string]>('SELECT * FROM connections WHERE id = $1 AND user_id = $2 AND managed = 1 AND active = 1').get(connectionId, userId);
  if (!row) throw new BusinessError(404, 'Wallet aktif milik Anda tidak ditemukan.');
  return row;
}
async function refusePending(connectionId: string) {
  await expireInvoices();
  const pending = await db.query<{ count: number }, [string]>("SELECT count(*)::integer AS count FROM invoices WHERE connection_id = $1 AND environment = 'production' AND status = 'pending' AND creation_state != 'failed'").get(connectionId);
  if (pending?.count) throw new BusinessError(409, 'Selesaikan atau batalkan invoice produksi pending sebelum mengganti akun, QRIS, atau sesi wallet.');
}
function walletDto(row: WalletRow) {
  const secrets = walletSecrets(row);
  let qr_merchant_name: string | undefined;
  if (row.managed && secrets.qris_static) qr_merchant_name = validateStaticQris(secrets.qris_static).merchant_name;
  return {
    id: row.id, provider: row.provider, label: row.label || row.provider, kind: row.kind, managed: Boolean(row.managed), active: Boolean(row.active),
    configured: Boolean(row.managed && secrets.qris_static && (row.provider === 'gopay' ? secrets.merchant_id : secrets.shopee_token)),
    session_present: Boolean(row.managed && (row.provider === 'gopay' ? sessionPresent(row.id) : secrets.shopee_token)), qr_merchant_name,
    token_status: row.managed ? tokenStatuses.get(row.id) || 'unknown' : 'unknown',
  };
}
export async function listConnections(userId: string) {
  return (await db.query<WalletRow, [string]>('SELECT * FROM connections WHERE user_id = $1 AND active = 1 ORDER BY label, id').all(userId)).map(walletDto);
}
function configuredSecrets(body: Record<string, unknown>, walletProvider: 'gopay' | 'shopeepay', previous?: WalletSecrets): WalletSecrets {
  const qris = body.qris_static === undefined && previous ? validateStaticQris(previous.qris_static) : validateStaticQris(body.qris_static);
  const result: WalletSecrets = { ...previous, api_key: previous?.api_key || newSecret(), qris_static: qris.payload };
  for (const field of ['merchant_id', 'shopee_token', 'telegram_bot_token', 'telegram_chat_id'] as const) {
    const value = text(body, field, field === 'shopee_token' ? 8192 : 256, false);
    if (value) {
      if (/[\r\n\x00-\x1f\x7f]/.test(value)) throw new BusinessError(400, `${field} tidak boleh mengandung karakter kontrol.`);
      result[field] = value;
    }
  }
  if (walletProvider === 'gopay' && !result.merchant_id) throw new BusinessError(400, 'merchant_id GoPay wajib diisi untuk memilih akun mutasi yang benar.');
  if (walletProvider === 'shopeepay' && !result.shopee_token) throw new BusinessError(400, 'Token merchant ShopeePay wajib diisi.');
  if (walletProvider === 'gopay' && (result.telegram_bot_token || result.telegram_chat_id || result.shopee_token)) throw new BusinessError(400, 'Token Shopee dan Telegram hanya digunakan oleh program ShopeePay.');
  if (walletProvider === 'shopeepay' && Boolean(result.telegram_bot_token) !== Boolean(result.telegram_chat_id)) throw new BusinessError(400, 'Isi token bot dan chat ID Telegram bersama-sama.');
  return result;
}
function dateSeconds(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,11}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new BusinessError(400, 'Waktu mutasi harus timestamp Unix detik.');
  return Number(value);
}
async function transactions(row: WalletRow, query: Record<string, unknown>) {
  const range = query.range || 'recent';
  if (range !== 'recent' && range !== 'month') throw new BusinessError(400, 'Rentang mutasi harus recent atau month.');
  let path = range === 'month' ? '/transactions/all' : '/transactions';
  if (row.provider === 'shopeepay' && (query.start_time !== undefined || query.end_time !== undefined)) throw new BusinessError(400, 'Gateway ShopeePay hanya mendokumentasikan mutasi terbaru atau bulan ini, tanpa filter tanggal khusus.');
  if (row.provider === 'gopay') {
    const end = dateSeconds(query.end_time, Math.floor(Date.now() / 1000));
    const jakarta = new Date(Date.now() + 7 * 3600_000);
    const monthStart = Date.UTC(jakarta.getUTCFullYear(), jakarta.getUTCMonth(), 1) / 1000 - 7 * 3600;
    const start = dateSeconds(query.start_time, range === 'month' ? monthStart : end - 3 * 86400);
    if (start >= end || end > Math.floor(Date.now() / 1000) + 60) throw new BusinessError(400, 'Rentang waktu mutasi tidak valid.');
    path = `/transactions?startTime=${start}&endTime=${end}&pageSize=100`;
  }
  const result = await gatewayRequest(row.id, path);
  const data = result.data as { transactions?: unknown } | undefined;
  if (!Array.isArray(data?.transactions)) throw new BusinessError(502, 'Gateway tidak memberikan daftar mutasi.');
  let totalAmount = 0;
  const normalized = data.transactions.map(item => {
    if (!item || typeof item !== 'object') throw new BusinessError(502, 'Format transaksi gateway tidak valid.');
    const value = item as Record<string, unknown>;
    const amount = typeof value.amount === 'number' ? value.amount : Number(value.amount);
    if (!Number.isSafeInteger(amount) || typeof value.status !== 'string' || typeof value.time !== 'string') throw new BusinessError(502, 'Data transaksi gateway tidak lengkap.');
    totalAmount += amount;
    const localTime = row.provider === 'shopeepay' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value.time) ? value.time.replace(' ', 'T') + '+07:00' : value.time;
    const timestamp = new Date(localTime);
    if (!Number.isFinite(timestamp.getTime())) throw new BusinessError(502, 'Waktu transaksi gateway tidak valid.');
    const transactionId = value.transaction_id ?? value.transactionId;
    return { id: typeof transactionId === 'string' || typeof transactionId === 'number' ? String(transactionId).slice(0, 200) : undefined, amount, status: value.status.slice(0, 40), time: timestamp.toISOString(), issuer: typeof value.issuer === 'string' ? value.issuer.slice(0, 100) : undefined, payment_type: typeof value.payment_type === 'string' ? value.payment_type.slice(0, 50) : undefined };
  });
  return { transactions: normalized, total_amount: totalAmount, ...(row.provider === 'gopay' ? { limit: 100, note: 'Program GoPay hanya mengembalikan maksimal 100 transaksi per rentang, bukan ekspor lengkap.' } : {}) };
}

export const gatewayRoutes = new Elysia({ name: 'managed-gateways' })
  .get('/api/connections', async ({ request }) => await listConnections((await sessionUser(request)).id))
  .post('/api/connections', async ({ request, body }) => {
    const user = await sessionUser(request);
    rateLimit(`wallet-create:${user.id}`, 20, 3600_000);
    const input = objectBody(body);
    const walletProvider = provider(input.provider);
    const label = text(input, 'label', 80);
    const secrets = configuredSecrets(input, walletProvider);
    const connectionId = id();
    await db.query('INSERT INTO connections (id, user_id, provider, base_url, encrypted_secrets, kind, label, managed, active) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 1)').run(connectionId, user.id, walletProvider, 'http://127.0.0.1:0', encrypt(JSON.stringify(secrets)), 'merchant', label);
    return walletDto(await ownedWallet(user.id, connectionId));
  })
  .put('/api/connections/:id', async ({ request, params, body }) => {
    const user = await sessionUser(request);
    return withWalletLock(params.id, async () => {
      const row = await ownedWallet(user.id, params.id);
      const input = objectBody(body);
      if (input.provider !== undefined && input.provider !== row.provider) throw new BusinessError(400, 'Provider wallet tidak dapat diubah. Buat wallet baru.');
      const previous = walletSecrets(row);
      const secrets = configuredSecrets(input, row.provider, previous);
      const label = input.label === undefined ? row.label : text(input, 'label', 80);
      const accountChanged = secrets.qris_static !== previous.qris_static || secrets.merchant_id !== previous.merchant_id || secrets.shopee_token !== previous.shopee_token;
      if (accountChanged) await refusePending(row.id);
      await stopLogin(row.id);
      await stopGateway(row.id);
      await atomic(async () => {
        if (accountChanged) await refusePending(row.id);
        await db.query('UPDATE connections SET label = $1, encrypted_secrets = $2 WHERE id = $3 AND user_id = $4').run(label, encrypt(JSON.stringify(secrets)), row.id, user.id);
      });
      tokenStatuses.delete(row.id);
      return walletDto(await ownedWallet(user.id, row.id));
    });
  })
  .delete('/api/connections/:id', async ({ request, params }) => {
    const user = await sessionUser(request);
    return withWalletLock(params.id, async () => {
      const row = await db.query<WalletRow, [string, string]>('SELECT * FROM connections WHERE id = $1 AND user_id = $2 AND active = 1').get(params.id, user.id);
      if (!row) throw new BusinessError(404, 'Wallet milik Anda tidak ditemukan.');
      await atomic(async () => { await refusePending(row.id); await db.query('UPDATE connections SET active = 0 WHERE id = $1 AND user_id = $2').run(row.id, user.id); });
      await stopLogin(row.id); await stopGateway(row.id); tokenStatuses.delete(row.id);
      return { success: true };
    });
  })
  .post('/api/connections/:id/test', async ({ request, params }) => {
    const user = await sessionUser(request); const row = await ownedWallet(user.id, params.id);
    rateLimit(`wallet-test:${row.id}`, 10, 60_000);
    const result = await testManagedWallet(row.id);
    tokenStatuses.set(row.id, result.valid ? 'valid' : 'invalid');
    return result;
  })
  .get('/api/connections/:id/transactions', async ({ request, params, query }) => transactions(await ownedWallet((await sessionUser(request)).id, params.id), query))
  .get('/api/connections/:id/logs', async ({ request, params }) => ({ logs: await gatewayLogs((await ownedWallet((await sessionUser(request)).id, params.id)).id) }))
  .post('/api/connections/:id/login/start', async ({ request, params }) => {
    const user = await sessionUser(request);
    return withWalletLock(params.id, async () => { const row = await ownedWallet(user.id, params.id); await refusePending(row.id); rateLimit(`wallet-login:${row.id}`, 5, 3600_000); tokenStatuses.delete(row.id); return await startLogin(row.id); });
  })
  .post('/api/connections/:id/login/input', async ({ request, params, body }) => {
    const row = await ownedWallet((await sessionUser(request)).id, params.id);
    if (row.provider !== 'gopay') throw new BusinessError(400, 'OTP hanya untuk GoPay.');
    rateLimit(`wallet-input:${row.id}`, 30, 60_000);
    return loginInput(row.id, text(objectBody(body), 'value', 200));
  })
  .get('/api/connections/:id/login', async ({ request, params }) => loginStatus((await ownedWallet((await sessionUser(request)).id, params.id)).id))
  .post('/api/connections/:id/session', async ({ request, params, body }) => {
    const user = await sessionUser(request); const input = objectBody(body);
    return withWalletLock(params.id, async () => { const row = await ownedWallet(user.id, params.id); await refusePending(row.id); rateLimit(`wallet-session:${row.id}`, 5, 60_000); const result = await importSession(row.id, input.session); tokenStatuses.set(row.id, result.valid ? 'valid' : 'invalid'); return result; });
  })
  .post('/api/connections/:id/refresh', async ({ request, params }) => {
    const user = await sessionUser(request);
    return withWalletLock(params.id, async () => { const row = await ownedWallet(user.id, params.id); rateLimit(`wallet-refresh:${row.id}`, 5, 60_000); const result = await refreshSession(row.id); tokenStatuses.set(row.id, result.valid ? 'valid' : 'invalid'); return result; });
  })
  .post('/api/connections/:id/token', async ({ request, params, body }) => {
    const user = await sessionUser(request); const input = objectBody(body);
    return withWalletLock(params.id, async () => {
      const row = await ownedWallet(user.id, params.id);
      if (row.provider !== 'shopeepay') throw new BusinessError(400, 'Rotasi token manual hanya untuk ShopeePay.');
      const token = text(input, 'shopee_token', 8192);
      if (/[\r\n\x00-\x1f\x7f]/.test(token)) throw new BusinessError(400, 'Token tidak boleh mengandung karakter kontrol.');
      await refusePending(row.id);
      rateLimit(`wallet-token:${row.id}`, 5, 60_000);
      await stopGateway(row.id);
      const secrets = { ...walletSecrets(row), shopee_token: token };
      await db.query('UPDATE connections SET encrypted_secrets = $1 WHERE id = $2 AND user_id = $3').run(encrypt(JSON.stringify(secrets)), row.id, user.id);
      tokenStatuses.delete(row.id);
      const result = await testManagedWallet(row.id);
      tokenStatuses.set(row.id, result.valid ? 'valid' : 'invalid');
      return result;
    });
  });
