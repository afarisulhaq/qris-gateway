<script lang="ts">
  import { onMount } from 'svelte';
  import { api, date, environment, message, rentalStatus, rupiah } from '../lib/api';
  import type { Plan, Rental, User } from '../lib/api';
  let { user, paymentMode, onaccountrefresh }: { user: User; paymentMode: 'manual' | 'automatic'; onaccountrefresh: () => Promise<void> } = $props();
  let plans = $state<Plan[]>([]);
  let rentals = $state<Rental[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let feedback = $state('');
  let reference = $state('');
  let chosen = $state<Plan | null>(null);
  let dialog: HTMLDialogElement;
  async function load() {
    loading = true; error = '';
    try { const result = await Promise.all([api<Plan[]>('/api/plans'), api<Rental[]>('/api/rentals'), onaccountrefresh()]); plans = result[0]; rentals = result[1]; }
    catch (e) { error = message(e); } finally { loading = false; }
  }
  async function request(event: SubmitEvent) {
    event.preventDefault(); if (!chosen) return;
    busy = true; error = ''; feedback = '';
    try {
      const rental = await api<Rental>('/api/rentals', 'POST', { days: chosen.days, ...(paymentMode === 'manual' && reference.trim() ? { payment_reference: reference.trim() } : {}) });
      rentals = [rental, ...rentals]; reference = ''; dialog.close();
      feedback = rental.status === 'requested' ? 'Permintaan sewa diterima. Admin perlu memverifikasi pembayaran dan menyetujuinya.' : 'Invoice sewa dibuat. Buka pembayaran pada riwayat sewa untuk membayar QRIS operator.';
    } catch (e) { error = message(e); } finally { busy = false; }
  }
  onMount(load);
</script>
<div class="page-heading"><div><span class="eyebrow">Kuota produksi tanpa batas gratis harian</span><h1>Gratis, atau sewa sesuai kebutuhan.</h1><p class="muted">Gratis selamanya: 5 invoice produksi per hari WIB. Sewa 7 atau 30 hari menghapus batas harian selama masa aktif.</p></div><button class="secondary" disabled={loading} onclick={load}>Perbarui status sewa</button></div>
<div class="subscription-state"><strong>{user.role === 'admin' ? 'Akun administrator' : user.subscription_active ? 'Masa sewa Anda aktif' : 'Paket gratis aktif'}</strong><p>{user.role === 'admin' ? 'Akses admin tidak memerlukan sewa.' : user.subscription_active ? `Batas masa sewa: ${date(user.subscription_expires_at)}.` : 'Anda tetap bisa membuat 5 invoice produksi per hari. Reset pukul 00.00 WIB. Sandbox dan pemeriksaan invoice lama tidak memerlukan sewa.'}</p><p class="small">Sewa dan pembayaran operator selalu nyata, walaupun selector konsol sedang Sandbox. Simulasi tidak dapat mengaktifkan masa sewa.</p></div>
{#if $environment === 'sandbox'}<p class="notice">Riwayat sewa tetap akun nyata. Beralih ke Produksi untuk mengajukan atau membayar sewa; simulator tidak mengaktifkan masa akses.</p>{/if}
{#if loading}<p class="loading" role="status">Memuat durasi dan riwayat sewa…</p>{/if}
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if feedback}<p class="notice" role="status">{feedback}</p>{/if}
{#if !loading}
  <div class="plan-grid">{#each [7, 30] as days}
    {@const plan = plans.find(p => p.days === days)}
    <section class="plan"><span class="eyebrow">{days === 7 ? 'Sewa mingguan' : 'Sewa bulanan'}</span><h2>{days}<span> hari</span></h2><p class="plan-price">{plan?.price != null ? rupiah(plan.price) : 'Harga belum ditetapkan'}</p><p class="muted">{days === 7 ? 'Masa akses singkat untuk kebutuhan operasional Anda.' : 'Masa akses lebih panjang tanpa mengubah koneksi merchant.'}</p><button class="secondary" disabled={plan?.price == null || busy || $environment === 'sandbox'} onclick={() => { if (plan) { chosen = plan; error = ''; dialog.showModal(); } }}>{paymentMode === 'manual' ? `Ajukan sewa ${days} hari` : `Bayar sewa ${days} hari`}</button></section>
  {/each}</div>
  <p class="notice">{paymentMode === 'manual' ? 'Pembayaran sewa manual. Hubungi operator instalasi untuk instruksi pembayaran, lalu kirim referensi pembayaran. Akses aktif hanya setelah admin menyetujui permintaan.' : 'Pembayaran sewa melalui QRIS operator. Masa sewa aktif setelah pembayaran terverifikasi. Ini terpisah dari QRIS merchant Anda.'} Perpanjangan ditambahkan ke akhir masa aktif, atau dimulai saat aktivasi bila masa sebelumnya berakhir.</p>
  <section class="section"><h2>Riwayat sewa</h2>{#if !rentals.length}<div class="empty"><h3>Belum ada permintaan sewa.</h3><p>Pilih salah satu durasi di atas. Jika harga belum tersedia, operator perlu mengaturnya terlebih dahulu.</p></div>{:else}<div class="table-scroll" tabindex="0" role="region" aria-label="Riwayat sewa"><table><thead><tr><th>Durasi</th><th>Biaya sewa</th><th>Status</th><th>Diajukan</th><th>Pembayaran</th></tr></thead><tbody>{#each rentals as rental (rental.id)}<tr><td><strong>{rental.days} hari</strong><span class="cell-detail">{rental.id}</span></td><td class="money">{rupiah(rental.price)}</td><td><span class:paid={rental.status === 'active'} class="status">{rentalStatus[rental.status]}</span></td><td>{date(rental.created_at)}</td><td>{#if rental.checkout_url}<a class="button secondary" href={rental.checkout_url} target="_blank" rel="noopener noreferrer">{rental.status === 'pending' ? 'Bayar QRIS sewa' : 'Lihat pembayaran'}</a>{:else}<span class="muted">Persetujuan manual</span>{/if}</td></tr>{/each}</tbody></table></div>{/if}</section>
{/if}
<dialog bind:this={dialog} aria-labelledby="rental-title"><div class="dialog-header"><h2 id="rental-title">Sewa {chosen?.days} hari.</h2><button class="quiet" onclick={() => dialog.close()}>Tutup</button></div><p class="plan-price">{chosen?.price != null ? rupiah(chosen.price) : ''}</p><form onsubmit={request}>{#if paymentMode === 'manual'}<p>Sewa ini memerlukan verifikasi admin. Pastikan Anda sudah menerima instruksi pembayaran dari operator instalasi.</p><label>Referensi pembayaran <span class="muted">(opsional)</span><input bind:value={reference} maxlength="200" placeholder="Nomor transfer atau catatan pembayaran" /></label>{:else}<p>Invoice QRIS operator akan dibuat. Setelah bayar, periksa status pada halaman pembayaran dan perbarui status sewa di sini.</p>{/if}{#if error}<p class="notice error" role="alert">{error}</p>{/if}<button class="primary" disabled={busy}>{busy ? 'Memproses…' : paymentMode === 'manual' ? 'Kirim permintaan sewa' : 'Buat pembayaran sewa'}</button></form></dialog>
