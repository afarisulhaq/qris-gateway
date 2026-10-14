import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, type ConnectionRow } from './db';
import { BusinessError, decrypt } from './security';

export type WalletSecrets = { api_key: string; qris_static: string; merchant_id?: string; shopee_token?: string; telegram_bot_token?: string; telegram_chat_id?: string };
export type GatewayLog = { timestamp: string; type: string; message: string };
type ManagedRow = ConnectionRow & { managed: number; active: number; label: string };
type Login = { child: ChildProcess; running: boolean; completed: boolean; lines: GatewayLog[]; timer: NodeJS.Timeout };
type Runtime = { child: ChildProcess; base_url: string; api_key: string; shopee_token?: string };
const vendorRoot = fileURLToPath(new URL('./vendor/', import.meta.url));
const runtimeRoot = resolve(process.env.GATEWAY_DATA_DIR || join(process.env.DATA_DIR || (process.env.DATABASE_PATH && process.env.DATABASE_PATH !== ':memory:' ? dirname(process.env.DATABASE_PATH) : 'data'), 'wallets'));
const processes = new Map<string, Runtime>();
const startups = new Map<string, Promise<Runtime>>();
const logins = new Map<string, Login>();
const logs = new Map<string, GatewayLog[]>();
const revisions = new Map<string, number>();
const locks = new Map<string, Promise<unknown>>();
const redactions = new Map<string, Set<string>>();
let shuttingDown = false;

