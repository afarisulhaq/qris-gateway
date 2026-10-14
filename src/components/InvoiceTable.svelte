<script lang="ts">
  import { api, copy, date, environment, invoiceStatus, message, providerName, rupiah } from '../lib/api';
  import type { Invoice } from '../lib/api';
  let { invoices, onchanged, compact = false }: { invoices: Invoice[]; onchanged: (invoice: Invoice) => void; compact?: boolean } = $props();
  let search = $state('');
  let status = $state('all');
  let provider = $state('all');
  let from = $state('');
  let to = $state('');
  let busy = $state('');
  let feedback = $state('');
  let error = $state('');
  const filtered = $derived(invoices.filter(invoice => {
    const query = search.toLocaleLowerCase('id');
    const day = invoice.created_at.slice(0, 10);
    return (status === 'all' || invoice.status === status) && (provider === 'all' || invoice.provider === provider) && (!from || day >= from) && (!to || day <= to) && `${invoice.description} ${invoice.id} ${invoice.external_id || ''}`.toLocaleLowerCase('id').includes(query);
  }));
  async function check(invoice: Invoice) {
    busy = invoice.id; error = ''; feedback = '';
    try { const updated = await api<Invoice>(`/api/invoices/${encodeURIComponent(invoice.id)}/check`, 'POST', undefined, invoice.environment); onchanged(updated); feedback = `${invoice.description}: ${invoiceStatus[updated.status]}${invoice.environment === 'sandbox' ? ' (simulasi)' : ''}.`; }
    catch (e) { error = message(e); } finally { busy = ''; }
  }
  async function copyLink(invoice: Invoice) {
    error = ''; feedback = '';
    try { await copy(invoice.checkout_url); feedback = 'Tautan pembayaran disalin.'; } catch (e) { error = message(e); }
  }
  function exportCsv() {
    const cells = (values: unknown[]) => values.map(value => `"${String(value ?? '').replace(/"/g, '""').replace(/^[=+@-]/, "'$&")}"`).join(',');
    const lines = [cells(['Lingkungan', 'Dompet', 'ID', 'Referensi', 'Deskripsi', 'Nominal', 'Total invoice', 'Provider', 'Status', 'Dibuat (UTC)', 'Dibayar (UTC)']), ...filtered.map(i => cells([i.environment, i.connection_label, i.id, i.external_id, i.description, i.amount, i.payable_amount, i.provider, i.status, i.created_at, i.paid_at]))];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `transaksi-${$environment}-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  }
</script>

{#if !compact}
  <div class="filters">
    <label class="search-field">Cari transaksi<input type="search" bind:value={search} placeholder="Deskripsi, ID, atau referensi" /></label>
    <label>Status<select bind:value={status}><option value="all">Semua status</option><option value="pending">Menunggu</option><option value="paid">Lunas</option><option value="expired">Kedaluwarsa</option><option value="failed">Gagal</option><option value="cancelled">Dibatalkan</option></select></label>
    <label>Provider<select bind:value={provider}><option value="all">Semua provider</option><option value="gopay">GoPay</option><option value="shopeepay">ShopeePay</option></select></label>
    <label>Dari tanggal (UTC)<input type="date" bind:value={from} max={to || undefined} /></label>
    <label>Sampai tanggal (UTC)<input type="date" bind:value={to} min={from || undefined} /></label>
    <button onclick={exportCsv} disabled={!filtered.length} class="secondary">Ekspor CSV</button>
  </div>
  <p class="muted small">{filtered.length} dari {invoices.length} transaksi. CSV mengikuti filter yang dipilih.</p>
{/if}
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if feedback}<p class="notice" role="status">{feedback}</p>{/if}
{#if !filtered.length}
  <div class="empty"><h3>{invoices.length ? 'Tidak ada transaksi yang cocok.' : compact ? 'Tidak ada pembayaran tertunda.' : 'Transaksi pertama Anda dimulai di sini.'}</h3><p>{invoices.length ? 'Ubah pencarian atau filter untuk melihat transaksi lain.' : compact ? 'Invoice yang menunggu pembayaran akan muncul di sini.' : 'Buat invoice produksi dengan dompet siap, atau pilih Sandbox untuk uji tanpa transfer. Sewa tidak wajib.'}</p></div>
{:else}
  <div class="table-scroll" tabindex="0" role="region" aria-label="Daftar transaksi">
    <table>
      <thead><tr><th scope="col">Invoice</th><th scope="col">Total dibayar</th><th scope="col">Status</th><th scope="col">Dibuat</th><th scope="col">Tindakan</th></tr></thead>
      <tbody>{#each filtered as invoice (invoice.id)}
        <tr><td><a class="invoice-link" href={`/transactions/${encodeURIComponent(invoice.id)}`}><strong>{invoice.description}</strong></a><span class="cell-detail">{invoice.environment === 'sandbox' ? 'Sandbox · ' : 'Produksi · '}{invoice.connection_label || providerName(invoice.provider)} · {invoice.external_id || invoice.id}</span></td><td class="money"><strong>{rupiah(invoice.payable_amount)}</strong>{#if invoice.payable_amount !== invoice.amount}<span class="cell-detail">Termasuk kode unik {rupiah(invoice.payable_amount - invoice.amount)}</span>{/if}{#if invoice.environment === 'sandbox'}<span class="cell-detail">Nominal simulasi</span>{/if}</td><td><span class:paid={invoice.status === 'paid'} class="status">{invoiceStatus[invoice.status]}</span>{#if invoice.paid_at}<span class="cell-detail">{date(invoice.paid_at)}</span>{/if}</td><td>{date(invoice.created_at)}<span class="cell-detail">Batas: {date(invoice.expires_at)}</span></td><td><div class="row-actions"><a class="button secondary" href={invoice.checkout_url} target="_blank" rel="noopener noreferrer">{invoice.environment === 'sandbox' ? 'Buka simulator' : 'Buka checkout'}</a><button class="quiet" onclick={() => copyLink(invoice)}>Salin tautan</button>{#if invoice.status === 'pending'}<button class="quiet" disabled={!!busy} onclick={() => check(invoice)}>{busy === invoice.id ? 'Memeriksa…' : 'Cek status'}</button>{/if}</div></td></tr>
      {/each}</tbody>
    </table>
  </div>
{/if}
