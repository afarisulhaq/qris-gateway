import { get, writable } from 'svelte/store';

export type Environment = 'production' | 'sandbox';
export const environment = writable<Environment>(localStorage.getItem('qris-environment') === 'sandbox' ? 'sandbox' : 'production');
export function selectEnvironment(value: Environment) { localStorage.setItem('qris-environment', value); environment.set(value); }
export type Provider = 'gopay' | 'shopeepay';
export type Access = { environment?: Environment; access_tier?: 'free' | 'paid' | 'admin' | 'sandbox'; daily_limit?: number | null; daily_used?: number; daily_remaining?: number | null; resets_at?: string | null; subscription_expires_at: string | null; subscription_active: boolean };
export type User = Access & { id: string; name: string; email: string; role: 'admin' | 'merchant' };
export type Connection = { id: string; provider: Provider; kind: 'merchant' | 'operator'; label: string; managed: boolean; active: boolean; configured: boolean; session_present: boolean; qr_merchant_name?: string; token_status: 'unknown' | 'valid' | 'invalid' };
export type Invoice = { id: string; environment: Environment; connection_id: string | null; connection_label: string | null; external_id: string | null; description: string; amount: number; payable_amount: number; provider: Provider; status: 'pending' | 'paid' | 'expired' | 'failed' | 'cancelled'; created_at: string; expires_at: string; paid_at: string | null; checkout_url: string; qr_code: string | null; qr_url: string | null; payment_warning: string | null };
export type Dashboard = Access & { paid_total: number; pending_total: number; paid_count: number; pending_count: number; invoices: Invoice[]; connections: Connection[] };
export type Plan = { days: 7 | 30; price: number | null };
export type Rental = { id: string; days: 7 | 30; price: number; status: 'requested' | 'pending' | 'active' | 'rejected'; created_at: string; checkout_url: string | null };
export type ApiKey = { id: string; environment: Environment; label: string; prefix: string; created_at: string };
export type Delivery = { id: string; environment: Environment; event: string; status: number | null; created_at: string; error: string | null };
export type Webhook = { url: string; configured: boolean; deliveries: Delivery[] };
export type AdminData = { operator_connection_id: string | null; merchants: Pick<User, 'id' | 'name' | 'email' | 'subscription_expires_at' | 'subscription_active'>[]; rentals: (Rental & { merchant_name: string; merchant_email: string; payment_reference: string | null })[]; plans: Plan[] };
export type WalletTransaction = { id?: string; amount: number; status: string; time: string; issuer?: string; payment_type?: string };
export type GatewayLog = { timestamp: string; type?: string; message: string };
export type LoginState = { running: boolean; completed: boolean; session_present: boolean; lines: GatewayLog[] };

export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, method = 'GET', body?: unknown, scope?: Environment): Promise<T> {
  if (/^\/api\/(me|dashboard|invoices|keys|webhook)(\/|\?|$)/.test(path) || (method !== 'GET' && /^\/api\/(admin|rentals)(\/|\?|$)/.test(path))) {
    const url = new URL(path, location.origin);
    if (!url.searchParams.has('environment')) url.searchParams.set('environment', scope ?? get(environment));
    path = url.pathname + url.search;
  }
  const payload = body === undefined && ['POST', 'PUT', 'PATCH'].includes(method) ? {} : body;
  let response: Response;
  try { response = await fetch(path, { method, credentials: 'same-origin', headers: payload === undefined ? {} : { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) }); }
  catch { throw new Error('Server tidak dapat dihubungi. Periksa koneksi Anda lalu coba lagi.'); }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.message || `Permintaan gagal (HTTP ${response.status}).`, response.status);
  if (data === null) throw new Error('Respons server tidak terbaca. Coba lagi.');
  return data as T;
}
const currencyFormatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
export const message = (error: unknown) => error instanceof Error ? error.message : 'Permintaan gagal. Coba lagi.';
export const rupiah = (amount: number) => currencyFormatter.format(amount);
export const date = (value: string | null) => value ? dateFormatter.format(new Date(value)) : 'Belum aktif';
export const providerName = (provider: Provider) => provider === 'gopay' ? 'GoPay' : 'ShopeePay';
export const invoiceStatus: Record<Invoice['status'], string> = { pending: 'Menunggu pembayaran', paid: 'Lunas', expired: 'Kedaluwarsa', failed: 'Gagal', cancelled: 'Dibatalkan' };
export const rentalStatus: Record<Rental['status'], string> = { requested: 'Menunggu persetujuan manual', pending: 'Menunggu pembayaran', active: 'Aktif', rejected: 'Ditolak' };
export async function copy(text: string) {
  if (!navigator.clipboard) throw new Error('Salin otomatis membutuhkan HTTPS atau localhost. Pilih teks lalu salin secara manual.');
  try { await navigator.clipboard.writeText(text); } catch { throw new Error('Tidak dapat menyalin. Pilih teks lalu salin secara manual.'); }
}
