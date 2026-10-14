<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import QRCode from 'qrcode';
  import { api, copy, date, invoiceStatus, message, providerName, rupiah } from '../lib/api';
  import type { Invoice } from '../lib/api';
  let { token, invoiceId, merchantName = '' }: { token?: string; invoiceId?: string; merchantName?: string } = $props();
  let invoice = $state<Invoice | null>(null); let merchant = $state(untrack(() => merchantName));
  let loading = $state(true); let busy = $state(false); let error = $state(''); let feedback = $state(''); let qr = $state(''); let qrError = $state('');
  let checkedAt = $state(0); let now = $state(Date.now()); let cancelDialog: HTMLDialogElement;
  const endpoint = $derived(token ? `/api/checkout/${encodeURIComponent(token)}` : `/api/invoices/${encodeURIComponent(invoiceId || '')}`);
  const sandbox = $derived(invoice?.environment === 'sandbox');
  const waitSeconds = $derived(Math.max(0, Math.ceil((checkedAt + 15000 - now) / 1000)));
  const expired = $derived(invoice?.status === 'pending' && now >= Date.parse(invoice.expires_at));
  async function fetchInvoice(check = false) {
    error = ''; feedback = '';
    if (check) { busy = true; checkedAt = Date.now(); now = checkedAt; } else loading = true;
    try {
      if (token) { const result = await api<{ invoice: Invoice; merchant_name: string }>(endpoint + (check ? '/check' : ''), check ? 'POST' : 'GET'); invoice = result.invoice; merchant = result.merchant_name; }
      else invoice = await api<Invoice>(endpoint + (check ? '/check' : ''), check ? 'POST' : 'GET', undefined, invoice?.environment);
      if (check) feedback = sandbox ? `Status sandbox: ${invoiceStatus[invoice.status]}. Tidak ada transaksi uang.` : invoice.status === 'paid' ? 'Pembayaran terverifikasi. Terima kasih.' : invoice.status === 'pending' ? 'Pembayaran belum terverifikasi. Pastikan nominal sesuai, lalu periksa kembali.' : `Invoice ${invoiceStatus[invoice.status].toLowerCase()}. Jangan membayar QRIS ini.`;
    } catch (e) { error = message(e); } finally { loading = false; busy = false; }
  }
  async function simulate(action: 'paid' | 'failed' | 'expired') {
    if (!invoice || invoice.environment !== 'sandbox') return; busy = true; error = ''; feedback = '';
    try {
      if (token) { const result = await api<{ invoice: Invoice; merchant_name: string }>(endpoint + '/simulate', 'POST', { action }); invoice = result.invoice; }
      else invoice = await api<Invoice>(endpoint + '/simulate', 'POST', { action }, invoice.environment);
      feedback = 'Status uji diperbarui. Tidak ada uang diterima atau dipindahkan.';
    } catch (e) { error = message(e); } finally { busy = false; }
  }
  async function cancelInvoice() {
    if (!invoice || token) return; busy = true; error = '';
    try { invoice = await api<Invoice>(endpoint + '/cancel', 'POST', undefined, invoice.environment); cancelDialog.close(); feedback = 'Invoice dibatalkan. Pembatalan tidak membatalkan transfer yang sudah dilakukan pelanggan.'; }
    catch (e) { error = message(e); } finally { busy = false; }
  }
  $effect(() => {
    const payload = invoice?.status === 'pending' ? invoice.environment === 'sandbox' ? invoice.checkout_url : invoice.qr_code : null;
    let cancelled = false; qr = ''; qrError = '';
    if (payload) QRCode.toDataURL(payload, { width: 420, margin: 4, errorCorrectionLevel: 'M' }).then(value => { if (!cancelled) qr = value; }).catch(() => { if (!cancelled) qrError = 'Kode QR tidak dapat ditampilkan. Hubungi merchant sebelum melanjutkan.'; });
    return () => { cancelled = true; };
  });
  async function copyLink() { try { await copy(invoice?.checkout_url || location.href); feedback = 'Tautan invoice disalin.'; } catch (e) { error = message(e); } }
  onMount(() => { void fetchInvoice(); const timer = setInterval(() => { now = Date.now(); }, 1000); return () => clearInterval(timer); });
