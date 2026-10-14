<script lang="ts">
  import { onMount } from 'svelte';
  import { api, copy, date, environment, message } from '../lib/api';
  import type { ApiKey, Webhook } from '../lib/api';
  let keys = $state<ApiKey[]>([]);
  let webhook = $state<Webhook | null>(null);
  let loading = $state(true);
  let busy = $state('');
  let error = $state('');
  let feedback = $state('');
  let label = $state('');
  let url = $state('');
  let secret = $state('');
  let secretTitle = $state('');
  let secretDialog: HTMLDialogElement;
  let confirmDialog: HTMLDialogElement;
  let removing = $state<{ kind: 'key' | 'webhook'; id: string; label: string } | null>(null);
  async function load() {
    loading = true; error = '';
    try { const result = await Promise.all([api<ApiKey[]>('/api/keys'), api<Webhook>('/api/webhook')]); keys = result[0]; webhook = result[1]; url = webhook.url; }
    catch (e) { error = message(e); } finally { loading = false; }
  }
  async function createKey(event: SubmitEvent) {
    event.preventDefault(); busy = 'key'; error = ''; feedback = '';
    try {
      const result = await api<{ id: string; key: string; prefix: string; label: string }>('/api/keys', 'POST', { label });
      secret = result.key; secretTitle = 'Simpan kunci API Anda.'; secretDialog.showModal(); label = '';
      keys = await api<ApiKey[]>('/api/keys');
    } catch (e) { error = message(e); } finally { busy = ''; }
  }
  async function saveWebhook(event: SubmitEvent) {
    event.preventDefault(); busy = 'webhook'; error = ''; feedback = '';
    try {
      const result = await api<{ url: string; secret: string }>('/api/webhook', 'PUT', { url });
      secret = result.secret; secretTitle = 'Simpan secret webhook Anda.'; secretDialog.showModal();
      webhook = await api<Webhook>('/api/webhook'); url = webhook.url;
    } catch (e) { error = message(e); } finally { busy = ''; }
  }
  async function remove() {
    if (!removing) return;
    busy = 'remove'; error = ''; feedback = '';
    try {
      await api(removing.kind === 'key' ? `/api/keys/${encodeURIComponent(removing.id)}` : '/api/webhook', 'DELETE');
      if (removing.kind === 'key') keys = keys.filter(key => key.id !== removing?.id);
      else { webhook = await api<Webhook>('/api/webhook'); url = ''; }
      feedback = removing.kind === 'key' ? 'Kunci dicabut. Permintaan dengan kunci ini tidak lagi diterima.' : 'Webhook dinonaktifkan.';
      confirmDialog.close(); removing = null;
    } catch (e) { error = message(e); confirmDialog.close(); } finally { busy = ''; }
  }
  async function retry(id: string) {
    busy = id; error = ''; feedback = '';
    try { await api(`/api/webhook/deliveries/${encodeURIComponent(id)}/retry`, 'POST'); webhook = await api<Webhook>('/api/webhook'); feedback = 'Pengiriman ulang diminta. Muat ulang riwayat untuk melihat hasil terbaru.'; }
    catch (e) { error = message(e); } finally { busy = ''; }
  }
  async function copySecret() {
    try { await copy(secret); feedback = 'Rahasia disalin. Simpan pada penyimpanan server Anda.'; } catch (e) { error = message(e); }
  }
  onMount(load);
