<script lang="ts">
  import { onMount } from 'svelte';
  import InvoiceTable from '../components/InvoiceTable.svelte';
  import { api, message } from '../lib/api';
  import type { Invoice } from '../lib/api';
  let { oncreate }: { oncreate: () => void } = $props();
  let invoices = $state<Invoice[]>([]);
  let loading = $state(true);
  let error = $state('');
  async function load() {
    loading = true; error = '';
    try { invoices = await api<Invoice[]>('/api/invoices'); } catch (e) { error = message(e); } finally { loading = false; }
  }
  onMount(load);
</script>
<div class="page-heading"><div><span class="eyebrow">Riwayat pembayaran</span><h1>Transaksi.</h1><p class="muted">Cari invoice, cek status pembayaran, dan ekspor riwayat akun Anda.</p></div><div class="actions"><button class="secondary" disabled={loading} onclick={load}>Muat ulang</button><button class="primary" onclick={oncreate}>+ Buat invoice</button></div></div>
{#if loading}<p class="loading" role="status">Memuat riwayat transaksi…</p>{:else if error}<div class="notice error" role="alert"><p>{error}</p><button class="secondary" onclick={load}>Muat ulang transaksi</button></div>{:else}<InvoiceTable {invoices} onchanged={invoice => { invoices = invoices.map(i => i.id === invoice.id ? invoice : i); }} />{/if}
