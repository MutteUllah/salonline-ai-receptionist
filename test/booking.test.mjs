import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { createStore } from '../server/store.mjs';
import { defaultSalonSettings, loadConfig } from '../server/config.mjs';
import { enumerateSlots, intervalFor, normalizePhone } from '../server/booking.mjs';

async function fixture(t, options = {}) {
  const settings = structuredClone(defaultSalonSettings);
  const store = await createStore({ databasePath: ':memory:', salon: settings, ...options });
  t.after(() => store.close());
  let day = DateTime.now().setZone(settings.salon.timeZone).plus({ days: 3 }).startOf('day');
  while (!settings.salon.businessHours[day.weekday]) day = day.plus({ days: 1 });
  const h = settings.salon.businessHours[day.weekday];
  const startAt = DateTime.fromISO(`${day.toISODate()}T${h.open}`, { zone: settings.salon.timeZone }).toUTC().toISO();
  const input = { serviceId: 'haircut', stylistId: 'maya', startAt, customerName: 'Sam Customer', phone: '+12125550123', channel: 'web', whatsappConsent: true, confirmed: true };
  return { store, settings, day, input };
}
const errorCode = code => error => error.code === code;

test('concurrent overlapping bookings commit exactly once and enqueue one confirmation', async t => {
  const { store, input, day } = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.createBooking({ ...input, phone: `+1212555${String(i).padStart(4, '0')}` }, `concurrent-${i}`)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'SLOT_UNAVAILABLE'));
  assert.equal((await store.listBookings({ date: day.toISODate() })).length, 1);
  const messages = await store.listOutbox();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.templateVariables['5'], 'confirmed');
});

test('idempotent requests return same booking and reject changed payloads', async t => {
  const { store, input } = await fixture(t);
  const [first, repeated] = await Promise.all([store.createBooking(input, 'same-request-key'), store.createBooking(input, 'same-request-key')]);
  assert.deepEqual(first, repeated);
  await assert.rejects(store.createBooking({ ...input, customerName: 'Another Person' }, 'same-request-key'), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.equal((await store.listOutbox()).length, 1);
});

test('availability accounts for full service duration and independent stylists', async t => {
  const { store, input, day } = await fixture(t);
  await store.createBooking(input, 'availability-seed');
  const result = await store.availability({ date: day.toISODate(), serviceId: 'haircut', stylistId: 'maya' });
  const thirtyLater = DateTime.fromISO(input.startAt).plus({ minutes: 30 }).toUTC().toISO();
  assert.ok(!result.slots.some(s => s.startAt === input.startAt || s.startAt === thirtyLater));
  const other = await store.createBooking({ ...input, stylistId: 'james' }, 'other-stylist-key');
  assert.equal(other.stylistId, 'james');
  await assert.rejects(store.createBooking({ ...input, startAt: thirtyLater }, 'overlapping-key'), errorCode('SLOT_UNAVAILABLE'));
});

test('explicit confirmation, phone format, channel, and consent are mandatory', async t => {
  const { store, input } = await fixture(t);
  await assert.rejects(store.createBooking({ ...input, confirmed: false }, 'no-confirm-key'), errorCode('CONFIRMATION_REQUIRED'));
  await assert.rejects(store.createBooking({ ...input, phone: '5551234' }, 'bad-phone-key'), errorCode('INVALID_PHONE'));
  await assert.rejects(store.createBooking({ ...input, whatsappConsent: undefined }, 'no-consent-key'), errorCode('CONSENT_REQUIRED'));
  await assert.rejects(store.createBooking({ ...input, channel: 'unknown' }, 'bad-channel-key'), errorCode('INVALID_CHANNEL'));
  await assert.rejects(store.createBooking(input, 'short'), errorCode('INVALID_IDEMPOTENCY_KEY'));
  assert.equal(normalizePhone('+1 (212) 555-0123'), '+12125550123');
  assert.equal((await store.listBookings()).length, 0);
});

test('dates use salon local day and reject past, offset-free, off-grid, and closing-time starts', async t => {
  const { store, input, settings, day } = await fixture(t);
  await assert.rejects(store.createBooking({ ...input, startAt: day.toISODate() + 'T10:00:00' }, 'offsetless-key'), errorCode('INVALID_TIME'));
  const offGrid = DateTime.fromISO(input.startAt).plus({ minutes: 10 }).toUTC().toISO();
  await assert.rejects(store.createBooking({ ...input, startAt: offGrid }, 'off-grid-key'), errorCode('OUTSIDE_HOURS'));
  const closing = DateTime.fromISO(`${day.toISODate()}T${settings.salon.businessHours[day.weekday].close}`, { zone: settings.salon.timeZone }).toUTC().toISO();
  await assert.rejects(store.createBooking({ ...input, startAt: closing }, 'closing-time-key'), errorCode('OUTSIDE_HOURS'));
  await assert.rejects(store.availability({ date: '2026-02-30', serviceId: 'haircut' }), errorCode('INVALID_DATE'));
  await assert.rejects(store.availability({ date: DateTime.now().minus({ days: 3 }).toISODate(), serviceId: 'haircut' }), errorCode('DATE_OUT_OF_RANGE'));
});

test('customer verification protects lookup and appointment changes; cancellation is idempotent', async t => {
  const { store, input } = await fixture(t);
  const booking = await store.createBooking(input, 'verification-key');
  const identity = { phone: input.phone, bookingCode: booking.bookingCode, confirmed: true };
  await assert.rejects(store.lookupBooking({ phone: '+12125559999', bookingCode: booking.bookingCode }), errorCode('BOOKING_NOT_FOUND'));
  await assert.rejects(store.cancelBooking(booking.id, { ...identity, bookingCode: 'bad-code' }), errorCode('BOOKING_NOT_FOUND'));
  assert.equal((await store.lookupBooking(identity)).id, booking.id);
  const cancelled = await store.cancelBooking(booking.id, identity);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await store.cancelBooking(booking.id, identity), cancelled);
  assert.equal((await store.listOutbox()).length, 2);
  await store.createBooking(input, 'released-slot-key');
});

