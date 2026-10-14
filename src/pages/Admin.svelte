<script lang="ts">
  import { onMount } from 'svelte';
  import { api, date, environment, message, rentalStatus, rupiah } from '../lib/api';
  import type { AdminData, Connection } from '../lib/api';
  let data = $state<AdminData | null>(null);
  let loading = $state(true);
  let busy = $state('');
  let error = $state('');
  let feedback = $state('');
  let weekly = $state<number | undefined>();
  let monthly = $state<number | undefined>();
  let query = $state('');
  let rentalFilter = $state('all');
  let grantDays = $state<Record<string, 7 | 30>>({});
  let action = $state<{ path: string; label: string; body?: unknown } | null>(null);
  let dialog: HTMLDialogElement;
  let wallets = $state<Connection[]>([]);
  let operatorId = $state('');
  const merchants = $derived(data?.merchants.filter(m => `${m.name} ${m.email}`.toLowerCase().includes(query.toLowerCase())) || []);
  const rentals = $derived(data?.rentals.filter(r => rentalFilter === 'all' || r.status === rentalFilter) || []);
  async function load() {
    loading = true; error = '';
    try { const result = await Promise.all([api<AdminData>('/api/admin'), api<Connection[]>('/api/connections')]); data = result[0]; wallets = result[1]; operatorId = data.operator_connection_id || ''; weekly = data.plans.find(p => p.days === 7)?.price ?? undefined; monthly = data.plans.find(p => p.days === 30)?.price ?? undefined; }
    catch (e) { error = message(e); } finally { loading = false; }
  }
  async function savePrices(event: SubmitEvent) {
    event.preventDefault(); busy = 'prices'; error = ''; feedback = '';
    try { await api('/api/admin/plans', 'PUT', { weekly_price: weekly, monthly_price: monthly }); feedback = 'Harga sewa disimpan. Harga pada permintaan yang sudah dibuat tidak berubah.'; await load(); }
    catch (e) { error = message(e); } finally { busy = ''; }
  }
  async function saveOperator(event: SubmitEvent) {
    event.preventDefault(); busy = 'operator'; error = ''; feedback = '';
    try { await api('/api/admin/operator', 'PUT', { connection_id: operatorId || null }); await load(); feedback = operatorId ? 'Dompet pembayaran sewa dipilih. QR sewa menggunakan akun nyata ini.' : 'Persetujuan sewa manual diaktifkan.'; }
    catch (e) { error = message(e); } finally { busy = ''; }
  }
  async function confirmAction() {
    if (!action) return;
    busy = action.path; error = ''; feedback = '';
    try { await api(action.path, 'POST', action.body); feedback = 'Perubahan tersimpan.'; dialog.close(); action = null; await load(); }
    catch (e) { error = message(e); } finally { busy = ''; }
  }
  onMount(load);
