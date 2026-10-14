<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { IScannerControls } from '@zxing/browser';
  import { message } from '../lib/api';
  let { value = $bindable(''), required = false }: { value?: string; required?: boolean } = $props();
  let video: HTMLVideoElement;
  let root: HTMLDivElement;
  let controls: IScannerControls | undefined;
  let scanning = $state(false);
  let busy = $state(false);
  let error = $state('');
  let feedback = $state('');
  const preview = $derived.by(() => {
    const fields: Record<string, string> = {}; let offset = 0;
    while (offset + 4 <= value.length) {
      const tag = value.slice(offset, offset + 2); const size = Number(value.slice(offset + 2, offset + 4));
      if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(value.slice(offset + 2, offset + 4)) || offset + 4 + size > value.length) return null;
      fields[tag] = value.slice(offset + 4, offset + 4 + size); offset += 4 + size;
    }
    return offset === value.length && fields['00'] === '01' && fields['59'] ? { name: fields['59'], city: fields['60'] } : null;
  });
  function stopCamera() {
    controls?.stop(); controls = undefined; scanning = false;
    const stream = video?.srcObject;
    if (stream instanceof MediaStream) stream.getTracks().forEach(track => track.stop());
  }
  async function decodeImage(event: Event) {
    const input = event.target as HTMLInputElement; const file = input.files?.[0];
    if (!file) return;
    stopCamera(); busy = true; error = ''; feedback = '';
    const url = URL.createObjectURL(file);
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      const reader = new BrowserQRCodeReader();
      const result = await reader.decodeFromImageUrl(url); value = result.getText();
      feedback = 'QR berhasil dibaca secara lokal. Periksa nama merchant sebelum menyimpan.';
    } catch { error = 'QR tidak terbaca. Gunakan gambar tajam yang menampilkan seluruh kode, atau tempel payload QRIS.'; }
    finally { URL.revokeObjectURL(url); busy = false; input.value = ''; }
  }
  async function startCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices) { error = 'Kamera membutuhkan HTTPS atau localhost. Gunakan unggah gambar atau payload QRIS.'; return; }
    error = ''; feedback = ''; scanning = true;
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      const reader = new BrowserQRCodeReader();
      const handle = await reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, (result, _error, currentControls) => {
        if (result) { value = result.getText(); currentControls.stop(); scanning = false; feedback = 'QR kamera terbaca. Periksa merchant sebelum menyimpan.'; }
      });
      if (scanning) controls = handle; else handle.stop();
    } catch (e) { stopCamera(); error = `Kamera tidak dapat dibuka: ${message(e)}`; }
  }
  onMount(() => {
    const dialog = root.closest('dialog');
    dialog?.addEventListener('close', stopCamera);
    return () => dialog?.removeEventListener('close', stopCamera);
  });
  onDestroy(stopCamera);
</script>
<div class="qris-input" bind:this={root}>
  <label>Payload QRIS statis<textarea bind:value rows="4" {required} placeholder="Tempel teks QRIS asli merchant, dimulai dengan 000201" spellcheck="false"></textarea><span class="field-hint">Jangan gunakan QR invoice dinamis atau QR akun merchant lain. Server memvalidasi struktur dan CRC saat disimpan.</span></label>
  <label>Atau unggah gambar QRIS<input type="file" accept="image/*" onchange={decodeImage} disabled={busy || scanning} /></label>
  <div class="actions"><button type="button" class="secondary" disabled={busy || scanning} onclick={startCamera}>Pindai dengan kamera</button>{#if scanning}<button type="button" class="quiet" onclick={stopCamera}>Hentikan kamera</button>{/if}</div>
  <video bind:this={video} class="scanner-video" class:scanner-hidden={!scanning} muted playsinline aria-label="Pratinjau kamera pemindai QRIS"></video>
  {#if busy}<p role="status">Membaca QR dari gambar…</p>{/if}
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  {#if feedback}<p class="small" role="status">{feedback}</p>{/if}
  {#if preview}<p class="notice"><strong>Pratinjau lokal: {preview.name}</strong>{#if preview.city} · {preview.city}{/if}<br /><span class="small">Nama ini dibaca dari payload. Validasi server tetap menentukan apakah QRIS dapat digunakan.</span></p>{:else if value}<p class="small">Payload belum dapat dikenali sebagai QRIS. Periksa teks atau pindai ulang sebelum menyimpan.</p>{/if}
</div>
