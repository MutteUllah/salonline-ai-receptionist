import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import WebSocket from 'ws';
import { createAgentTools, isExplicitAffirmative } from '../server/agent.mjs';
import { createRealtimeBridge, createVoiceService, issueStreamToken, verifyStreamToken } from '../server/voice.mjs';
import { createTwilioClient, signTwilioRequest, streamTwiml, validateTwilioSignature } from '../server/twilio.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
class FakeSocket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  message(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
const catalog = { salon: { name: 'Test Salon', timeZone: 'Asia/Karachi', currency: 'PKR' }, services: [{ id: 'cut', name: 'Haircut', price: 1500 }], stylists: [{ id: 'ali', name: 'Ali', serviceIds: ['cut'] }] };

test('Twilio request verification covers exact URL, all form fields and duplicate values', () => {
  const url = 'https://example.com/webhooks/twilio/voice?x=1';
  const params = new URLSearchParams('CallSid=CA123&From=%2B923001234567&Tag=b&Tag=a');
  const expected = createHmac('sha1', 'secret').update(url + 'CallSidCA123From+923001234567TagaTagb').digest('base64');
  assert.equal(signTwilioRequest('secret', url, params), expected);
  assert.equal(validateTwilioSignature('secret', url, params, expected), true);
  assert.equal(validateTwilioSignature('secret', url + 'x', params, expected), false);
  assert.equal(validateTwilioSignature('secret', url, { CallSid: 'CA123' }, expected), false);
  assert.equal(validateTwilioSignature('', url, params, expected), false);
});

test('stream token rejects tampering and expiry, and TwiML does not put the token in a query string', () => {
  const payload = { callSid: `CA${'1'.repeat(32)}`, callId: 'abc', fromNumber: '+923001234567', channel: 'phone' };
  const token = issueStreamToken('long-secret', payload, 1_000_000);
  assert.equal(verifyStreamToken('long-secret', token, 1_000_100).callSid, payload.callSid);
  assert.equal(verifyStreamToken('wrong-secret', token, 1_000_100), null);
  assert.equal(verifyStreamToken('long-secret', token, 1_100_000), null);
  const xml = streamTwiml({ url: 'wss://example.com/ws/twilio', token, ...payload });
  assert.match(xml, /url="wss:\/\/example.com\/ws\/twilio"/);
  assert.match(xml, /Parameter name="token"/);
  assert.equal(xml.includes('?token'), false);
});

test('agent requires a separate caller turn, binds phone identity, and replays committed results without a duplicate booking', async () => {
  let writes = 0;
  const context = { callId: 'test-call', fromNumber: 'whatsapp:+923001234567', channel: 'whatsapp', userTurn: 1 };
  const store = { catalog: async () => catalog, createBooking: async (input) => { writes++; assert.equal(input.phone, '+923001234567'); assert.equal(input.confirmed, true); return { ...input, id: 'booking', bookingCode: 'ABCD12' }; }, recordEvent: async () => {} };
  const agent = await createAgentTools(store, {}, context);
  const proposal = await agent.execute('prepare_booking', { serviceId: 'cut', stylistId: 'ali', startAt: '2026-10-20T05:00:00Z', customerName: 'Amir', whatsappConsent: false, phone: '+15555550123' });
  assert.equal(proposal.ok, true);
  assert.equal((await agent.execute('confirm_action', { proposalId: proposal.proposalId, confirmed: true })).error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(writes, 0);
  context.userTurn++;
  context.latestTranscript = { turn: context.userTurn, text: 'Yes, please.' };
  const result = await agent.execute('confirm_action', { proposalId: proposal.proposalId, confirmed: true });
  assert.equal(result.ok, true);
  assert.equal((await agent.execute('confirm_action', { proposalId: proposal.proposalId, confirmed: true })).booking.id, 'booking');
  assert.equal(writes, 1);
  assert.match(agent.instructions, /Urdu/);
});

test('confirmation accepts only an entire short English or Urdu affirmation', async () => {
  for (const text of ['Yes.', 'yes please', 'GO AHEAD!', 'جی ہاں۔', 'ٹھیک ہے']) assert.equal(isExplicitAffirmative(text), true, text);
  for (const text of ['', '...', '[noise]', 'no', 'not yes', 'yes but change time', 'what is the price', 'جی نہیں', 'جی ہاں لیکن وقت بدل دیں']) assert.equal(isExplicitAffirmative(text), false, text);
  let writes = 0;
  const context = { callId: 'guarded', fromNumber: '+923001234567', channel: 'phone', userTurn: 1 };
  const agent = await createAgentTools({ catalog: async () => catalog, createBooking: async (input) => { writes++; return { ...input, id: 'b' }; }, recordEvent: async () => {} }, {}, context);
  const proposal = await agent.execute('prepare_booking', { serviceId: 'cut', stylistId: 'ali', startAt: '2026-10-20T05:00:00Z', customerName: 'Amir', whatsappConsent: false });
  context.userTurn = 2;
  for (const text of ['', 'yes but change time', 'what is the price', 'جی نہیں']) {
    context.latestTranscript = { turn: 2, text };
    assert.equal((await agent.execute('confirm_action', { proposalId: proposal.proposalId, confirmed: true })).error.code, 'EXPLICIT_CONFIRMATION_REQUIRED');
  }
  assert.equal(writes, 0);
  context.latestTranscript = { turn: 1, text: 'Yes' };
  assert.equal((await agent.execute('confirm_action', { proposalId: proposal.proposalId, confirmed: true })).ok, false, 'a stale affirmative turn cannot confirm');
  context.latestTranscript = { turn: 2, text: 'جی ہاں۔' };
  assert.equal((await agent.execute('confirm_action', { proposalId: proposal.proposalId, confirmed: true })).ok, true);
  assert.equal(writes, 1);
});

test('lookup and change cannot use a model-selected customer phone', async () => {
  const context = { callId: 'test', fromNumber: '+923001234567', channel: 'phone', userTurn: 0 };
  const agent = await createAgentTools({ catalog: async () => catalog, lookupBooking: async (input) => { assert.deepEqual(input, { phone: context.fromNumber, bookingCode: 'ABCD12' }); return { id: 'b', bookingCode: 'ABCD12' }; } }, {}, context);
  const result = await agent.execute('lookup_booking', { phone: '+15555550123', bookingCode: 'ABCD12' });
  assert.equal(result.ok, true);
});

test('GA voice protocol forwards raw μ-law, acknowledges readiness, and truncates actual playback on interruption', async () => {
  const phone = new FakeSocket(); const upstream = new FakeSocket(); const context = { userTurn: 0 };
  const bridge = createRealtimeBridge({ twilioSocket: phone, start: { streamSid: 'MZtest' }, context, config: { maxCallSeconds: 60 }, agentPromise: Promise.resolve({ instructions: 'test', tools: [], execute: async () => ({ ok: true }) }), createUpstream: () => upstream });
  phone.message({ event: 'media', streamSid: 'MZtest', media: { timestamp: '100', payload: Buffer.alloc(160, 127).toString('base64') } });
  assert.equal(upstream.sent.length, 0);
  upstream.emit('open'); await tick();
  assert.deepEqual(upstream.sent[0].session.audio.input.format, { type: 'audio/pcmu' });
  assert.deepEqual(upstream.sent[0].session.audio.output.format, { type: 'audio/pcmu' });
  upstream.message({ type: 'session.updated' });
  assert.ok(upstream.sent.some((event) => event.type === 'input_audio_buffer.append'));
  upstream.message({ type: 'response.created', response: { id: 'r1' } });
  const delta = Buffer.alloc(3200, 127).toString('base64');
  upstream.message({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'i1', content_index: 0, delta });
  const media = phone.sent.filter((event) => event.event === 'media');
  assert.equal(Buffer.concat(media.map((event) => Buffer.from(event.media.payload, 'base64'))).length, 3200);
  phone.message({ event: 'media', streamSid: 'MZtest', media: { timestamp: '250', payload: Buffer.alloc(160).toString('base64') } });
  upstream.message({ type: 'input_audio_buffer.speech_started' });
  assert.equal(phone.sent.at(-1).event, 'clear');
  assert.equal(upstream.sent.at(-1).type, 'conversation.item.truncate');
  assert.equal(upstream.sent.at(-1).audio_end_ms, 150);
  const count = phone.sent.length;
  upstream.message({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'i1', delta });
  assert.equal(phone.sent.length, count, 'late cancelled audio is ignored');
  upstream.message({ type: 'input_audio_buffer.speech_stopped' });
  assert.equal(context.userTurn, 1);
  bridge.close();
});

test('Twilio clear marks cannot claim cancelled audio was heard', async () => {
  const phone = new FakeSocket(); const upstream = new FakeSocket();
  const bridge = createRealtimeBridge({ twilioSocket: phone, start: { streamSid: 's' }, context: {}, config: {}, agentPromise: Promise.resolve({ instructions: '', tools: [] }), createUpstream: () => upstream });
  upstream.emit('open'); await tick(); upstream.message({ type: 'session.updated' });
  upstream.message({ type: 'response.created', response: { id: 'r' } });
  upstream.message({ type: 'response.output_audio.delta', response_id: 'r', item_id: 'item', delta: Buffer.alloc(1600).toString('base64') });
  const mark = phone.sent.find((event) => event.event === 'mark');
  upstream.message({ type: 'input_audio_buffer.speech_started' });
  phone.message({ event: 'mark', streamSid: 's', mark: mark.mark });
  assert.equal(upstream.sent.filter((event) => event.type === 'conversation.item.truncate').length, 1);
  bridge.close();
});

test('transcription gate waits for the correct caller item, ignores stale turns and never stores a transcript', async () => {
  const phone = new FakeSocket(); const upstream = new FakeSocket(); const context = { userTurn: 0 };
  const bridge = createRealtimeBridge({ twilioSocket: phone, start: { streamSid: 's' }, context, config: {}, agentPromise: Promise.resolve({ instructions: '', tools: [] }), createUpstream: () => upstream });
  upstream.emit('open'); await tick();
  assert.equal(upstream.sent[0].session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
  upstream.message({ type: 'input_audio_buffer.speech_stopped', item_id: 'old' });
  upstream.message({ type: 'input_audio_buffer.speech_stopped', item_id: 'latest' });
  const waiting = context.awaitConfirmation(2);
  upstream.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old', transcript: 'yes' });
  assert.equal(context.latestTranscript, null);
  upstream.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'latest', transcript: 'yes but change time' });
  assert.equal(await waiting, 'yes but change time');
  assert.equal(isExplicitAffirmative(context.latestTranscript.text), false);
  await bridge.close();
  assert.equal(context.latestTranscript, null);
});

test('outbound WhatsApp requires explicit consent and an approved template', async () => {
  let requests = 0;
  const config = { whatsappSendEnabled: true, twilioAccountSid: `AC${'a'.repeat(32)}`, twilioAuthToken: 'secret', twilioWhatsAppNumber: 'whatsapp:+14155550100', whatsappContentSid: `HX${'b'.repeat(32)}`, publicBaseUrl: 'https://example.com' };
  const client = createTwilioClient(config, async (url, options) => { requests++; assert.match(url, /Messages.json$/); assert.ok(options.body.has('ContentSid')); assert.equal(options.body.has('Body'), false); return { ok: true, json: async () => ({ sid: 'SM1' }) }; });
  await assert.rejects(client.sendWhatsApp({ to: '+923001234567', consent: false }), (error) => error.code === 'WHATSAPP_CONSENT');
  assert.equal(requests, 0);
  assert.deepEqual(await client.sendWhatsApp({ to: '+923001234567', consent: true, templateVariables: { '1': 'Amir' } }), { providerId: 'SM1' });
  assert.equal(requests, 1);
});

test('unconfigured incoming calls enter callback queue without offering a fake booking', async () => {
  const updates = [];
  const service = createVoiceService({ config: {}, store: { createCall: async () => ({ id: 'c' }), updateCall: async (id, patch) => updates.push(patch), recordEvent: async () => {} } });
  const xml = await service.handleIncoming({ CallSid: `CA${'c'.repeat(32)}`, From: '+923001234567' });
  assert.match(xml, /No appointment has been made/);
  assert.equal(updates[0].status, 'needs_callback');
  assert.equal(xml.includes('<Stream'), false);
  await service.close();
});

test('websocket upgrades fail closed for an absent Twilio signature', async () => {
  const service = createVoiceService({ config: { publicBaseUrl: 'https://example.com', openaiApiKey: 'key', twilioAuthToken: 'token', sessionSecret: 'secret' }, store: {} });
  const socket = { write(value) { this.response = value; }, destroy() { this.destroyed = true; } };
  assert.equal(service.handleUpgrade({ url: '/ws/twilio', headers: {} }, socket, Buffer.alloc(0)), true);
  assert.match(socket.response, /403/); assert.equal(socket.destroyed, true);
  await service.close();
});

test('a reserved call closed before connecting is recorded with completion metadata and released', async () => {
  const patches = [];
  const service = createVoiceService({ config: { publicBaseUrl: 'https://example.com', openaiApiKey: 'test-key', twilioAccountSid: `AC${'a'.repeat(32)}`, twilioAuthToken: 'test-token', sessionSecret: 'test-secret' }, store: { createCall: async () => ({ id: 'reserved' }), updateCall: async (id, patch) => patches.push(patch), recordEvent: async () => {} } });
  const sid = `CA${'d'.repeat(32)}`;
  assert.match(await service.handleIncoming({ CallSid: sid, From: '+923001234567' }), /<Stream/);
  assert.equal(service.stats().pendingCalls, 1);
  await service.handleStatus({ CallSid: sid, CallStatus: 'completed', CallDuration: '4' });
  assert.equal(service.stats().pendingCalls, 0);
  assert.equal(patches.at(-1).durationSeconds, 4);
  assert.ok(Number.isFinite(Date.parse(patches.at(-1).endedAt)));
  assert.equal(patches.at(-1).status, 'needs_callback');
  await service.close();
});

test('shutdown awaits pending reservation cleanup before closing the database', async () => {
  const patches = [];
  const service = createVoiceService({ config: { publicBaseUrl: 'https://example.com', openaiApiKey: 'test-key', twilioAccountSid: `AC${'a'.repeat(32)}`, twilioAuthToken: 'test-token', sessionSecret: 'test-secret' }, store: { createCall: async () => ({ id: 'reserved' }), updateCall: async (id, patch) => { await tick(); patches.push(patch); }, recordEvent: async () => {} } });
  await service.handleIncoming({ CallSid: `CA${'e'.repeat(32)}`, From: '+923001234567' });
  await service.close();
  assert.equal(patches.length, 1);
  assert.equal(patches[0].status, 'needs_callback');
  assert.ok(Number.isFinite(Date.parse(patches[0].endedAt)));
});

test('signed WebSocket upgrade authenticates the bound start token, forwards audio and rejects token replay', async () => {
  const upstreams = []; const patches = [];
  class FakeUpstream extends FakeSocket {
    constructor(url, options) {
      super(); upstreams.push(this);
      assert.match(url, /^wss:\/\/api.openai.com\/v1\/realtime\?model=/);
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      queueMicrotask(() => this.emit('open'));
    }
    send(value) {
      super.send(value);
      if (JSON.parse(value).type === 'session.update') queueMicrotask(() => this.message({ type: 'session.updated' }));
    }
  }
  const sid = `CA${'f'.repeat(32)}`; const accountSid = `AC${'a'.repeat(32)}`; const streamSid = `MZ${'b'.repeat(32)}`;
  const config = { publicBaseUrl: 'https://salon.example', openaiApiKey: 'test-key', twilioAccountSid: accountSid, twilioAuthToken: 'test-token', sessionSecret: 'test-secret' };
  const store = { catalog: async () => catalog, createCall: async () => ({ id: 'live-call' }), updateCall: async (id, patch) => patches.push(patch), recordEvent: async () => {} };
  const service = createVoiceService({ config, store, WebSocketImpl: FakeUpstream, fetchImpl: async () => ({ ok: true, json: async () => ({ sid }) }) });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => service.handleUpgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let phone; let replay;
  try {
    const xml = await service.handleIncoming({ CallSid: sid, From: '+923001234567' });
    const token = xml.match(/name="token" value="([^"]+)"/)[1];
    const signature = signTwilioRequest(config.twilioAuthToken, `${config.publicBaseUrl}/ws/twilio`);
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/twilio`, { headers: { 'X-Twilio-Signature': signature } });
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return socket;
    };
    const start = { event: 'start', start: { accountSid, callSid: sid, streamSid, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: { token, callSid: sid, fromNumber: '+923001234567', channel: 'phone' } } };
    phone = await connect();
    phone.send(JSON.stringify(start));
    for (let n = 0; n < 20 && !upstreams[0]?.sent.some((event) => event.type === 'response.create'); n++) await tick();
    assert.equal(service.stats().activeCalls, 1);
    const audio = Buffer.alloc(160, 127).toString('base64');
    phone.send(JSON.stringify({ event: 'media', streamSid, media: { timestamp: '20', payload: audio } }));
    for (let n = 0; n < 20 && !upstreams[0].sent.some((event) => event.type === 'input_audio_buffer.append'); n++) await tick();
    assert.equal(upstreams[0].sent.find((event) => event.type === 'input_audio_buffer.append').audio, audio);
    replay = await connect();
    const replayClosed = new Promise((resolve) => replay.once('close', resolve));
    replay.send(JSON.stringify(start));
    assert.equal(await replayClosed, 1008);
    assert.equal(upstreams.length, 1, 'token replay cannot create another upstream');
    const stopped = new Promise((resolve) => phone.once('close', resolve));
    phone.send(JSON.stringify({ event: 'stop', streamSid }));
    await stopped;
    await tick();
    assert.equal(service.stats().activeCalls, 0);
    assert.ok(patches.some((patch) => patch.endedAt && Number.isFinite(patch.durationSeconds)));
  } finally {
    phone?.terminate(); replay?.terminate(); await service.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