export function managedRow(connectionId: string): ManagedRow {
  const row = db.query<ManagedRow, [string]>('SELECT * FROM connections WHERE id = ?').get(connectionId);
  if (!row || !row.managed || !row.active) throw new BusinessError(404, 'Wallet managed aktif tidak ditemukan.');
  return row;
}
export function walletSecrets(row: ConnectionRow): WalletSecrets { return JSON.parse(decrypt(row.encrypted_secrets)); }
export function walletDirectory(connectionId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(connectionId)) throw new BusinessError(400, 'ID wallet tidak valid.');
  return join(runtimeRoot, connectionId);
}
export async function withWalletLock<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(connectionId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  locks.set(connectionId, current);
  try { return await current; } finally { if (locks.get(connectionId) === current) locks.delete(connectionId); }
}
function rememberSecrets(connectionId: string, secrets: WalletSecrets) {
  const values = redactions.get(connectionId) || new Set<string>();
  for (const value of Object.values(secrets)) if (value) values.add(value);
  const session = join(walletDirectory(connectionId), '.GOPAY_SESI_JANGAN_DIHAPUS.json');
  try {
    const visit = (value: unknown) => {
      if (typeof value === 'string' && value.length >= 4) values.add(value);
      else if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item);
    };
    visit(JSON.parse(readFileSync(session, 'utf8')));
  } catch {}
  redactions.set(connectionId, values);
}
export function redactGatewayMessage(message: string, secrets: Iterable<string> = []): string {
  let result = message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]');
  if (/[{}]|(?:bearer|cookie|access[_ -]?token|refresh[_ -]?token|authorization|password|api[_ -]?key)\s*[:=]/i.test(result)) return '[Detail rahasia gateway disembunyikan]';
  result = result.replace(/(?:https?:\/\/|\/home\/|\/tmp\/|\/app\/|\/data\/)[^\s]+/g, '[REDACTED]')
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, '[REDACTED]').replace(/\d{4,}/g, '[REDACTED]');
  return result.slice(0, 600);
}
function record(connectionId: string, message: string, type = 'SYSTEM', target?: GatewayLog[]) {
  const entries = target || logs.get(connectionId) || [];
  const redacted = redactGatewayMessage(message, redactions.get(connectionId));
  if (!redacted.trim()) return;
  entries.push({ timestamp: now(), type, message: redacted });
  if (entries.length > 100) entries.splice(0, entries.length - 100);
  if (!target) logs.set(connectionId, entries);
}
function capture(child: ChildProcess, connectionId: string, target?: GatewayLog[]) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 16384) { record(connectionId, '[Output gateway terlalu panjang, disembunyikan]', 'INFO', target); buffer = ''; return; }
      const lines = buffer.split(/[\r\n]+/);
      buffer = lines.pop() || '';
      for (const line of lines) record(connectionId, line, stream === child.stderr ? 'ERROR' : 'INFO', target);
      if (target && /(?:masuk|input|enter|pilih|choose|select|nomor|phone|otp).{0,160}[:?]\s*$/i.test(buffer)) {
        record(connectionId, buffer, 'INFO', target);
        buffer = '';
      }
    });
    stream.on('end', () => { if (buffer) record(connectionId, buffer, stream === child.stderr ? 'ERROR' : 'INFO', target); });
  }
}
function protectedDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new BusinessError(503, 'Direktori gateway tidak aman.');
  chmodSync(path, 0o700);
}
export function prepareWallet(row: ManagedRow): { directory: string; secrets: WalletSecrets } {
  const directory = walletDirectory(row.id);
  protectedDirectory(runtimeRoot);
  protectedDirectory(directory);
  const source = join(vendorRoot, row.provider);
  if (!existsSync(join(source, 'node_modules', 'express'))) throw new BusinessError(503, `Dependensi gateway ${row.provider} belum dipasang. Operator perlu menjalankan npm ci --omit=dev --ignore-scripts di server/vendor/${row.provider}.`);
  const dependencies = join(directory, 'node_modules');
  if (existsSync(dependencies)) {
    if (!lstatSync(dependencies).isSymbolicLink() || realpathSync(dependencies) !== realpathSync(join(source, 'node_modules'))) throw new BusinessError(503, 'Direktori dependensi gateway tidak sesuai vendor.');
  } else symlinkSync(join(source, 'node_modules'), dependencies, 'dir');
  for (const name of row.provider === 'gopay' ? ['server.js', 'login.js', 'sessionManager.js', 'package.json'] : ['server.js', 'package.json']) {
    const destination = join(directory, name);
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) throw new BusinessError(503, 'Berkas gateway tidak aman.');
    copyFileSync(join(source, name), destination);
    chmodSync(destination, 0o600);
  }
  // Upstream dotenv must never load a stale or user-supplied environment file.
  for (const filename of ['.env', '.gopay_cache.json']) rmSync(join(directory, filename), { force: true });
  const session = join(directory, '.GOPAY_SESI_JANGAN_DIHAPUS.json');
  if (existsSync(session)) {
    if (lstatSync(session).isSymbolicLink() || !lstatSync(session).isFile()) throw new BusinessError(503, 'Berkas sesi gateway tidak aman.');
    chmodSync(session, 0o600);
  }
  const secrets = walletSecrets(row);
  rememberSecrets(row.id, secrets);
  return { directory, secrets };
}
function childEnvironment(row: ManagedRow, secrets: WalletSecrets, directory: string): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, TMPDIR: directory, NODE_ENV: 'production', TZ: 'Asia/Jakarta',
    PORT: '0', MANAGED_PROVIDER: row.provider, API_KEY: secrets.api_key, QRIS_STATIC: secrets.qris_static,
    GOPAY_MERCHANT_ID: secrets.merchant_id || '', SHOPEE_TOKEN: secrets.shopee_token || '',
    TELEGRAM_BOT_TOKEN: secrets.telegram_bot_token || '', TELEGRAM_CHAT_ID: secrets.telegram_chat_id || '',
  };
}
function launch(row: ManagedRow, directory: string, secrets: WalletSecrets, script: 'server.js' | 'login.js'): ChildProcess {
  return spawn(process.env.GATEWAY_NODE_BINARY || Bun.which('node') || 'node', ['--require', join(vendorRoot, 'managed-preload.cjs'), join(directory, script)], {
    cwd: directory, env: childEnvironment(row, secrets, directory), stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
}
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolveDone => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
    const deadline = setTimeout(() => { clearTimeout(timer); resolveDone(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); clearTimeout(deadline); resolveDone(); });
    child.kill('SIGTERM');
  });
}
async function start(row: ManagedRow): Promise<Runtime> {
  const revision = revisions.get(row.id) || 0;
  const { directory, secrets } = prepareWallet(row);
  const child = launch(row, directory, secrets, 'server.js');
  capture(child, row.id);
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new BusinessError(504, 'Gateway belum siap setelah 20 detik.')), 20_000);
      child.once('error', () => { clearTimeout(timer); reject(new BusinessError(503, 'Node.js gateway tidak dapat dijalankan. Periksa instalasi Node.js dan dependensi vendor.')); });
      child.once('exit', () => { clearTimeout(timer); reject(new BusinessError(502, 'Program gateway berhenti sebelum siap. Periksa log wallet.')); });
      child.on('message', message => {
        const value = message as { type?: string; port?: number };
        if (value.type === 'listening' && Number.isInteger(value.port) && value.port! > 0 && value.port! <= 65535) { clearTimeout(timer); resolvePort(value.port!); }
      });
    });
    const runtime = { child, base_url: `http://127.0.0.1:${port}`, api_key: secrets.api_key, shopee_token: secrets.shopee_token };
    const health = await fetch(runtime.base_url + '/api/health', { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!health.ok || (await health.json() as { success?: boolean }).success !== true) throw new BusinessError(502, 'Health gateway tidak valid.');
    if (shuttingDown || revision !== (revisions.get(row.id) || 0)) throw new BusinessError(409, 'Startup gateway dibatalkan karena konfigurasi berubah.');
    processes.set(row.id, runtime);
    child.once('exit', () => { if (processes.get(row.id) === runtime) processes.delete(row.id); record(row.id, 'Proses gateway berhenti.'); });
    record(row.id, 'Gateway loopback siap.');
    return runtime;
  } catch (error) { await terminate(child); throw error; }
}
export async function ensureGateway(connectionId: string): Promise<{ base_url: string; api_key: string; shopee_token?: string }> {
  if (shuttingDown) throw new BusinessError(503, 'Gateway sedang dihentikan.');
  const row = managedRow(connectionId);
  let runtime = processes.get(connectionId);
  if (runtime?.child.exitCode === null && runtime.child.signalCode === null) return runtime;
  if (logins.get(connectionId)?.running) throw new BusinessError(409, 'Login OTP sedang berjalan. Selesaikan login sebelum memakai wallet.');
  let startup = startups.get(connectionId);
  if (!startup) { startup = start(row); startups.set(connectionId, startup); }
  try { return await startup; } finally { if (startups.get(connectionId) === startup) startups.delete(connectionId); }
}
export async function stopGateway(connectionId: string): Promise<void> {
  revisions.set(connectionId, (revisions.get(connectionId) || 0) + 1);
  const runtime = processes.get(connectionId);
  processes.delete(connectionId);
  if (runtime) await terminate(runtime.child);
  const startup = startups.get(connectionId);
  if (startup) { try { await startup; } catch {} }
}
export async function shutdownGateways(): Promise<void> {
  shuttingDown = true;
  await Promise.all([...new Set([...processes.keys(), ...startups.keys()])].map(stopGateway));
  await Promise.all([...logins.values()].map(async login => { clearTimeout(login.timer); await terminate(login.child); }));
}
export function sessionPresent(connectionId: string): boolean {
  const filename = join(walletDirectory(connectionId), '.GOPAY_SESI_JANGAN_DIHAPUS.json');
  try { return !lstatSync(filename).isSymbolicLink() && lstatSync(filename).isFile() && lstatSync(filename).size > 2; } catch { return false; }
}
export async function gatewayRequest(connectionId: string, path: string, body?: Record<string, unknown>, requireSuccess = true): Promise<Record<string, unknown>> {
  const runtime = await ensureGateway(connectionId);
  const response = await fetch(runtime.base_url + path, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-API-Key': runtime.api_key, ...(runtime.shopee_token ? { 'X-Shopee-Token': runtime.shopee_token } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000), redirect: 'error',
  }).catch(() => { throw new BusinessError(502, 'Gateway tidak dapat dijangkau.'); });
  if (!response.ok) throw new BusinessError(502, `Gateway menolak permintaan (HTTP ${response.status}).`);
  const content = await response.text();
  if (content.length > 1_000_000) throw new BusinessError(502, 'Respons gateway terlalu besar.');
  let value: Record<string, unknown>;
  try { value = JSON.parse(content); } catch { throw new BusinessError(502, 'Respons gateway bukan JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (requireSuccess && value.success !== true)) throw new BusinessError(502, 'Gateway gagal memproses permintaan. Periksa sesi wallet.');
  return value;
}
export async function testManagedWallet(connectionId: string): Promise<{ valid: boolean; message: string }> {
  const result = await gatewayRequest(connectionId, '/token-status', undefined, false);
  const data = result.data as { token_status?: unknown } | undefined;
  const valid = result.success === true && data?.token_status === 'valid';
  return { valid, message: valid ? 'Sesi wallet valid menurut gateway.' : 'Sesi wallet tidak valid. Login ulang GoPay atau rotasi token ShopeePay.' };
}
export async function gatewayLogs(connectionId: string): Promise<GatewayLog[]> {
  const row = managedRow(connectionId);
  rememberSecrets(connectionId, walletSecrets(row));
  const result = await gatewayRequest(connectionId, '/api/logs');
  const entries = row.provider === 'shopeepay' ? (result.data as { logs?: unknown } | undefined)?.logs : result.logs;
  if (!Array.isArray(entries)) throw new BusinessError(502, 'Gateway tidak memberikan log yang valid.');
  const upstream = entries.slice(-100).map(item => {
    const value = item as Record<string, unknown>;
    const level = value.type ?? value.level;
    return { timestamp: typeof value.timestamp === 'string' ? value.timestamp : now(), type: typeof level === 'string' ? level.slice(0, 20) : 'INFO', message: redactGatewayMessage(String(value.message || ''), redactions.get(connectionId)) };
  });
  return [...upstream, ...(logs.get(connectionId) || [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-100);
}
export async function startLogin(connectionId: string) {
  const row = managedRow(connectionId);
  if (row.provider !== 'gopay') throw new BusinessError(400, 'OTP hanya tersedia melalui program GoPay.');
  if (logins.get(connectionId)?.running) throw new BusinessError(409, 'Login OTP sudah berjalan.');
  await stopGateway(connectionId);
  const { directory, secrets } = prepareWallet(row);
  const child = launch(row, directory, secrets, 'login.js');
  const timer = setTimeout(() => { record(connectionId, 'Login OTP melewati batas 5 menit.'); void terminate(child); }, 300_000);
  const login: Login = { child, running: true, completed: false, lines: [], timer };
  logins.set(connectionId, login);
  capture(child, connectionId, login.lines);
  child.once('error', () => { clearTimeout(timer); login.running = false; record(connectionId, 'Program OTP tidak dapat dijalankan.', 'ERROR', login.lines); });
  child.once('exit', code => { clearTimeout(timer); login.running = false; login.completed = code === 0 && sessionPresent(connectionId); rememberSecrets(connectionId, secrets); record(connectionId, login.completed ? 'Program login selesai; uji sesi untuk memastikan validitas.' : 'Program login berhenti tanpa sesi baru yang terkonfirmasi.', 'SYSTEM', login.lines); });
  return loginStatus(connectionId);
}
export function loginStatus(connectionId: string) {
  const login = logins.get(connectionId);
  return { running: Boolean(login?.running), completed: Boolean(login?.completed), session_present: sessionPresent(connectionId), lines: (login?.lines || []).map(({ timestamp, message }) => ({ timestamp, message })) };
}
export function loginInput(connectionId: string, value: string) {
  const login = logins.get(connectionId);
  if (!login?.running || !login.child.stdin?.writable) throw new BusinessError(409, 'Tidak ada proses login OTP aktif.');
  if (!value.trim() || value.length > 200 || /[\r\n\x00-\x1f\x7f]/.test(value)) throw new BusinessError(400, 'Input terminal harus satu baris, maksimal 200 karakter.');
  redactions.get(connectionId)?.add(value);
  login.child.stdin.write(value + '\n');
  return { accepted: true };
}
export async function stopLogin(connectionId: string) {
  const login = logins.get(connectionId);
  if (login?.running) { clearTimeout(login.timer); await terminate(login.child); login.running = false; }
}
export async function importSession(connectionId: string, session: unknown) {
  const row = managedRow(connectionId);
  if (row.provider !== 'gopay') throw new BusinessError(400, 'Import sesi hanya untuk GoPay.');
  let parsed: unknown = session;
  if (typeof session === 'string') { if (session.length > 65536) throw new BusinessError(400, 'Sesi maksimal 64 KiB.'); try { parsed = JSON.parse(session); } catch { throw new BusinessError(400, 'Sesi harus berupa JSON valid.'); } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BusinessError(400, 'Impor objek JSON dari berkas sesi program GoPay.');
  const serialized = JSON.stringify(parsed);
  if (serialized.length > 65536) throw new BusinessError(400, 'Sesi maksimal 64 KiB.');
  await stopLogin(connectionId);
  await stopGateway(connectionId);
  const { directory } = prepareWallet(row);
  const filename = join(directory, '.GOPAY_SESI_JANGAN_DIHAPUS.json');
  const previous = existsSync(filename) ? readFileSync(filename) : undefined;
  writeFileSync(filename + '.incoming', serialized, { mode: 0o600 });
  renameSync(filename + '.incoming', filename);
  try {
    const result = await testManagedWallet(connectionId);
    if (!result.valid) throw new BusinessError(400, 'Sesi impor ditolak oleh gateway GoPay. Sesi sebelumnya dipertahankan.');
    return result;
  } catch (error) {
    await stopGateway(connectionId);
    if (previous) writeFileSync(filename, previous, { mode: 0o600 }); else rmSync(filename, { force: true });
    throw error;
  }
}
export async function refreshSession(connectionId: string) {
  if (managedRow(connectionId).provider !== 'gopay') throw new BusinessError(400, 'Refresh sesi hanya untuk GoPay.');
  await ensureGateway(connectionId);
  const child = processes.get(connectionId)!.child;
  const request = crypto.randomUUID();
  const success = await new Promise<boolean>((resolveResult, reject) => {
    const finish = (value: boolean) => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); resolveResult(value); };
    const onMessage = (message: unknown) => { const value = message as { type?: string; request?: string; success?: boolean }; if (value.type === 'refresh-result' && value.request === request) finish(value.success === true); };
    const onExit = () => finish(false);
    const timer = setTimeout(() => { child.off('message', onMessage); child.off('exit', onExit); reject(new BusinessError(504, 'Refresh GoPay melewati batas waktu.')); }, 20_000);
    child.on('message', onMessage); child.once('exit', onExit);
    child.send({ type: 'refresh', request }, error => { if (error) finish(false); });
  });
  if (!success) throw new BusinessError(502, 'Program GoPay gagal memperbarui sesi. Login OTP mungkin diperlukan.');
  return testManagedWallet(connectionId);
}
