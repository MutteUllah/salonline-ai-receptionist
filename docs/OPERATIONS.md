# Operations

## Data and access

The owner dashboard uses a password exchange for an eight-hour HMAC-signed bearer session, held in tab-scoped browser session storage. Change `SESSION_SECRET` to invalidate existing sessions. This is a single-owner deployment, not a multi-tenant SaaS identity system. For a staff organization, put an identity-aware access proxy with MFA in front of dashboard/API paths while keeping signed Twilio webhook and media paths reachable by Twilio.

Audio and live speech transcripts are not recorded to the database by the streaming bridge. Audio is processed by Twilio and OpenAI; consult and configure their account retention/data controls. Customer names, phones, appointment records, brief call summaries, audit events, and notification payloads are persisted. Apply a documented retention period and backup expiry policy before using real data. Never record payment-card information in notes or transcripts.

Logs contain request ID, method, route, status and duration, not request bodies, caller numbers, signatures or API keys. Avoid adding request-body logs to production. Treat `.env`, database backups and booking references as private. `.env` and runtime data are excluded from Git and the delivery archive.

## Health and monitoring

- `/healthz`: process liveness.
- `/readyz`: database can be read. A 200 does not establish that Twilio, OpenAI or Meta approval is operational.
- **Go live**: checks configuration presence. It never reports that credentials have been verified remotely.
- **Call activity**: review `needs_callback` entries and unexpected disconnects.
- **Overview**: inspect appointment counts and queued messages.
- Authenticated `/api/messages`: inspect delivery queue state without exposing it publicly.

Alert on unavailable readiness, elevated 5xx responses, increasing callback requests, failed message jobs, unusual call duration, or provider spending. Configure budget alerts and quotas in provider consoles. No paid account resources or monitor integrations are provisioned automatically by this project.

## Message delivery semantics

Creating/changing an appointment and enqueuing its consented notification happen in one database transaction. Multiple workers claim jobs using leases (`FOR UPDATE SKIP LOCKED` on PostgreSQL). Failed transient sends retry with exponential delay, at most five attempts. Stale leases can be reclaimed after five minutes. Permanent errors fail the job.

Outbox `sent` means **accepted by Twilio**, not delivered to the customer's handset. Signed delivery callbacks are audit events. Network timeouts after provider acceptance are ambiguous: a retry can send a duplicate. Delivery is at-least-once, not exactly-once; all notifications contain the same booking reference for reconciliation. Do not promise guaranteed or exactly-once delivery to callers.

Set `WHATSAPP_SEND_ENABLED=false` and restart to pause further sends. Existing appointments remain valid. Correct credentials/template approval before requeuing failed jobs through an operator-controlled database procedure. Do not change a booking merely because its notification failed.

## Backups and updates

Use scheduled encrypted PostgreSQL backups and test restoring to a separate database. The SQLite development database lives in `data/` and is not part of the source package. For a development backup, stop the app first or use SQLite's backup API rather than copying a live WAL database file alone.

The initial schema uses idempotent table/index creation under a PostgreSQL advisory migration lock. Later schema changes need explicitly versioned migrations and a tested rollback/recovery plan. Do not assume changing schema.sql alone migrates existing columns.

Deployment updates interrupt in-memory calls. Drain new calls, wait for active calls to end (maximum call duration is bounded), deploy, then place a smoke-test call. Do not increase replicas without adding shared stream reservations/sticky routing. A process restart ends active media sessions; pending provider callbacks may no longer map to an in-memory call, so reconcile with Twilio logs during incidents.

## Failure response

1. **Voice unavailable:** check provider status/configuration and callback queue. The fallback says no appointment was made.
2. **Booking write error:** inspect request ID and database health. An ambiguous response is resolved by reusing the same idempotency key; do not create a new key until the earlier result is understood.
3. **Webhook 403:** compare exact public URL and Auth Token. Preserve signature checks.
4. **Message failure:** preserve the booking, inspect template/sender/consent/provider error, then retry delivery deliberately.
5. **Suspected credential exposure:** rotate provider credentials and owner/session secrets, audit access and deployment logs, and retest inbound calls.
