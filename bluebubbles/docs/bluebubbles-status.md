# BlueBubbles status for Troy

Last updated: 2026-11-14 21:12 UTC (feature-test.ts)

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
| Receive photo | Works | image/jpeg, 2400492 bytes, saved to tmp-downloads/IMG_0001.HEIC.jpeg |
| Send text | Works |  |
| Send image | Works |  |
| Read receipts | Works |  |
| Typing indicators | Works | send works; incoming typing shows in the listener as typing-indicator |
| Tapbacks | Works |  |
| Edits | Works |  |
| Effects | Works |  |
| Group chat creation | Not tested | needs two other people; skipped to keep tests to one chat. Endpoint: POST /api/v1/chat/new {addresses:[...], message, method:'private-api'} |
| Polls (send) | Works | native poll via patched helper |
| Poll votes (receive) | Works | read vote: Tacos |
| Receive location share | Works | iOS 26 Messages > + > Location arrives as a Find My balloon ("Started Sharing Location"). decodeFindMyPayload() reads initialLocation (lat/long, accuracy, speed) from the message itself (tested, 61 m accuracy) |
| Live location updates (Find My) | Works, about every 2 to 3 min | location-get while they share; a new fix every 2 to 3 min in background mode (measured on a consenting friend's phone). Seconds-level live mode isn't reachable |
| Share my location | Skipped | Would share the host Mac's Apple ID location; not useful for Troy |
| Request someone's location | Works (via Find My app) | location-request sends a real Find My request; it appears in Find My > People on their phone. The chat bubble shows but has no Share button. Repeat while pending = error 7 |

## Patched helper (2026-11-14)

- /Applications/BlueBubbles.app/.../private-api/macos11/BlueBubblesHelper.dylib replaced with a build of BlueBubblesApp/bluebubbles-helper (source in helper-src/) plus Troy's PollSupport.m. Original saved in backups/BlueBubblesHelper.original.dylib. To undo: quit BlueBubbles, copy the backup back, reopen.
- A BlueBubbles update will overwrite the patched helper; rerun scripts/build-helper.sh and copy it in again.
- Troy control channel: helper connects out to 127.0.0.1:45699 (Messages is sandboxed, can't listen). Needs TROY_HELPER_TOKEN; helper refuses any chat not in ~/Library/Containers/com.apple.MobileSMS/Data/Library/Application Support/troy-helper/config.json. Tested: read works, other chats refused.

## Verified so far

- Webhook delivery fixed 2026-11-14: BlueBubbles sends to localhost as IPv6 ::1, so the listener now binds ::1 and 127.0.0.1 (still loopback only). Before the fix every event was refused (ECONNREFUSED ::1:3000). Verified after the fix with a real text: the listener logged `new-message handle=test-phone@example.com chat=any;-;test-phone@example.com`.
- Note: BlueBubbles' own log (~/Library/Logs/bluebubbles-server/main.log) includes previews of messages from ALL chats. Don't share it or paste it anywhere.
- Test chat guid is `any;-;test-phone@example.com` (macOS 27 uses the `any;` prefix).

- API ping returns `pong`; a wrong password returns 401.
- Webhook registered via API and listed.
- Private API enabled 2026-11-14 after SIP disable; server info reports `private_api: true`, `helper_connected: true`.
- Webhook registration survived the reboot.
- Listener privacy filter tested with fake events: only allowed 1:1 chats are logged, everything else logs `ignored event`.
