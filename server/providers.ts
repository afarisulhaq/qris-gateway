
export type ProviderName = 'gopay' | 'shopeepay';
export type GatewayConnection = {
  id: string;
  provider: ProviderName;
  base_url: string;
  api_key: string;
  shopee_token?: string;
  managed?: boolean;
};

type JsonObject = Record<string, unknown>;

function failure(message: string, status = 502): never {
  throw Object.assign(new Error(message), { status });
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('Respons gateway bukan objek JSON yang valid.');
  return value as JsonObject;
}

export function validateGatewayUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { failure('URL gateway tidak valid.', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    failure('Gunakan origin HTTP/HTTPS gateway tanpa path, query, atau kredensial.', 400);
  }
  const allowed = (process.env.GATEWAY_ALLOWED_HOSTS || 'localhost:3000,localhost:3001,127.0.0.1:3000,127.0.0.1:3001').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(url.host.toLowerCase())) failure('Host gateway belum diizinkan operator dalam GATEWAY_ALLOWED_HOSTS.', 400);
  return url.origin;
}

async function resolveConnection(connection: GatewayConnection): Promise<GatewayConnection> {
  if (!connection.managed) return connection;
  const { ensureGateway } = await import('./gateway-runtime');
  return { ...connection, ...await ensureGateway(connection.id) };
}

function gatewayOrigin(connection: GatewayConnection): string {
  if (!connection.managed) return validateGatewayUrl(connection.base_url);
  const url = new URL(connection.base_url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    failure('Origin gateway terkelola tidak valid.');
  }
  return url.origin;
}

function headers(connection: GatewayConnection): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': connection.api_key };
  if (connection.provider === 'shopeepay' && connection.shopee_token) result['X-Shopee-Token'] = connection.shopee_token;
  return result;
}

async function request(connection: GatewayConnection, path: string, body?: JsonObject, successRequired = true): Promise<JsonObject> {
  const url = gatewayOrigin(connection) + path;
  let response: Response;
  try {
    response = await fetch(url, { method: body ? 'POST' : 'GET', headers: headers(connection), body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(12_000) });
  } catch { failure('Gateway tidak dapat dijangkau. Periksa alamat, layanan, dan sesi merchant.'); }
  if (!response.ok) failure(`Gateway menolak permintaan (HTTP ${response.status}). Periksa API key dan sesi merchant.`);
  let data: JsonObject;
  try { data = object(await response.json()); } catch { failure('Gateway mengirim respons yang tidak valid.'); }
  if (successRequired && data.success !== true) failure('Gateway gagal memproses permintaan. Periksa konfigurasi QRIS dan sesi merchant.');
  return data;
}

function timestamp(value: unknown, provider: ProviderName): string {
  if (typeof value !== 'string' || !value.trim()) failure('Gateway tidak memberikan waktu transaksi yang valid.');
  // ShopeePay documents Jakarta-local timestamps without an offset.
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value) && provider === 'shopeepay' ? value.replace(' ', 'T') + '+07:00' : value;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) failure('Format waktu gateway tidak valid.');
  if (provider === 'gopay' && !/(Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) failure('Waktu GoPay harus menyertakan zona waktu.');
  return date.toISOString();
}

function money(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) failure('Nominal dari gateway tidak valid.');
  return parsed;
}

async function readQrPayload(connection: GatewayConnection, qrUrl: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(qrUrl, { headers: headers(connection), redirect: 'manual', signal: AbortSignal.timeout(12_000) });
  } catch { failure('QRIS berhasil dibuat tetapi QR gateway tidak dapat dibaca.'); }
  if (response.status < 300 || response.status > 399) return null;
  const location = response.headers.get('location');
  if (!location) return null;
  let target: URL;
  try { target = new URL(location, qrUrl); } catch { return null; }
  // Read the payload from the documented image redirect without sending it to an image service.
  if (target.protocol !== 'https:' || target.hostname !== 'api.qrserver.com') return null;
  const payload = target.searchParams.get('data');
  return payload && payload.startsWith('000201') ? payload : null;
}