</script>
<div class="page-heading"><div><span class="eyebrow">Integrasi {$environment === 'sandbox' ? 'sandbox' : 'produksi'}</span><h1>API &amp; webhook.</h1><p class="muted">Kunci, endpoint webhook, dan riwayat hanya untuk lingkungan yang dipilih. Kunci sandbox tidak membuat invoice produksi.</p></div><a href="/guide" class="button secondary">Baca panduan lengkap</a></div>
{#if loading}<p class="loading" role="status">Memuat kunci API dan webhook…</p>{/if}
{#if error}<div class="notice error" role="alert"><p>{error}</p>{#if !webhook}<button class="secondary" onclick={load}>Muat ulang integrasi</button>{/if}</div>{/if}
{#if feedback}<p class="notice" role="status">{feedback}</p>{/if}
{#if !loading && webhook}
  <section class="section"><div class="section-heading"><div><h2>Kunci API {$environment}</h2><p class="muted">Kunci mengakses invoice {$environment} akun ini. Gunakan di server, jangan di browser. Pilih lingkungan lain di header untuk mengelola kunci terpisah.</p></div></div>
    <form class="inline-form" onsubmit={createKey}><label>Label kunci<input required maxlength="80" bind:value={label} placeholder="Nama aplikasi atau lingkungan" /></label><button class="primary" disabled={!!busy}>{busy === 'key' ? 'Membuat…' : 'Buat kunci API'}</button></form>
    {#if !keys.length}<div class="empty"><h3>Belum ada kunci API.</h3><p>Buat kunci jika Anda ingin menghubungkan aplikasi lain. Pembuatan invoice lewat dashboard tidak memerlukan kunci ini.</p></div>{:else}<div class="table-scroll" tabindex="0" role="region" aria-label="Kunci API"><table><thead><tr><th>Label</th><th>Awalan kunci</th><th>Dibuat</th><th>Tindakan</th></tr></thead><tbody>{#each keys as key (key.id)}<tr><td><strong>{key.label}</strong></td><td><code>{key.prefix}…</code></td><td>{date(key.created_at)}</td><td><button class="quiet" disabled={!!busy} onclick={() => { removing = { kind: 'key', id: key.id, label: key.label }; confirmDialog.showModal(); }}>Cabut kunci</button></td></tr>{/each}</tbody></table></div>{/if}
  </section>
  <section class="section"><div class="section-heading"><div><h2>Webhook {$environment}</h2><p class="muted">Peristiwa invoice lunas lingkungan ini dikirim ke endpoint HTTPS milik Anda. Sandbox mengirim hasil simulasi, bukan uang masuk.</p></div><span class="status">{webhook.configured ? 'Terkonfigurasi' : 'Belum aktif'}</span></div>
    <form onsubmit={saveWebhook} class="webhook-form"><label>URL endpoint HTTPS<input type="url" required pattern="https://.*" bind:value={url} placeholder="https://domain-Anda/webhook" /><span class="field-hint">Endpoint harus dapat diakses publik. URL lokal dan alamat privat ditolak.</span></label><div class="actions"><button class="secondary" disabled={!!busy}>{busy === 'webhook' ? 'Menyimpan…' : webhook.configured ? 'Simpan & ganti secret' : 'Aktifkan webhook'}</button>{#if webhook.configured}<button class="quiet" type="button" disabled={!!busy} onclick={() => { removing = { kind: 'webhook', id: '', label: 'Webhook pembayaran' }; confirmDialog.showModal(); }}>Nonaktifkan webhook</button>{/if}</div></form>
    <p class="small muted">Setiap penyimpanan mengganti secret. Perbarui verifikasi HMAC pada server penerima. Pengiriman dapat berulang, deduplikasi berdasarkan header X-QRIS-Event-Id.</p>
    <div class="section-heading"><h3>Riwayat pengiriman</h3><button class="quiet" disabled={!!busy} onclick={load}>Muat ulang riwayat</button></div>
    {#if !webhook.deliveries.length}<div class="empty"><p>Belum ada pengiriman. Riwayat akan muncul setelah invoice lunas menghasilkan peristiwa webhook.</p></div>{:else}<div class="table-scroll" tabindex="0" role="region" aria-label="Riwayat webhook"><table><thead><tr><th>Peristiwa</th><th>Hasil</th><th>Waktu</th><th>Tindakan</th></tr></thead><tbody>{#each webhook.deliveries as delivery (delivery.id)}<tr><td><strong>{delivery.event}</strong><span class="cell-detail">{delivery.id}</span></td><td>{delivery.status === null ? 'Belum ada respons' : `HTTP ${delivery.status}`}{#if delivery.error}<span class="cell-detail">{delivery.error}</span>{/if}</td><td>{date(delivery.created_at)}</td><td>{#if delivery.status === null || delivery.status < 200 || delivery.status >= 300}<button class="quiet" disabled={!!busy || !webhook.configured} onclick={() => retry(delivery.id)}>{busy === delivery.id ? 'Memproses…' : 'Kirim ulang'}</button>{:else}<span class="muted">Terkirim</span>{/if}</td></tr>{/each}</tbody></table></div>{/if}
  </section>
{/if}
<dialog bind:this={secretDialog} aria-labelledby="secret-title" onclose={() => { secret = ''; }}><div class="dialog-header"><h2 id="secret-title">{secretTitle}</h2><button class="quiet" onclick={() => secretDialog.close()}>Tutup</button></div><p>Lingkungan: <strong>{$environment}</strong>. Nilai ini hanya ditampilkan sekali. Setelah ditutup, nilainya tidak dapat dilihat kembali.</p><label>Rahasia baru<textarea readonly value={secret} rows="3"></textarea></label><button class="primary" onclick={copySecret}>Salin rahasia</button>{#if feedback}<p role="status">{feedback}</p>{/if}{#if error}<p role="alert">{error}</p>{/if}</dialog>
<dialog bind:this={confirmDialog} aria-labelledby="remove-title"><h2 id="remove-title">{removing?.kind === 'key' ? 'Cabut kunci API?' : 'Nonaktifkan webhook?'}</h2><p>{removing?.label}. {removing?.kind === 'key' ? 'Aplikasi yang menggunakan kunci ini akan kehilangan akses. Tindakan ini tidak dapat dibatalkan.' : 'Endpoint ini tidak lagi menerima pemberitahuan pembayaran baru.'}</p><div class="actions"><button class="secondary" disabled={!!busy} onclick={remove}>Ya, {removing?.kind === 'key' ? 'cabut kunci' : 'nonaktifkan'}</button><button class="quiet" onclick={() => confirmDialog.close()}>Batal</button></div></dialog>
