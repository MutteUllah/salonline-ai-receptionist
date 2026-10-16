# Go live

## 1. Prepare your business

Choose your real business name, address, public contact number, currency, services, durations, staff, opening hours and IANA time zone. Replace the fictional details through Business settings. Supported conversation languages are English and Urdu. Test names, dates and mixed-language conversations with your actual callers before launch.

This application runs its own authoritative calendar. If the salon uses an existing booking system, connect that system before launch or agree a controlled migration. There is no external calendar integration hidden behind the dashboard.

## 2. Accounts and numbers

- An OpenAI API project with credit and access to the configured Realtime model. Set `OPENAI_API_KEY` and `OPENAI_REALTIME_MODEL` on the server.
- A Twilio account and voice-capable number for regular phone calls. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER`.
- A registered WhatsApp Business Platform sender with Calling enabled for WhatsApp calls. Set `TWILIO_WHATSAPP_NUMBER=whatsapp:+<countrycode><number>`.

WhatsApp Calling prerequisites must be checked in your provider console. At the time these integration docs were consulted, Twilio listed Meta Business Verification and a messaging tier of at least 2,000 business-initiated conversations per rolling 24 hours among its enablement requirements. Eligibility is not proven merely by putting a number in `.env`.

Official references: [Twilio WhatsApp Business Calling](https://www.twilio.com/docs/voice/whatsapp-business-calling), [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams), [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime).

## 3. Deploy the application

Use a server that supports persistent inbound and outbound WebSockets. This Node process is not packaged as a short-lived serverless function. The included deployment is **one app replica** plus PostgreSQL. HTTP webhook and media-upgrade requests must reach the same process: pending stream reservations and active audio sessions are held in memory. Multi-replica deployment requires a shared reservation store/sticky routing and additional tests.

1. Copy the project to your server and install Docker Compose and Caddy from their official sources.
2. Run `node scripts/setup.mjs`, then edit `.env` on the server.
3. Set `PUBLIC_BASE_URL=https://your-domain.example` with no path and no trailing slash, a strong `ADMIN_PASSWORD` (16+ characters), a strong `SESSION_SECRET` (32+ characters), and a new `POSTGRES_PASSWORD`. Use a generated alphanumeric database password to avoid URL escaping issues in the Compose connection string.
4. Add your provider credentials to `.env`. Keep `WHATSAPP_SEND_ENABLED=false` until your template and consent flow pass testing.
5. Run `docker compose up -d --build`. PostgreSQL is private to the Compose network. The application is exposed only at host loopback port 3000.
6. Set `DOMAIN` for Caddy, point that domain's DNS to the server, and run Caddy with the provided Caddyfile. Allow HTTPS and the ACME validation ports through the server firewall.
7. Open `https://your-domain.example/healthz` and `/readyz`. Sign into the owner dashboard and check **Go live**.

Configuration is validated at startup. Production refuses SQLite, an HTTP public URL or missing owner secrets. Set `DATABASE_URL` explicitly if deploying without Compose; use your database provider's TLS-verifying connection string. Never disable certificate verification.

The database integration was verified against a temporary local PostgreSQL 17.10 instance. The Docker image/Compose deployment and managed-database TLS were not run in the delivery environment. Validate those on your staging server before connecting customer traffic.

## 4. Configure Twilio

For the regular phone number:

| Setting | Value |
|---|---|
| Incoming voice webhook | `https://your-domain.example/webhooks/twilio/voice` |
| Method | POST |
| Call status callback | `https://your-domain.example/webhooks/twilio/status` |
| Callback events | initiated, ringing, answered, completed |

For WhatsApp Calling, create a TwiML Voice Application with that same incoming Request URL, then attach its SID in the approved sender's Voice Endpoint Configuration. Enable the calling icon/business hours in WhatsApp Manager where applicable. Follow the official Twilio onboarding procedure for your account.

The server validates the Twilio signature against the **configured public URL**, not a forwarded Host header. If calls receive 403, first check `PUBLIC_BASE_URL`, the exact webhook path and the account Auth Token. Do not bypass signature verification. Your reverse proxy must forward WebSocket upgrades and the `X-Twilio-Signature` header.

Calls use `/ws/twilio` internally through the generated TwiML. Do not manually add a token query parameter. The signed start parameter binds the stream to its CallSid, caller, channel and short-lived reservation.

## 5. Enable confirmation messages

Create a Meta-approved **utility** template through Twilio Content, using five variables in this exact mapping:

| Variable | Meaning |
|---|---|
| 1 | Customer name |
| 2 | Service name |
| 3 | Exact business-local date/time and time zone |
| 4 | Booking reference |
| 5 | Appointment state: confirmed, rescheduled or cancelled |

Example wording: `Hello {{1}}. Your {{2}} appointment on {{3}} is {{5}}. Reference: {{4}}. Contact the salon if you need help.`

Set `WHATSAPP_CONTENT_SID=HX...` to the approved template. Verify the sender is in `whatsapp:+...` format. The agent asks for messaging consent separately from booking confirmation. Only after staging checks, set `WHATSAPP_SEND_ENABLED=true` and restart the app. All queued consented messages then become eligible for sending; inspect or remove staging data before enabling on your real business database.

Only inbound voice is implemented. Automated outbound phone calls, WhatsApp outbound calling and live human transfer are outside this version. Human assistance creates a callback task visible in call activity. Staff must handle it through their approved contact process.

## 6. Acceptance before customer traffic

- Place a real regular phone call, and separately a real WhatsApp call.
- Complete bookings in English, Urdu, and a mixed-language conversation; verify date/time, name and price.
- Interrupt speech, give an ambiguous confirmation, decline WhatsApp, request an unavailable time, and try to change another customer's booking.
- Make simultaneous attempts for one slot and verify one succeeds.
- Verify the approved message arrives only after consent and a successful write.
- Simulate an invalid provider key, database outage, full capacity and call disconnect. Confirm staff see actionable outcomes.
- Measure response latency, booking accuracy, message delivery, call cost and callback workload under realistic load.
- Verify backup restore, access controls, retention policy and customer disclosures for your operating region.

No real calls, messages, charges, or account approvals were performed as part of this local build. Your provider credentials and country-specific availability must be established by the account owner.
