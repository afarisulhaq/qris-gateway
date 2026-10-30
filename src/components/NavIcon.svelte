<script lang="ts">
  let { name }: { name: string } = $props();
  const paths: Record<string, string> = {
    overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    transactions: 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4',
    wallet: 'M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h15v11H6a3 3 0 0 1-3-3V6m18 7h-5v4h5',
    integration: 'm8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16',
    subscription: 'M4 5h16v15H4z M4 10h16M8 3v4m8-4v4m-8 7h3m2 0h3',
    guide: 'M12 5v16m0-16C9 3 6 3 3 4v15c3-1 6-1 9 2 3-3 6-3 9-2V4c-3-1-6-1-9 1Z',
    admin: 'm12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Zm-4 9 3 3 5-6',
    more: 'M4 6h16M4 12h16M4 18h16',
    close: 'm6 6 12 12M6 18 18 6',
    logout: 'M9 4H4v16h5m6-13 5 5-5 5m-6-5h11'
  };
</script>
<svg class="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name] || paths.overview} /></svg>
