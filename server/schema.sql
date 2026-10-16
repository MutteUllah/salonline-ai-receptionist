CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL, whatsapp_consent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY, booking_code TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL REFERENCES customers(id),
  service_id TEXT NOT NULL, service_name TEXT NOT NULL, stylist_id TEXT NOT NULL, stylist_name TEXT NOT NULL,
  start_at TEXT NOT NULL, end_at TEXT NOT NULL, local_date TEXT NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed','cancelled')), channel TEXT NOT NULL, whatsapp_consent INTEGER NOT NULL,
  price DOUBLE PRECISION NOT NULL, currency TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (start_at < end_at)
);
CREATE INDEX IF NOT EXISTS bookings_stylist_date ON bookings(stylist_id,local_date,status);
CREATE INDEX IF NOT EXISTS bookings_start_at ON bookings(start_at);
CREATE INDEX IF NOT EXISTS bookings_phone ON bookings(phone);
CREATE TABLE IF NOT EXISTS idempotency (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY, provider_call_id TEXT UNIQUE, channel TEXT NOT NULL, from_number TEXT NOT NULL, status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '', transcript TEXT NOT NULL DEFAULT '', booking_id TEXT REFERENCES bookings(id),
  started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_started_at ON calls(started_at);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, call_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_call_id ON events(call_id);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL, locked_at TEXT, lease_token TEXT, provider_id TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_available ON outbox(status,available_at);
