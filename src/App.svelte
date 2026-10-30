<script lang="ts">
  import { onMount } from 'svelte';
  import Auth from './pages/Auth.svelte';
  import NavIcon from './components/NavIcon.svelte';
  import Landing from './pages/Landing.svelte';
  import Dashboard from './pages/Dashboard.svelte';
  import Transactions from './pages/Transactions.svelte';
  import Connections from './pages/Connections.svelte';
  import Integrations from './pages/Integrations.svelte';
  import Subscription from './pages/Subscription.svelte';
  import Admin from './pages/Admin.svelte';
  import Checkout from './pages/Checkout.svelte';
  import Guide from './pages/Guide.svelte';
  import Legal from './pages/Legal.svelte';
  import InvoiceDialog from './components/InvoiceDialog.svelte';
  import { api, ApiError, date, message, environment, selectEnvironment } from './lib/api';
  import type { Invoice, User } from './lib/api';
  let route = $state(location.pathname.replace(/\/$/, '') || '/');
  let user = $state<User | null>(null);
  let setupRequired = $state(false);
  let paymentMode = $state<'manual' | 'automatic'>('manual');
  let loading = $state(true);
  let error = $state('');
  let feedback = $state('');
  let loggingOut = $state(false);
  let menu = $state(false);
  let revision = $state(0);
  let invoiceDialog = $state<{ open: () => Promise<void> }>();
  const nav = [
    { path: '/', label: 'Ringkasan', icon: 'overview' },
    { path: '/transactions', label: 'Transaksi', icon: 'transactions' },
    { path: '/connections', label: 'Dompet QRIS', icon: 'wallet' },
    { path: '/integrations', label: 'API & webhook', icon: 'integration' },
    { path: '/subscription', label: 'Langganan', icon: 'subscription' },
    { path: '/guide', label: 'Panduan lengkap', icon: 'guide' }
  ];
  const currentPage = $derived(nav.find(item => item.path === route)?.label || (route === '/admin' ? 'Admin' : 'Invoice'));
  const publicPage = $derived(route.startsWith('/pay/') || route === '/terms' || route === '/privacy');
  async function initialize() {
    loading = true; error = '';
    try {
      const bootstrap = await api<{ setup_required: boolean; rental_payment_mode: 'manual' | 'automatic' }>('/api/bootstrap');
      setupRequired = bootstrap.setup_required; paymentMode = bootstrap.rental_payment_mode;
      try { user = await api<User>('/api/me'); } catch (e) { if (!(e instanceof ApiError && e.status === 401)) throw e; user = null; }
    } catch (e) { error = message(e); } finally { loading = false; }
  }
  async function refreshAccount() {
    const result = await Promise.all([api<User>('/api/me'), api<{ rental_payment_mode: 'manual' | 'automatic' }>('/api/bootstrap')]);
    user = result[0]; paymentMode = result[1].rental_payment_mode;
  }
  async function authenticated(account: User) {
    user = account; setupRequired = false; error = ''; loading = true; navigate('/');
    try { await refreshAccount(); } catch (e) { error = message(e); } finally { loading = false; }
  }
  async function logout() {
    loggingOut = true; error = '';
    try { await api('/api/auth/logout', 'POST'); user = null; feedback = ''; navigate('/'); }
    catch (e) { error = message(e); } finally { loggingOut = false; }
  }
  function navigate(path: string) {
    history.pushState({}, '', path); route = path; menu = false; feedback = ''; error = ''; window.scrollTo({ top: 0 });
    requestAnimationFrame(() => document.getElementById('main-content')?.focus());
  }
  function created(invoice: Invoice) { revision += 1; feedback = `Invoice “${invoice.description}” berhasil dibuat.`; }
  async function changeEnvironment(event: Event) {
    selectEnvironment((event.target as HTMLSelectElement).value as 'production' | 'sandbox');
    revision += 1; feedback = ''; error = '';
    try { await refreshAccount(); } catch (e) { error = message(e); }
  }
  onMount(() => {
    void initialize();
    const pop = () => { route = location.pathname.replace(/\/$/, '') || '/'; menu = false; feedback = ''; };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element).closest('a');
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href?.startsWith('/') || href.startsWith('//')) return;
      const url = new URL(anchor.href);
      if (url.origin !== location.origin || url.hash) return;
      event.preventDefault(); navigate(url.pathname);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !menu || document.querySelector('dialog[open]')) return;
      menu = false;
      document.querySelector<HTMLButtonElement>('.menu-button')?.focus();
    };
    window.addEventListener('popstate', pop); document.addEventListener('click', click); document.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('popstate', pop); document.removeEventListener('click', click); document.removeEventListener('keydown', keydown); };
  });
