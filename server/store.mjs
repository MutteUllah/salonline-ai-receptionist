import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DateTime } from 'luxon';
import { defaultSalonSettings, validateSettings } from './config.mjs';
import { AppError, fail, normalizePhone, intervalFor, enumerateSlots, validateCustomer, verifyBooking, checkChangeAllowed, idempotencyKey, fingerprint, localDay, localBoundary } from './booking.mjs';

const iso = () => new Date().toISOString();
const keys = object => Object.fromEntries(Object.entries(object).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
function bookingRecord(row) {
  if (!row) return null;
  const b = keys(row);
  b.whatsappConsent = Boolean(b.whatsappConsent);
  return b;
}
const callRecord = row => row ? keys(row) : null;
const outboxRecord = row => row ? { ...keys(row), payload: JSON.parse(row.payload) } : null;
const boundedLimit = (value, fallback = 100) => Math.max(1, Math.min(500, Number.isInteger(Number(value)) ? Number(value) : fallback));

export async function createStore(config = {}) {
  const postgres = Boolean(config.databaseUrl);
  let database;
  let pool;
  let queue = Promise.resolve();
  const sql = query => postgres ? query.replace(/\?/g, (() => { let i = 0; return () => `$${++i}`; })()) : query;
  const adapter = connection => ({
    all: async (query, params = []) => postgres ? (await connection.query(sql(query), params)).rows : connection.prepare(query).all(...params),
    one: async (query, params = []) => postgres ? (await connection.query(sql(query), params)).rows[0] : connection.prepare(query).get(...params),
    run: async (query, params = []) => postgres ? connection.query(sql(query), params) : connection.prepare(query).run(...params),
  });
  if (postgres) {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, application_name: 'salonline' });
    pool.on('error', error => console.error('PostgreSQL idle client error:', error.code || 'unknown'));
  } else {
    if (config.nodeEnv === 'production') throw new Error('Production requires PostgreSQL via DATABASE_URL.');
    const path = config.databasePath || './data/salonline.sqlite';
    if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  }

  async function transaction(fn, write = true) {
    if (postgres) {
      const connection = await pool.connect();
      try {
        // A transaction snapshot must refresh after an advisory-lock wait, even if
        // the database role has a different default isolation level configured.
        await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await connection.query("SET LOCAL lock_timeout='5s'");
        await connection.query("SET LOCAL statement_timeout='15s'");
        const result = await fn(adapter(connection));
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        try { await connection.query('ROLLBACK'); } catch { /* retain original failure */ }
        throw error;
      } finally { connection.release(); }
    }
    const run = queue.then(async () => {
      database.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const result = await fn(adapter(database));
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    });
    queue = run.catch(() => {});
    return run;
  }
  async function lock(tx, key, shared = false) {
    if (postgres) await tx.one(`SELECT pg_advisory_xact_lock${shared ? '_shared' : ''}(hashtextextended(?, 0))`, [`salonline:${key}`]);
  }
  try {
    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    if (postgres) {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await connection.query("SET LOCAL lock_timeout='5s'");
        await connection.query("SET LOCAL statement_timeout='15s'");
        await connection.query("SELECT pg_advisory_xact_lock(hashtextextended('salonline:migrations',0))");
        await connection.query(schema);
        await connection.query('COMMIT');
      } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    } else database.exec(schema);
    await transaction(async tx => {
      await tx.run('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?) ON CONFLICT(version) DO NOTHING', [1, iso()]);
      await tx.run('INSERT INTO settings(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING', ['salon', JSON.stringify(validateSettings(config.salon || defaultSalonSettings)), iso()]);
    });
  } catch (error) {
    if (postgres) await pool.end(); else database.close();
    throw error;
  }

  async function getSettings(tx) { return JSON.parse((await tx.one('SELECT value FROM settings WHERE id=?', ['salon'])).value); }
  async function settings() { return transaction(getSettings, false); }
  async function allBookings(tx, where = '1=1', params = [], limit = 500) {
    return (await tx.all(`SELECT * FROM bookings WHERE ${where} ORDER BY start_at ASC LIMIT ?`, [...params, limit])).map(bookingRecord);
  }
  async function cached(tx, key, hash) {
    await lock(tx, `idempotency:${key}`);
    const row = await tx.one('SELECT * FROM idempotency WHERE id=?', [key]);
    if (row && row.fingerprint !== hash) fail(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for different details.');
    return row ? JSON.parse(row.response) : null;
  }
  async function remember(tx, key, hash, response) {
    await tx.run('INSERT INTO idempotency(id,fingerprint,response,created_at) VALUES(?,?,?,?)', [key, hash, JSON.stringify(response), iso()]);
  }
  async function checkOverlap(tx, interval, exceptId = '') {
    const conflict = await tx.one("SELECT id FROM bookings WHERE stylist_id=? AND status='confirmed' AND start_at < ? AND end_at > ? AND id <> ? LIMIT 1", [interval.stylist.id, interval.endAt, interval.startAt, exceptId]);
    if (conflict) fail(409, 'SLOT_UNAVAILABLE', 'This appointment time was just booked. Please choose another available time.');
  }
  async function event(tx, type, payload, callId = null) {
    const id = randomUUID();
    await tx.run('INSERT INTO events(id,call_id,type,payload,created_at) VALUES(?,?,?,?,?)', [id, callId, type, JSON.stringify(payload), iso()]);
    return { id };
  }
  async function message(tx, booking, kind, salonSettings) {
    if (!booking.whatsappConsent) return;
    const when = DateTime.fromISO(booking.startAt, { zone: 'utc' }).setZone(salonSettings.salon.timeZone).toFormat('cccc, LLLL d, yyyy h:mm a ZZZZ');
    const payload = {
      to: booking.phone, bookingId: booking.id, kind, consent: true,
      body: `${salonSettings.salon.name}: Your ${booking.serviceName} appointment with ${booking.stylistName} on ${when} is ${kind}. Booking code: ${booking.bookingCode}. Contact ${salonSettings.salon.phone} for help.`,
      templateVariables: { '1': booking.customerName, '2': booking.serviceName, '3': when, '4': booking.bookingCode, '5': kind },
    };
    const timestamp = iso();
    await tx.run('INSERT INTO outbox(id,type,payload,status,attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [randomUUID(), 'whatsapp', JSON.stringify(payload), 'pending', 0, timestamp, timestamp, timestamp]);
  }
  async function createBooking(input, requestKey) {
    const customer = validateCustomer(input);
    const key = idempotencyKey(requestKey);
    const hash = fingerprint({ operation: 'create', ...input, ...customer });
    return transaction(async tx => {
      const existing = await cached(tx, key, hash);
      if (existing) return existing;
      await lock(tx, 'settings', true);
      const salonSettings = await getSettings(tx);
      const interval = intervalFor(salonSettings, input);
      await lock(tx, `stylist:${interval.stylist.id}:${interval.date}`);
      await checkOverlap(tx, interval);
      const timestamp = iso();
      const customerId = randomUUID();
      await tx.run('INSERT INTO customers(id,phone,name,whatsapp_consent,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name,whatsapp_consent=excluded.whatsapp_consent,updated_at=excluded.updated_at', [customerId, customer.phone, customer.customerName, Number(customer.whatsappConsent), timestamp, timestamp]);
      const savedCustomer = await tx.one('SELECT id FROM customers WHERE phone=?', [customer.phone]);
      const booking = {
        id: randomUUID(), bookingCode: `BK-${randomBytes(6).toString('hex').toUpperCase()}`,
        customerId: savedCustomer.id, serviceId: interval.service.id, serviceName: interval.service.name,
        stylistId: interval.stylist.id, stylistName: interval.stylist.name, startAt: interval.startAt, endAt: interval.endAt, localDate: interval.date,
        ...customer, status: 'confirmed', price: interval.service.price, currency: salonSettings.salon.currency, createdAt: timestamp, updatedAt: timestamp,
      };
      await tx.run('INSERT INTO bookings(id,booking_code,customer_id,service_id,service_name,stylist_id,stylist_name,start_at,end_at,local_date,customer_name,phone,status,channel,whatsapp_consent,price,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [booking.id, booking.bookingCode, booking.customerId, booking.serviceId, booking.serviceName, booking.stylistId, booking.stylistName, booking.startAt, booking.endAt, booking.localDate, booking.customerName, booking.phone, booking.status, booking.channel, Number(booking.whatsappConsent), booking.price, booking.currency, timestamp, timestamp]);
      await event(tx, 'booking.created', { bookingId: booking.id, channel: booking.channel });
      await message(tx, booking, 'confirmed', salonSettings);
      await remember(tx, key, hash, booking);
      return booking;
    });
  }
  async function lookupBooking(input) {
    const phone = normalizePhone(input?.phone);
    const code = typeof input.bookingCode === 'string' ? input.bookingCode.trim().toUpperCase() : '';
    return transaction(async tx => {
      const booking = bookingRecord(await tx.one('SELECT * FROM bookings WHERE phone=? AND booking_code=?', [phone, code]));
      verifyBooking(booking, { ...input, admin: false });
      return booking;
    }, false);
  }
  async function cancelBooking(id, input) {
    return transaction(async tx => {
      await lock(tx, 'settings', true);
      const salonSettings = await getSettings(tx);
      const booking = bookingRecord(await tx.one(`SELECT * FROM bookings WHERE id=?${postgres ? ' FOR UPDATE' : ''}`, [id]));
      if (!booking) fail(404, 'BOOKING_NOT_FOUND', 'No appointment matches these details.');
      verifyBooking(booking, input);
      if (input?.confirmed !== true) fail(400, 'CONFIRMATION_REQUIRED', 'Explicit confirmation is required.');
      if (booking.status === 'cancelled') return booking;
      checkChangeAllowed(booking, input, salonSettings);
      booking.status = 'cancelled'; booking.updatedAt = iso();
      await tx.run('UPDATE bookings SET status=?,updated_at=? WHERE id=?', [booking.status, booking.updatedAt, id]);
      await event(tx, 'booking.cancelled', { bookingId: id });
      await message(tx, booking, 'cancelled', salonSettings);
      return booking;
    });
  }
  async function rescheduleBooking(id, input, requestKey) {
    const key = idempotencyKey(requestKey);
    const hash = fingerprint({ operation: 'reschedule', id, ...input });
    return transaction(async tx => {
      const existing = await cached(tx, key, hash);
      if (existing) return existing;
      await lock(tx, 'settings', true);
      const salonSettings = await getSettings(tx);
      const booking = bookingRecord(await tx.one(`SELECT * FROM bookings WHERE id=?${postgres ? ' FOR UPDATE' : ''}`, [id]));
      if (!booking) fail(404, 'BOOKING_NOT_FOUND', 'No appointment matches these details.');
      checkChangeAllowed(booking, input, salonSettings);
      const interval = intervalFor(salonSettings, { serviceId: input.serviceId || booking.serviceId, stylistId: input.stylistId || booking.stylistId, startAt: input.startAt });
      for (const key of [...new Set([`stylist:${booking.stylistId}:${booking.localDate}`, `stylist:${interval.stylist.id}:${interval.date}`])].sort()) await lock(tx, key);
      await checkOverlap(tx, interval, id);
      Object.assign(booking, { serviceId: interval.service.id, serviceName: interval.service.name, stylistId: interval.stylist.id, stylistName: interval.stylist.name, startAt: interval.startAt, endAt: interval.endAt, localDate: interval.date, price: interval.service.price, currency: salonSettings.salon.currency, updatedAt: iso() });
      await tx.run('UPDATE bookings SET service_id=?,service_name=?,stylist_id=?,stylist_name=?,start_at=?,end_at=?,local_date=?,price=?,currency=?,updated_at=? WHERE id=?', [booking.serviceId, booking.serviceName, booking.stylistId, booking.stylistName, booking.startAt, booking.endAt, booking.localDate, booking.price, booking.currency, booking.updatedAt, id]);
      await event(tx, 'booking.rescheduled', { bookingId: id });
      await message(tx, booking, 'rescheduled', salonSettings);
      await remember(tx, key, hash, booking);
      return booking;
    });
  }
  async function availability(input) {
    return transaction(async tx => {
      const salonSettings = await getSettings(tx);
      const day = localDay(salonSettings, input.date);
      const start = day.toUTC().toISO(); const end = day.plus({ days: 1 }).toUTC().toISO();
      const bookings = (await tx.all("SELECT * FROM bookings WHERE status='confirmed' AND start_at < ? AND end_at > ?", [end, start])).map(bookingRecord);
      return enumerateSlots(salonSettings, input, bookings);
    }, false);
  }
  async function listBookings(query = {}) {
    return transaction(async tx => {
      const clauses = []; const params = [];
      if (query.status) { if (!['confirmed', 'cancelled'].includes(query.status)) fail(400, 'INVALID_STATUS', 'Invalid booking status.'); clauses.push('status=?'); params.push(query.status); }
      if (query.date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) fail(400, 'INVALID_DATE', 'Use YYYY-MM-DD.'); clauses.push('local_date=?'); params.push(query.date); }
      if (query.phone) { clauses.push('phone=?'); params.push(normalizePhone(query.phone)); }
      if (query.from) { const d = DateTime.fromISO(query.from, { zone: 'utc' }); if (!d.isValid) fail(400, 'INVALID_DATE', 'Invalid from date.'); clauses.push('start_at>=?'); params.push(d.toUTC().toISO()); }
      if (query.to) { const d = DateTime.fromISO(query.to, { zone: 'utc' }); if (!d.isValid) fail(400, 'INVALID_DATE', 'Invalid to date.'); clauses.push('start_at<?'); params.push(d.toUTC().toISO()); }
      if (query.stylistId) { clauses.push('stylist_id=?'); params.push(query.stylistId); }
      return allBookings(tx, clauses.join(' AND ') || '1=1', params, boundedLimit(query.limit));
    }, false);
  }
  async function updateSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'INVALID_SETTINGS', 'Settings must be a JSON object.');
    return transaction(async tx => {
      await lock(tx, 'settings');
      const current = await getSettings(tx);
      let next;
      try { next = validateSettings({ salon: { ...current.salon, ...patch.salon, businessHours: patch.salon?.businessHours || current.salon.businessHours }, services: patch.services || current.services, stylists: patch.stylists || current.stylists }); }
      catch (error) { throw new AppError(400, 'INVALID_SETTINGS', error.message); }
      const upcoming = await tx.all("SELECT * FROM bookings WHERE status='confirmed' AND end_at > ?", [iso()]);
      if (upcoming.length && current.salon.timeZone !== next.salon.timeZone) fail(409, 'TIME_ZONE_IN_USE', 'Keep the current time zone while future appointments exist.');
      if (upcoming.some(b => !next.stylists.some(s => s.id === b.stylist_id))) fail(409, 'STYLIST_IN_USE', 'A stylist with future appointments cannot be removed.');
      for (const booking of upcoming) {
        const stylist = next.stylists.find(s => s.id === booking.stylist_id);
        if (!next.services.some(s => s.id === booking.service_id) || !stylist.serviceIds.includes(booking.service_id)) fail(409, 'SERVICE_IN_USE', 'Keep services and stylist assignments used by future appointments.');
        const start = DateTime.fromISO(booking.start_at, { zone: 'utc' }).setZone(next.salon.timeZone);
        const end = DateTime.fromISO(booking.end_at, { zone: 'utc' }).setZone(next.salon.timeZone);
        const hours = next.salon.businessHours[start.weekday];
        if (!hours || start < localBoundary(start.toISODate(), hours.open, next.salon.timeZone) || end > localBoundary(start.toISODate(), hours.close, next.salon.timeZone, true)) fail(409, 'HOURS_IN_USE', 'New opening hours must still accommodate existing future appointments.');
      }
      await tx.run('UPDATE settings SET value=?,updated_at=? WHERE id=?', [JSON.stringify(next), iso(), 'salon']);
      await event(tx, 'settings.updated', { salonId: next.salon.id });
      return next;
    });
  }
  async function createCall(input = {}) {
    return transaction(async tx => {
      if (input.providerCallId) { const existing = await tx.one('SELECT * FROM calls WHERE provider_call_id=?', [String(input.providerCallId)]); if (existing) return callRecord(existing); }
      const timestamp = iso();
      const call = { id: randomUUID(), providerCallId: input.providerCallId ? String(input.providerCallId).slice(0, 128) : null, channel: input.channel || 'phone', fromNumber: String(input.fromNumber || 'unknown').slice(0, 80), status: input.status || 'in-progress', summary: String(input.summary || '').slice(0, 5000), transcript: String(input.transcript || '').slice(0, 100000), bookingId: input.bookingId || null, startedAt: timestamp, endedAt: null, durationSeconds: 0, updatedAt: timestamp };
      await tx.run('INSERT INTO calls(id,provider_call_id,channel,from_number,status,summary,transcript,booking_id,started_at,ended_at,duration_seconds,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_call_id) DO NOTHING', [call.id, call.providerCallId, call.channel, call.fromNumber, call.status, call.summary, call.transcript, call.bookingId, call.startedAt, call.endedAt, call.durationSeconds, timestamp]);
      return call.providerCallId ? callRecord(await tx.one('SELECT * FROM calls WHERE provider_call_id=?', [call.providerCallId])) : call;
    });
  }
  async function updateCall(id, patch = {}) {
    return transaction(async tx => {
      const call = callRecord(await tx.one('SELECT * FROM calls WHERE id=?', [id]));
      if (!call) fail(404, 'CALL_NOT_FOUND', 'Call not found.');
      for (const key of ['status', 'summary', 'transcript', 'bookingId', 'endedAt', 'durationSeconds']) if (patch[key] !== undefined) call[key] = patch[key];
      call.summary = String(call.summary || '').slice(0, 5000); call.transcript = String(call.transcript || '').slice(0, 100000);
      call.durationSeconds = Math.max(0, Math.floor(Number(call.durationSeconds) || 0)); call.updatedAt = iso();
      await tx.run('UPDATE calls SET status=?,summary=?,transcript=?,booking_id=?,ended_at=?,duration_seconds=?,updated_at=? WHERE id=?', [String(call.status).slice(0, 64), call.summary, call.transcript, call.bookingId, call.endedAt, call.durationSeconds, call.updatedAt, id]);
      return call;
    });
  }
  async function listCalls(query = {}) { return transaction(async tx => (await tx.all('SELECT * FROM calls ORDER BY started_at DESC LIMIT ?', [boundedLimit(query.limit)])).map(callRecord), false); }
  async function overview() {
    return transaction(async tx => {
      const salonSettings = await getSettings(tx);
      const timestamp = iso();
      const today = DateTime.now().setZone(salonSettings.salon.timeZone).toISODate();
      const count = async (query, params = []) => Number((await tx.one(query, params)).count);
      const stats = {
        todayBookings: await count("SELECT COUNT(*) AS count FROM bookings WHERE local_date=? AND status='confirmed'", [today]),
        upcomingBookings: await count("SELECT COUNT(*) AS count FROM bookings WHERE start_at>=? AND status='confirmed'", [timestamp]),
        totalBookings: await count('SELECT COUNT(*) AS count FROM bookings'),
        completedCalls: await count("SELECT COUNT(*) AS count FROM calls WHERE status IN ('completed','complete')"),
        pendingMessages: await count("SELECT COUNT(*) AS count FROM outbox WHERE status IN ('pending','sending')"),
      };
      return { stats, bookings: await allBookings(tx, "start_at>=? AND status='confirmed'", [timestamp], 8), calls: (await tx.all('SELECT * FROM calls ORDER BY started_at DESC LIMIT 8')).map(callRecord) };
    }, false);
  }
  async function recordEvent(input = {}) {
    if (typeof input.type !== 'string' || input.type.length > 100) fail(400, 'INVALID_EVENT', 'Event type is required.');
    return transaction(tx => event(tx, input.type, input.payload || {}, input.callId || null));
  }
  async function claimOutbox({ limit = 10 } = {}) {
    return transaction(async tx => {
      const timestamp = iso(); const stale = new Date(Date.now() - 5 * 60000).toISOString();
      await tx.run("UPDATE outbox SET status='failed',locked_at=NULL,lease_token=NULL,last_error='Delivery worker lease expired after maximum attempts',updated_at=? WHERE status='sending' AND locked_at<? AND attempts>=5", [timestamp, stale]);
      await tx.run("UPDATE outbox SET status='pending',locked_at=NULL,lease_token=NULL,updated_at=? WHERE status='sending' AND locked_at<? AND attempts<5", [timestamp, stale]);
      const rows = await tx.all(`SELECT * FROM outbox WHERE status='pending' AND available_at<=? ORDER BY created_at ASC LIMIT ?${postgres ? ' FOR UPDATE SKIP LOCKED' : ''}`, [timestamp, boundedLimit(limit, 10)]);
      for (const row of rows) {
        row.status = 'sending'; row.attempts += 1; row.locked_at = timestamp; row.updated_at = timestamp; row.lease_token = randomUUID();
        await tx.run("UPDATE outbox SET status='sending',attempts=?,locked_at=?,lease_token=?,updated_at=? WHERE id=?", [row.attempts, timestamp, row.lease_token, timestamp, row.id]);
      }
      return rows.map(outboxRecord);
    });
  }
  async function completeOutbox(id, { providerId = null, leaseToken } = {}) {
    if (!leaseToken) fail(400, 'LEASE_REQUIRED', 'Outbox lease token is required.');
    return transaction(async tx => {
      await tx.run("UPDATE outbox SET status='sent',provider_id=?,locked_at=NULL,lease_token=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='sending' AND lease_token=?", [providerId, iso(), id, leaseToken]);
      return { ok: true };
    });
  }
  async function failOutbox(id, { error = 'Delivery failed', retryable = true, leaseToken } = {}) {
    if (!leaseToken) fail(400, 'LEASE_REQUIRED', 'Outbox lease token is required.');
    return transaction(async tx => {
      const row = await tx.one('SELECT * FROM outbox WHERE id=? AND lease_token=?', [id, leaseToken]);
      if (!row) return { ok: false };
      const status = retryable && row.attempts < 5 ? 'pending' : 'failed';
      await tx.run('UPDATE outbox SET status=?,last_error=?,available_at=?,locked_at=NULL,lease_token=NULL,updated_at=? WHERE id=? AND lease_token=?', [status, String(error).slice(0, 1000), new Date(Date.now() + Math.min(3600000, 30000 * 2 ** row.attempts)).toISOString(), iso(), id, leaseToken]);
      return { ok: true, status };
    });
  }
  async function listOutbox(query = {}) { return transaction(async tx => (await tx.all('SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?', [boundedLimit(query.limit)])).map(outboxRecord), false); }
  async function health() { return transaction(async tx => { await tx.one('SELECT 1 AS ok'); return { database: postgres ? 'postgresql' : 'sqlite', ok: true }; }, false); }
  async function close() { if (postgres) await pool.end(); else { await queue; database.close(); } }
  return { catalog: settings, settings, updateSettings, overview, listBookings, lookupBooking, createBooking, cancelBooking, rescheduleBooking, availability, createCall, updateCall, listCalls, recordEvent, claimOutbox, completeOutbox, failOutbox, listOutbox, health, close };
}
