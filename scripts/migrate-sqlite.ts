import { Database } from 'bun:sqlite';
import { atomic, db } from '../server/db';

const tables = ['users', 'sessions', 'connections', 'api_keys', 'plans', 'rentals', 'invoices', 'transaction_claim', 'webhooks', 'webhook_deliveries', 'admin_audit'] as const;
const quote = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';

export async function importSqlite(path: string): Promise<Record<string, number>> {
  const source = new Database(path, { readonly: true, strict: true });
  try {
    source.exec('BEGIN');
    if (source.query('PRAGMA foreign_key_check').all().length) throw new Error('SQLite memiliki foreign key yang tidak valid. Impor dibatalkan.');
    const present = new Set(source.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!present.has('users') || !present.has('invoices')) throw new Error('File bukan database QRIS Gateway.');
    const customObjects = source.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger' OR (type = 'table' AND name NOT LIKE 'sqlite_%')").all()
      .filter(row => !tables.includes(row.name as typeof tables[number]));
    if (customObjects.length) throw new Error('SQLite memiliki tabel/trigger tambahan. Port objek kustom secara manual sebelum impor.');
    return await atomic(async () => {
      for (const table of tables.filter(table => table !== 'plans')) {
        if (await db.query(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get()) throw new Error('PostgreSQL tujuan harus kosong. Tidak ada data yang ditimpa.');
      }
      if (await db.query('SELECT 1 FROM plans WHERE price IS NOT NULL LIMIT 1').get()) throw new Error('Harga PostgreSQL sudah dikonfigurasi. Tujuan harus kosong.');
      const counts: Record<string, number> = {};
      for (const table of tables) {
        if (!present.has(table)) continue;
        const rows = source.query<Record<string, unknown>, []>(`SELECT * FROM ${quote(table)}`).all();
        if (table === 'plans') await db.exec('DELETE FROM plans');
        const columns = (await db.query<{ column_name: string }, [string]>(`SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`).all(table)).map(row => row.column_name);
        for (const row of rows) {
          if (['invoices', 'api_keys', 'webhooks', 'webhook_deliveries'].includes(table)) row.environment ??= 'production';
          if (table === 'connections') { row.label ??= row.provider; row.managed ??= 0; row.active ??= 1; }
          const names = columns.filter(column => Object.hasOwn(row, column));
          await db.query(`INSERT INTO ${quote(table)} (${names.map(quote).join(', ')}) VALUES (${names.map((_, index) => '$' + (index + 1)).join(', ')})`)
            .run(...names.map(column => row[column]));
        }
        const actual = await db.query<{ total: number }>(`SELECT COUNT(*)::integer AS total FROM ${quote(table)}`).get();
        if (actual?.total !== rows.length) throw new Error(`Jumlah record ${table} tidak cocok. Impor dibatalkan.`);
        counts[table] = rows.length;
      }
      return counts;
    });
  } finally { source.close(); }
}

if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path || path === ':memory:') throw new Error('Pemakaian: bun run db:import:sqlite /path/qris.sqlite');
    const counts = await importSqlite(path);
    console.log('Impor selesai. SQLite sumber tidak diubah. Pertahankan ENCRYPTION_KEY dan direktori wallet yang sama.');
    console.log(JSON.stringify(counts));
  } catch (error) {
    // Database errors may include row values containing credentials; keep CLI output private.
    console.error(error instanceof Error && !('code' in error) ? error.message : 'Impor gagal; transaksi PostgreSQL dibatalkan. Periksa schema dan integritas sumber secara lokal.');
    process.exitCode = 1;
  } finally { await db.close(); }
}