</script>
<svelte:head><title>{publicPage ? 'Pembayaran & informasi' : user ? currentPage : route === '/' ? 'Kelola invoice QRIS' : 'Masuk'} · QRIS Gateway</title><meta name="description" content="Kelola invoice QRIS, koneksi gateway merchant, dan masa sewa 7 atau 30 hari." /></svelte:head>
<a href="#main-content" class="skip-link">Lewati ke konten</a>
{#if publicPage}
  <main id="main-content" tabindex="-1">{#key route}{#if route.startsWith('/pay/')}<Checkout token={route.slice(5)} />{:else}<Legal kind={route === '/terms' ? 'terms' : 'privacy'} />{/if}{/key}</main>
{:else if loading}
  <main class="startup" id="main-content" tabindex="-1"><a class="wordmark" href="/">QRIS Gateway</a><p class="loading" role="status">Menyiapkan ruang pembayaran…</p></main>
{:else if !user}<main id="main-content" tabindex="-1">{#if error}<div class="startup"><p class="notice error" role="alert">{error}</p><button class="secondary" onclick={initialize}>Hubungkan kembali ke server</button></div>{:else if route === '/'}<Landing />{:else}<Auth {setupRequired} initialRegister={route === '/register'} onauthenticated={authenticated} />{/if}</main><footer class="auth-footer legal-links"><a href="/terms">Ketentuan layanan</a><a href="/privacy">Kebijakan privasi</a></footer>
{:else}
  <div class="app-layout">
    <aside class="sidebar">
      <div class="brand-row"><a class="wordmark app-wordmark" href="/"><img src="/favicon.svg" width="36" height="36" alt="" /><span class="brand-name">QRIS Gateway<small>Ruang pembayaran Anda.</small></span></a></div>
      <div class="sidebar-content" class:menu-open={menu}>
        <nav aria-label="Navigasi utama">
          {#each nav as item, index}
            <a id={index > 2 ? `secondary-nav-${index}` : undefined} href={item.path} class:secondary-nav={index > 2} class:active={route === item.path || (item.path === '/transactions' && route.startsWith('/transactions/'))} aria-current={route === item.path || (item.path === '/transactions' && route.startsWith('/transactions/')) ? 'page' : undefined}><NavIcon name={item.icon} /><span>{item.label}</span></a>
          {/each}
          {#if user.role === 'admin'}<a id="admin-nav" href="/admin" class="secondary-nav" class:active={route === '/admin'} aria-current={route === '/admin' ? 'page' : undefined}><NavIcon name="admin" /><span>Admin</span></a>{/if}
          <button class="menu-button" class:active={menu || nav.slice(3).some(item => item.path === route) || route === '/admin'} aria-expanded={menu} aria-controls={`secondary-nav-3 secondary-nav-4 secondary-nav-5 ${user.role === 'admin' ? 'admin-nav ' : ''}account-menu`} onclick={() => { menu = !menu; }}><NavIcon name={menu ? 'close' : 'more'} /><span>{menu ? 'Tutup' : 'Lainnya'}</span></button>
        </nav>
        <div id="account-menu" class="sidebar-bottom"><div class="account"><span class="eyebrow">{user.role === 'admin' ? 'Administrator' : 'Akun merchant'}</span><strong>{user.name}</strong><span class="small muted">{user.email}</span></div><button class="quiet logout" disabled={loggingOut} onclick={logout}><NavIcon name="logout" />{loggingOut ? 'Keluar…' : 'Keluar dari akun'}</button><div class="sidebar-legal"><a href="/terms">Ketentuan</a><a href="/privacy">Privasi</a></div></div>
      </div>
    </aside>
    <div class="workspace"><header class="workspace-bar"><span>{currentPage}</span><label class="environment-picker">Lingkungan<select value={$environment} onchange={changeEnvironment}><option value="production">Produksi</option><option value="sandbox">Sandbox</option></select></label><a href="/subscription" class="rental-indicator">{user.role === 'admin' ? 'Akses admin' : user.subscription_active ? `Sewa aktif · ${date(user.subscription_expires_at)}` : 'Gratis · 5 invoice/hari WIB'}</a></header>
      <main id="main-content" class="workspace-main" tabindex="-1">{#if error}<p class="notice error" role="alert">{error}</p>{/if}{#if feedback}<p class="notice" role="status">{feedback} <a href="/transactions">Lihat transaksi</a></p>{/if}
        {#if $environment === 'sandbox'}<p class="notice sandbox-banner"><strong>Sandbox: simulasi, bukan pembayaran nyata.</strong> Invoice, kunci API, webhook, dan total terpisah dari produksi. Dompet dan sewa tetap akun nyata.</p>{/if}
        {#key `${route}:${revision}:${$environment}`}
          {#if route === '/'}<Dashboard {user} oncreate={() => invoiceDialog?.open()} />
          {:else if route === '/transactions'}<Transactions oncreate={() => invoiceDialog?.open()} />
          {:else if route.startsWith('/transactions/')}<Checkout invoiceId={route.slice(14)} merchantName={user.name} />
          {:else if route === '/connections'}<Connections />
          {:else if route === '/integrations'}<Integrations />
          {:else if route === '/subscription'}<Subscription {user} {paymentMode} onaccountrefresh={refreshAccount} />
          {:else if route === '/guide'}<Guide />
          {:else if route === '/admin' && user.role === 'admin'}<Admin />
          {:else}<div class="empty"><h1>Halaman tidak tersedia.</h1><p>Tujuan ini tidak ditemukan atau akun Anda tidak memiliki akses.</p><a href="/" class="button secondary">Kembali ke ringkasan</a></div>{/if}
        {/key}
      </main><footer class="workspace-footer"><span>QRIS Gateway</span><span>Dana langsung ke merchant. Sewa hanya untuk akses aplikasi.</span></footer>
    </div>
  </div>
  <InvoiceDialog bind:this={invoiceDialog} oncreated={created} />
{/if}
