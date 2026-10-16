# Delivery verification

Verified on 16 October 2026 with Node.js 24.19.0.

## Working local story

Customer conversation in the browser → authenticated/same-origin API → booking rules → persistent database → appointment visible in the owner workspace.

Browser checks completed:

- Dashboard loads and shows actual database counts without fabricated activity.
- English Voice Studio conversation selects a real slot, reads details back, requires confirmation, then saves an appointment.
- The saved appointment appears in Appointments and can be moved to another available time.
- Business settings edit and persist the complete service/staff catalog, prices, durations, cancellation notice and weekday opening hours.
- Go live reports missing configuration clearly; it does not claim an approved or tested provider connection.
- No browser console errors were observed during these flows.

**Final automated result: 34 passed, 0 failed, 0 skipped.** See [test-results.txt](test-results.txt) for the captured TAP output. JavaScript syntax checks also passed.

Automated checks include SQLite booking races and persistence, daylight-saving folds/gaps, customer verification, idempotency, reschedule rollback, outbox leases, HTTP owner access, English/Urdu end-to-end conversations, Twilio signatures, token expiry/replay, actual local WebSocket upgrades with a mocked upstream, raw μ-law forwarding and playback interruption.

An isolated temporary **PostgreSQL 17.10** server ran on loopback during final verification and was stopped afterward. Two independent stores passed concurrent migrations, eight-way conflicting booking attempts, identical-request replay, duplicate provider-call insertion and competing notification leases. The test used its own random schema and no existing business database.

The live action guard independently transcribes the latest caller turn in memory and accepts only a short complete English/Urdu affirmation after a proposal/readback. Noise, stale yes, silence, unrelated replies and “yes but change the time” cannot commit. An unclear or delayed transcription requires the caller to confirm again. Audio and transcripts are not persisted by the bridge.

Dependency audit: the production lockfile had **zero reported advisories** when `pnpm audit --prod --json` ran during delivery. This is a point-in-time registry check, not a guarantee against future advisories.

## External acceptance still required

- Real OpenAI audio latency, voice quality, Urdu recognition quality and account/model access.
- Real Twilio telephone calls, WhatsApp calling approval, country eligibility, audio quality and approved-template delivery.
- Public HTTPS/WSS reverse proxy, Docker image/Compose on the target server and managed-database TLS.
- Load, failover, retention, backup restore and staff callback handling with the actual business.

Provider calls and messages were not placed during development. No paid account resources were provisioned. The server is designed for one app replica; expanding to multiple replicas requires shared stream reservations or sticky routing.

The PostgreSQL integration test is gated by `TEST_DATABASE_URL` for subsequent runs. Without that opt-in, the standard suite passes 33 tests and skips this one integration test. The included GitHub Actions workflow supplies a disposable PostgreSQL 17 service so all 34 tests can run in CI; that remote workflow itself has not been executed here.
