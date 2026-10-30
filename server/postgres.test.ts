import { expect, test, afterAll } from 'bun:test';
if (process.env.QRIS_TEST_DATABASE !== '1') throw new Error('Jalankan bun run test dengan TEST_DATABASE_URL.');
const { db, id, now } = await import('./db');
const { encrypt, newSecret } = await import('./security');
afterAll(async () => { await db.close(); });

async function child(source: string) {
  const process = Bun.spawn(['bun', '-e', source], { stdout: 'pipe', stderr: 'pipe', env: { ...globalThis.process.env } });
  const output = await new Response(process.stdout).text();
  expect(await process.exited, await new Response(process.stderr).text()).toBe(0);
  return JSON.parse(output);
}

test('independent application processes share quota and unique payable amounts, and cannot reuse a receipt', async () => {
  const user = id(), wallet = id();
  await db.query("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES ($1,'TEST ONLY',$2,'test','merchant',$3)").run(user, `${user}@example.test`, now());
  await db.query("INSERT INTO connections(id,user_id,provider,base_url,encrypted_secrets,managed) VALUES ($1,$2,'gopay','http://127.0.0.1:0',$3,1)")
    .run(wallet, user, encrypt(JSON.stringify({ api_key: newSecret() })));
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => child(`
    const {spyOn}=await import('bun:test');
    const providers=await import('./server/providers');
    spyOn(providers,'createPayment').mockImplementation(async()=>({reference:'TEST-ONLY',qr_code:'TEST-ONLY-NOT-PAYABLE',qr_url:null,expires_at:new Date(Date.now()+600000).toISOString()}));
    const {createMerchantInvoice}=await import('./server/domain');
    const {db}=await import('./server/db');
    try { const invoice=await createMerchantInvoice(${JSON.stringify(user)},{connection_id:${JSON.stringify(wallet)},amount:10000,description:'TEST ONLY',external_id:'parallel-${index}'},'production');console.log(JSON.stringify({id:invoice.id,amount:invoice.payable_amount})); }
    catch(error){if(error.status!==429)throw error;console.log(JSON.stringify({limited:true}));}
    finally{await db.close();}
  `)));
  expect(results.filter(result => result.limited)).toHaveLength(3);
  const invoices = results.filter(result => result.id);
  expect(invoices).toHaveLength(5);
  expect(new Set(invoices.map(invoice => invoice.amount)).size).toBe(5);
  const paid = await Promise.all(invoices.slice(0, 2).map(invoice => child(`
    const {recordPaid}=await import('./server/domain');const {db}=await import('./server/db');
    try{await recordPaid(${JSON.stringify(invoice.id)},{transaction_id:'SAME-RECEIPT',amount:${invoice.amount},paid_at:new Date().toISOString()});console.log(JSON.stringify({paid:true}));}
    catch(error){if(error.status!==409)throw error;console.log(JSON.stringify({conflict:true}));}
    finally{await db.close();}
  `)));
  expect(paid.filter(result => result.paid)).toHaveLength(1);
  expect(paid.filter(result => result.conflict)).toHaveLength(1);
  expect(await db.query('SELECT COUNT(*)::integer AS total FROM transaction_claim').get()).toEqual({ total: 1 });
}, 15000);
