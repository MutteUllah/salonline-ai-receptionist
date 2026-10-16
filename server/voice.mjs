import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { createAgentTools } from './agent.mjs';
import { createTwilioClient, fallbackTwiml, streamTwiml, validateTwilioSignature } from './twilio.mjs';

const baseUrl = (config) => (config.publicBaseUrl || config.publicUrl || '').replace(/\/$/, '');
const tokenSecret = (config) => config.streamTokenSecret || config.sessionSecret;
const unref = (timer) => { timer.unref?.(); return timer; };
const send = (socket, value) => { if (socket?.readyState === 1) socket.send(JSON.stringify(value)); };

export function issueStreamToken(secret, payload, now = Date.now()) {
  const encoded = Buffer.from(JSON.stringify({ ...payload, nonce: randomBytes(12).toString('base64url'), exp: Math.floor(now / 1000) + 90 })).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

export function verifyStreamToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 2048) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(encoded).digest('base64url'));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Number.isInteger(payload.exp) || payload.exp < Math.floor(now / 1000) || payload.exp > Math.floor(now / 1000) + 100 || !payload.nonce || !payload.callSid || !payload.callId) return null;
    return payload;
  } catch { return null; }
}

/** GA Realtime bridge. μ-law bytes pass through unchanged at 8 kHz. No audio or transcript is stored. */
export function createRealtimeBridge({ twilioSocket, start, context, config, agentPromise, createUpstream, onEnd = () => {} }) {
  const streamSid = start.streamSid;
  const upstream = createUpstream();
  let closed = false;
  let endPromise;
  let ready = false;
  let latestMediaTimestamp = 0;
  let lastScheduledEnd = 0;
  let markSequence = 0;
  let pendingOutputMs = 0;
  let activeResponseId = null;
  let lastSpeechAt = Date.now();
  let toolCount = 0;
  const inbound = [];
  const outputQueue = [];
  const marks = new Map();
  const playback = new Map();
  const ignoredResponses = new Set();
  const executedTools = new Set();
  const pendingTools = new Map();
  const turnByItem = new Map();
  const transcriptByItem = new Map();
  const transcriptionWaiters = new Map();
  let toolChain = Promise.resolve();
  let agent;
  const timers = [];
  context.awaitConfirmation = async (turn) => {
    if (closed || context.userSpeaking || context.userTurn !== turn) return '';
    if (context.latestTranscript?.turn === turn) return context.latestTranscript.text;
    return new Promise((resolve) => {
      const finishWait = (text = '') => {
        clearTimeout(timer);
        transcriptionWaiters.delete(turn);
        resolve(!closed && !context.userSpeaking && context.userTurn === turn ? text : '');
      };
      const timer = setTimeout(finishWait, 2000);
      transcriptionWaiters.set(turn, finishWait);
    });
  };
  const finish = (reason = 'completed') => {
    if (closed) return endPromise;
    closed = true;
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    inbound.length = 0; outputQueue.length = 0; marks.clear(); playback.clear();
    for (const complete of transcriptionWaiters.values()) complete('');
    transcriptionWaiters.clear(); turnByItem.clear(); transcriptByItem.clear();
    context.latestTranscript = null;
    if (upstream.readyState === 0) upstream.terminate?.();
    else if (upstream.readyState === 1) upstream.close(1000, 'Call ended');
    if (twilioSocket.readyState === 1) twilioSocket.close(1000, 'Call ended');
    endPromise = Promise.resolve(onEnd(reason)).catch(() => {});
    return endPromise;
  };
  const agentReady = Promise.resolve(agentPromise);
  agentReady.catch(() => finish('agent_setup_error'));
  const setupTimer = unref(setTimeout(() => finish('connection_timeout'), 12_000)); timers.push(setupTimer);
  timers.push(unref(setTimeout(() => finish('max_duration'), Math.min(config.maxCallSeconds || 600, 3600) * 1000)));
  timers.push(unref(setInterval(() => { if (Date.now() - lastSpeechAt > (config.silenceTimeoutSeconds || 90) * 1000) finish('silence_timeout'); }, 10_000)));

  function flushOutput() {
    while (!closed && outputQueue.length && pendingOutputMs < 2000) {
      if (twilioSocket.bufferedAmount > 1_000_000) return finish('media_backpressure');
      const frame = outputQueue.shift();
      const item = playback.get(frame.itemId);
      if (!item) continue;
      const scheduled = Math.max(latestMediaTimestamp, lastScheduledEnd);
      if (item.firstSentAt === null) item.firstSentAt = scheduled - frame.offset;
      lastScheduledEnd = scheduled + frame.duration;
      const name = `p${++markSequence}`;
      marks.set(name, { itemId: frame.itemId, endOffset: frame.offset + frame.duration, duration: frame.duration });
      pendingOutputMs += frame.duration;
      send(twilioSocket, { event: 'media', streamSid, media: { payload: frame.payload } });
      send(twilioSocket, { event: 'mark', streamSid, mark: { name } });
    }
  }

  function interrupt() {
    if (activeResponseId) ignoredResponses.add(activeResponseId);
    if (ignoredResponses.size > 100) ignoredResponses.delete(ignoredResponses.values().next().value);
    for (const [itemId, item] of playback) {
      if (item.acknowledged >= item.duration) continue;
      const elapsed = item.firstSentAt === null ? 0 : Math.max(0, latestMediaTimestamp - item.firstSentAt);
      const heard = Math.floor(Math.max(item.acknowledged, Math.min(item.duration, elapsed)));
      send(upstream, { type: 'conversation.item.truncate', item_id: itemId, content_index: item.contentIndex, audio_end_ms: heard });
    }
    send(twilioSocket, { event: 'clear', streamSid });
    // Twilio emits marks for cleared audio too; remove them before those echoes arrive.
    marks.clear(); playback.clear(); outputQueue.length = 0; pendingOutputMs = 0; lastScheduledEnd = latestMediaTimestamp;
  }

  function onTwilioMessage(raw) {
    if (closed) return;
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return finish('invalid_media'); }
    if (event.streamSid && event.streamSid !== streamSid) return finish('stream_mismatch');
    if (event.event === 'stop') return finish('completed');
    if (event.event === 'start') return finish('duplicate_start');
    if (event.event === 'mark') {
      const mark = marks.get(event.mark?.name);
      if (mark) {
        marks.delete(event.mark.name); pendingOutputMs = Math.max(0, pendingOutputMs - mark.duration);
        const item = playback.get(mark.itemId);
        if (item) item.acknowledged = Math.max(item.acknowledged, mark.endOffset);
        flushOutput();
      }
    }
    if (event.event !== 'media' || event.media?.track === 'outbound') return;
    const timestamp = Number(event.media?.timestamp);
    const audio = event.media?.payload;
    if (!Number.isFinite(timestamp) || timestamp < 0 || typeof audio !== 'string' || audio.length > 32_768 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) return finish('invalid_media');
    latestMediaTimestamp = Math.max(latestMediaTimestamp, timestamp);
    if (!ready) { if (inbound.length >= 250) return finish('input_backpressure'); inbound.push(audio); }
    else if (upstream.bufferedAmount > 1_000_000) finish('upstream_backpressure');
    else send(upstream, { type: 'input_audio_buffer.append', audio });
  }
  twilioSocket.on('message', onTwilioMessage);
  twilioSocket.on('error', () => finish('phone_connection_error'));
  twilioSocket.on('close', (code) => finish(code === 1000 ? 'completed' : 'phone_disconnected'));
  upstream.on('error', () => finish('ai_connection_error'));
  upstream.on('close', () => finish('ai_disconnected'));
  upstream.on('open', async () => {
    try {
      agent = await agentReady;
      if (closed) return;
      send(upstream, { type: 'session.update', session: {
        type: 'realtime', instructions: agent.instructions, output_modalities: ['audio'],
        audio: { input: { format: { type: 'audio/pcmu' }, transcription: { model: 'gpt-4o-mini-transcribe', prompt: 'The caller may speak Urdu, English, or switch between them. Transcribe the actual speech in its original language.' }, turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 650, create_response: true, interrupt_response: true } }, output: { format: { type: 'audio/pcmu' }, voice: config.voice || 'marin' } },
        tools: agent.tools, tool_choice: 'auto', max_output_tokens: 800,
      } });
    } catch { finish('agent_setup_error'); }
  });
  upstream.on('message', (raw) => {
    if (closed) return;
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return finish('invalid_ai_event'); }
    if (event.type === 'session.updated' && !ready) {
      ready = true; clearTimeout(setupTimer);
      for (const audio of inbound.splice(0)) send(upstream, { type: 'input_audio_buffer.append', audio });
      send(upstream, { type: 'response.create', response: { instructions: 'Briefly greet the caller as the salon AI receptionist in English and Urdu, and ask how you can help with their appointment. Do not repeat the privacy disclosure already played by the phone system.' } });
    }
    if (event.type === 'response.created') activeResponseId = event.response?.id;
    if (event.type === 'input_audio_buffer.speech_started') {
      lastSpeechAt = Date.now(); context.userSpeaking = true;
      for (const complete of transcriptionWaiters.values()) complete('');
      interrupt();
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      lastSpeechAt = Date.now(); context.userSpeaking = false; context.userTurn = (context.userTurn || 0) + 1;
      context.latestTranscript = null;
      if (event.item_id) {
        turnByItem.set(event.item_id, context.userTurn);
        if (transcriptByItem.has(event.item_id)) context.latestTranscript = { turn: context.userTurn, text: transcriptByItem.get(event.item_id) };
      }
      // Transcripts are transient, bounded, and used only for confirmation guards.
      if (turnByItem.size > 50) { const oldest = turnByItem.keys().next().value; turnByItem.delete(oldest); transcriptByItem.delete(oldest); }
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(event.transcript || '').slice(0, 1000);
      if (typeof event.item_id === 'string') {
        transcriptByItem.set(event.item_id, text);
        if (transcriptByItem.size > 50) transcriptByItem.delete(transcriptByItem.keys().next().value);
        const turn = turnByItem.get(event.item_id);
        if (turn === context.userTurn) {
          context.latestTranscript = { turn, text };
          transcriptionWaiters.get(turn)?.(text);
        }
      }
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      const turn = turnByItem.get(event.item_id);
      transcriptionWaiters.get(turn)?.('');
    }
    if (event.type === 'response.output_audio.delta') {
      if (!ready || ignoredResponses.has(event.response_id)) return;
      if (!event.item_id || typeof event.delta !== 'string' || event.delta.length > 100_000) return finish('invalid_ai_audio');
      const bytes = Buffer.from(event.delta, 'base64');
      let item = playback.get(event.item_id);
      if (!item) { item = { duration: 0, acknowledged: 0, firstSentAt: null, contentIndex: event.content_index || 0 }; playback.set(event.item_id, item); }
      for (let offset = 0; offset < bytes.length; offset += 1600) {
        const data = bytes.subarray(offset, offset + 1600);
        const duration = data.length / 8;
        outputQueue.push({ itemId: event.item_id, offset: item.duration, duration, payload: data.toString('base64') }); item.duration += duration;
      }
      if (outputQueue.reduce((sum, frame) => sum + frame.duration, 0) > 15_000) return finish('output_backpressure');
      if (playback.size > 100) for (const [id, value] of playback) if (value.acknowledged >= value.duration) playback.delete(id);
      flushOutput();
    }
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') pendingTools.set(event.item.call_id, event.item);
    if (event.type === 'response.done') {
      for (const item of event.response?.output || []) if (item.type === 'function_call') pendingTools.set(item.call_id, item);
      const calls = [...pendingTools.values()].filter((item) => !executedTools.has(item.call_id)); pendingTools.clear();
      if (calls.length) toolChain = toolChain.then(async () => {
        for (const item of calls) {
          if (closed) return;
          if (++toolCount > 40) return finish('tool_limit');
          executedTools.add(item.call_id);
          let args; let result;
          try { args = JSON.parse(item.arguments || '{}'); result = await agent.execute(item.name, args); }
          catch { result = { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'The action could not be understood. Please ask the caller again.' } }; }
          if (closed) return;
          send(upstream, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result) } });
        }
        if (!closed) send(upstream, { type: 'response.create' });
      }).catch(() => finish('tool_error'));
      if (event.response?.status === 'failed') finish('ai_response_failed');
    }
    if (event.type === 'error') {
      // A VAD cancellation may race with response completion; all other protocol errors fail closed.
      if (!['response_cancel_not_active', 'conversation_already_has_active_response'].includes(event.error?.code)) finish('ai_protocol_error');
    }
  });
  return { close: finish, handleMessage: onTwilioMessage, get closed() { return closed; } };
}

