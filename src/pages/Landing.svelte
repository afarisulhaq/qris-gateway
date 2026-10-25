<script lang="ts">
  const features = [
    {
      number: '01',
      title: 'Invoice yang bisa ditelusuri',
      description: 'Buat invoice GoPay atau ShopeePay, kirim pelanggan ke halaman checkout, lalu cek status pembayarannya dari satu tempat.'
    },
    {
      number: '02',
      title: 'Dompet tetap milik merchant',
      description: 'Setiap dompet memakai akun provider merchant sendiri. Dana pembayaran masuk langsung ke akun tersebut, bukan ditampung oleh aplikasi.'
    },
    {
      number: '03',
      title: 'API dan webhook untuk toko',
      description: 'Buat invoice dari backend toko dengan API key. Terima perubahan status lewat webhook bertanda tangan HMAC.'
    }
  ];
</script>

<svelte:head>
  <title>QRIS Gateway | Kelola invoice QRIS</title>
  <meta name="description" content="Kelola invoice QRIS GoPay dan ShopeePay, dompet merchant, API, webhook, dan sandbox dari satu tempat." />
</svelte:head>

<div class="landing-page">
  <header class="landing-header">
    <a class="wordmark landing-wordmark" href="/" aria-label="QRIS Gateway, beranda">QRIS Gateway<span>Ruang pembayaran Anda.</span></a>
    <nav class="landing-nav" aria-label="Navigasi halaman">
      <a href="#fitur">Fitur</a>
      <a href="#alur">Alur kerja</a>
      <a href="#sandbox">Sandbox</a>
    </nav>
    <div class="landing-actions">
      <a class="landing-login" href="/login">Masuk</a>
      <a class="button primary" href="/register">Buat akun</a>
    </div>
  </header>

  <main id="main-content" class="landing-main" tabindex="-1">
    <section class="landing-hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <span class="eyebrow">Operasional QRIS untuk merchant</span>
        <h1 id="hero-title">Pembayaran tercatat. Kendali tetap di tangan Anda.</h1>
        <p>Kelola invoice, dompet GoPay dan ShopeePay, serta pemeriksaan pembayaran dalam satu ruang kerja.</p>
        <div class="hero-actions">
          <a class="button primary" href="/register">Buat akun merchant</a>
          <a class="button secondary" href="#fitur">Lihat cara kerjanya</a>
        </div>
        <p class="hero-note">Dana pembayaran masuk langsung ke akun merchant. QRIS Gateway bukan penyedia jasa pembayaran.</p>
      </div>

      <div class="flow-art" aria-label="Alur invoice, checkout pelanggan, dan pemeriksaan status">
        <div class="flow-art-top"><span>Alur pembayaran</span><span class="flow-status">Merchant</span></div>
        <div class="flow-node flow-node-main"><span class="flow-index">01</span><div><strong>Invoice dibuat</strong><small>GoPay atau ShopeePay</small></div><span class="flow-mark" aria-hidden="true">+</span></div>
        <div class="flow-connector" aria-hidden="true"></div>
        <div class="flow-node"><span class="flow-index">02</span><div><strong>Pelanggan membuka checkout</strong><small>QR pembayaran ditampilkan</small></div></div>
        <div class="flow-connector" aria-hidden="true"></div>
        <div class="flow-node flow-node-end"><span class="flow-index">03</span><div><strong>Status diperiksa</strong><small>Bukti pembayaran diverifikasi</small></div><span class="flow-check" aria-hidden="true">✓</span></div>
        <p class="flow-caption">Status paid mengikuti bukti dari gateway, bukan klaim pelanggan.</p>
      </div>
    </section>

    <section class="landing-trustline" aria-label="Batas penggunaan yang penting">
      <p><strong>Produksi</strong><span>Dana masuk ke akun provider merchant.</span></p>
      <p><strong>Pengujian</strong><span>Sandbox terpisah dan tidak menerima uang nyata.</span></p>
      <p><strong>Provider</strong><span>GoPay dan ShopeePay melalui gateway yang disiapkan operator.</span></p>
    </section>

    <section id="fitur" class="landing-features" aria-labelledby="features-title">
      <div class="section-intro">
        <span class="eyebrow">Satu ruang kerja</span>
        <h2 id="features-title">Fokus pada transaksi yang perlu Anda urus.</h2>
        <p>Alat operasional untuk mengelola invoice QRIS, tanpa menahan dana pelanggan.</p>
      </div>
      <div class="feature-list">
        {#each features as feature}
          <article class="feature-row">
            <span class="feature-number">{feature.number}</span>
            <h3>{feature.title}</h3>
            <p>{feature.description}</p>
          </article>
        {/each}
      </div>
    </section>

    <section id="alur" class="landing-workflow" aria-labelledby="workflow-title">
      <div class="workflow-heading">
        <span class="eyebrow">Dari pembuatan sampai rekonsiliasi</span>
        <h2 id="workflow-title">Satu alur yang jelas untuk setiap invoice.</h2>
      </div>
      <ol class="workflow-steps">
        <li><span>01</span><div><strong>Hubungkan dompet</strong><p>Tambahkan QRIS dan sesi atau token dari akun merchant Anda.</p></div></li>
        <li><span>02</span><div><strong>Buat invoice</strong><p>Gunakan dashboard atau API untuk membuat checkout pelanggan.</p></div></li>
        <li><span>03</span><div><strong>Periksa hasilnya</strong><p>Gateway mencocokkan bukti pembayaran sebelum invoice ditandai lunas.</p></div></li>
      </ol>
    </section>

    <section id="sandbox" class="landing-sandbox" aria-labelledby="sandbox-title">
      <div class="sandbox-copy">
        <span class="eyebrow">Uji tanpa transfer</span>
        <h2 id="sandbox-title">Sandbox terpisah dari transaksi produksi.</h2>
        <p>Uji alur invoice dan integrasi dengan status simulasi. Sandbox tidak memanggil provider, tidak menerima uang, dan tidak mengaktifkan sewa.</p>
      </div>
      <div class="sandbox-facts">
        <p><span>Produksi</span><strong>Transaksi gateway nyata</strong></p>
        <p><span>Sandbox</span><strong>Simulasi berlabel</strong></p>
        <a class="text-link" href="#alur">Lihat alur invoice</a>
      </div>
    </section>

    <section class="landing-final" aria-labelledby="final-title">
      <p class="eyebrow">Mulai dari kebutuhan Anda</p>
      <h2 id="final-title">Siapkan ruang kerja pembayaran merchant.</h2>
      <p>Paket gratis mencakup 5 invoice produksi per hari WIB. Sewa 7 atau 30 hari tersedia untuk menghapus batas harian saat aktif.</p>
      <a class="button primary" href="/register">Buat akun merchant</a>
    </section>
  </main>

  <footer class="landing-footer">
    <a class="wordmark" href="/">QRIS Gateway</a>
    <p>Dana pembayaran masuk langsung ke akun merchant.</p>
    <nav class="legal-links" aria-label="Informasi layanan"><a href="/terms">Ketentuan layanan</a><a href="/privacy">Kebijakan privasi</a><a href="/login">Masuk</a></nav>
  </footer>
</div>
