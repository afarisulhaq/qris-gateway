import { SQL } from 'bun';
import { AsyncLocalStorage } from 'node:async_hooks';
import { schema } from './schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
  throw new Error('DATABASE_URL wajib diisi dengan URL PostgreSQL. Lihat .env.example.');
}
const pool = new SQL(databaseUrl, { max: 10, connectionTimeout: 10, idleTimeout: 30 });
const transaction = new AsyncLocalStorage<Bun.TransactionSQL>();
const client = () => transaction.getStore() || pool;

export const db = {
  query<Row = Record<string, unknown>, Params extends unknown[] = unknown[]>(statement: string) {
    return {
      async all(...params: Params): Promise<Row[]> {
        return await client().unsafe(statement, params) as Row[];
      },
      async get(...params: Params): Promise<Row | null> {
        const rows = await client().unsafe(statement, params);
        return (rows[0] as Row | undefined) ?? null;
      },
      async run(...params: Params): Promise<{ changes: number }> {
        const result = await client().unsafe(statement, params);
        return { changes: result.count };
      },
    };
  },
  async exec(statement: string): Promise<void> { await client().unsafe(statement); },
  async close(): Promise<void> { await pool.close(); },
};

export async function atomic<T>(operation: () => T | Promise<T>): Promise<T> {
  if (transaction.getStore()) return await operation();
  return await pool.begin(async tx => {
    // Serialize short business transitions across processes: quota, receipt claims, rental activation and outbox leases.
    // Provider and webhook network I/O must stay outside this lock.
    await tx`SELECT pg_advisory_xact_lock(716982031)`;
    return await transaction.run(tx, operation);
  });
}

await atomic(async () => { await db.exec(schema); });

export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export type Environment = 'production' | 'sandbox';
export type UserRow = {
  id: string; name: string; email: string; password_hash: string;
  role: 'admin' | 'merchant'; subscription_expires_at: string | null; created_at: string;
};
export type ConnectionRow = {
  id: string; user_id: string | null; provider: 'gopay' | 'shopeepay';
  base_url: string; encrypted_secrets: string; kind: 'merchant' | 'operator';
  label: string; managed: number; active: number;
};
export type InvoiceRow = {
  id: string; user_id: string; connection_id: string | null; rental_id: string | null; environment: Environment;
  external_id: string | null; description: string; amount: number; payable_amount: number;
  provider: 'gopay' | 'shopeepay'; status: 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed';
  creation_state: 'creating' | 'ready' | 'failed'; reference: string | null;
  created_at: string; expires_at: string; paid_at: string | null;
  checkout_token: string; qr_code: string | null; qr_url: string | null; last_checked_at: string | null;
};
export type RentalRow = {
  id: string; user_id: string; days: 7 | 30; price: number;
  status: 'requested' | 'pending' | 'active' | 'rejected';
  payment_reference: string | null; created_at: string; activated_at: string | null;
};
