<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import QrisInput from '../components/QrisInput.svelte';
  import { api, date, message, providerName, rupiah } from '../lib/api';
  import type { Connection, GatewayLog, LoginState, Provider, WalletTransaction } from '../lib/api';
  let connections = $state<Connection[]>([]);
  let loading = $state(true); let error = $state(''); let feedback = $state(''); let busy = $state('');
  let editor = $state<HTMLDialogElement>()!; let detail: HTMLDialogElement; let deactivateDialog = $state<HTMLDialogElement>()!;
  let editing = $state<Connection | null>(null); let selected = $state<Connection | null>(null);
  let provider = $state<Provider>('gopay'); let label = $state(''); let qris = $state(''); let merchantId = $state('');
  let token = $state(''); let telegramBot = $state(''); let telegramChat = $state(''); let session = $state(''); let input = $state('');
  let logs = $state<GatewayLog[]>([]); let transactions = $state<WalletTransaction[]>([]); let total = $state<number | null>(null);
  let loadedHistory = $state(false); let loadedLogs = $state(false); let range = $state<'recent' | 'month'>('recent');
  let start = $state(''); let end = $state(''); let login = $state<LoginState | null>(null); let detailError = $state(''); let detailFeedback = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function load() {
    loading = true; error = '';
    try { connections = await api<Connection[]>('/api/connections'); } catch (e) { error = message(e); } finally { loading = false; }
  }
  function openEditor(connection: Connection | null = null) {
    editing = connection; provider = connection?.provider || 'gopay'; label = connection?.label || ''; qris = ''; merchantId = ''; token = ''; telegramBot = ''; telegramChat = ''; error = ''; editor.showModal();
  }
  async function save(event: SubmitEvent) {
    event.preventDefault(); busy = 'save'; error = ''; feedback = '';
    try {
      await api(editing ? `/api/connections/${encodeURIComponent(editing.id)}` : '/api/connections', editing ? 'PUT' : 'POST', { provider, label, ...(qris.trim() ? { qris_static: qris.trim() } : {}), ...(merchantId.trim() ? { merchant_id: merchantId.trim() } : {}), ...(token.trim() ? { shopee_token: token.trim() } : {}), ...(telegramBot.trim() ? { telegram_bot_token: telegramBot.trim() } : {}), ...(telegramChat.trim() ? { telegram_chat_id: telegramChat.trim() } : {}) });
      editor.close(); token = ''; telegramBot = ''; feedback = 'Dompet tersimpan. Lakukan login/import GoPay atau uji token ShopeePay sebelum menerima pembayaran.'; await load();
    } catch (e) { error = message(e); } finally { busy = ''; }
  }
  async function openDetail(connection: Connection) {
    selected = connection; session = ''; token = ''; input = ''; transactions = []; logs = []; login = null; loadedHistory = false; loadedLogs = false; total = null; detailError = ''; detailFeedback = ''; detail.showModal();
    if (connection.provider === 'gopay') await pollLogin();
  }
  async function pollLogin() {
    clearTimeout(timer);
    if (!selected || !detail.open || selected.provider !== 'gopay') return;
    const id = selected.id;
    try { const state = await api<LoginState>(`/api/connections/${encodeURIComponent(id)}/login`); if (selected?.id !== id || !detail.open) return; login = state; if (state.running) timer = setTimeout(pollLogin, 2000); }
    catch (e) { detailError = message(e); }
  }
  async function action(name: string, body?: unknown) {
    if (!selected) return;
    busy = name; detailError = ''; detailFeedback = '';
    try {
      const result = await api<{ valid?: boolean; message?: string }>(`/api/connections/${encodeURIComponent(selected.id)}/${name}`, 'POST', body);
      if (result.valid === false) detailError = result.message || 'Token atau sesi belum valid. Periksa kredensial.';
      else detailFeedback = result.message || 'Permintaan berhasil diproses.';
      session = ''; token = ''; input = '';
      const rows = await api<Connection[]>('/api/connections'); connections = rows; selected = rows.find(c => c.id === selected?.id) || selected;
      if (selected.provider === 'gopay') await pollLogin();
    } catch (e) { detailError = message(e); } finally { busy = ''; }
  }
  async function importSession(event: SubmitEvent) {
    event.preventDefault(); detailError = '';
    try { const parsed = JSON.parse(session); await action('session', { session: parsed }); } catch (e) { detailError = `Sesi harus JSON valid: ${message(e)}`; }
  }
  async function history() {
    if (!selected) return; busy = 'history'; detailError = '';
    const query = new URLSearchParams({ range }); if (start) query.set('start_time', String(Math.floor(new Date(start).getTime() / 1000))); if (end) query.set('end_time', String(Math.floor(new Date(end).getTime() / 1000)));
    try { const result = await api<{ transactions: WalletTransaction[]; total_amount?: number }>(`/api/connections/${encodeURIComponent(selected.id)}/transactions?${query}`); transactions = result.transactions; total = result.total_amount ?? null; loadedHistory = true; }
    catch (e) { detailError = message(e); } finally { busy = ''; }
  }
  async function readLogs() {
    if (!selected) return; busy = 'logs'; detailError = '';
    try { const result = await api<{ logs: GatewayLog[] }>(`/api/connections/${encodeURIComponent(selected.id)}/logs`); logs = result.logs; loadedLogs = true; }
    catch (e) { detailError = message(e); } finally { busy = ''; }
  }
  async function deactivate() {
    if (!selected) return; busy = 'deactivate'; error = '';
    try { await api(`/api/connections/${encodeURIComponent(selected.id)}`, 'DELETE'); deactivateDialog.close(); feedback = 'Dompet dinonaktifkan. Riwayat invoice tetap tersimpan.'; await load(); }
    catch (e) { error = message(e); } finally { busy = ''; }
  }
  onMount(load); onDestroy(() => clearTimeout(timer));
