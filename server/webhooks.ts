import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { createHmac } from 'node:crypto';
import { db, atomic, now } from './db';
import type { Environment } from './db';
import { BusinessError, decrypt, encrypt, newSecret } from './security';

type Delivery = {
  id: string; user_id: string; environment: Environment; event: string; payload: string; url: string;
  encrypted_secret: string; attempts: number; status: number | null;
  error: string | null; created_at: string; delivered_at: string | null;
};

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const first = Number.parseInt(address.split(':')[0] || '0', 16);
    if (first < 0x2000 || first > 0x3fff || first === 0x2002) return false;
    const second = Number.parseInt(address.split(':')[1] || '0', 16);
    if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return false;
    if (first === 0x3fff && second <= 0xfff) return false;
    return true;
  }
  return false;
}

export async function validateWebhookUrl(raw: string): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new BusinessError(400, 'URL webhook tidak valid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || raw.length > 2048) {
    throw new BusinessError(400, 'Webhook harus berupa URL HTTPS publik tanpa kredensial atau fragmen.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || /\.(localhost|local|internal|test|invalid|example|onion)$/.test(hostname)) {
    throw new BusinessError(400, 'Webhook tidak boleh mengarah ke jaringan lokal.');
  }
  const family = isIP(hostname);
  let addresses: { address: string; family: number }[];
  if (family) addresses = [{ address: hostname, family }];
  else {
    let timer: NodeJS.Timeout | undefined;
    try {
      addresses = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 5000); }),
      ]);
    } catch { throw new BusinessError(400, 'Alamat DNS webhook tidak dapat diverifikasi.'); }
    finally { clearTimeout(timer); }
  }
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) {
    throw new BusinessError(400, 'Semua alamat DNS webhook harus berupa IP publik.');
  }
  const selected = addresses[0]!;
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export async function saveWebhook(userId: string, raw: string, environment: Environment) {
  const target = await validateWebhookUrl(raw);
  const secret = newSecret();
  db.query(`INSERT INTO webhooks(user_id, environment, url, encrypted_secret) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, environment) DO UPDATE SET url = excluded.url, encrypted_secret = excluded.encrypted_secret`)
    .run(userId, environment, target.url.toString(), encrypt(secret));
  return { environment, url: target.url.toString(), secret };
}

export function webhookData(userId: string, environment: Environment) {
  const setting = db.query<{ url: string }, [string, Environment]>(
    'SELECT url FROM webhooks WHERE user_id = ? AND environment = ?').get(userId, environment);
  const deliveries = db.query<{
    id: string; environment: Environment; event: string; status: number | null; created_at: string; error: string | null;
  }, [string, Environment]>(`SELECT id, environment, event, status, created_at, error FROM webhook_deliveries
    WHERE user_id = ? AND environment = ? ORDER BY created_at DESC LIMIT 100`).all(userId, environment);
  return { environment, url: setting?.url || '', configured: Boolean(setting), deliveries };
}

export function deleteWebhook(userId: string, environment: Environment): void {
  atomic(() => {
    db.query('DELETE FROM webhooks WHERE user_id = ? AND environment = ?').run(userId, environment);
    db.query(`UPDATE webhook_deliveries SET next_attempt_at = NULL, error = 'Webhook dinonaktifkan.'
      WHERE user_id = ? AND environment = ? AND delivered_at IS NULL`).run(userId, environment);
  });
}