test('rescheduling is atomic and preserves original booking on a conflict', async t => {
  const { store, input } = await fixture(t);
  const first = await store.createBooking(input, 'reschedule-first');
  const later = DateTime.fromISO(input.startAt).plus({ hours: 2 }).toUTC().toISO();
  await store.createBooking({ ...input, startAt: later }, 'reschedule-second');
  const identity = { phone: first.phone, bookingCode: first.bookingCode, confirmed: true };
  await assert.rejects(store.rescheduleBooking(first.id, { ...identity, startAt: later }, 'reschedule-conflict'), errorCode('SLOT_UNAVAILABLE'));
  assert.equal((await store.lookupBooking(identity)).startAt, first.startAt);
  const changedTime = DateTime.fromISO(input.startAt).plus({ hours: 4 }).toUTC().toISO();
  const changed = await store.rescheduleBooking(first.id, { ...identity, startAt: changedTime }, 'reschedule-success');
  assert.equal(changed.id, first.id);
  assert.equal(changed.startAt, changedTime);
  assert.deepEqual(await store.rescheduleBooking(first.id, { ...identity, startAt: changedTime }, 'reschedule-success'), changed);
  assert.equal((await store.listOutbox()).length, 3);
});

test('customer change cutoff is enforced and trusted admin override is explicit', async t => {
  const { store, input } = await fixture(t);
  const booking = await store.createBooking(input, 'cutoff-booking-key');
  await store.updateSettings({ salon: { cancellationHours: 168 } });
  const identity = { phone: booking.phone, bookingCode: booking.bookingCode, confirmed: true };
  await assert.rejects(store.cancelBooking(booking.id, identity), errorCode('CHANGE_WINDOW_CLOSED'));
  assert.equal((await store.cancelBooking(booking.id, { admin: true, confirmed: true })).status, 'cancelled');
});