</script>
<div class="page-heading"><div><span class="eyebrow">Akun provider dikelola di aplikasi</span><h1>Dompet QRIS.</h1><p class="muted">Hubungkan beberapa akun GoPay atau ShopeePay, lalu pilih dompet pada setiap invoice.</p></div><button class="primary" onclick={() => openEditor()}>+ Tambah dompet</button></div>
<p class="notice">Dompet ini selalu akun nyata, termasuk saat konsol memilih Sandbox. Gateway tidak resmi dapat terganggu perubahan provider. Dana produksi langsung masuk ke akun provider Anda.</p>
{#if loading}<p class="loading" role="status">Memuat dompet merchant…</p>{/if}
{#if error && !editor?.open && !deactivateDialog?.open}<p class="notice error" role="alert">{error} <button class="quiet" onclick={load}>Muat ulang</button></p>{/if}
{#if feedback}<p class="notice" role="status">{feedback}</p>{/if}
{#if !loading && !connections.length}<div class="empty"><h2>Belum ada dompet.</h2><p>Tambahkan QRIS merchant Anda dan sesi GoPay atau token ShopeePay. Sandbox bisa dipakai tanpa dompet.</p><a href="/guide" class="button secondary">Baca cara onboarding</a></div>{/if}
<div class="connection-grid">{#each connections as connection (connection.id)}
  <section class="panel wallet-card">
    <div class="section-heading"><div><span class="eyebrow">{providerName(connection.provider)}</span><h2>{connection.label || providerName(connection.provider)}</h2></div><span class="status">{!connection.active ? 'Nonaktif' : !connection.managed ? 'Perlu onboarding' : connection.configured ? 'Terkonfigurasi' : 'Belum siap'}</span></div>
    <p>{connection.qr_merchant_name || 'Nama QRIS belum tersedia'}</p>
    <p class="small">ID dompet: <code>{connection.id}</code>{#if connection.kind === 'operator'}<br />Akun penerima pembayaran sewa operator.{/if}</p>
    <p class="small muted">Token: {connection.token_status === 'valid' ? 'Valid saat pengujian terakhir' : connection.token_status === 'invalid' ? 'Tidak valid' : 'Belum diuji'}{#if connection.provider === 'gopay'} · Sesi {connection.session_present ? 'tersimpan' : 'belum tersedia'}{/if}</p>
    {#if !connection.managed}<p class="small">Koneksi lama hanya untuk rekonsiliasi invoice terdahulu. Gunakan Tambah dompet untuk onboarding gateway terkelola.</p>{/if}
    {#if connection.active}<div class="actions">{#if connection.managed}<button class="secondary" onclick={() => openDetail(connection)}>Kelola &amp; uji</button><button class="quiet" onclick={() => openEditor(connection)}>Ubah konfigurasi</button>{/if}<button class="quiet" onclick={() => { selected = connection; error = ''; deactivateDialog.showModal(); }}>Nonaktifkan</button></div>{/if}
  </section>
{/each}</div>
<p class="small muted">Sesi, token, dan konfigurasi private tidak ditampilkan kembali. Perubahan QRIS/akun, import sesi, rotasi token ShopeePay, serta deaktivasi ditolak saat ada invoice produksi menunggu. Rotasi token hanya untuk akun yang sama.</p>
<dialog bind:this={editor} aria-labelledby="wallet-title" onclose={() => { token = ''; telegramBot = ''; qris = ''; }}><div class="dialog-header"><h2 id="wallet-title">{editing ? 'Ubah dompet' : 'Tambah dompet merchant'}</h2><button class="quiet" onclick={() => editor.close()}>Tutup</button></div>{#if error}<p class="notice error" role="alert">{error}</p>{/if}<form onsubmit={save}><label>Provider<select bind:value={provider} disabled={!!editing}><option value="gopay">GoPay</option><option value="shopeepay">ShopeePay</option></select></label><label>Label dompet<input bind:value={label} required maxlength="80" placeholder="Nama yang membantu Anda membedakan akun" /></label><QrisInput bind:value={qris} required={!editing} />{#if editing}<p class="small">Kosongkan QRIS dan rahasia untuk mempertahankan nilai tersimpan.</p>{/if}{#if provider === 'gopay'}<label>ID merchant QRIS GoPay<input bind:value={merchantId} required={!editing} autocomplete="off" /><span class="field-hint">ID merchant dari akun GoPay yang memiliki QRIS ini, bukan nomor telepon. Setelah simpan, buka Kelola untuk login OTP asli atau import sesi.</span></label>{:else}<label>Token ShopeePay<input type="password" bind:value={token} required={!editing} autocomplete="off" /><span class="field-hint">Token sah milik merchant dari sumber yang diizinkan. Tidak ada login OTP ShopeePay di aplikasi ini.</span></label><details><summary>Telegram opsional</summary><label>Token bot<input type="password" bind:value={telegramBot} autocomplete="off" /></label><label>Chat ID<input bind:value={telegramChat} autocomplete="off" /></label><p class="small">Isi keduanya untuk notifikasi yang didukung source ShopeePay. Ini terpisah dari webhook aplikasi.</p></details>{/if}<button class="primary" disabled={!!busy}>{busy === 'save' ? 'Menyimpan…' : 'Simpan dompet'}</button></form></dialog>
<dialog bind:this={detail} class="wallet-dialog" aria-labelledby="detail-title" onclose={() => { clearTimeout(timer); session = ''; token = ''; input = ''; }}><div class="dialog-header"><div><span class="eyebrow">{selected ? providerName(selected.provider) : ''}</span><h2 id="detail-title">{selected?.label}</h2></div><button class="quiet" onclick={() => detail.close()}>Tutup</button></div>{#if detailError}<p class="notice error" role="alert">{detailError}</p>{/if}{#if detailFeedback}<p class="notice" role="status">{detailFeedback}</p>{/if}{#if busy}<p role="status">Memproses {busy}…</p>{/if}<div class="actions"><button class="secondary" disabled={!!busy} onclick={() => action('test')}>Uji status token/sesi</button>{#if selected?.provider === 'gopay'}<button class="quiet" disabled={!!busy} onclick={() => action('refresh')}>Refresh token GoPay</button>{/if}</div>
{#if selected?.provider === 'gopay'}<section class="section"><h3>Login terminal GoPay asli</h3><p class="small">Ikuti prompt dari program GoPay. Nomor telepon, OTP, atau jawaban dimasukkan hanya ketika prompt memintanya. Berhasil ditentukan oleh sesi upstream, bukan oleh pengiriman OTP.</p><div class="actions"><button class="secondary" disabled={!!busy || login?.running} onclick={() => action('login/start')}>Mulai login GoPay</button><button class="quiet" disabled={!!busy} onclick={pollLogin}>Muat status login</button></div><p role="status">{login?.completed ? 'Login selesai' : login?.running ? 'Proses login berjalan' : 'Login belum berjalan'} · Sesi {login?.session_present ? 'tersedia' : 'belum tersedia'}</p><div class="gateway-log" role="log" aria-label="Output login GoPay">{#each login?.lines || [] as line}<p><time>{date(line.timestamp)}</time> {line.message}</p>{:else}<p>Prompt login akan tampil di sini setelah proses dimulai.</p>{/each}</div><form onsubmit={event => { event.preventDefault(); void action('login/input', { value: input }); }}><label>Jawaban untuk prompt aktif<input type="password" bind:value={input} required autocomplete="off" /></label><button class="secondary" disabled={!!busy || !login?.running}>Kirim ke terminal</button></form><details><summary>Import sesi GoPay JSON</summary><form onsubmit={importSession}><label>Sesi dari source GoPay yang didukung<textarea bind:value={session} rows="5" required spellcheck="false"></textarea></label><p class="small">Import divalidasi terhadap upstream. Jangan unggah sesi akun lain; nilai tidak ditampilkan setelah tersimpan.</p><button class="secondary" disabled={!!busy}>Import &amp; validasi sesi</button></form></details></section>{:else}<section class="section"><h3>Rotasi token ShopeePay</h3><form onsubmit={event => { event.preventDefault(); void action('token', { shopee_token: token }); }}><label>Token baru akun yang sama<input type="password" bind:value={token} required autocomplete="off" /></label><button class="secondary" disabled={!!busy}>Simpan token baru</button></form></section>{/if}
<section class="section"><h3>Mutasi &amp; riwayat nyata</h3><p class="small">Data dari provider, bukan simulasi sandbox atau daftar invoice aplikasi.</p><form onsubmit={event => { event.preventDefault(); void history(); }}><label>Rentang<select bind:value={range}><option value="recent">Mutasi terbaru</option><option value="month">Riwayat bulan berjalan</option></select></label>{#if selected?.provider === 'gopay'}<div class="date-fields"><label>Mulai (waktu lokal perangkat)<input type="datetime-local" bind:value={start} max={end || undefined} /></label><label>Akhir (waktu lokal perangkat)<input type="datetime-local" bind:value={end} min={start || undefined} /></label></div><p class="small muted">Maksimal 100 transaksi dari gateway pada rentang ini. Gunakan portal provider untuk ekspor lengkap.</p>{:else}<p class="small muted">ShopeePay tidak mendokumentasikan filter tanggal khusus pada gateway ini.</p>{/if}<button class="secondary" disabled={!!busy}>Ambil riwayat provider</button></form>{#if total !== null}<p>Jumlah nominal baris hasil: <strong>{rupiah(total)}</strong><br /><span class="small muted">Bukan saldo atau settlement bersih.</span></p>{/if}{#if loadedHistory}{#if !transactions.length}<p class="empty">Provider tidak mengembalikan transaksi pada rentang ini.</p>{:else}<div class="table-scroll" tabindex="0" role="region" aria-label="Mutasi provider"><table><thead><tr><th>Nominal</th><th>Status</th><th>Waktu</th><th>Issuer / tipe</th><th>ID</th></tr></thead><tbody>{#each transactions as transaction}<tr><td>{rupiah(transaction.amount)}</td><td>{transaction.status}</td><td>{date(transaction.time)}</td><td>{transaction.issuer || 'Tidak diberikan'}<span class="cell-detail">{transaction.payment_type || ''}</span></td><td>{transaction.id || 'Tidak diberikan'}</td></tr>{/each}</tbody></table></div>{/if}{/if}</section>
<section class="section"><div class="section-heading"><h3>Log gateway (disensor)</h3><button class="quiet" disabled={!!busy} onclick={readLogs}>Muat log</button></div><div class="gateway-log" role="log" aria-label="Log gateway">{#each logs as line}<p><time>{date(line.timestamp)}</time> {line.type || ''}: {line.message}</p>{:else}<p>{loadedLogs ? 'Belum ada log gateway.' : 'Muat log untuk membaca keluaran gateway akun ini.'}</p>{/each}</div></section></dialog>
<dialog bind:this={deactivateDialog} aria-labelledby="deactivate-title"><h2 id="deactivate-title">Nonaktifkan {selected?.label}?</h2><p>Dompet tidak dapat dipilih untuk invoice baru. Riwayat tetap tersimpan. Invoice produksi yang masih menunggu harus diselesaikan atau dibatalkan dahulu.</p>{#if error}<p class="notice error" role="alert">{error}</p>{/if}<div class="actions"><button class="secondary" disabled={!!busy} onclick={deactivate}>Nonaktifkan dompet</button><button class="quiet" onclick={() => deactivateDialog.close()}>Batal</button></div></dialog>
