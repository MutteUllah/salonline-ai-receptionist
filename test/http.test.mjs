import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { createApplication, makeSession, validSession } from '../server/index.mjs';

async function fixture(t, overrides={}) {
  const app=await createApplication({databasePath:':memory:',databaseUrl:'',nodeEnv:'development',host:'127.0.0.1',openaiApiKey:'',twilioAccountSid:'',twilioAuthToken:'',adminPassword:'',log:false,...overrides});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(route,method='GET',value,headers={})=>{
    const response=await fetch(base+route,{method,headers:{...(value?{'Content-Type':'application/json'}:{}),...headers},body:value?JSON.stringify(value):undefined});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  return {app,request,base};
}
function openDate(catalog) {
  let day=DateTime.now().setZone(catalog.salon.timeZone).plus({days:2}).startOf('day');
  while(!catalog.salon.businessHours[day.weekday])day=day.plus({days:1});
  return day.toISODate();
}
test('owner authentication protects private records and mutations',async t=>{
  const {request}=await fixture(t,{adminPassword:'a-unique-long-owner-password',sessionSecret:'a-very-long-unique-session-signing-secret'});
  assert.equal((await request('/api/bootstrap')).body.authRequired,true);
  assert.equal((await request('/api/bookings')).status,401);
  assert.equal((await request('/api/auth/login','POST',{password:'wrong'})).status,401);
  const login=await request('/api/auth/login','POST',{password:'a-unique-long-owner-password'});
  assert.equal(login.status,200);
  const auth={Authorization:`Bearer ${login.body.token}`};
  assert.equal((await request('/api/bookings','GET',null,auth)).status,200);
  assert.equal((await request('/api/settings','PUT',{}, {...auth,Origin:'https://evil.example'})).status,403);
  assert.equal((await request('/webhooks/twilio/voice','POST',{})).status,403);
});
test('English training conversation creates an actual appointment and call outcome',async t=>{
  const {request,app}=await fixture(t);
  const catalog=await app.store.catalog();
  let sessionId;
  for(const message of ['haircut',openDate(catalog),'1','Demo Customer','+923001234567','confirm']) {
    const response=await request('/api/demo/turn','POST',{sessionId,message});
    assert.equal(response.status,200,JSON.stringify(response.body));
    sessionId=response.body.sessionId;
  }
  const bookings=(await request('/api/bookings')).body.bookings;
  assert.equal(bookings.length,1);assert.equal(bookings[0].customerName,'Demo Customer');
  assert.equal(bookings[0].channel,'demo');assert.equal(bookings[0].whatsappConsent,false);
  assert.equal((await app.store.listOutbox()).length,0);
  assert.equal((await request('/api/calls')).body.calls[0].status,'completed');
  await request('/api/demo/turn','POST',{sessionId,message:'confirm'});
  assert.equal((await app.store.listBookings()).length,1);
});
test('Urdu training conversation reaches a confirmed appointment',async t=>{
  const {request,app}=await fixture(t);const catalog=await app.store.catalog();let sessionId,last;
  for(const message of ['بال',openDate(catalog),'۱','علی رضا','+923009876543','تصدیق']) {
    const response=await request('/api/demo/turn','POST',{sessionId,message,language:'ur'});
    assert.equal(response.status,200,JSON.stringify(response.body));last=response.body;sessionId=last.sessionId;
  }
  assert.equal(last.stage,'done');assert.match(last.reply,/بکنگ/);assert.equal((await app.store.listBookings()).length,1);
});
test('HTTP booking API preserves idempotency, then reschedules and cancels',async t=>{
  const {request,app}=await fixture(t);const catalog=await app.store.catalog();
  const date=openDate(catalog);const slots=(await request(`/api/availability?date=${date}&serviceId=haircut&stylistId=maya`)).body.slots;
  const input={serviceId:'haircut',stylistId:'maya',startAt:slots[0].startAt,customerName:'API Customer',phone:'+12125550123',whatsappConsent:false,confirmed:true};
  const first=await request('/api/bookings','POST',input,{'Idempotency-Key':'http-booking-0001'});
  assert.equal(first.status,201,JSON.stringify(first.body));
  const replay=await request('/api/bookings','POST',input,{'Idempotency-Key':'http-booking-0001'});assert.equal(first.body.id,replay.body.id);
  const move=await request(`/api/bookings/${first.body.id}/reschedule`,'POST',{startAt:slots.at(-1).startAt,stylistId:'maya',confirmed:true},{'Idempotency-Key':'http-reschedule-0001'});
  assert.equal(move.status,200,JSON.stringify(move.body));assert.equal(move.body.startAt,slots.at(-1).startAt);
  const cancel=await request(`/api/bookings/${first.body.id}/cancel`,'POST',{confirmed:true});assert.equal(cancel.status,200);assert.equal(cancel.body.status,'cancelled');
});
test('session integrity and expiry are checked',()=>{
  const token=makeSession('secret');assert.equal(validSession(token,'secret'),true);assert.equal(validSession(token,'different'),false);assert.equal(validSession(token+'x','secret'),false);assert.equal(validSession(makeSession('secret',-5),'secret'),false);
});