test('customers can decline WhatsApp and leases prevent stale delivery completion', async t => {
  const { store, input } = await fixture(t);
  await store.createBooking({ ...input, whatsappConsent: false }, 'no-whatsapp-key');
  assert.equal((await store.claimOutbox()).length, 0);
  await store.createBooking({ ...input, stylistId: 'james' }, 'with-whatsapp-key');
  const [message] = await store.claimOutbox();
  assert.equal(message.attempts, 1);
  assert.equal((await store.claimOutbox()).length, 0);
  await store.completeOutbox(message.id, { leaseToken: 'stale-lease', providerId: 'SM_stale' });
  assert.equal((await store.listOutbox())[0].status, 'sending');
  await store.completeOutbox(message.id, { leaseToken: message.leaseToken, providerId: 'SM_correct' });
  assert.equal((await store.listOutbox())[0].status, 'sent');
});

test('DST fall-back offers distinct real instants and spring-forward skips nonexistent wall time', () => {
  const settings = structuredClone(defaultSalonSettings);
  settings.salon.timeZone = 'America/New_York'; settings.salon.minLeadMinutes = 0;
  settings.salon.businessHours[7] = { open: '00:00', close: '05:00' };
  const fall = enumerateSlots(settings, { date: '2026-11-01', serviceId: 'beard', stylistId: 'james' }, [], Date.parse('2026-10-16T00:00:00Z'));
  const repeated = fall.slots.filter(s => DateTime.fromISO(s.startAt).setZone(settings.salon.timeZone).toFormat('HH:mm') === '01:00');
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0].startAt, repeated[1].startAt);
  for (const slot of repeated) assert.equal(intervalFor(settings, { serviceId: 'beard', stylistId: 'james', startAt: slot.startAt }, Date.parse('2026-10-16T00:00:00Z')).startAt, slot.startAt);
  const spring = enumerateSlots(settings, { date: '2027-03-14', serviceId: 'beard', stylistId: 'james' }, [], Date.parse('2027-03-01T00:00:00Z'));
  assert.ok(!spring.slots.some(s => DateTime.fromISO(s.startAt).setZone(settings.salon.timeZone).hour === 2));
});

test('settings persist and cannot remove a booked stylist or alter an active time zone', async t => {
  const path = await mkdtemp(join(tmpdir(), 'salonline-booking-'));
  const { store, input } = await fixture(t, { databasePath: join(path, 'test.sqlite') });
  t.after(() => rm(path, { recursive: true, force: true }));
  await store.createBooking(input, 'settings-booking');
  await assert.rejects(store.updateSettings({ salon: { timeZone: 'Europe/London' } }), errorCode('TIME_ZONE_IN_USE'));
  const settings = await store.settings();
  await assert.rejects(store.updateSettings({ stylists: settings.stylists.filter(s => s.id !== 'maya') }), errorCode('STYLIST_IN_USE'));
  const changedHours = structuredClone(settings.salon.businessHours);
  const appointmentDay = DateTime.fromISO(input.startAt).setZone(settings.salon.timeZone).weekday;
  changedHours[appointmentDay] = null;
  await assert.rejects(store.updateSettings({ salon: { businessHours: changedHours } }), errorCode('HOURS_IN_USE'));
  await store.updateSettings({ salon: { name: 'Saved Salon' } });
  const second = await createStore({ databasePath: join(path, 'test.sqlite') });
  try { assert.equal((await second.settings()).salon.name, 'Saved Salon'); assert.equal((await second.listBookings()).length, 1); } finally { await second.close(); }
});

test('call history and operational counts reflect persisted data', async t => {
  const { store, input } = await fixture(t);
  const call = await store.createCall({ providerCallId: 'CA-demo', fromNumber: input.phone, channel: 'whatsapp' });
  assert.equal((await store.createCall({ providerCallId: 'CA-demo' })).id, call.id);
  await store.updateCall(call.id, { status: 'completed', summary: 'Booked a haircut.', endedAt: new Date().toISOString(), durationSeconds: 65 });
  const snapshot = await store.overview();
  assert.equal(snapshot.stats.completedCalls, 1);
  assert.equal(snapshot.calls[0].durationSeconds, 65);
  assert.equal((await store.health()).ok, true);
});

test('production startup rejects missing persistent database and insecure configuration', async () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://example' }), /ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://example', ADMIN_PASSWORD: 'long-password-123456', SESSION_SECRET: 's'.repeat(32) }), /HTTPS/);
  await assert.rejects(createStore({ nodeEnv: 'production' }), /PostgreSQL/);
  assert.throws(() => loadConfig({ MAX_CONCURRENT_CALLS: 'NaN' }), /MAX_CONCURRENT_CALLS/);
  assert.throws(() => loadConfig({ MAX_CALL_SECONDS: '0' }), /MAX_CALL_SECONDS/);
});

