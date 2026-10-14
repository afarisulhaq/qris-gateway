import { resolve } from 'node:path';

const node = Bun.which('node');
const npm = Bun.which('npm');
if (!node || !npm) throw new Error('Node.js >= 18 dan npm diperlukan untuk program gateway upstream. Aplikasi utama tetap menggunakan Bun.');
const versionProcess = Bun.spawn([node, '--version'], { stdout: 'pipe', stderr: 'inherit' });
const version = (await new Response(versionProcess.stdout).text()).trim();
if (await versionProcess.exited !== 0 || Number(version.match(/^v(\d+)\./)?.[1]) < 18) throw new Error('Gunakan Node.js >= 18 untuk gateway upstream.');
for (const provider of ['gopay', 'shopeepay']) {
  console.log(`Memasang dependencies terkunci untuk ${provider}, tanpa lifecycle script.`);
  const child = Bun.spawn([npm, 'ci', '--omit=dev', '--ignore-scripts'], { cwd: resolve('server/vendor', provider), stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Pemasangan dependencies ${provider} gagal.`);
}
