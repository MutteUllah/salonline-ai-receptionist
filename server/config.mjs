import { resolve } from 'node:path';
import { DateTime, IANAZone } from 'luxon';

export const defaultSalonSettings = {
  salon: {
    id: 'salonline', name: 'Atelier Salon', timeZone: 'Asia/Karachi',
    address: '125 Spring Street (demo location)', phone: '+12125550100', currency: 'USD', languages: ['en', 'ur'],
    slotIntervalMinutes: 30, minLeadMinutes: 60, bookingWindowDays: 90, cancellationHours: 2,
    businessHours: {
      1: { open: '09:00', close: '18:00' }, 2: { open: '09:00', close: '18:00' },
      3: { open: '09:00', close: '18:00' }, 4: { open: '09:00', close: '20:00' },
      5: { open: '09:00', close: '20:00' }, 6: { open: '10:00', close: '17:00' }, 7: null,
    },
  },
  services: [
    { id: 'haircut', name: 'Signature haircut', durationMinutes: 45, price: 65, description: 'Consultation, precision cut, wash, and finish.' },
    { id: 'color', name: 'Color & finish', durationMinutes: 120, price: 160, description: 'Single-process color, wash, and finish. A consultation may be required.' },
    { id: 'blowout', name: 'Blowout', durationMinutes: 45, price: 45, description: 'Wash and a professionally styled finish.' },
    { id: 'beard', name: 'Beard trim', durationMinutes: 30, price: 30, description: 'Shape, detail, and finish.' },
  ],
  stylists: [
    { id: 'maya', name: 'Maya Chen', serviceIds: ['haircut', 'color', 'blowout'] },
    { id: 'james', name: 'James Wilson', serviceIds: ['haircut', 'blowout', 'beard'] },
    { id: 'sofia', name: 'Sofia Rivera', serviceIds: ['haircut', 'color', 'blowout'] },
  ],
};

const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const validId = value => typeof value === 'string' && idPattern.test(value);
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const boundedText = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.length <= max;

export function validateSettings(value) {
  if (!value || !value.salon || !Array.isArray(value.services) || !Array.isArray(value.stylists)) throw new Error('Settings require salon, services, and stylists.');
  const s = value.salon;
  if (!validId(s.id) || !boundedText(s.name, 1, 120) || !IANAZone.isValidZone(s.timeZone)) throw new Error('A valid salon id, name, and IANA time zone are required.');
  if (!boundedText(s.address, 1, 500) || !/^\+[1-9]\d{7,14}$/.test(s.phone) || !/^[A-Z]{3}$/.test(s.currency)) throw new Error('Salon address, international phone, and currency are required.');
  for (const [key, min, max] of [['slotIntervalMinutes', 5, 120], ['minLeadMinutes', 0, 10080], ['bookingWindowDays', 1, 365], ['cancellationHours', 0, 168]]) {
    if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) throw new Error(`Invalid ${key}.`);
  }
  if (!s.businessHours || typeof s.businessHours !== 'object' || Array.isArray(s.businessHours)) throw new Error('Business hours are required.');
  for (let day = 1; day <= 7; day++) {
    const h = s.businessHours[day];
    if (h === null) continue;
    if (!h || !timePattern.test(h.open) || !timePattern.test(h.close) || h.open >= h.close) throw new Error(`Invalid business hours for weekday ${day}. Overnight hours are not supported.`);
  }
  if (value.services.length < 1 || value.services.length > 50 || value.stylists.length < 1 || value.stylists.length > 50) throw new Error('Use between 1 and 50 services and stylists.');
  const serviceIds = new Set();
  for (const service of value.services) {
    if (!service || !validId(service.id) || serviceIds.has(service.id) || !boundedText(service.name, 1, 120) || !Number.isInteger(service.durationMinutes) || service.durationMinutes < 5 || service.durationMinutes > 480 || !Number.isFinite(service.price) || service.price < 0 || service.price > 100000 || (service.description !== undefined && !boundedText(service.description, 0, 1000))) throw new Error('Invalid or duplicate service.');
    serviceIds.add(service.id);
  }
  const stylistIds = new Set();
  for (const stylist of value.stylists) {
    if (!stylist || !validId(stylist.id) || stylistIds.has(stylist.id) || !boundedText(stylist.name, 1, 120) || !Array.isArray(stylist.serviceIds) || stylist.serviceIds.length < 1 || stylist.serviceIds.some(id => !serviceIds.has(id)) || new Set(stylist.serviceIds).size !== stylist.serviceIds.length) throw new Error('Invalid or duplicate stylist.');
    stylistIds.add(stylist.id);
  }
  return structuredClone(value);
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';
  const publicUrl = (env.PUBLIC_BASE_URL || env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  const config = {
    nodeEnv, port: Number(env.PORT || 3000), host: env.HOST || '127.0.0.1',
    databaseUrl: env.DATABASE_URL || '', databasePath: resolve(env.DATABASE_PATH || './data/salonline.sqlite'),
    publicUrl, publicBaseUrl: publicUrl,
    adminPassword: env.ADMIN_PASSWORD || '', sessionSecret: env.SESSION_SECRET || '',
    openaiApiKey: env.OPENAI_API_KEY || '', realtimeModel: env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1', voice: env.OPENAI_VOICE || 'marin',
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || '', twilioAuthToken: env.TWILIO_AUTH_TOKEN || '',
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER || '', twilioWhatsappNumber: env.TWILIO_WHATSAPP_NUMBER || '',
    twilioWhatsAppNumber: env.TWILIO_WHATSAPP_NUMBER || '', whatsappContentSid: env.WHATSAPP_CONTENT_SID || env.TWILIO_WHATSAPP_CONTENT_SID || '',
    whatsappSendEnabled: env.WHATSAPP_SEND_ENABLED === 'true', streamTokenSecret: env.STREAM_TOKEN_SECRET || env.SESSION_SECRET || '',
    maxConcurrentCalls: Number(env.MAX_CONCURRENT_CALLS || 10), maxCallSeconds: Number(env.MAX_CALL_SECONDS || 600),
    salon: structuredClone(defaultSalonSettings),
  };
  if (env.SALON_TIME_ZONE) config.salon.salon.timeZone = env.SALON_TIME_ZONE;
  validateSettings(config.salon);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (!Number.isInteger(config.maxConcurrentCalls) || config.maxConcurrentCalls < 1 || config.maxConcurrentCalls > 1000) throw new Error('MAX_CONCURRENT_CALLS must be between 1 and 1000.');
  if (!Number.isInteger(config.maxCallSeconds) || config.maxCallSeconds < 30 || config.maxCallSeconds > 3600) throw new Error('MAX_CALL_SECONDS must be between 30 and 3600.');
  const parsedUrl = new URL(publicUrl);
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error('PUBLIC_BASE_URL must be an HTTP or HTTPS URL.');
  if (production) {
    if (!config.databaseUrl) throw new Error('Production requires DATABASE_URL (PostgreSQL).');
    if (config.adminPassword.length < 16 || config.sessionSecret.length < 32) throw new Error('Production requires ADMIN_PASSWORD (at least 16 characters) and SESSION_SECRET (at least 32 characters).');
    if (parsedUrl.protocol !== 'https:') throw new Error('Production requires an HTTPS PUBLIC_BASE_URL.');
  }
  return config;
}

export const salonNow = (settings, now = Date.now()) => DateTime.fromMillis(now, { zone: settings.salon.timeZone });
