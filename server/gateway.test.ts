import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('original gateway processes preserve each wallet identity and payment amount across interleaved requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qris-gateway-'));
  const guard = join(directory, 'network-guard.cjs');
  const executable = join(directory, 'node-offline');
  writeFileSync(guard, `const net=require('node:net');const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const options=typeof first==='object'?first:{host:args[1]};if(options.host&&!['127.0.0.1','localhost','::1'].includes(options.host)){process.nextTick(()=>this.destroy(new Error('Test prohibits external network')));return this;}return connect.apply(this,args);};`, { mode: 0o600 });
  writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(Bun.which('node'))} --require ${JSON.stringify(guard)} "$@"\n`, { mode: 0o700 });
  const script = `
    const {db,id,now}=await import('./server/db.ts');
    const {encrypt}=await import('./server/security.ts');
    const {qrisCrc,validatePaymentQris}=await import('./server/qris.ts');
    const {createPayment}=await import('./server/providers.ts');
    const {ensureGateway,gatewayLogs,shutdownGateways}=await import('./server/gateway-runtime.ts');
    const field=(tag,value)=>tag+String(value.length).padStart(2,'0')+value;
    const template=name=>{const p=field('00','01')+field('01','11')+field('51',field('00','ID.CO.QRIS.WWW')+field('01','TEST-ONLY-NOT-PAYABLE'))+field('52','5812')+field('53','360')+field('58','ID')+field('59',name)+field('60','JAKARTA')+'6304';return p+qrisCrc(p);};
    const user=id();db.query("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,'Test','gateway@example.test','unused','merchant',?)").run(user,now());
    const wallets=[];
    for(const [provider,name] of [['gopay','TEST 6304 QR A'],['gopay','TEST QR B'],['shopeepay','TEST SHOPEE QR']]){
      const wallet=id(),api_key=id();const secrets={api_key,qris_static:template(name),...(provider==='gopay'?{merchant_id:name}:{shopee_token:'B:TEST-ONLY-INVALID'})};
      db.query("INSERT INTO connections(id,user_id,provider,base_url,encrypted_secrets,label,managed) VALUES (?,?,?,'http://127.0.0.1:0',?,?,1)").run(wallet,user,provider,encrypt(JSON.stringify(secrets)),name);
      wallets.push({id:wallet,provider,name,base_url:'http://127.0.0.1:0',api_key,managed:true});
    }
    try{
      const outputs=[];
      for(const [index,amount] of [[0,25000],[1,35000],[2,45000],[0,55000]]){
        const wallet=wallets[index];const payment=await createPayment(wallet,amount);const decoded=validatePaymentQris(payment.qr_code,amount);const runtime=await ensureGateway(wallet.id);const logs=await gatewayLogs(wallet.id);
        outputs.push({merchant:decoded.merchant_name,amount,qr_url:payment.qr_url,origin:new URL(runtime.base_url).hostname,leaksToken:JSON.stringify(logs).includes('B:TEST-ONLY-INVALID')});
      }
      console.log(JSON.stringify(outputs));
    }finally{await shutdownGateways();db.close();}
  `;
  try {
    const child = Bun.spawn(['bun', '-e', script], {
      cwd: resolve(import.meta.dir, '..'),
      env: { ...process.env, DATABASE_PATH: ':memory:', GATEWAY_DATA_DIR: directory, GATEWAY_NODE_BINARY: executable, ENCRYPTION_KEY: 'b'.repeat(64) },
      stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      { merchant: 'TEST 6304 QR A', amount: 25000, qr_url: null, origin: '127.0.0.1', leaksToken: false },
      { merchant: 'TEST QR B', amount: 35000, qr_url: null, origin: '127.0.0.1', leaksToken: false },
      { merchant: 'TEST SHOPEE QR', amount: 45000, qr_url: null, origin: '127.0.0.1', leaksToken: false },
      { merchant: 'TEST 6304 QR A', amount: 55000, qr_url: null, origin: '127.0.0.1', leaksToken: false },
    ]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);

test('managed interactive login exits after completion without the parent closing IPC or stdin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qris-login-lifecycle-'));
  const script = join(directory, 'login.js');
  const result = join(directory, 'result.json');
  writeFileSync(script, `
    const readline = require('node:readline');
    const fs = require('node:fs');
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    input.question('Input: ', answer => {
      fs.writeFileSync('result.json', JSON.stringify({ answer }));
      input.close();
    });
  `, { mode: 0o600 });
  const child = spawn(Bun.which('node') || 'node', ['--require', resolve(import.meta.dir, 'vendor/managed-preload.cjs'), script], {
    cwd: directory,
    env: { PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    // Bound the real Node subprocess; fake timers cannot advance its event loop.
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  const exited = once(child, 'exit');
  try {
    const prompt = await new Promise<string>((resolvePrompt, reject) => {
      let output = '';
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('Input: ')) {
          child.stdout!.off('data', onData);
          resolvePrompt(output);
        }
      };
      child.stdout!.on('data', onData);
      child.once('exit', () => reject(new Error('Login exited before requesting input')));
      child.once('error', reject);
    });
    expect(prompt).toContain('Input: ');
    child.stdin!.write('test-only-input\n');
    expect(await exited).toEqual([0, null]);
    expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({ answer: 'test-only-input' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);

test('original GoPay gateway converts analytics minor units and matches only receipts within the invoice window', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qris-gopay-proof-'));
  const fixture = join(directory, 'analytics.json');
  const guard = join(directory, 'analytics-fixture.cjs');
  const executable = join(directory, 'node-fixture');
  writeFileSync(guard, `
    const Module = require('node:module');
    const fs = require('node:fs');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === './sessionManager' && parent.filename.endsWith('/server.js')) {
        return { getValidHeaders: async () => ({ Authorization: 'TEST-ONLY-NOT-A-SESSION' }) };
      }
      const value = load.apply(this, arguments);
      if (request === 'axios') value.get = async url => {
        if (url !== 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions') throw new Error('External network prohibited');
        return { data: { transactions: JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8')) } };
      };
      return value;
    };
  `, { mode: 0o600 });
  writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(Bun.which('node'))} --require ${JSON.stringify(guard)} "$@"\n`, { mode: 0o700 });
  const script = `
    const assert = await import('node:assert/strict');
    const {writeFileSync}=await import('node:fs');
    const {db,id,now}=await import('./server/db.ts');
    const {encrypt}=await import('./server/security.ts');
    const {checkPayment}=await import('./server/providers.ts');
    const {shutdownGateways}=await import('./server/gateway-runtime.ts');
    const user=id(),wallet=id();
    db.query("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,'Test','proof@example.test','unused','merchant',?)").run(user,now());
    db.query("INSERT INTO connections(id,user_id,provider,base_url,encrypted_secrets,label,managed) VALUES (?,?,'gopay','http://127.0.0.1:0',?,'TEST ONLY',1)").run(wallet,user,encrypt(JSON.stringify({api_key:id(),merchant_id:'TEST-ONLY',qris_static:'TEST-ONLY-NOT-PAYABLE'})));
    const connection={id:wallet,provider:'gopay',base_url:'http://127.0.0.1:0',api_key:'resolved-by-runtime',managed:true};
    const time=Date.now();
    const invoice={reference:'test-invoice-scope',amount:1000,created_at:new Date(time-60000).toISOString(),expires_at:new Date(time-1000).toISOString()};
    const row=(id,amount,date)=>({id,gross_amount:amount,real_gross_amount:amount,currency:'IDR',transaction_status:'SETTLEMENT',payment_type:'QRIS',transaction_time:new Date(date).toISOString()});
    try {
      writeFileSync(${JSON.stringify(fixture)},JSON.stringify([row('late',100000,time),row('on-time',100000,time-10000)]));
      const proof=await checkPayment(connection,invoice);
      assert.deepEqual(proof,{paid:true,transaction_id:'on-time',amount:1000,paid_at:new Date(time-10000).toISOString()});
      writeFileSync(${JSON.stringify(fixture)},JSON.stringify([row('wrong-unit',1000,time-10000)]));
      assert.deepEqual(await checkPayment(connection,invoice),{paid:false});
      writeFileSync(${JSON.stringify(fixture)},JSON.stringify([row('fractional-rupiah',100001,time-10000)]));
      await assert.rejects(()=>checkPayment(connection,invoice),error=>error.status===502);
      console.log(JSON.stringify({paid:proof.paid,amount:proof.amount,selectedOnTimeReceipt:proof.transaction_id==='on-time',wrongUnitRejected:true,fractionalRupiahRejected:true}));
    } finally {await shutdownGateways();db.close();}
  `;
  try {
    const child = Bun.spawn(['bun', '-e', script], {
      cwd: resolve(import.meta.dir, '..'),
      env: { ...process.env, DATABASE_PATH: ':memory:', GATEWAY_DATA_DIR: join(directory, 'wallets'), GATEWAY_NODE_BINARY: executable, ENCRYPTION_KEY: 'd'.repeat(64) },
      stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ paid: true, amount: 1000, selectedOnTimeReceipt: true, wrongUnitRejected: true, fractionalRupiahRejected: true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);