export async function createPayment(connection: GatewayConnection, amount: number): Promise<{ reference: string; qr_code: string | null; qr_url: string | null; expires_at: string }> {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000) failure('Nominal harus berupa rupiah bulat antara 1 dan 1.000.000.000.', 400);
  connection = await resolveConnection(connection);
  const response = await request(connection, '/create-qris', { amount });
  const data = object(response.data);
  if (money(data.amount) !== amount) failure('Nominal QRIS gateway berbeda dengan nominal invoice.');
  if (typeof data.qris_url !== 'string') failure('Gateway tidak memberikan URL QRIS.');
  let upstream: URL;
  try { upstream = new URL(data.qris_url); } catch { failure('URL QRIS gateway tidak valid.'); }
  if (!/^\/qr\/[A-Za-z0-9_-]+$/.test(upstream.pathname) || upstream.search || upstream.hash || upstream.username || upstream.password) failure('URL QRIS gateway tidak sesuai kontrak.');
  const qrUrl = gatewayOrigin(connection) + upstream.pathname;
  const expiresAt = timestamp(data.expires_at, connection.provider);
  if (new Date(expiresAt).getTime() <= Date.now()) failure('Gateway memberikan QRIS yang sudah kedaluwarsa.');
  const reference = connection.provider === 'gopay' ? data.trx_id : upstream.pathname.split('/').pop();
  if (typeof reference !== 'string' || !reference) failure('Gateway tidak memberikan referensi pembayaran.');
  let qrCode = typeof data.qris_code === 'string' && data.qris_code.startsWith('000201') ? data.qris_code : connection.provider === 'shopeepay' ? await readQrPayload(connection, qrUrl) : null;
  if (connection.provider === 'gopay' && !qrCode) failure('GoPay tidak memberikan payload QRIS yang valid.');
  if (connection.managed) {
    if (!qrCode) failure('Gateway terkelola tidak memberikan payload QRIS.');
    const { validatePaymentQris } = await import('./qris');
    qrCode = validatePaymentQris(qrCode, amount).payload;
  }
  return { reference, qr_code: qrCode, qr_url: connection.managed ? null : qrUrl, expires_at: expiresAt };
}

export async function checkPayment(connection: GatewayConnection, invoice: { reference: string; amount: number; created_at: string; expires_at: string }): Promise<{ paid: boolean; transaction_id?: string; amount?: number; paid_at?: string }> {
  connection = await resolveConnection(connection);
  const start = new Date(invoice.created_at).getTime();
  const end = new Date(invoice.expires_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) failure('Rentang waktu invoice tidak valid.', 400);
  const response = await request(connection, '/check-payment', connection.provider === 'gopay'
    ? { amount: invoice.amount, startTime: invoice.created_at, endTime: invoice.expires_at, trx_id: invoice.reference }
    : { amount: invoice.amount, startTime: Math.floor(start / 1000) });
  if (response.paid === false) return { paid: false };
  if (response.paid !== true) failure('Gateway tidak memberikan status pembayaran yang valid.');
  let transaction = object(response.transaction);
  const id = connection.provider === 'gopay' ? transaction.transaction_id : transaction.transactionId;
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id)) failure('Bukti pembayaran tidak memiliki ID transaksi.');
  if (connection.provider === 'gopay') {
    if (transaction.payment_type !== 'QRIS') failure('Bukti GoPay bukan transaksi QRIS.');
    // Upstream /check-payment also matches refunds; corroborate the captured/settled state.
    const history = await request(connection, `/transactions?startTime=${Math.floor(start / 1000)}&endTime=${Math.ceil(Math.min(Date.now(), end) / 1000)}&pageSize=100`);
    const transactions = object(history.data).transactions;
    if (!Array.isArray(transactions)) failure('Riwayat GoPay tidak tersedia untuk memverifikasi status transaksi.');
    const match = transactions.find(value => value && typeof value === 'object' && String((value as JsonObject).transaction_id) === String(id));
    if (!match) failure('Bukti pembayaran GoPay tidak ditemukan pada riwayat merchant.');
    transaction = object(match);
    if (!['settlement', 'capture'].includes(String(transaction.status).toLowerCase())) failure('Transaksi GoPay belum capture/settlement atau sudah direfund.');
  } else if (transaction.status !== 'success') {
    failure('Transaksi ShopeePay belum sukses.');
  }
  const amount = money(transaction.amount);
  const paidAt = timestamp(transaction.time, connection.provider);
  const paidTime = new Date(paidAt).getTime();
  const earliest = connection.provider === 'shopeepay' ? Math.floor(start / 1000) * 1000 : start;
  if (amount !== invoice.amount || paidTime < earliest || paidTime > end || paidTime > Date.now() + 5_000) failure('Nominal atau waktu bukti pembayaran tidak cocok dengan invoice.');
  return { paid: true, transaction_id: String(id), amount, paid_at: paidAt };
}

export async function testConnection(connection: GatewayConnection): Promise<{ valid: boolean; message: string }> {
  connection = await resolveConnection(connection);
  const result = await request(connection, '/token-status', undefined, false);
  const valid = object(result.data).token_status === 'valid';
  return { valid, message: valid ? 'Sesi merchant aktif. Pastikan QRIS statis gateway sesuai akun merchant ini.' : 'Sesi merchant tidak aktif. Login OTP GoPay atau perbarui token ShopeePay di gateway.' };
}
