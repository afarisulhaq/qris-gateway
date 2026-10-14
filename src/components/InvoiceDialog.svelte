<script lang="ts">
  import { api, environment, message, providerName } from '../lib/api';
  import type { Connection, Environment, Invoice, User } from '../lib/api';
  let { oncreated }: { oncreated: (invoice: Invoice) => void } = $props();
  let dialog: HTMLDialogElement;
  let connections = $state<Connection[]>([]); let account = $state<User | null>(null);
  let loading = $state(false); let busy = $state(false); let error = $state('');
  let description = $state(''); let amount = $state<number | undefined>(); let connectionId = $state('');
  let provider = $state<'gopay' | 'shopeepay'>('gopay'); let externalId = $state(''); let scope = $state<Environment>('production');
  const ready = $derived(connections.filter(c => c.kind === 'merchant' && c.active && c.managed && c.configured));
  export async function open() {
    error = ''; loading = true; scope = $environment; dialog.showModal();
    try { const result = await Promise.all([api<Connection[]>('/api/connections'), api<User>('/api/me', 'GET', undefined, scope)]); connections = result[0]; account = result[1]; connectionId = ready[0]?.id || ''; }
    catch (e) { error = message(e); } finally { loading = false; }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault(); error = ''; busy = true;
    try {
      const wallet = ready.find(c => c.id === connectionId);
      const invoice = await api<Invoice>('/api/invoices', 'POST', { amount, description, provider: scope === 'production' ? wallet?.provider : provider, ...(scope === 'production' ? { connection_id: connectionId } : {}), ...(externalId.trim() ? { external_id: externalId.trim() } : {}) }, scope);
      oncreated(invoice); dialog.close(); description = ''; amount = undefined; externalId = '';
    } catch (e) { error = message(e); } finally { busy = false; }
  }
</script>
<dialog bind:this={dialog} aria-labelledby="invoice-title"><div class="dialog-header"><div><span class="eyebrow">{scope === 'sandbox' ? 'Sandbox, bukan pembayaran nyata' : 'Produksi'}</span><h2 id="invoice-title">Buat invoice QRIS.</h2></div><button class="quiet" onclick={() => dialog.close()}>Tutup</button></div>
{#if loading}<p role="status">Memuat dompet dan kuota invoice…</p>{/if}{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if !loading && (scope === 'sandbox' || ready.length)}<form onsubmit={submit}>
{#if scope === 'sandbox'}<p class="notice">Invoice uji tanpa dompet nyata. Checkout hanya menampilkan tautan QR sandbox dan simulator; tidak menerima uang.</p>{:else if account?.daily_limit != null}<p class="notice">Gratis: {account.daily_used ?? 0}/{account.daily_limit} invoice produksi dibuat hari ini. Sisa {account.daily_remaining ?? 0}. Reset pukul 00.00 WIB. Sewa 7/30 hari menghapus batas harian.</p>{:else}<p class="small">Akses produksi tanpa batas kuota gratis harian.</p>{/if}
<label>Deskripsi pembayaran<input bind:value={description} required maxlength="200" placeholder="Nama pesanan atau tujuan pembayaran" /></label><label>Nominal invoice (Rp)<input type="number" bind:value={amount} min="1" step="1" required inputmode="numeric" /></label>
{#if scope === 'production'}<label>Dompet penerima<select bind:value={connectionId} required>{#each ready as connection}<option value={connection.id}>{connection.label} · {providerName(connection.provider)} · {connection.qr_merchant_name || 'QRIS merchant'}</option>{/each}</select></label>{:else}<label>Provider simulasi<select bind:value={provider}><option value="gopay">GoPay</option><option value="shopeepay">ShopeePay</option></select></label>{/if}
<label>Referensi pesanan (opsional)<input bind:value={externalId} maxlength="100" placeholder="ID unik dari sistem Anda" /></label><p class="notice small">Produksi dapat menambahkan kode unik Rp0 sampai Rp99. Referensi yang sama dalam lingkungan yang sama mengembalikan invoice yang sama, bukan transaksi baru.</p><button class="primary" disabled={busy || (scope === 'production' && account?.daily_remaining === 0)}>{busy ? 'Membuat invoice…' : scope === 'sandbox' ? 'Buat invoice sandbox' : 'Buat tautan pembayaran'}</button>{#if scope === 'production' && account?.daily_remaining === 0}<p class="small">Kuota hari ini habis. Tunggu reset WIB atau <a href="/subscription" onclick={() => dialog.close()}>aktifkan sewa</a>. Pemeriksaan invoice lama tetap tersedia.</p>{/if}</form>
{:else if !loading && !error}<div class="empty"><h3>Dompet produksi belum siap.</h3><p>Tambahkan dan uji dompet GoPay atau ShopeePay terlebih dahulu. Sandbox tidak membutuhkan dompet.</p><a class="button secondary" href="/connections" onclick={() => dialog.close()}>Hubungkan dompet</a></div>{/if}</dialog>