export function createVoiceService({ config, store, WebSocketImpl = WebSocket, fetchImpl = fetch }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  const pending = new Map();
  const active = new Map();
  const calls = new Map();
  const cleanupWork = new Set();
  const twilio = createTwilioClient(config, fetchImpl);
  let outboxRunning = false;
  const configured = () => Boolean(config.openaiApiKey && /^AC[a-fA-F0-9]{32}$/.test(config.twilioAccountSid || '') && config.twilioAuthToken && tokenSecret(config) && /^https:\/\//.test(baseUrl(config)));
  function trackCleanup(promise) {
    const work = Promise.resolve(promise).catch(() => {}).finally(() => cleanupWork.delete(work));
    cleanupWork.add(work);
    return work;
  }
  function expirePending(now = Date.now(), force = false) {
    for (const [sid, item] of pending) if (force || item.expiresAt < now) {
      pending.delete(sid); calls.delete(sid);
      trackCleanup(store.updateCall(item.callId, { status: 'needs_callback', endedAt: new Date(now).toISOString(), durationSeconds: Math.max(0, Math.floor((now - item.startedAt) / 1000)), summary: 'The voice connection did not start. Staff callback requested.' }));
      trackCleanup(store.recordEvent({ callId: item.callId, type: 'callback.requested', payload: { reason: 'Voice stream start timed out.' } }));
    }
  }
  const expiryTimer = unref(setInterval(expirePending, 15_000));

  async function handleIncoming(body) {
    expirePending();
    const callSid = body.CallSid;
    if (!/^CA[a-fA-F0-9]{32}$/.test(callSid || '')) return fallbackTwiml();
    const fromNumber = String(body.From || '').slice(0, 40);
    const channel = fromNumber.startsWith('whatsapp:') || body.Channel === 'whatsapp' ? 'whatsapp' : 'phone';
    const existing = pending.get(callSid);
    if (existing && existing.expiresAt > Date.now()) return existing.xml;
    if (active.has(callSid)) return fallbackTwiml('This call is already connected. Please call again if you need more help.');
    const call = await store.createCall({ providerCallId: callSid, fromNumber, channel, status: 'ringing' });
    calls.set(callSid, call.id);
    if (!configured() || pending.size + active.size >= (config.maxConcurrentCalls || 10)) {
      await store.updateCall(call.id, { status: 'needs_callback', endedAt: new Date().toISOString(), summary: 'Incoming call could not connect. Staff callback requested.' });
      await store.recordEvent({ callId: call.id, type: 'callback.requested', payload: { reason: 'Voice service unavailable or at capacity.' } });
      calls.delete(callSid);
      return fallbackTwiml('Our AI receptionist is temporarily unavailable. Your call is in the salon callback queue. No appointment has been made. Please call again if you need immediate assistance.');
    }
    const token = issueStreamToken(tokenSecret(config), { callSid, callId: call.id, fromNumber, channel });
    const xml = streamTwiml({ url: `${baseUrl(config).replace(/^https:/, 'wss:')}/ws/twilio`, token, callSid, fromNumber, channel });
    pending.set(callSid, { token, xml, callId: call.id, startedAt: Date.now(), expiresAt: Date.now() + 90_000 });
    return xml;
  }

  async function handleStatus(body) {
    const callId = calls.get(body.CallSid);
    if (!callId) return;
    const status = String(body.CallStatus || body.StreamEvent || '').slice(0, 40);
    await store.recordEvent({ callId, type: 'provider.status', payload: { status, duration: Number(body.CallDuration) || 0 } });
    if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
      const reservation = pending.get(body.CallSid);
      pending.delete(body.CallSid);
      const bridge = active.get(body.CallSid);
      if (bridge) bridge.close(status);
      else if (reservation) await store.updateCall(callId, { status: 'needs_callback', endedAt: new Date().toISOString(), durationSeconds: Math.max(0, Number(body.CallDuration) || 0), summary: 'The call ended before the AI voice connection started. Staff callback requested.' });
      calls.delete(body.CallSid);
    }
  }

  function handleUpgrade(req, socket, head) {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws/twilio') return false;
    const target = `${baseUrl(config)}${req.url}`;
    const signature = req.headers['x-twilio-signature'];
    // Deployments differ in the scheme Twilio signs for a WebSocket upgrade. Both
    // candidates are derived from the configured public origin, never forwarded headers.
    const valid = validateTwilioSignature(config.twilioAuthToken, target, {}, signature) || validateTwilioSignature(config.twilioAuthToken, target.replace(/^https:/, 'wss:'), {}, signature);
    if (!configured() || !valid || wss.clients.size >= (config.maxConcurrentCalls || 10) * 2) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return true; }
    wss.handleUpgrade(req, socket, head, (phoneSocket) => {
      let started = false;
      const deadline = unref(setTimeout(() => phoneSocket.close(1008, 'Start required'), 5000));
      const onStart = (raw) => {
        let event;
        try { event = JSON.parse(raw.toString()); } catch { phoneSocket.close(1008, 'Invalid start'); return; }
        if (event.event === 'connected') return;
        if (started || event.event !== 'start') { phoneSocket.close(1008, 'Start required'); return; }
        const params = event.start?.customParameters;
        const payload = verifyStreamToken(tokenSecret(config), params?.token);
        const reservation = payload && pending.get(payload.callSid);
        if (!payload || !reservation || reservation.token !== params.token || payload.callSid !== event.start.callSid || params.callSid !== payload.callSid || params.fromNumber !== payload.fromNumber || params.channel !== payload.channel || event.start.accountSid !== config.twilioAccountSid || event.start.mediaFormat?.encoding !== 'audio/x-mulaw' || event.start.mediaFormat?.sampleRate !== 8000 || event.start.mediaFormat?.channels !== 1 || !/^MZ[a-fA-F0-9]{32}$/.test(event.start.streamSid || '') || active.has(payload.callSid)) { phoneSocket.close(1008, 'Unauthorized stream'); return; }
        started = true; clearTimeout(deadline); pending.delete(payload.callSid); phoneSocket.off('message', onStart);
        const context = { callId: payload.callId, fromNumber: payload.fromNumber, channel: payload.channel, userTurn: 0, startedAt: Date.now() };
        const bridge = createRealtimeBridge({
          twilioSocket: phoneSocket, start: event.start, context, config,
          agentPromise: createAgentTools(store, config, context),
          createUpstream: () => new WebSocketImpl(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.realtimeModel || 'gpt-realtime-2.1')}`, { headers: { Authorization: `Bearer ${config.openaiApiKey}` }, handshakeTimeout: 10_000, maxPayload: 1_000_000 }),
          onEnd: async (reason) => {
            active.delete(payload.callSid); calls.delete(payload.callSid);
            const abnormal = !['completed', 'canceled'].includes(reason);
            await store.updateCall(payload.callId, { status: context.callbackRequested || abnormal ? 'needs_callback' : 'completed', endedAt: new Date().toISOString(), durationSeconds: Math.max(0, Math.floor((Date.now() - context.startedAt) / 1000)), ...(context.bookingId ? { bookingId: context.bookingId } : {}), ...(!context.callbackRequested ? { summary: context.actionCompleted ? `Appointment managed. Call ended: ${reason}.` : `Call ended: ${reason}.${abnormal ? ' Staff callback requested.' : ''}` } : {}) });
            await store.recordEvent({ callId: payload.callId, type: 'voice.ended', payload: { reason } });
            if (abnormal) await twilio.endCall(payload.callSid).catch(() => {});
          },
        });
        active.set(payload.callSid, bridge);
        store.updateCall(payload.callId, { status: 'in_progress' }).catch(() => bridge.close('storage_error'));
      };
      phoneSocket.on('message', onStart);
      phoneSocket.on('error', () => { clearTimeout(deadline); });
      phoneSocket.on('close', () => { clearTimeout(deadline); });
    });
    return true;
  }

  async function processOutbox() {
    if (outboxRunning || !config.whatsappSendEnabled) return { processed: 0 };
    outboxRunning = true;
    let processed = 0;
    try {
      const jobs = await store.claimOutbox({ limit: 10 });
      for (const job of jobs) {
        try {
          if (job.type !== 'whatsapp') { await store.failOutbox(job.id, { leaseToken: job.leaseToken, error: 'Unsupported delivery type.', retryable: false }); continue; }
          const result = await twilio.sendWhatsApp(job.payload);
          await store.completeOutbox(job.id, { ...result, leaseToken: job.leaseToken });
        } catch (error) {
          await store.failOutbox(job.id, { leaseToken: job.leaseToken, error: error.code || 'DELIVERY_FAILED', retryable: error.retryable !== false });
        }
        processed++;
      }
      return { processed };
    } finally { outboxRunning = false; }
  }
  return {
    handleIncoming, handleStatus, handleUpgrade, processOutbox,
    stats: () => ({ configured: configured(), activeCalls: active.size, pendingCalls: pending.size }),
    async close() { clearInterval(expiryTimer); const endings = [...active.values()].map((bridge) => bridge.close('shutdown')); expirePending(Date.now(), true); for (const socket of wss.clients) socket.close(1001, 'Server shutting down'); wss.close(); pending.clear(); calls.clear(); await Promise.allSettled([...endings, ...cleanupWork]); },
  };
}