</script>
<div class="page-heading"><div><span class="eyebrow">Administrator</span><h1>Kelola akses merchant.</h1><p class="muted">Atur harga sewa, verifikasi permintaan, dan kelola masa aktif akun.</p></div><button class="secondary" disabled={loading || !!busy} onclick={load}>Muat ulang data</button></div>
{#if loading}<p class="loading" role="status">Memuat data administrasi…</p>{/if}
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if feedback}<p class="notice" role="status">{feedback}</p>{/if}
{#if !loading && data}
  {#if $environment === 'sandbox'}<p class="notice">Pengaturan admin hanya-baca dalam Sandbox. Beralih ke Produksi untuk mengubah harga, dompet operator, atau masa sewa nyata.</p>{/if}
  <fieldset class="admin-real-actions" disabled={$environment === 'sandbox'}>
  <section class="panel section"><h2>Dompet pembayaran sewa operator</h2><p>Gunakan dompet terkelola milik admin ini. Pembayaran sewa selalu produksi; sandbox tidak mengaktifkan akses.</p><form onsubmit={saveOperator}><label>Dompet penerima sewa<select bind:value={operatorId}><option value="">Persetujuan manual</option>{#each wallets.filter(c => c.active && c.managed && c.configured) as wallet}<option value={wallet.id}>{wallet.label} · {wallet.provider}</option>{/each}</select></label><button class="secondary" disabled={!!busy}>Simpan mode pembayaran sewa</button></form><a href="/connections" class="text-link">Kelola dompet admin</a></section>
  <section class="panel price-settings"><h2>Harga masa sewa</h2><p class="muted">Harga ini ditampilkan ke merchant sebelum mereka mengajukan sewa.</p><form class="inline-form" onsubmit={savePrices}><label>7 hari (Rp)<input type="number" min="1" step="1" required bind:value={weekly} /></label><label>30 hari (Rp)<input type="number" min="1" step="1" required bind:value={monthly} /></label><button class="primary" disabled={!!busy}>{busy === 'prices' ? 'Menyimpan…' : 'Simpan harga'}</button></form></section>
  <section class="section"><div class="section-heading"><div><h2>Permintaan sewa</h2><p class="muted">Setujui pembayaran manual hanya setelah bukti pembayaran diverifikasi.</p></div><label>Status sewa<select bind:value={rentalFilter}><option value="all">Semua status</option><option value="requested">Persetujuan manual</option><option value="pending">Menunggu pembayaran</option><option value="active">Aktif</option><option value="rejected">Ditolak</option></select></label></div>
    {#if !rentals.length}<div class="empty"><p>{data.rentals.length ? 'Tidak ada permintaan dengan status ini.' : 'Belum ada permintaan sewa merchant.'}</p></div>{:else}<div class="table-scroll" tabindex="0" role="region" aria-label="Permintaan sewa merchant"><table><thead><tr><th>Merchant</th><th>Sewa</th><th>Referensi</th><th>Status</th><th>Tindakan</th></tr></thead><tbody>{#each rentals as rental (rental.id)}<tr><td><strong>{rental.merchant_name}</strong><span class="cell-detail">{rental.merchant_email}</span></td><td>{rental.days} hari · {rupiah(rental.price)}<span class="cell-detail">{date(rental.created_at)}</span></td><td>{rental.payment_reference || 'Tidak dicantumkan'}</td><td><span class="status">{rentalStatus[rental.status]}</span></td><td>{#if rental.status === 'requested'}<div class="row-actions"><button class="secondary" disabled={!!busy} onclick={() => { action = { path: `/api/admin/rentals/${encodeURIComponent(rental.id)}/approve`, label: `Setujui sewa ${rental.days} hari untuk ${rental.merchant_name}? Pastikan pembayaran ${rupiah(rental.price)} telah diterima.` }; dialog.showModal(); }}>Setujui</button><button class="quiet" disabled={!!busy} onclick={() => { action = { path: `/api/admin/rentals/${encodeURIComponent(rental.id)}/reject`, label: `Tolak permintaan sewa ${rental.merchant_name}?` }; dialog.showModal(); }}>Tolak</button></div>{:else if rental.status === 'pending'}<span class="muted">Aktivasi otomatis setelah bayar</span>{:else}<span class="muted">Sudah diproses</span>{/if}</td></tr>{/each}</tbody></table></div>{/if}
  </section>
  <section class="section"><div class="section-heading"><h2>Akun merchant</h2><label>Cari merchant<input type="search" bind:value={query} placeholder="Nama atau email" /></label></div>{#if !merchants.length}<div class="empty"><p>{data.merchants.length ? 'Tidak ada merchant yang cocok dengan pencarian.' : 'Belum ada akun merchant terdaftar.'}</p></div>{:else}<div class="table-scroll" tabindex="0" role="region" aria-label="Akun merchant"><table><thead><tr><th>Merchant</th><th>Masa aktif</th><th>Tambahkan akses</th></tr></thead><tbody>{#each merchants as merchant (merchant.id)}<tr><td><strong>{merchant.name}</strong><span class="cell-detail">{merchant.email}</span></td><td><span class="status">{merchant.subscription_active ? 'Aktif' : 'Tidak aktif'}</span><span class="cell-detail">{date(merchant.subscription_expires_at)}</span></td><td><div class="row-actions"><label class="sr-only" for={`grant-${merchant.id}`}>Durasi akses {merchant.name}</label><select id={`grant-${merchant.id}`} value={String(grantDays[merchant.id] || 7)} onchange={event => { grantDays[merchant.id] = Number(event.currentTarget.value) as 7 | 30; }}><option value="7">7 hari</option><option value="30">30 hari</option></select><button class="quiet" disabled={!!busy} onclick={() => { const days = grantDays[merchant.id] || 7; action = { path: `/api/admin/merchants/${encodeURIComponent(merchant.id)}/subscription`, body: { days }, label: `Tambahkan akses ${days} hari ke akun ${merchant.name}? Ini mengubah masa aktif tanpa membuat pembayaran baru.` }; dialog.showModal(); }}>Tambahkan akses</button></div></td></tr>{/each}</tbody></table></div>{/if}</section>
  </fieldset>
{/if}
<dialog bind:this={dialog} aria-labelledby="admin-confirm"><h2 id="admin-confirm">Konfirmasi perubahan.</h2><p>{action?.label}</p><p class="muted small">Perubahan administrasi dicatat oleh server.</p>{#if error}<p class="notice error" role="alert">{error}</p>{/if}<div class="actions"><button class="primary" disabled={!!busy} onclick={confirmAction}>{busy ? 'Memproses…' : 'Konfirmasi'}</button><button class="quiet" onclick={() => dialog.close()}>Batal</button></div></dialog>
