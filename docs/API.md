# HTTP API

All business endpoints except bootstrap and login require `Authorization: Bearer <token>` when `ADMIN_PASSWORD` is configured. Mutations use JSON and a permitted same-origin request. Never expose the unauthenticated development server outside loopback. External callbacks use Twilio signature authentication instead of the owner session.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/bootstrap` | Public business catalog, environment and owner-auth requirement; no customer records |
| POST | `/api/auth/login` | `{password}` → `{token,expiresIn}` |
| GET | `/api/overview` | Operational counts, next appointments, recent calls |
| GET | `/api/bookings` | Appointment records |
| GET | `/api/availability?date=YYYY-MM-DD&serviceId=haircut&stylistId=maya` | Available exact ISO instants and labels; stylist optional |
| POST | `/api/bookings` | Create a confirmed appointment |
| POST | `/api/bookings/:id/reschedule` | Move an appointment as authenticated owner |
| POST | `/api/bookings/:id/cancel` | Cancel as owner, `{confirmed:true}` |
| GET | `/api/calls` | Call history and callback tasks |
| GET | `/api/messages` | Notification jobs, including error/retry state |
| GET / PUT | `/api/settings` | Read/update validated business, services and staff settings |
| GET | `/api/readiness` | Configuration checks and webhook URLs |
| POST | `/api/demo/turn` | `{sessionId?,message,language?}` → guided simulator reply/session |
| POST | `/api/demo/end` | End a training session |
| POST | `/webhooks/twilio/voice` | Signed form-encoded incoming call → TwiML |
| POST | `/webhooks/twilio/status` | Signed call status |
| POST | `/webhooks/twilio/message-status` | Signed message delivery status audit |
| WSS | `/ws/twilio` | Signed Twilio Media Streams upgrade + caller-bound start token |
| GET | `/healthz`, `/readyz` | Process/database checks |

Create/reschedule requests require a stable `Idempotency-Key` of 8–120 characters (letters, numbers, dots, colons, underscores, hyphens). Reuse it when retrying an identical request. Reusing it with changed details returns 409.

Example create body:

```json
{
  "serviceId": "haircut",
  "stylistId": "maya",
  "startAt": "2026-11-02T05:00:00.000Z",
  "customerName": "Example Customer",
  "phone": "+12125550123",
  "whatsappConsent": false,
  "confirmed": true
}
```

Use an exact time returned by availability; the fixed example may be outside the live booking window. The server enforces duration, opening hours, advance notice, maximum horizon, staff capabilities and overlap. Price and appointment end time come from approved configuration. Dates/labels use the business IANA time zone; stored timestamps use UTC.

Live voice calls do not call owner HTTP mutations. They use a restricted internal tool adapter bound to the signed caller identity. Existing booking lookup/change requires the caller's booking reference and matching phone number. The adapter never accepts caller-controlled `admin:true`.

Errors use `{error,code,requestId}` with an appropriate HTTP status. An internal exception returns a generic message rather than leaking SQL, credentials or personal data.