</script>
<div class="checkout-wrapper"><div class="checkout-top"><a class="wordmark" href="/">QRIS Gateway</a><span class="muted">Halaman invoice</span></div>
{#if loading}<p class="loading" role="status">Memuat invoice…</p>{/if}{#if error}<div class="notice error" role="alert"><p>{error}</p>{#if !invoice}<button class="secondary" onclick={() => fetchInvoice()}>Muat ulang invoice</button>{/if}</div>{/if}
{#if !loading && invoice}<section class="checkout-card" aria-labelledby="checkout-title">
{#if sandbox}<p class="notice sandbox-banner"><strong>Sandbox: bukan pembayaran nyata.</strong> Kode di bawah adalah tautan checkout uji, bukan QRIS EMV. Jangan pindai dengan aplikasi bank/dompet. Status lunas hanyalah hasil simulator.</p>{/if}
<div class="checkout-heading"><span class="eyebrow">{sandbox ? 'Invoice uji' : `Pembayaran kepada ${merchant}`}</span><h1 id="checkout-title">{invoice.description}</h1><span class:paid={invoice.status === 'paid'} class="status">{invoiceStatus[expired ? 'expired' : invoice.status]}{sandbox ? ' · Simulasi' : ''}</span></div>
<div class="checkout-amount"><span>{sandbox ? 'Nominal simulasi' : 'Total yang harus dibayar'}</span><strong>{rupiah(invoice.payable_amount)}</strong>{#if !sandbox}<p>{invoice.payable_amount !== invoice.amount ? `Nominal ${rupiah(invoice.amount)} + kode unik ${rupiah(invoice.payable_amount - invoice.amount)}.` : ''} Bayar persis sesuai total.</p>{/if}</div>
{#if invoice.status === 'pending' && !expired}<div class="qr-area">{#if qr}<img src={qr} alt={sandbox ? 'QR tautan checkout sandbox, bukan QRIS pembayaran' : `QRIS ${rupiah(invoice.payable_amount)} kepada ${merchant}`} width="420" height="420" />{#if !sandbox}<a class="button quiet" href={qr} download={`qris-${invoice.id}.png`}>Unduh QRIS</a>{:else}<p class="small"><strong>QR tautan sandbox, tidak dapat digunakan untuk membayar.</strong></p>{/if}{:else if (invoice.qr_code || sandbox) && !qrError}<p role="status">Menyiapkan kode QR…</p>{/if}{#if qrError}<p class="notice error" role="alert">{qrError}</p>{/if}{#if !sandbox && invoice.qr_url}<a class="button secondary" href={invoice.qr_url} target="_blank" rel="noopener noreferrer">Buka QRIS pada provider</a>{/if}{#if !sandbox && !invoice.qr_code && !invoice.qr_url}<p class="notice error">Gateway tidak memberikan QRIS. Hubungi merchant sebelum membayar.</p>{/if}</div>
{#if sandbox}<section class="simulator"><h2>Simulator sandbox</h2><p>Pilih hasil untuk menguji perubahan invoice dan webhook. Aksi ini hanya tersedia pada token invoice sandbox.</p><div class="actions"><button class="primary" disabled={busy} onclick={() => simulate('paid')}>Simulasikan lunas</button><button class="secondary" disabled={busy} onclick={() => simulate('failed')}>Simulasikan gagal</button><button class="secondary" disabled={busy} onclick={() => simulate('expired')}>Simulasikan kedaluwarsa</button></div></section>{:else}<ol class="payment-steps"><li>Buka aplikasi bank atau dompet yang mendukung QRIS.</li><li>Pindai QRIS. Periksa nama merchant dan total sebelum membayar.</li><li>Setelah transfer, periksa status invoice.</li></ol>{/if}
<button class="secondary wide" disabled={busy || waitSeconds > 0} onclick={() => fetchInvoice(true)}>{busy ? 'Memproses…' : waitSeconds > 0 ? `Cek lagi dalam ${waitSeconds} detik` : 'Cek status invoice'}</button>{#if !token}<button class="quiet wide" disabled={busy} onclick={() => cancelDialog.showModal()}>Batalkan invoice</button>{/if}
{:else if invoice.status === 'paid'}<div class="payment-result"><h2>{sandbox ? 'Simulasi lunas selesai.' : 'Pembayaran terverifikasi.'}</h2><p>{sandbox ? 'Tidak ada uang diterima. Gunakan invoice sandbox baru untuk menguji hasil lainnya.' : `Invoice lunas pada ${date(invoice.paid_at)}. Jangan membayar kembali.`}</p></div>{:else}<div class="payment-result"><h2>Invoice {invoiceStatus[expired ? 'expired' : invoice.status].toLowerCase()}.</h2><p>{sandbox ? 'Hasil ini hanya simulasi. Buat invoice sandbox baru untuk menguji ulang.' : 'Jangan membayar QRIS ini. Jika sudah transfer, hubungi merchant dengan bukti pembayaran untuk rekonsiliasi. Pembatalan tidak menarik kembali transfer.'}</p></div>{/if}
{#if !sandbox && (invoice.status === 'expired' || expired)}<button class="secondary wide" disabled={busy || waitSeconds > 0} onclick={() => fetchInvoice(true)}>{busy ? 'Memproses…' : waitSeconds > 0 ? `Cek lagi dalam ${waitSeconds} detik` : 'Cek pembayaran sebelumnya'}</button><p class="small">Pembayaran yang tercatat sebelum batas invoice tetap dapat diperiksa. Jangan membayar QRIS yang sudah kedaluwarsa.</p>{/if}
{#if feedback}<p class="notice" role="status">{feedback}</p>{/if}<dl class="invoice-meta"><div><dt>Lingkungan</dt><dd>{invoice.environment === 'sandbox' ? 'Sandbox (simulasi)' : 'Produksi'}</dd></div><div><dt>Provider / dompet</dt><dd>{providerName(invoice.provider)}{invoice.connection_label ? ` · ${invoice.connection_label}` : ''}</dd></div><div><dt>Batas invoice</dt><dd>{date(invoice.expires_at)}</dd></div><div><dt>ID invoice</dt><dd>{invoice.id}</dd></div>{#if invoice.external_id}<div><dt>Referensi</dt><dd>{invoice.external_id}</dd></div>{/if}</dl><button class="quiet" onclick={copyLink}>Salin tautan invoice</button></section><p class="checkout-footer">{sandbox ? 'Sandbox terpisah dari produksi. Simulasi tidak mengaktifkan sewa atau menerima uang.' : 'Dana produksi diterima akun merchant pada provider. QRIS Gateway menyediakan pencatatan dan pemeriksaan, bukan dompet dana pelanggan.'}</p>{/if}
<footer class="legal-links"><a href="/terms">Ketentuan layanan</a><a href="/privacy">Privasi</a></footer></div>
<dialog bind:this={cancelDialog} aria-labelledby="cancel-title"><h2 id="cancel-title">Batalkan invoice?</h2><p>Checkout tidak akan menampilkan QR pembayaran lagi. Ini tidak membatalkan transfer yang sudah dilakukan dan bukan refund. Hubungi pelanggan serta rekonsiliasi jika sudah membayar.</p>{#if error}<p class="notice error" role="alert">{error}</p>{/if}<div class="actions"><button class="secondary" disabled={busy} onclick={cancelInvoice}>Batalkan invoice ini</button><button class="quiet" onclick={() => cancelDialog.close()}>Kembali</button></div></dialog>
