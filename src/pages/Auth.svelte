<script lang="ts">
  import { untrack } from 'svelte';
  import { api, message } from '../lib/api';
  import type { User } from '../lib/api';
  let { setupRequired, onauthenticated, initialRegister = false }: { setupRequired: boolean; onauthenticated: (user: User) => void; initialRegister?: boolean } = $props();
  let register = $state(untrack(() => setupRequired || initialRegister));
  let name = $state('');
  let email = $state('');
  let password = $state('');
  let setupToken = $state('');
  let accepted = $state(false);
  let busy = $state(false);
  let error = $state('');
  async function submit(event: SubmitEvent) {
    event.preventDefault(); busy = true; error = '';
    try {
      const result = await api<{ user: User }>(register ? '/api/auth/register' : '/api/auth/login', 'POST', register ? { name, email, password, ...(setupRequired ? { setup_token: setupToken } : {}) } : { email, password });
      password = ''; setupToken = ''; onauthenticated(result.user);
    } catch (e) { error = message(e); } finally { busy = false; }
  }
</script>
<div class="auth-layout">
  <section class="auth-story">
    <a class="wordmark" href="/">QRIS Gateway<span>Ruang pembayaran Anda.</span></a>
    <div class="auth-headline"><span class="eyebrow">QRIS untuk operasional harian</span><h1>Terima pembayaran.<br />Tetap pegang kendali.</h1><p>Kelola beberapa dompet GoPay dan ShopeePay, buat invoice, dan periksa pembayaran dari satu tempat.</p></div>
    <div class="auth-note"><strong>Dana pelanggan masuk ke akun merchant.</strong><p>Gratis 5 invoice produksi per hari WIB. Sewa opsional 7/30 hari menghapus batas harian. Sandbox tersedia untuk uji tanpa transfer.</p></div>
  </section>
  <section class="auth-form panel" aria-labelledby="auth-title">
    <span class="eyebrow">{setupRequired ? 'Penyiapan instalasi' : 'Akun merchant'}</span>
    <h2 id="auth-title">{setupRequired ? 'Siapkan akun admin.' : register ? 'Daftar akun Anda.' : 'Selamat datang kembali.'}</h2>
    <p class="muted">{setupRequired ? 'Akun pertama mengelola harga dan persetujuan sewa. Token penyiapan berasal dari operator server.' : register ? 'Mulai dengan paket gratis. Hubungkan dompet setelah masuk, atau uji alur di Sandbox tanpa dompet.' : 'Masuk untuk melanjutkan operasional pembayaran Anda.'}</p>
    {#if !setupRequired}<div class="auth-tabs"><button class:active={!register} onclick={() => { register = false; error = ''; }} aria-pressed={!register}>Masuk</button><button class:active={register} onclick={() => { register = true; error = ''; }} aria-pressed={register}>Daftar</button></div>{/if}
    {#if error}<p class="notice error" role="alert">{error}</p>{/if}
    <form onsubmit={submit}>
      {#if register}<label>Nama merchant / pemilik<input bind:value={name} required maxlength="100" autocomplete="name" /></label>{/if}
      <label>Email<input type="email" bind:value={email} required autocomplete="email" maxlength="254" /></label>
      <label>Kata sandi<input type="password" bind:value={password} required minlength={register ? 10 : undefined} autocomplete={register ? 'new-password' : 'current-password'} />{#if register}<span class="field-hint">Gunakan sedikitnya 10 karakter.</span>{/if}</label>
      {#if setupRequired}<label>Token penyiapan<input type="password" bind:value={setupToken} required autocomplete="off" /><span class="field-hint">Sesuai SETUP_TOKEN pada konfigurasi server.</span></label>{/if}
      {#if register}<label class="check-label"><input type="checkbox" bind:checked={accepted} required /><span>Saya membaca <a href="/terms">ketentuan layanan</a> dan <a href="/privacy">kebijakan privasi</a>.</span></label>{/if}
      <button class="primary" disabled={busy}>{busy ? 'Memproses…' : setupRequired ? 'Buat admin pertama' : register ? 'Buat akun merchant' : 'Masuk ke ruang pembayaran'}</button>
    </form>
    <p class="small muted">Gateway GoPay dan ShopeePay yang digunakan bukan integrasi resmi penyedia. Perubahan upstream dapat mengganggu pembuatan atau pemeriksaan QRIS.</p>
  </section>
</div>