test('settings reject non-string identifiers before they can break future bookings', async t => {
  const { store, settings } = await fixture(t);
  await assert.rejects(store.updateSettings({ services: settings.services.map((s, i) => i ? s : { ...s, id: null }) }), errorCode('INVALID_SETTINGS'));
  await assert.rejects(store.updateSettings({ stylists: settings.stylists.map((s, i) => i ? s : { ...s, id: 123 }) }), errorCode('INVALID_SETTINGS'));
  assert.equal((await store.settings()).services[0].id, 'haircut');
});

// Explicitly opt in with a disposable PostgreSQL database connection. Each run
// owns one randomly named schema; no preexisting application tables are read.
test('PostgreSQL: independent stores serialize bookings, retries, calls, and outbox claims', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const { Pool } = await import('pg');
  const baseUrl = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(baseUrl.protocol), 'TEST_DATABASE_URL must reference a disposable PostgreSQL test database.');
  const schema = `salonline_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^salonline_test_[a-f0-9]{32}$/);
  const adminPool = new Pool({ connectionString: baseUrl.toString(), max: 1, connectionTimeoutMillis: 10000 });
  let first; let second; let schemaCreated = false;
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const testUrl = new URL(baseUrl);
    // Test an altered role default too: store operations must explicitly choose
    // READ COMMITTED so the overlap query sees the preceding lock owner's commit.
    const priorOptions = testUrl.searchParams.get('options') || '';
    testUrl.searchParams.set('options', `${priorOptions} -c search_path=${schema} -c default_transaction_isolation=serializable`.trim());
    const config = { databaseUrl: testUrl.toString(), salon: structuredClone(defaultSalonSettings) };
    const initialized = await Promise.allSettled([createStore(config), createStore(config)]);
    if (initialized[0].status === 'fulfilled') first = initialized[0].value;
    if (initialized[1].status === 'fulfilled') second = initialized[1].value;
    for (const result of initialized) if (result.status === 'rejected') throw result.reason;
    let day = DateTime.now().setZone(defaultSalonSettings.salon.timeZone).plus({ days: 3 }).startOf('day');
    while (!defaultSalonSettings.salon.businessHours[day.weekday]) day = day.plus({ days: 1 });
    const startAt = DateTime.fromISO(`${day.toISODate()}T${defaultSalonSettings.salon.businessHours[day.weekday].open}`, { zone: defaultSalonSettings.salon.timeZone }).toUTC().toISO();
    const input = { serviceId: 'haircut', stylistId: 'maya', startAt, customerName: 'Postgres Test Customer', phone: '+12125550123', channel: 'web', whatsappConsent: false, confirmed: true };
    const races = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? first : second).createBooking(input, `pg-concurrency-${i}`)));
    assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(races.filter(r => r.status === 'rejected').every(r => r.reason.code === 'SLOT_UNAVAILABLE'));
    const replayInput = { ...input, stylistId: 'james', whatsappConsent: true };
    const replays = await Promise.all([first.createBooking(replayInput, 'pg-idempotent-key'), second.createBooking(replayInput, 'pg-idempotent-key')]);
    assert.deepEqual(replays[0], replays[1]);
    const calls = await Promise.all([first.createCall({ providerCallId: 'CA-race-test' }), second.createCall({ providerCallId: 'CA-race-test' })]);
    assert.equal(calls[0].id, calls[1].id);
    const claims = await Promise.all([first.claimOutbox(), second.claimOutbox()]);
    assert.equal(claims.flat().length, 1);
    const message = claims.flat()[0];
    await first.completeOutbox(message.id, { leaseToken: message.leaseToken, providerId: 'SM-test-only' });
    assert.equal((await second.listOutbox())[0].status, 'sent');
    assert.equal((await second.listBookings()).length, 2);
  } finally {
    await Promise.allSettled([first?.close(), second?.close()]);
    if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
});