export function retryWebhook(userId: string, deliveryId: string, environment: Environment): void {
  atomic(() => {
    const delivery = db.query<Delivery & { lease_until: string | null }, [string, string, Environment]>(
      'SELECT * FROM webhook_deliveries WHERE id = ? AND user_id = ? AND environment = ?').get(deliveryId, userId, environment);
    if (!delivery) throw new BusinessError(404, 'Pengiriman webhook tidak ditemukan.');
    if (!db.query('SELECT user_id FROM webhooks WHERE user_id = ? AND environment = ?').get(userId, environment)) {
      throw new BusinessError(409, 'Aktifkan webhook environment ini sebelum mengirim ulang.');
    }
    if (delivery.delivered_at) throw new BusinessError(409, 'Event ini sudah berhasil dikirim.');
    if (delivery.lease_until && delivery.lease_until > now()) throw new BusinessError(409, 'Event ini sedang dikirim.');
    db.query('UPDATE webhook_deliveries SET attempts = 0, next_attempt_at = ?, lease_until = NULL, error = NULL WHERE id = ?')
      .run(now(), deliveryId);
  });
}

async function postPinned(delivery: Delivery): Promise<number> {
  const target = await validateWebhookUrl(delivery.url);
  const signature = createHmac('sha256', decrypt(delivery.encrypted_secret)).update(delivery.payload).digest('hex');
  return new Promise<number>((resolve, reject) => {
    const hostname = target.url.hostname.replace(/^\[|\]$/g, '');
    // Pin the address checked above; TLS still verifies the original hostname. Redirects are never followed.
    const outgoing = httpsRequest({
      hostname: target.address, port: target.url.port || 443,
      path: target.url.pathname + target.url.search,
      method: 'POST', agent: false, servername: isIP(hostname) ? undefined : hostname,
      headers: {
        Host: target.url.host,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(delivery.payload),
        'X-QRIS-Signature': `sha256=${signature}`, 'X-QRIS-Event-Id': delivery.id,
        'X-QRIS-Environment': delivery.environment,
        'User-Agent': 'QRIS-Gateway-Webhook/1.0',
      },
    }, response => {
      const status = response.statusCode || 502;
      response.destroy();
      resolve(status);
    });
    const deadline = setTimeout(() => outgoing.destroy(new Error('Webhook timeout')), 10_000);
    outgoing.on('close', () => clearTimeout(deadline));
    outgoing.on('error', reject);
    outgoing.end(delivery.payload);
  });
}

export async function dispatchWebhookBatch(): Promise<void> {
  const lease = new Date(Date.now() + 60_000).toISOString();
  const deliveries = atomic(() => {
    const timestamp = now();
    const due = db.query<Delivery, [string, string]>(`SELECT webhook_deliveries.* FROM webhook_deliveries
      JOIN invoices ON invoices.id = webhook_deliveries.invoice_id AND invoices.environment = webhook_deliveries.environment
      JOIN webhooks ON webhooks.user_id = webhook_deliveries.user_id AND webhooks.environment = webhook_deliveries.environment
      WHERE delivered_at IS NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
      AND (lease_until IS NULL OR lease_until <= ?) AND attempts < 6 ORDER BY next_attempt_at LIMIT 10`)
      .all(timestamp, timestamp);
    for (const entry of due) db.query('UPDATE webhook_deliveries SET lease_until = ?, attempts = attempts + 1 WHERE id = ?').run(lease, entry.id);
    return due;
  });
  await Promise.all(deliveries.map(async delivery => {
    let status: number | null = null;
    let error: string | null = null;
    try {
      status = await postPinned(delivery);
      if (status < 200 || status >= 300) error = `Penerima webhook membalas HTTP ${status}.`;
    } catch (failure) {
      error = failure instanceof BusinessError ? failure.message : 'Pengiriman webhook gagal atau melewati batas waktu.';
    }
    const success = status !== null && status >= 200 && status < 300;
    const retryDelays = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];
    const delay = retryDelays[delivery.attempts];
    db.query(`UPDATE webhook_deliveries SET status = ?, error = ?, lease_until = NULL, delivered_at = ?, next_attempt_at = ?
      WHERE id = ? AND lease_until = ?`)
      .run(status, error, success ? now() : null, !success && delay !== undefined ? new Date(Date.now() + delay).toISOString() : null, delivery.id, lease);
  }));
}
