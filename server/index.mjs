import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { createStore } from './store.mjs';
import { createVoiceService } from './voice.mjs';
import { validateTwilioSignature } from './twilio.mjs';
import { createDemo } from './demo.mjs';

const publicDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const hash=s=>createHash('sha256').update(String(s)).digest();
export function makeSession(secret, ttl=8*60*60) {
  const body=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+ttl,nonce:randomBytes(16).toString('hex')})).toString('base64url');
  return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
export function validSession(value,secret) {
  try {const [body,signature,...rest]=String(value).split('.');if(rest.length||!body||!signature)return false;
    const expected=createHmac('sha256',secret).update(body).digest('base64url');
    if(!timingSafeEqual(hash(signature),hash(expected)))return false;
    const p=JSON.parse(Buffer.from(body,'base64url'));return p.exp>Math.floor(Date.now()/1000)&&p.exp<=Math.floor(Date.now()/1000)+86400;
  }catch{return false;}
}

export async function createApplication(overrides={}) {
  const config={...loadConfig(),...overrides};
  config.sessionSecret ||= randomBytes(36).toString('base64url');
  config.publicUrl=config.publicBaseUrl;
  config.streamTokenSecret ||= config.sessionSecret;
  config.twilioWhatsappNumber=config.twilioWhatsAppNumber;
  config.whatsappContentSid ||= process.env.WHATSAPP_CONTENT_SID||process.env.TWILIO_WHATSAPP_CONTENT_SID||'';
  config.realtimeModel=process.env.OPENAI_REALTIME_MODEL||'gpt-realtime-2.1';
  config.voice=process.env.OPENAI_VOICE||'marin';
  config.maxConcurrentCalls=Number(process.env.MAX_CONCURRENT_CALLS||10);
  config.maxCallSeconds=Number(process.env.MAX_CALL_SECONDS||600);
  const live=Boolean(config.openaiApiKey&&config.twilioAccountSid&&config.twilioAuthToken);
  const externallyBound=!['127.0.0.1','localhost','::1'].includes(config.host);
  if((config.nodeEnv==='production'||live||externallyBound) && (!config.adminPassword||config.adminPassword.length<16)) throw new Error('A unique ADMIN_PASSWORD of at least 16 characters is required for live calls or non-loopback access.');
  if(config.nodeEnv==='production') {
    if(!config.databaseUrl?.startsWith('postgres'))throw new Error('Production requires DATABASE_URL for PostgreSQL.');
    if(!config.publicBaseUrl?.startsWith('https://'))throw new Error('Production requires PUBLIC_BASE_URL=https://...');
    if(!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32)throw new Error('Production requires SESSION_SECRET of at least 32 characters.');
  }
  const store=overrides.store||await createStore(config);
  const catalog=await store.catalog();config.business={...catalog.salon,services:catalog.services,stylists:catalog.stylists};
  const voice=createVoiceService({config,store});
  const demo=createDemo(store);
  const rate=new Map();
  const rateLimited=(key,max=120,window=60e3)=>{let r=rate.get(key);if(!r||Date.now()>r.exp){r={n:0,exp:Date.now()+window};rate.set(key,r);}return ++r.n>max;};
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  const body=async req=>{let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>32768)throw Object.assign(new Error('Request too large'),{status:413});}return text;};
  const readiness=()=>{
    const checks=[
      {id:'owner',label:'Owner access',ready:Boolean(config.adminPassword),detail:'Set ADMIN_PASSWORD and SESSION_SECRET before exposing the server.'},
      {id:'database',label:'Production database',ready:Boolean(config.databaseUrl),detail:'Use PostgreSQL for deployment; local development uses SQLite.'},
      {id:'publicUrl',label:'Public HTTPS endpoint',ready:config.publicBaseUrl.startsWith('https://'),detail:'Point Twilio webhooks at this server over HTTPS/WSS.'},
      {id:'openai',label:'Realtime voice',ready:Boolean(config.openaiApiKey),detail:'Set OPENAI_API_KEY on the server.'},
      {id:'twilio',label:'Twilio account',ready:Boolean(config.twilioAccountSid&&config.twilioAuthToken),detail:'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.'},
      {id:'phone',label:'Regular phone number',ready:Boolean(config.twilioPhoneNumber),detail:'Provision a voice-capable number and configure its incoming webhook.'},
      {id:'whatsapp',label:'WhatsApp sender configured',ready:Boolean(config.twilioWhatsAppNumber),detail:'Meta verification and Calling approval must also be checked in your provider console.'},
      {id:'messages',label:'WhatsApp confirmations',ready:Boolean(config.whatsappContentSid&&config.whatsappSendEnabled),detail:'Requires an approved utility template, customer consent and explicit sending enablement.'}
    ];return {mode:live?'live':'demo',checks,ready:checks.filter(x=>!['whatsapp','messages'].includes(x.id)).every(x=>x.ready),note:'Configuration presence does not verify provider approval or a successful real call.',webhooks:{incoming:`${config.publicBaseUrl}/webhooks/twilio/voice`,status:`${config.publicBaseUrl}/webhooks/twilio/status`,messages:`${config.publicBaseUrl}/webhooks/twilio/message-status`}};
  };
  const server=http.createServer(async(req,res)=>{
    const requestId=randomUUID();const started=Date.now();
    res.setHeader('X-Request-Id',requestId);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; media-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    if(config.nodeEnv==='production')res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    const url=new URL(req.url,'http://localhost');
    res.on('finish',()=>{if(overrides.log!==false)console.log(JSON.stringify({time:new Date().toISOString(),requestId,method:req.method,path:url.pathname,status:res.statusCode,ms:Date.now()-started}));});
    try {
      if(url.pathname==='/healthz')return json(res,200,{ok:true});
      if(url.pathname==='/readyz'){await store.catalog();return json(res,200,{ok:true});}
      const ip=req.socket.remoteAddress||'unknown';
      if(rateLimited(`all:${ip}`,300))return json(res,429,{error:'Too many requests; try again shortly.'});
      if(url.pathname.startsWith('/webhooks/twilio/')) {
        if(req.method!=='POST')return json(res,405,{error:'POST required'});
        const signedParams=new URLSearchParams(await body(req));
        const params=Object.fromEntries(signedParams);
        const signedUrl=config.publicBaseUrl.replace(/\/$/,'')+req.url;
        if(!config.twilioAuthToken||!validateTwilioSignature(config.twilioAuthToken,signedUrl,signedParams,req.headers['x-twilio-signature']))return json(res,403,{error:'Invalid webhook signature'});
        if(url.pathname==='/webhooks/twilio/voice'){const xml=await voice.handleIncoming(params);res.writeHead(200,{'Content-Type':'text/xml; charset=utf-8'});return res.end(xml);}
        if(url.pathname==='/webhooks/twilio/status'){await voice.handleStatus(params);return json(res,200,{ok:true});}
        if(url.pathname==='/webhooks/twilio/message-status') {await store.recordEvent({type:'message.delivery',payload:{messageSid:params.MessageSid,status:params.MessageStatus,errorCode:params.ErrorCode||null}});return json(res,200,{ok:true});}
        return json(res,404,{error:'Unknown webhook'});
      }
      if(url.pathname==='/api/bootstrap'&&req.method==='GET') {
        const c=await store.catalog();return json(res,200,{mode:live?'live':'demo',authRequired:Boolean(config.adminPassword),business:{...c.salon,timezone:c.salon.timeZone},services:c.services,stylists:c.stylists,timezone:c.salon.timeZone,languages:['en','ur'],integrations:{phone:Boolean(config.twilioPhoneNumber),whatsapp:Boolean(config.twilioWhatsAppNumber),voice:Boolean(config.openaiApiKey)}});
      }
      if(url.pathname==='/api/auth/login'&&req.method==='POST') {
        if(rateLimited(`login:${ip}`,8,15*60e3))return json(res,429,{error:'Too many sign-in attempts. Try again in 15 minutes.'});
        let input;try{input=JSON.parse(await body(req));}catch{return json(res,400,{error:'Invalid JSON'});}
        if(!config.adminPassword||!timingSafeEqual(hash(input.password||''),hash(config.adminPassword)))return json(res,401,{error:'Incorrect owner password'});
        return json(res,200,{token:makeSession(config.sessionSecret),expiresIn:28800});
      }
      if(url.pathname.startsWith('/api/')) {
        if(config.adminPassword&&!validSession(req.headers.authorization?.replace(/^Bearer /,''),config.sessionSecret))return json(res,401,{error:'Sign in to access the owner dashboard'});
        if(['POST','PUT','PATCH','DELETE'].includes(req.method)) {
          const origin=req.headers.origin;
          if(origin&&origin!==config.publicBaseUrl&&origin!==`http://${req.headers.host}`)return json(res,403,{error:'Origin not permitted'});
          if(!String(req.headers['content-type']).startsWith('application/json'))return json(res,415,{error:'Use application/json'});
        }
        let input={};if(['POST','PUT','PATCH'].includes(req.method)){try{input=JSON.parse(await body(req));}catch(e){if(e.status)throw e;return json(res,400,{error:'Invalid JSON'});}}
        if(url.pathname==='/api/overview'&&req.method==='GET')return json(res,200,await store.overview());
        if(url.pathname==='/api/bookings'&&req.method==='GET')return json(res,200,{bookings:await store.listBookings(Object.fromEntries(url.searchParams))});
        if(url.pathname==='/api/bookings'&&req.method==='POST')return json(res,201,await store.createBooking({...input,channel:'admin'},req.headers['idempotency-key']));
        if(url.pathname==='/api/availability'&&req.method==='GET')return json(res,200,await store.availability(Object.fromEntries(url.searchParams)));
        const action=url.pathname.match(/^\/api\/bookings\/([a-zA-Z0-9-]+)\/(cancel|reschedule)$/);
        if(action&&req.method==='POST')return json(res,200,action[2]==='cancel'?await store.cancelBooking(action[1],{...input,admin:true}):await store.rescheduleBooking(action[1],{...input,admin:true},req.headers['idempotency-key']));
        if(url.pathname==='/api/calls'&&req.method==='GET')return json(res,200,{calls:await store.listCalls(Object.fromEntries(url.searchParams))});
        if(url.pathname==='/api/messages'&&req.method==='GET')return json(res,200,{messages:await store.listOutbox(Object.fromEntries(url.searchParams))});
        if(url.pathname==='/api/settings'&&req.method==='GET')return json(res,200,await store.settings());
        if(url.pathname==='/api/settings'&&req.method==='PUT'){const settings=await store.updateSettings(input);const c=await store.catalog();config.business={...c.salon,services:c.services,stylists:c.stylists};return json(res,200,settings);}
        if(url.pathname==='/api/readiness'&&req.method==='GET')return json(res,200,readiness());
        if(url.pathname==='/api/demo/turn'&&req.method==='POST')return json(res,200,await demo.turn(input));
        if(url.pathname==='/api/demo/end'&&req.method==='POST')return json(res,200,await demo.end(input.sessionId));
        if(url.pathname==='/api/voice/session')return json(res,409,{error:'Use the configured phone or WhatsApp number for live Realtime calls. Voice Studio provides a clearly labeled browser training demo.'});
        return json(res,404,{error:'Endpoint not found'});
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'Method not allowed'});
      const allowed={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/favicon.svg':'favicon.svg'};
      const file=allowed[url.pathname];if(!file)return json(res,404,{error:'Not found'});
      const content=await readFile(path.join(publicDir,file));
      res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8'});res.end(req.method==='HEAD'?undefined:content);
    }catch(e){const status=Number(e.status)||500;if(status>=500)console.error(JSON.stringify({requestId,error:e.code||e.name}));json(res,status,{error:status>=500?'Something went wrong. Please try again or contact the receptionist.':e.message,code:e.code||'REQUEST_FAILED',requestId});}
  });
  server.headersTimeout=15000;server.requestTimeout=30000;
  server.on('upgrade',(req,socket,head)=>{if(!voice.handleUpgrade(req,socket,head))socket.destroy();});
  const worker=setInterval(()=>{if(config.whatsappSendEnabled)voice.processOutbox().catch(e=>console.error(JSON.stringify({event:'outbox.error',code:e.code||e.name})));for(const [k,v]of rate)if(v.exp<Date.now())rate.delete(k);},10000);worker.unref();
  return {server,store,config,voice,async close(){clearInterval(worker);await voice.close();await new Promise(r=>server.listening?server.close(r):r());await store.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=await createApplication();
  app.server.listen(app.config.port,app.config.host,()=>console.log(`SalonLine ready at http://${app.config.host}:${app.config.port} · ${app.config.openaiApiKey?'voice configured':'local demo'} · Urdu + English`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
}
