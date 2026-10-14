'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

process.umask(0o077);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
  this.once('listening', () => {
    const address = this.address();
    if (!address || address.address !== '127.0.0.1') {
      this.close();
      process.exit(78);
    }
    if (process.send) process.send({ type: 'listening', port: address.port });
  });
  return listen.call(this, { host: '127.0.0.1', port: 0 }, callback);
};


process.on('message', async message => {
  if (!message || message.type !== 'refresh' || process.env.MANAGED_PROVIDER !== 'gopay') return;
  try {
    const manager = require(path.join(process.cwd(), 'sessionManager.js'));
    const success = Boolean(await manager.refreshSession());
    if (process.send) process.send({ type: 'refresh-result', request: message.request, success });
  } catch {
    if (process.send) process.send({ type: 'refresh-result', request: message.request, success: false });
  }
});
process.on('disconnect', () => process.exit(0));
process.on('exit', () => {
  const session = path.join(process.cwd(), '.GOPAY_SESI_JANGAN_DIHAPUS.json');
  try { fs.chmodSync(session, 0o600); } catch {}
});

// Keep supervision and refresh IPC without holding a completed login CLI open.
process.channel?.unref();

if (path.basename(process.argv[1] || '') === 'login.js') {
  // Bun supplies stdin as a socket; readline.close() pauses it without releasing its reference.
  process.stdin.on('pause', () => process.stdin.unref?.());
  process.stdin.on('resume', () => process.stdin.ref?.());
}
