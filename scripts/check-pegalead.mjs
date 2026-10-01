// Actual HTTP/HMAC cross-system check; synthetic data, no WhatsApp send.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prisma } from '../src/lib/prisma.ts';
import { dispatchWebhook } from '../src/lib/webhook.ts';
if (!process.env.PEGALEAD_CHECKOUT || process.env.PEGALEAD_TEST_POSTGRES_URL) throw new Error('Provide PEGALEAD_CHECKOUT; inherited test PostgreSQL is forbidden.');
const root = path.resolve(process.env.PEGALEAD_CHECKOUT);
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const { eq } = await load('node_modules/drizzle-orm/index.js');
const { createTestEnv, setupFirstOwner, api, ctxFor } = await load('tests/helpers.ts');
const { messages, suppressionEntries } = await load('src/server/db/schema.ts');
const { verifyIntegration } = await load('src/server/services/integrations.ts');
const { createWaAkgAdapter } = await load('src/server/integrations/wa-akg.ts');
const sessionId = process.env.WA_AKG_SESSION_ID || 'pegalead';
if (!process.env.WA_AKG_BASE_URL || !process.env.WA_AKG_API_KEY) throw new Error('Gateway origin and authorized API key required.');
const secret = randomBytes(32).toString('hex'), slug = 'cross_' + randomBytes(6).toString('hex');
const dbUrl = new URL(process.env.DATABASE_URL);
assert.equal(dbUrl.hostname, '127.0.0.1'); assert.equal(dbUrl.pathname, '/wa_akg_contract');
const [activeHooks, pendingJobs] = await Promise.all([
  prisma.webhook.count({ where: { isActive: true } }),
  prisma.webhookDelivery.count({ where: { state: { in: ['PENDING', 'SENDING'] } } }),
]);
if (activeHooks || pendingJobs) {
  await prisma.$disconnect();
  throw new Error('Exclusive test schema required: active webhooks or delivery jobs already exist.');
}
process.chdir(root);
let userId, posts = 0;
const env = await createTestEnv({config: {waAkgBaseUrl: process.env.WA_AKG_BASE_URL, secrets:{waAkgApiKey:process.env.WA_AKG_API_KEY,waAkgWebhookSecret:secret}}});
try {
  const owner = await setupFirstOwner(env);
  await env.app.listen({host:'127.0.0.1',port:0});
  const origin = `http://127.0.0.1:${(env.app.server.address()).port}`;
  process.env.WEBHOOK_ALLOWED_ORIGINS = origin;
  assert.equal((await api(env,owner).patch('/api/v1/integrations/wa_akg/settings',{config:{session_id:sessionId}})).status,200);
  const realFetch = async (url, init) => {
    if (init?.method === 'POST') { posts++; throw new Error('WhatsApp sends forbidden in this functional test'); }
    return fetch(url, init);
  };
  const auth = await verifyIntegration({...env.deps,graphFetch:realFetch},ctxFor(owner),'wa_akg','auth');
  assert.ok(['passed','failed'].includes(auth.result)); assert.ok(auth.capabilities.every(cap => cap.status !== 'VERIFIED'));
  const adapter = createWaAkgAdapter(env.deps.config, realFetch);
  const send = await adapter.send({tenantId:owner.tenantId,actionId:slug,idempotencyKey:slug,channel:'whatsapp',recipient:'+15550100999',subject:null,body:'Never sent. Preflight only.',isFixture:false,fencingToken:slug,providerConfig:{session_id:sessionId},beforeSend:async()=>false});
  assert.ok(['failed_transient','failed_permanent'].includes(send.outcome)); assert.equal(posts,0);
  assert.equal((await api(env,owner).patch('/api/v1/integrations/wa_akg/settings',{config:{session_id:slug}})).status,200);
  userId = (await prisma.user.create({data:{email:slug+'@example.invalid',password:'UNUSABLE_SYNTHETIC_HASH'}})).id;
  const session = await prisma.session.create({data:{sessionId:slug,name:'Cross-system synthetic fixture',userId}});
  await prisma.sessionIdentifier.createMany({data:[{id:slug},{id:session.id}]});
  await prisma.webhook.create({data:{userId,sessionId:session.id,name:slug,url:origin+'/webhooks/wa-akg',secret,events:['message.received']}});
  const data = {key:{id:slug,fromMe:false},from:'15550100999@s.whatsapp.net',isGroup:false,type:'TEXT',content:'PARAR',messageTimestamp:Math.floor(env.clock.now().getTime()/1000)};
  await dispatchWebhook(slug,'message.received',data);
  for(let i=0;i<150;i++){if((await env.deps.db.select().from(messages)).length)break;await new Promise(r=>setTimeout(r,20));}
  const recorded = await env.deps.db.select().from(messages);
  assert.equal(recorded.length,1); assert.equal(recorded[0].body,'PARAR'); assert.equal(recorded[0].tenantId,owner.tenantId);
  const suppressions = await env.deps.db.select().from(suppressionEntries).where(eq(suppressionEntries.tenantId,owner.tenantId));
  assert.equal(suppressions.length,2); assert.ok(suppressions.every(row => row.sourceRef === recorded[0].id));
  await dispatchWebhook(slug,'message.received',data);
  for(let i=0;i<100;i++){if(await prisma.webhookLog.count({where:{webhook:{userId},status:'SUCCESS'}})===2)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(await prisma.webhookLog.count({where:{webhook:{userId},status:'SUCCESS'}}),2);
  assert.equal((await env.deps.db.select().from(messages)).length,1);
  console.log(JSON.stringify({gateway:'Docker app+MySQL8',gatewayAuth:auth.result,outbound:'actual preflight; zero POST',inbound:'WA-AKG encrypted queue -> real loopback HTTP/HMAC -> Pegalead Fastify/PGlite',stopSuppression:true,deduplication:true,fixtures:'synthetic disposable data',realWhatsAppSends:posts}));
} finally {
  await new Promise(r=>setTimeout(r,250));
  if(userId)await prisma.user.deleteMany({where:{id:userId}});
  await prisma.$disconnect(); await env.close();
}
