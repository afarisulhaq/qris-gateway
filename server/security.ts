import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, now } from './db';
import type { Environment, UserRow } from './db';

export class BusinessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function encryptionKey(): Buffer {
  const value = process.env.ENCRYPTION_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new BusinessError(503, 'ENCRYPTION_KEY harus berisi 64 karakter heksadesimal sebelum setup atau penyimpanan rahasia.');
  }
  return Buffer.from(value, 'hex');
}

export function encrypt(value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

export function decrypt(value: string): string {
  try {
    const [nonce, tag, encrypted, extra] = value.split('.');
    if (!nonce || !tag || !encrypted || extra) throw new Error('Invalid ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(nonce, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw new BusinessError(503, 'Rahasia tersimpan tidak dapat dibuka. Periksa ENCRYPTION_KEY yang digunakan saat penyimpanan.');
  }
}

export const hashSecret = (value: string): string => createHash('sha256').update(value).digest('hex');
export const newSecret = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function constantEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

export function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BusinessError(400, 'Kirim objek JSON yang valid.');
  return body as Record<string, unknown>;
}

export function text(body: Record<string, unknown>, field: string, max: number, required = true): string {
  const value = body[field];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new BusinessError(400, `${field} wajib berupa teks${required ? ' yang tidak kosong' : ''}, maksimal ${max} karakter.`);
  }
  return value.trim();
}

export function money(value: unknown, field = 'amount'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
    throw new BusinessError(400, `${field} harus bilangan bulat antara Rp1 dan Rp1.000.000.000.`);
  }
  return value;
}

export function duration(value: unknown): 7 | 30 {
  if (value !== 7 && value !== 30) throw new BusinessError(400, 'Pilih durasi 7 atau 30 hari.');
  return value;
}

export function provider(value: unknown): 'gopay' | 'shopeepay' {
  if (value !== 'gopay' && value !== 'shopeepay') throw new BusinessError(400, 'Provider harus gopay atau shopeepay.');
  return value;
}

export function publicUser(user: UserRow) {
  return {
    id: user.id, name: user.name, email: user.email, role: user.role,
    subscription_expires_at: user.subscription_expires_at,
    subscription_active: user.role === 'admin' || Boolean(user.subscription_expires_at && user.subscription_expires_at > now()),
  };
}


export function sessionUser(request: Request): UserRow {
  const cookie = request.headers.get('cookie') || '';
  const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('qris_session='))?.slice(13);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BusinessError(401, 'Silakan masuk terlebih dahulu.');
  const user = db.query<UserRow, [string, string]>(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashSecret(token), now());
  if (!user) throw new BusinessError(401, 'Sesi sudah berakhir. Silakan masuk kembali.');
  return user;
}

export function apiUser(request: Request): UserRow & { environment: Environment } {
  const key = request.headers.get('x-api-key');
  if (!key || key.length > 200) throw new BusinessError(401, 'X-API-Key wajib diisi.');
  const user = db.query<UserRow & { environment: Environment }, [string]>(`
    SELECT users.*, api_keys.environment FROM api_keys JOIN users ON users.id = api_keys.user_id WHERE api_keys.key_hash = ?
  `).get(hashSecret(key));
  if (!user) throw new BusinessError(401, 'API key tidak valid atau sudah dicabut.');
  const requested = new URL(request.url).searchParams.get('environment');
  if (requested !== null && requested !== user.environment) {
    throw new BusinessError(400, 'Environment harus sesuai dengan API key yang digunakan.');
  }
  return user;
}

export function adminUser(request: Request): UserRow {
  const user = sessionUser(request);
  if (user.role !== 'admin') throw new BusinessError(403, 'Hanya admin yang dapat melakukan tindakan ini.');
  return user;
}

export function sessionCookie(token: string, maxAge = 60 * 60 * 24 * 7): string {
  const secure = process.env.NODE_ENV === 'production' || process.env.APP_URL?.startsWith('https://');
  return `qris_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function mutationGuard(request: Request): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new BusinessError(403, 'Permintaan lintas situs ditolak.');
  const origin = request.headers.get('origin');
  if (origin) {
    const allowed = new Set([new URL(request.url).origin]);
    if (process.env.APP_URL) allowed.add(new URL(process.env.APP_URL).origin);
    if (process.env.NODE_ENV !== 'production') {
      allowed.add('http://localhost:5173');
      allowed.add('http://127.0.0.1:5173');
    }
    if (!allowed.has(origin)) throw new BusinessError(403, 'Origin permintaan tidak diizinkan.');
  }
  if (request.method !== 'DELETE' && !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new BusinessError(415, 'Gunakan Content-Type: application/json.');
  }
}

const rateLimits = new Map<string, { count: number; expires: number }>();
export function rateLimit(key: string, maximum: number, windowMs: number): void {
  const time = Date.now();
  if (rateLimits.size >= 10_000) {
    for (const [entry, state] of rateLimits) if (state.expires <= time) rateLimits.delete(entry);
    if (rateLimits.size >= 10_000 && !rateLimits.has(key)) throw new BusinessError(429, 'Terlalu banyak permintaan. Coba lagi nanti.');
  }
  let state = rateLimits.get(key);
  if (!state || state.expires <= time) {
    state = { count: 0, expires: time + windowMs };
    rateLimits.set(key, state);
  }
  state.count++;
  if (state.count > maximum) throw new BusinessError(429, 'Terlalu banyak permintaan. Coba lagi nanti.');
}
