# BlueBubbles status for Troy

Last updated: 2026-11-14 19:49 UTC (feature-test.ts)

## Setup

| Item | Status |
| --- | --- |
| Mac | macOS 27.0.1, Apple M5 |
| BlueBubbles Server | 1.9.12 (arm64, notarized), /Applications/BlueBubbles.app |
| URL | http://localhost:1234 (also listens on LAN; password protected) |
| Proxy | `lan-url` (no Cloudflare, ngrok or zrok) |
| Password | Generated, stored in `.env` as `BLUEBUBBLES_PASSWORD` only |
| Firebase / Google | Skipped |
| Keep awake | BlueBubbles auto-caffeinate on, plus `caffeinate -dimsu` (stop with `pkill caffeinate`) |
| Private API | On, helper connected (SIP disabled, library validation off). Re-enable SIP after the hackathon with `csrutil enable` in Recovery |
| Webhook | id 1 → http://localhost:3000/webhooks/bluebubbles, events: new-message, updated-message, typing-indicator |
| Listener | `node --env-file=.env scripts/webhook-test.ts` |

Caveat: lid closed on battery will still sleep the Mac.

## Feature checklist

Tested only against the second phone's 1:1 chat.

| Feature | Status | Notes |
| --- | --- | --- |
| Receive text | Works | found recent 'hey troy test' |
| Receive photo | Works | image/jpeg, 2400492 bytes, saved to tmp-downloads/81637835530__46C00828-A373-42B6-A4F2-C067801BACE3.HEIC.jpeg |
| Send text | Works |  |
| Send image | Works |  |
| Read receipts | Works | Needs 'Send Read Receipts' on for that chat in Mac Messages (turned on for the test chat only). POST /api/v1/chat/:guid/read then shows 'Read' on the phone |
| Typing indicators | Works | send works; incoming typing shows in the listener as typing-indicator |
| Tapbacks | Works |  |
| Edits | Fails (bug) | API says 'Message edited!' but Messages crashes (NSInvalidArgumentException in IMChat editMessageItem). BlueBubbles 1.9.12 helper doesn't support macOS 27 edits yet. Troy must not call /edit |
| Effects | Works |  |
| Group chat creation | Not tested | needs two other people; skipped to keep tests to one chat. Endpoint: POST /api/v1/chat/new {addresses:[...], message, method:'private-api'} |

## Verified so far

- Webhook delivery fixed 2026-11-14: BlueBubbles sends to localhost as IPv6 ::1, so the listener now binds ::1 and 127.0.0.1 (still loopback only). Before the fix every event was refused (ECONNREFUSED ::1:3000). Verified after the fix with a real text: the listener logged `new-message handle=test-phone@example.com chat=any;-;test-phone@example.com`.
- Note: BlueBubbles' own log (~/Library/Logs/bluebubbles-server/main.log) includes previews of messages from ALL chats. Don't share it or paste it anywhere.
- Test chat guid is `any;-;test-phone@example.com` (macOS 27 uses the `any;` prefix).

- API ping returns `pong`; a wrong password returns 401.
- Webhook registered via API and listed.
- Private API enabled 2026-11-14 after SIP disable; server info reports `private_api: true`, `helper_connected: true`.
- Webhook registration survived the reboot.
- Listener privacy filter tested with fake events: only allowed 1:1 chats are logged, everything else logs `ignored event`.
