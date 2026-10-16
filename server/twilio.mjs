import { createHmac, timingSafeEqual } from 'node:crypto';

export function signTwilioRequest(authToken, url, params = {}) {
  let value = url;
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  const keys = [...new Set(entries.map(([key]) => key))].sort();
  for (const key of keys) {
    const values = entries.filter(([name]) => name === key).flatMap(([, item]) => Array.isArray(item) ? item : [item]);
    for (const item of [...new Set(values.map(String))].sort()) value += key + item;
  }
  return createHmac('sha1', authToken).update(value, 'utf8').digest('base64');
}

export function validateTwilioSignature(authToken, url, params, signature) {
  if (!authToken || typeof signature !== 'string' || signature.length > 256) return false;
  const expected = Buffer.from(signTwilioRequest(authToken, url, params));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const escapeXml = (value = '') => String(value).replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);

export function fallbackTwiml(message = 'Our AI receptionist is temporarily unavailable. Please call again shortly. No appointment has been made.') {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`;
}

export function streamTwiml({ url, token, callSid, fromNumber, channel }) {
  const params = { token, callSid, fromNumber, channel };
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hello. You are speaking with the salon's AI receptionist. I can help in English or Urdu. Your call is processed by AI to help manage your appointment. Ask for a callback at any time.</Say><Connect><Stream url="${escapeXml(url)}">${Object.entries(params).map(([name, value]) => `<Parameter name="${name}" value="${escapeXml(value)}"/>`).join('')}</Stream></Connect><Say>The conversation has ended. If you still need help, please call the salon again.</Say><Hangup/></Response>`;
}

export class TwilioApiError extends Error {
  constructor(message, status = 502, code = 'TWILIO_ERROR', retryable = true) {
    super(message); this.name = 'TwilioApiError'; this.status = status; this.code = code; this.retryable = retryable;
  }
}

export function createTwilioClient(config, fetchImpl = fetch) {
  async function request(path, fields) {
    if (!/^AC[a-fA-F0-9]{32}$/.test(config.twilioAccountSid || '') || !config.twilioAuthToken) throw new TwilioApiError('Twilio is not configured.', 503, 'TWILIO_NOT_CONFIGURED', false);
    let response;
    try {
      response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields), signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // An ambiguous timeout may have been accepted by Twilio: outbox delivery is at-least-once.
      throw new TwilioApiError('Twilio request timed out or could not connect.', 502, 'TWILIO_NETWORK', true);
    }
    let data;
    try { data = await response.json(); } catch { throw new TwilioApiError('Twilio returned an invalid response.', 502, 'TWILIO_RESPONSE', true); }
    if (!response.ok) throw new TwilioApiError('Twilio rejected the request.', response.status, String(data.code || 'TWILIO_REJECTED'), response.status === 429 || response.status >= 500);
    return data;
  }
  return {
    async sendWhatsApp(payload) {
      if (config.whatsappSendEnabled !== true || payload.consent !== true) throw new TwilioApiError('WhatsApp delivery is disabled or consent is missing.', 403, 'WHATSAPP_CONSENT', false);
      const from = config.twilioWhatsAppNumber || config.twilioWhatsappNumber;
      if (!/^whatsapp:\+[1-9]\d{7,14}$/.test(from || '') || !/^\+[1-9]\d{7,14}$/.test(String(payload.to || '').replace(/^whatsapp:/, ''))) throw new TwilioApiError('Valid WhatsApp sender and recipient numbers are required.', 422, 'WHATSAPP_NUMBER', false);
      if (!/^HX[a-fA-F0-9]{32}$/.test(config.whatsappContentSid || '')) throw new TwilioApiError('An approved WhatsApp Content SID is required.', 503, 'WHATSAPP_TEMPLATE', false);
      if (!payload.templateVariables || typeof payload.templateVariables !== 'object') throw new TwilioApiError('WhatsApp template variables are missing.', 422, 'WHATSAPP_TEMPLATE_VARIABLES', false);
      const result = await request('Messages.json', {
        From: from, To: `whatsapp:${String(payload.to).replace(/^whatsapp:/, '')}`,
        ContentSid: config.whatsappContentSid, ContentVariables: JSON.stringify(payload.templateVariables),
        StatusCallback: `${(config.publicBaseUrl || config.publicUrl).replace(/\/$/, '')}/webhooks/twilio/message-status`,
      });
      return { providerId: result.sid };
    },
    async endCall(callSid) {
      if (!/^CA[a-fA-F0-9]{32}$/.test(callSid || '')) throw new TwilioApiError('Invalid call identifier.', 422, 'CALL_ID', false);
      return request(`Calls/${callSid}.json`, { Status: 'completed' });
    },
  };
}
