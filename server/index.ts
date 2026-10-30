import { Elysia } from 'elysia';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { db, atomic, id, now } from './db';
import type { UserRow, ConnectionRow, RentalRow } from './db';
import {
  BusinessError, objectBody, text, money, duration, publicUser,
  sessionUser, apiUser, adminUser, sessionCookie, mutationGuard, rateLimit,
  encryptionKey, constantEqual, newSecret, hashSecret,
} from './security';
import {
  invoicePublic, rentalPublic, expireInvoices, environmentInput, accessPublic,
  merchantInvoices, ownedInvoice, checkoutInvoice, checkoutPublic,
  rentalPaymentMode, createMerchantInvoice, checkInvoice, createRental,
  activateRental, extendSubscription, audit, adminData, cancelInvoice, simulateInvoice,
} from './domain';
import { gatewayRoutes, listConnections } from './gateway-api';
import { shutdownGateways } from './gateway-runtime';
import { saveWebhook, webhookData, deleteWebhook, retryWebhook, dispatchWebhookBatch } from './webhooks';

function emailInput(body: Record<string, unknown>): string {
  const email = text(body, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BusinessError(400, 'Alamat email tidak valid.');
  return email;
}

async function issueSession(userId: string): Promise<string> {
  const token = newSecret();
  await db.query('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, $3)')
    .run(hashSecret(token), userId, new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString());
  return sessionCookie(token);
}

function requestAddress(request: Request): string {
  return app.server?.requestIP(request)?.address || 'local';
}

function requestEnvironment(request: Request) {
  return environmentInput(new URL(request.url).searchParams.get('environment') || undefined);
}

export const app = new Elysia({ serve: { maxRequestBodySize: 64 * 1024 } })
  .onBeforeHandle({ as: 'global' }, ({ request, set }) => {
    const path = new URL(request.url).pathname;
    set.headers['X-Content-Type-Options'] = 'nosniff';
    set.headers['Referrer-Policy'] = 'no-referrer';
    set.headers['X-Frame-Options'] = 'DENY';
    if (path.startsWith('/api') || path.startsWith('/v1')) set.headers['Cache-Control'] = 'no-store';
    if (path.startsWith('/api/')) mutationGuard(request);
    if (path.startsWith('/api/admin/') && request.method !== 'GET' && requestEnvironment(request) === 'sandbox') {
      throw new BusinessError(400, 'Perubahan admin berlaku pada akun nyata. Beralih ke mode produksi terlebih dahulu.');
    }
  })
  .onError({ as: 'global' }, ({ error, code, set }) => {
    const declared = 'status' in error ? Number(error.status) : 0;
    const status = declared >= 400 && declared <= 599 ? declared
      : code === 'NOT_FOUND' ? 404 : code === 'PARSE' || code === 'VALIDATION' ? 400 : 500;
    set.status = status;
    const message = status === 500 ? 'Terjadi kesalahan server. Silakan hubungi operator.'
      : code === 'NOT_FOUND' ? 'Endpoint tidak ditemukan.'
      : code === 'PARSE' || code === 'VALIDATION' ? 'Permintaan JSON tidak valid.'
      : error instanceof Error ? error.message : 'Permintaan gagal diproses.';
    return { message };
  })
  .get('/api/health', async () => { await db.query('SELECT 1').get(); return { ok: true }; })
  .get('/api/bootstrap', async () => ({ setup_required: !(await db.query('SELECT id FROM users LIMIT 1').get()), rental_payment_mode: await rentalPaymentMode() }))
  .post('/api/auth/register', async ({ request, body, set }) => {
    rateLimit(`auth-ip:${requestAddress(request)}`, 20, 60_000);
    const input = objectBody(body);
    const name = text(input, 'name', 100);
    const email = emailInput(input);
    const password = input.password;
    if (typeof password !== 'string' || password.length < 10 || password.length > 256) {
      throw new BusinessError(400, 'Password harus terdiri dari 10 sampai 256 karakter.');
    }
    rateLimit(`register:${email}`, 5, 15 * 60_000);
    encryptionKey();
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
    const user = await atomic(async () => {
      const first = !(await db.query('SELECT id FROM users LIMIT 1').get());
      if (first) {
        if (!process.env.SETUP_TOKEN) throw new BusinessError(503, 'SETUP_TOKEN belum dikonfigurasi operator. Setup admin ditutup.');
        if (typeof input.setup_token !== 'string' || !constantEqual(input.setup_token, process.env.SETUP_TOKEN)) {
          throw new BusinessError(403, 'Token setup admin tidak valid.');
        }
      }
      if (await db.query('SELECT id FROM users WHERE email = $1').get(email)) throw new BusinessError(409, 'Email sudah terdaftar. Silakan masuk.');
      const userId = id();
      await db.query('INSERT INTO users(id, name, email, password_hash, role, created_at) VALUES ($1, $2, $3, $4, $5, $6)')
        .run(userId, name, email, passwordHash, first ? 'admin' : 'merchant', now());
      return (await db.query<UserRow, [string]>('SELECT * FROM users WHERE id = $1').get(userId))!;
    });
    set.headers['Set-Cookie'] = await issueSession(user.id);
    set.status = 201;
    return { user: publicUser(user) };
  })
  .post('/api/auth/login', async ({ request, body, set }) => {
    rateLimit(`auth-ip:${requestAddress(request)}`, 20, 60_000);
    const input = objectBody(body);
    const email = emailInput(input);
    const password = input.password;
    if (typeof password !== 'string' || !password || password.length > 256) throw new BusinessError(400, 'Isi email dan password.');
    rateLimit(`login:${email}`, 10, 15 * 60_000);
    const user = await db.query<UserRow, [string]>('SELECT * FROM users WHERE email = $1').get(email);
    if (!user || !await Bun.password.verify(password, user.password_hash)) throw new BusinessError(401, 'Email atau password tidak sesuai.');
    set.headers['Set-Cookie'] = await issueSession(user.id);
    return { user: publicUser(user) };
  })
  .post('/api/auth/logout', async ({ request, set }) => {
    const cookie = request.headers.get('cookie') || '';
    const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('qris_session='))?.slice(13);
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1').run(hashSecret(token));
    set.headers['Set-Cookie'] = sessionCookie('', 0);
    return { ok: true };
  })
  .get('/api/me', async ({ request }) => {
    const user = await sessionUser(request);
    return { ...publicUser(user), ...await accessPublic(user, requestEnvironment(request)) };
  })
  .get('/api/dashboard', async ({ request }) => {
    const user = await sessionUser(request);
    const environment = requestEnvironment(request);
    const invoices = await merchantInvoices(user.id, environment);
    const totals = (await db.query<{ paid_total: number; pending_total: number; paid_count: number; pending_count: number }, [string, string]>(`
      SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN payable_amount ELSE 0 END), 0)::double precision AS paid_total,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN payable_amount ELSE 0 END), 0)::double precision AS pending_total,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0)::integer AS paid_count,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::integer AS pending_count
      FROM invoices WHERE user_id = $1 AND environment = $2 AND rental_id IS NULL AND creation_state = 'ready'
    `).get(user.id, environment))!;
    return { ...totals, ...await accessPublic(user, environment), invoices: await Promise.all(invoices.slice(0, 20).map(invoicePublic)),
      connections: await listConnections(user.id), ...publicUser(user) };
  })
  .get('/api/invoices', async ({ request }) => Promise.all((await merchantInvoices((await sessionUser(request)).id, requestEnvironment(request))).map(invoicePublic)))
  .post('/api/invoices', async ({ request, body, set }) => {
    const user = await sessionUser(request);
    const invoice = await createMerchantInvoice(user.id, objectBody(body), requestEnvironment(request));
    set.status = 201;
    return await invoicePublic(invoice);
  })
  .get('/api/invoices/:id', async ({ request, params }) => await invoicePublic(await ownedInvoice((await sessionUser(request)).id, params.id, requestEnvironment(request))))
  .post('/api/invoices/:id/check', async ({ request, params }) => await invoicePublic(await checkInvoice(await ownedInvoice((await sessionUser(request)).id, params.id, requestEnvironment(request)))))
  .post('/api/invoices/:id/cancel', async ({ request, params }) => await invoicePublic(await cancelInvoice((await sessionUser(request)).id, params.id, requestEnvironment(request))))
  .post('/api/invoices/:id/simulate', async ({ request, params, body }) => await invoicePublic(await simulateInvoice((await sessionUser(request)).id, params.id, objectBody(body).action, requestEnvironment(request))))
  .use(gatewayRoutes)
  .get('/api/keys', async ({ request }) => await db.query<{ id: string; label: string; prefix: string; created_at: string; environment: string }, [string, string]>(
    'SELECT id, label, prefix, created_at, environment FROM api_keys WHERE user_id = $1 AND environment = $2 ORDER BY created_at DESC')
    .all((await sessionUser(request)).id, requestEnvironment(request)))
  .post('/api/keys', async ({ request, body, set }) => {
    const user = await sessionUser(request);
    const label = text(objectBody(body), 'label', 100);
    const key = `qris_${newSecret()}`;
    const keyId = id();
    const prefix = key.slice(0, 13);
    const environment = requestEnvironment(request);
    await db.query('INSERT INTO api_keys(id, user_id, label, prefix, key_hash, created_at, environment) VALUES ($1, $2, $3, $4, $5, $6, $7)')
      .run(keyId, user.id, label, prefix, hashSecret(key), now(), environment);
    set.status = 201;
    return { id: keyId, key, prefix, label, environment };
  })
  .delete('/api/keys/:id', async ({ request, params }) => {
    const result = await db.query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2 AND environment = $3').run(params.id, (await sessionUser(request)).id, requestEnvironment(request));
    if (!result.changes) throw new BusinessError(404, 'API key tidak ditemukan.');
    return { ok: true };
  })
  .get('/api/webhook', async ({ request }) => await webhookData((await sessionUser(request)).id, requestEnvironment(request)))
  .put('/api/webhook', async ({ request, body }) => await saveWebhook((await sessionUser(request)).id, text(objectBody(body), 'url', 2048), requestEnvironment(request)))
  .delete('/api/webhook', async ({ request }) => { await deleteWebhook((await sessionUser(request)).id, requestEnvironment(request)); return { ok: true }; })
  .post('/api/webhook/deliveries/:id/retry', async ({ request, params }) => { await retryWebhook((await sessionUser(request)).id, params.id, requestEnvironment(request)); return { ok: true }; })
  .get('/api/plans', async ({ request }) => {
    await sessionUser(request);
    return await db.query<{ days: 7 | 30; price: number | null }, []>('SELECT days, price FROM plans ORDER BY days').all();
  })
  .get('/api/rentals', async ({ request }) => {
    await expireInvoices();
    return Promise.all((await db.query<RentalRow, [string]>('SELECT * FROM rentals WHERE user_id = $1 ORDER BY created_at DESC').all((await sessionUser(request)).id)).map(rentalPublic));
  })
  .post('/api/rentals', async ({ request, body, set }) => {
    const user = await sessionUser(request);
    if (requestEnvironment(request) === 'sandbox') throw new BusinessError(400, 'Pembelian sewa menggunakan pembayaran produksi. Beralih ke mode produksi terlebih dahulu.');
    rateLimit(`rental-create:${user.id}`, 10, 60_000);
    const rental = await createRental(user.id, objectBody(body));
    set.status = 201;
    return await rentalPublic(rental);
  })
  .get('/api/admin', async ({ request }) => { await adminUser(request); return await adminData(); })
  .put('/api/admin/operator', async ({ request, body }) => {
    const user = await adminUser(request);
    const connectionId = objectBody(body).connection_id;
    if (connectionId !== null && typeof connectionId !== 'string') throw new BusinessError(400, 'Pilih akun gateway operator atau pembayaran manual.');
    await atomic(async () => {
      await expireInvoices();
      if (await db.query(`SELECT id FROM invoices WHERE rental_id IS NOT NULL AND status = 'pending' LIMIT 1`).get()) {
        throw new BusinessError(409, 'Selesaikan invoice sewa yang menunggu sebelum mengganti akun operator.');
      }
      if (connectionId !== null) {
        const connection = await db.query<ConnectionRow, [string, string]>(
          'SELECT * FROM connections WHERE id = $1 AND user_id = $2 AND managed = 1 AND active = 1').get(connectionId, user.id);
        if (!connection) throw new BusinessError(404, 'Akun operator aktif milik admin tidak ditemukan.');
      }
      await db.query("UPDATE connections SET kind = 'merchant' WHERE kind = 'operator'").run();
      if (connectionId !== null) await db.query("UPDATE connections SET kind = 'operator' WHERE id = $1").run(connectionId);
      await audit(user.id, 'operator.select', connectionId || 'manual', { connection_id: connectionId });
    });
    return { ok: true };
  })
  .put('/api/admin/plans', async ({ request, body }) => {
    const user = await adminUser(request);
    const input = objectBody(body);
    const weekly = money(input.weekly_price, 'weekly_price');
    const monthly = money(input.monthly_price, 'monthly_price');
    await atomic(async () => {
      await db.query('UPDATE plans SET price = $1 WHERE days = 7').run(weekly);
      await db.query('UPDATE plans SET price = $1 WHERE days = 30').run(monthly);
      await audit(user.id, 'plans.update', 'plans', { weekly_price: weekly, monthly_price: monthly });
    });
    return { ok: true };
  })
  .post('/api/admin/rentals/:id/approve', async ({ request, params }) => {
    const user = await adminUser(request);
    await atomic(async () => {
      const rental = await db.query<RentalRow, [string]>('SELECT * FROM rentals WHERE id = $1').get(params.id);
      if (!rental) throw new BusinessError(404, 'Pengajuan langganan tidak ditemukan.');
      if (rental.status === 'active') return;
      if (rental.status !== 'requested') throw new BusinessError(409, 'Hanya pengajuan manual yang dapat disetujui admin. Pembayaran otomatis harus diverifikasi gateway.');
      await activateRental(rental.id);
      await audit(user.id, 'rental.approve', rental.id, { days: rental.days, user_id: rental.user_id });
    });
    return { ok: true };
  })
  .post('/api/admin/rentals/:id/reject', async ({ request, params }) => {
    const user = await adminUser(request);
    await atomic(async () => {
      const rental = await db.query<RentalRow, [string]>('SELECT * FROM rentals WHERE id = $1').get(params.id);
      if (!rental) throw new BusinessError(404, 'Pengajuan langganan tidak ditemukan.');
      if (rental.status === 'rejected') return;
      if (rental.status !== 'requested') throw new BusinessError(409, 'Hanya pengajuan manual yang belum aktif dapat ditolak.');
      await db.query("UPDATE rentals SET status = 'rejected' WHERE id = $1").run(rental.id);
      await audit(user.id, 'rental.reject', rental.id, { user_id: rental.user_id });
    });
    return { ok: true };
  })
  .post('/api/admin/merchants/:id/subscription', async ({ request, params, body }) => {
    const user = await adminUser(request);
    const days = duration(objectBody(body).days);
    await atomic(async () => {
      const merchant = await db.query<UserRow, [string]>("SELECT * FROM users WHERE id = $1 AND role = 'merchant'").get(params.id);
      if (!merchant) throw new BusinessError(404, 'Merchant tidak ditemukan.');
      const expiresAt = await extendSubscription(merchant.id, days);
      await audit(user.id, 'subscription.extend', merchant.id, { days, subscription_expires_at: expiresAt });
    });
    return { ok: true };
  })
  .get('/api/checkout/:token', async ({ request, params }) => {
    rateLimit(`checkout-read:${requestAddress(request)}`, 120, 60_000);
    return await checkoutPublic(await checkoutInvoice(params.token));
  })
  .post('/api/checkout/:token/check', async ({ request, params }) => {
    rateLimit(`checkout-check:${requestAddress(request)}`, 40, 60_000);
    return await checkoutPublic(await checkInvoice(await checkoutInvoice(params.token)));
  })
  .post('/api/checkout/:token/simulate', async ({ request, params, body }) => {
    rateLimit(`checkout-simulate:${requestAddress(request)}`, 30, 60_000);
    const invoice = await checkoutInvoice(params.token);
    return await checkoutPublic(await simulateInvoice(invoice.user_id, invoice.id, objectBody(body).action, invoice.environment));
  })
  .get('/v1/connections', async ({ request }) => {
    const user = await apiUser(request);
    return user.environment === 'sandbox' ? [] : (await listConnections(user.id)).filter(connection => connection.kind === 'merchant' && connection.active && connection.managed);
  })
  .get('/v1/invoices', async ({ request }) => {
    const user = await apiUser(request);
    return Promise.all((await merchantInvoices(user.id, user.environment)).map(invoicePublic));
  })
  .post('/v1/invoices', async ({ request, body, set }) => {
    const user = await apiUser(request);
    const invoice = await createMerchantInvoice(user.id, objectBody(body), user.environment);
    set.status = 201;
    return await invoicePublic(invoice);
  })
  .get('/v1/invoices/:id', async ({ request, params }) => {
    const user = await apiUser(request);
    return await invoicePublic(await ownedInvoice(user.id, params.id, user.environment));
  })
  .post('/v1/invoices/:id/check', async ({ request, params }) => {
    const user = await apiUser(request);
    return await invoicePublic(await checkInvoice(await ownedInvoice(user.id, params.id, user.environment)));
  })
  .post('/v1/invoices/:id/cancel', async ({ request, params }) => {
    const user = await apiUser(request);
    return await invoicePublic(await cancelInvoice(user.id, params.id, user.environment));
  })
  .post('/v1/invoices/:id/simulate', async ({ request, params, body }) => {
    const user = await apiUser(request);
    return await invoicePublic(await simulateInvoice(user.id, params.id, objectBody(body).action, user.environment));
  })
  .all('/api/*', ({ set }) => { set.status = 404; return { message: 'Endpoint API tidak ditemukan.' }; })
  .all('/v1/*', ({ set }) => { set.status = 404; return { message: 'Endpoint API tidak ditemukan.' }; })
  .get('/*', async ({ request }) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/v1' || pathname.startsWith('/v1/')) {
      throw new BusinessError(404, 'Endpoint API tidak ditemukan.');
    }
    if (process.env.NODE_ENV !== 'production') throw new BusinessError(404, 'Jalankan frontend Vite pada port 5173, atau build frontend untuk produksi.');
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { throw new BusinessError(400, 'Path tidak valid.'); }
    if (decoded.includes('\0') || decoded.includes('\\')) throw new BusinessError(400, 'Path tidak valid.');
    const root = resolve('dist');
    const candidate = resolve(root, `.${decoded}`);
    if (candidate !== root && !candidate.startsWith(root + sep)) throw new BusinessError(404, 'File tidak ditemukan.');
    try {
      const actual = await realpath(candidate);
      const actualRoot = await realpath(root);
      if (actual !== actualRoot && !actual.startsWith(actualRoot + sep)) throw new BusinessError(404, 'File tidak ditemukan.');
      const file = Bun.file(actual);
      if ((await stat(actual)).isFile()) return file;
    } catch (error) { if (error instanceof BusinessError) throw error; }
    if (decoded.startsWith('/assets/') || /\.[a-zA-Z0-9]+$/.test(decoded)) throw new BusinessError(404, 'File tidak ditemukan.');
    let indexPath: string;
    try { indexPath = await realpath(resolve(root, 'index.html')); }
    catch { throw new BusinessError(503, 'Frontend produksi belum dibuild.'); }
    const actualRoot = await realpath(root);
    if (!indexPath.startsWith(actualRoot + sep)) throw new BusinessError(404, 'File tidak ditemukan.');
    return Bun.file(indexPath);
  });

if (import.meta.main) {
  if (process.env.NODE_ENV === 'production') {
    encryptionKey();
    if (!process.env.APP_URL) throw new Error('APP_URL wajib dikonfigurasi untuk produksi.');
  }
  const port = Number(process.env.PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT tidak valid.');
  app.listen({ port, hostname: process.env.HOST || '127.0.0.1' });
  let currentTick: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (currentTick) return;
    currentTick = (async () => {
      try { await expireInvoices(); await dispatchWebhookBatch(); }
      catch { console.error('Pemrosesan outbox QRIS gagal. Periksa database dan konfigurasi rahasia.'); }
      finally { currentTick = null; }
    })();
  }, 5000);
  const stop = async () => {
    clearInterval(timer);
    await app.stop();
    await currentTick;
    await shutdownGateways();
    await db.close();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log(`QRIS Gateway listening on ${app.server?.hostname}:${app.server?.port}`);
}
