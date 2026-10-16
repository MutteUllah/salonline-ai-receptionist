import { createHash, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.name = 'AppError'; this.status = status; this.statusCode = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new AppError(status, code, message); };
export function normalizePhone(value) {
  if (typeof value !== 'string') fail(400, 'INVALID_PHONE', 'Use an international phone number, for example +12125550123.');
  const phone = value.trim().replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) fail(400, 'INVALID_PHONE', 'Use an international phone number, for example +12125550123.');
  return phone;
}
export function serviceFor(settings, id) {
  const service = settings.services.find(s => s.id === id);
  if (!service) fail(400, 'INVALID_SERVICE', 'Choose an available service.');
  return service;
}
export function stylistsFor(settings, serviceId, stylistId) {
  const stylists = settings.stylists.filter(s => s.serviceIds.includes(serviceId) && (!stylistId || s.id === stylistId));
  if (!stylists.length) fail(400, 'INVALID_STYLIST', 'Choose a stylist who offers this service.');
  return stylists;
}
export function localDay(settings, date, now = Date.now()) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'INVALID_DATE', 'Use a calendar date in YYYY-MM-DD format.');
  const day = DateTime.fromISO(date, { zone: settings.salon.timeZone });
  if (!day.isValid || day.toISODate() !== date) fail(400, 'INVALID_DATE', 'Choose a valid calendar date.');
  const today = DateTime.fromMillis(now, { zone: settings.salon.timeZone }).startOf('day');
  if (day < today || day > today.plus({ days: settings.salon.bookingWindowDays })) fail(400, 'DATE_OUT_OF_RANGE', `Choose a date within the next ${settings.salon.bookingWindowDays} days.`);
  return day;
}
export function localBoundary(date, time, zone, closing = false) {
  const local = DateTime.fromISO(`${date}T${time}`, { zone });
  const candidates = local.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis());
  return closing ? candidates.at(-1) : candidates[0];
}
export function intervalFor(settings, input, now = Date.now()) {
  const service = serviceFor(settings, input.serviceId);
  const stylists = stylistsFor(settings, input.serviceId, input.stylistId);
  if (!input.stylistId) fail(400, 'INVALID_STYLIST', 'Choose a stylist for the appointment.');
  if (typeof input.startAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(input.startAt)) fail(400, 'INVALID_TIME', 'Appointment times must include a time zone offset.');
  const start = DateTime.fromISO(input.startAt, { setZone: true }).setZone(settings.salon.timeZone);
  if (!start.isValid || start.second !== 0 || start.millisecond !== 0) fail(400, 'INVALID_TIME', 'Choose a valid appointment time on a whole minute.');
  localDay(settings, start.toISODate(), now);
  if (start.toMillis() < now + settings.salon.minLeadMinutes * 60000) fail(400, 'INSUFFICIENT_NOTICE', `Appointments need at least ${settings.salon.minLeadMinutes} minutes notice.`);
  const h = settings.salon.businessHours[start.weekday];
  if (!h) fail(400, 'SALON_CLOSED', 'The salon is closed on this day.');
  const open = localBoundary(start.toISODate(), h.open, settings.salon.timeZone);
  const close = localBoundary(start.toISODate(), h.close, settings.salon.timeZone, true);
  const end = start.plus({ minutes: service.durationMinutes });
  const startMinute = start.hour * 60 + start.minute;
  const openMinute = Number(h.open.slice(0, 2)) * 60 + Number(h.open.slice(3));
  if (start < open || end > close || end.toISODate() !== start.toISODate() || (startMinute - openMinute) % settings.salon.slotIntervalMinutes !== 0) fail(400, 'OUTSIDE_HOURS', 'Choose a listed appointment slot within salon opening hours.');
  return { service, stylist: stylists[0], startAt: start.toUTC().toISO(), endAt: end.toUTC().toISO(), date: start.toISODate() };
}
export function enumerateSlots(settings, { date, serviceId, stylistId }, bookings = [], now = Date.now()) {
  const service = serviceFor(settings, serviceId);
  const stylists = stylistsFor(settings, serviceId, stylistId);
  const day = localDay(settings, date, now);
  const h = settings.salon.businessHours[day.weekday];
  const slots = [];
  if (!h) return { date, timeZone: settings.salon.timeZone, serviceId, slots };
  let cursor = localBoundary(date, h.open, settings.salon.timeZone);
  const close = localBoundary(date, h.close, settings.salon.timeZone, true);
  // Walk actual instants. A repeated DST wall-clock hour is represented by distinct offsets.
  while (cursor.plus({ minutes: service.durationMinutes }) <= close) {
    const end = cursor.plus({ minutes: service.durationMinutes });
    if (cursor.toMillis() >= now + settings.salon.minLeadMinutes * 60000) {
      for (const stylist of stylists) {
        const overlaps = bookings.some(b => b.status === 'confirmed' && b.stylistId === stylist.id && Date.parse(b.startAt) < end.toMillis() && Date.parse(b.endAt) > cursor.toMillis());
        if (!overlaps) slots.push({ startAt: cursor.toUTC().toISO(), endAt: end.toUTC().toISO(), stylistId: stylist.id, stylistName: stylist.name, label: cursor.toFormat('h:mm a ZZZZ') });
      }
    }
    cursor = cursor.plus({ minutes: settings.salon.slotIntervalMinutes });
  }
  return { date, timeZone: settings.salon.timeZone, serviceId, slots };
}
export function validateCustomer(input) {
  if (!input || input.confirmed !== true) fail(400, 'CONFIRMATION_REQUIRED', 'Explicit customer confirmation is required before saving an appointment.');
  if (typeof input.customerName !== 'string' || input.customerName.trim().length < 2 || input.customerName.length > 100 || /[\u0000-\u001f]/.test(input.customerName)) fail(400, 'INVALID_NAME', 'Enter a customer name between 2 and 100 characters.');
  if (typeof input.whatsappConsent !== 'boolean') fail(400, 'CONSENT_REQUIRED', 'Choose whether the customer consents to WhatsApp appointment messages.');
  if (!['web', 'phone', 'whatsapp', 'admin', 'demo'].includes(input.channel || 'web')) fail(400, 'INVALID_CHANNEL', 'Invalid appointment channel.');
  return { customerName: input.customerName.trim(), phone: normalizePhone(input.phone), channel: input.channel || 'web', whatsappConsent: input.whatsappConsent };
}
export function verifyBooking(booking, input) {
  if (input?.admin === true) return;
  let phone;
  try { phone = normalizePhone(input?.phone); } catch { fail(404, 'BOOKING_NOT_FOUND', 'No appointment matches these details.'); }
  const supplied = createHash('sha256').update(String(input?.bookingCode || '').toUpperCase().trim()).digest();
  const expected = createHash('sha256').update(booking?.bookingCode || '').digest();
  if (!booking || phone !== booking.phone || !timingSafeEqual(supplied, expected)) fail(404, 'BOOKING_NOT_FOUND', 'No appointment matches these details.');
}
export function checkChangeAllowed(booking, input, settings, now = Date.now()) {
  if (input?.confirmed !== true) fail(400, 'CONFIRMATION_REQUIRED', 'Explicit confirmation is required.');
  verifyBooking(booking, input);
  if (booking.status !== 'confirmed') fail(409, 'BOOKING_CANCELLED', 'This appointment has already been cancelled.');
  if (!input.admin && Date.parse(booking.startAt) - now < settings.salon.cancellationHours * 3600000) fail(409, 'CHANGE_WINDOW_CLOSED', `Please contact the salon to change an appointment within ${settings.salon.cancellationHours} hours of its start.`);
}
export function idempotencyKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{8,120}$/.test(value)) fail(400, 'INVALID_IDEMPOTENCY_KEY', 'Provide an Idempotency-Key of 8 to 120 letters, numbers, dots, dashes, or underscores.');
  return value;
}
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, ordered(value[k])]));
  return value;
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
