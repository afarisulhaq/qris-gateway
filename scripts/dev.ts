export {};

const commands = [['bun', '--watch', 'server/index.ts'], ['bun', 'run', 'dev:ui']];
const children = commands.map(command => Bun.spawn(command, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const code = await Promise.race(children.map(child => child.exited));
stop();
await Promise.all(children.map(child => child.exited));
process.exit(code);
