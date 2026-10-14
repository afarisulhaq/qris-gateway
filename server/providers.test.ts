import { describe, expect, test } from 'bun:test';
import { checkPayment, createPayment, validateGatewayUrl } from './providers';
import type { GatewayConnection } from './providers';

async function withGateway(run: (connection: GatewayConnection, state: { transaction: Record<string, unknown>; history: Record<string, unknown>; paid: boolean }) => Promise<void>) {
  const now = new Date();
  const state = {
    transaction: { transaction_id: 'proof-1', transactionId: 'proof-1', amount: 25000, payment_type: 'QRIS', status: 'success', time: now.toISOString() },
    history: { transaction_id: 'proof-1', amount: 25000, status: 'settlement', time: now.toISOString() },
    paid: true
  };
  const fixture = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get('X-API-Key') !== 'test-only-secret') return new Response('Unauthorized', { status: 401 });
      if (url.pathname === '/check-payment') return Response.json({ success: true, paid: state.paid, transaction: state.transaction });
      if (url.pathname === '/transactions') return Response.json({ success: true, data: { transactions: [state.history] } });
      if (url.pathname === '/create-qris') return Response.json({ success: true, data: { amount: 25000, trx_id: 'TRX-test', qris_url: 'http://untrusted-host.invalid/qr/test', qris_code: '000201TEST-ONLY', expires_at: new Date(Date.now() + 300000).toISOString() } });
      return new Response('Not found', { status: 404 });
    }
  });
  const previous = process.env.GATEWAY_ALLOWED_HOSTS;
  process.env.GATEWAY_ALLOWED_HOSTS = `127.0.0.1:${fixture.port}`;
  try {
    await run({ id: 'test-connection', provider: 'gopay', base_url: `http://127.0.0.1:${fixture.port}`, api_key: 'test-only-secret' }, state);
  } finally {
    fixture.stop(true);
    if (previous === undefined) delete process.env.GATEWAY_ALLOWED_HOSTS;
    else process.env.GATEWAY_ALLOWED_HOSTS = previous;
  }
}

const invoice = { reference: 'TRX-test', amount: 25000, created_at: new Date(Date.now() - 60000).toISOString(), expires_at: new Date(Date.now() + 300000).toISOString() };

describe('Gateway payment proof boundaries', () => {
  test('accepts settled GoPay proof and normalizes persistent claim identity', async () => {
    await withGateway(async connection => {
      const proof = await checkPayment(connection, invoice);
      expect(proof).toMatchObject({ paid: true, transaction_id: 'proof-1', amount: 25000 });
      expect(new Date(proof.paid_at!).getTime()).toBeGreaterThan(new Date(invoice.created_at).getTime());
    });
  });

  test('rejects refunded GoPay transactions even when upstream check reports paid', async () => {
    await withGateway(async (connection, state) => {
      state.history.status = 'refund';
      await expect(checkPayment(connection, invoice)).rejects.toThrow('direfund');
    });
  });

  test('rejects non-QRIS card payments despite matching amount and settled history', async () => {
    await withGateway(async (connection, state) => {
      state.transaction.payment_type = 'OFFLINE_CREDIT_CARD';
      await expect(checkPayment(connection, invoice)).rejects.toThrow('bukan transaksi QRIS');
    });
  });

  test('rejects wrong amount, stale evidence, and missing transaction IDs', async () => {
    await withGateway(async (connection, state) => {
      state.history.amount = 25001;
      await expect(checkPayment(connection, invoice)).rejects.toThrow('tidak cocok');
      state.history.amount = 25000;
      state.history.time = new Date(new Date(invoice.created_at).getTime() - 1).toISOString();
      await expect(checkPayment(connection, invoice)).rejects.toThrow('tidak cocok');
      delete (state.transaction as Record<string, unknown>).transaction_id;
      await expect(checkPayment(connection, invoice)).rejects.toThrow('ID transaksi');
    });
  });

  test('does not turn an unpaid response into payment evidence', async () => {
    await withGateway(async (connection, state) => {
      state.paid = false;
      expect(await checkPayment(connection, invoice)).toEqual({ paid: false });
    });
  });

  test('interprets ShopeePay local proof time as Jakarta and respects second precision', async () => {
    await withGateway(async (connection, state) => {
      connection.provider = 'shopeepay';
      const milliseconds = Math.floor(Date.now() / 1000) * 1000;
      state.transaction.time = new Date(milliseconds + 7 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
      const proof = await checkPayment(connection, { ...invoice, created_at: new Date(milliseconds + 123).toISOString() });
      expect(proof.paid_at).toBe(new Date(milliseconds).toISOString());
      state.transaction.status = 'failed';
      await expect(checkPayment(connection, invoice)).rejects.toThrow('belum sukses');
    });
  });

  test('keeps checkout on the configured gateway despite an untrusted upstream Host', async () => {
    await withGateway(async connection => {
      const payment = await createPayment(connection, 25000);
      expect(payment.qr_url).toBe(connection.base_url + '/qr/test');
      expect(payment.reference).toBe('TRX-test');
    });
  });

  test('blocks credential-bearing or non-allowlisted gateway addresses', () => {
    expect(() => validateGatewayUrl('http://user:secret@localhost:3000')).toThrow('kredensial');
    expect(() => validateGatewayUrl('http://169.254.169.254')).toThrow('belum diizinkan');
    expect(() => validateGatewayUrl('http://localhost:3000/path')).toThrow('tanpa path');
  });
});
