# BlueBubbles setup and tools

Everything for the BlueBubbles side of Troy, added 2026-11-14 from the BlueBubbles setup session. Self-contained: run every command from this folder. Nothing outside `bluebubbles/` was changed.

## What's new compared to the rest of the repo

- **Edits work now.** The edit crash came from the old Private API helper bundled with BlueBubbles 1.9.12. The current helper, built from source and installed into BlueBubbles.app, fixes it (tested, no crash). `CLAUDE.md` ("Edits are off") and `src/adapters/bluebubbles.ts` (`editMessage` returns false) are now out of date and can be updated when convenient.
- **Polls work.** The patched helper sends native iMessage polls from the host Apple ID (`send-poll`), and Troy can read votes. Formats and webhook shapes: `docs/tapback-events.md` (polls section) and the comments in `scripts/helper-client.ts` (`decodePollPayload`, `POLL_BALLOON_ID`).
- **Location.** `scripts/location.ts` reads a user's live location if they share it with the Mac's Apple ID, keeping only `ALLOWED_HANDLES` entries (BlueBubbles returns every Find My friend). Requesting someone's location has no callable API in macOS 27. Sharing the host's own location was skipped on purpose.
- `scripts/feature-test.ts` and `docs/bluebubbles-status.md` here are newer than the copies in the repo's `scripts/` and `docs/`. They add edits, location pin and live location steps, and the latest results.

## Files

| Path | What it is |
| --- | --- |
| `.env` | BlueBubbles URL and password, `ALLOWED_HANDLES`, `TROY_HELPER_TOKEN`. Gitignored |
| `scripts/feature-test.ts` | Interactive full test against the test chat only. Writes results to `docs/bluebubbles-status.md` |
| `scripts/webhook-test.ts` | Webhook listener on port 3000 (`::1` and `127.0.0.1`), logs only allowed chats |
| `scripts/location.ts` | Live location for allowed handles only (`--refresh` asks Find My to update) |
| `scripts/helper-client.ts` | Persistent helper connection for the Troy server (`HelperClient`): about 3 ms per request once connected, with its own chat allowlist |
| `scripts/troy-control.ts` | One-shot CLI for the helper: `get-payload`, `send-balloon` (can't run while the Troy server holds port 45699) |
| `scripts/decode-payload.py` | Decodes a balloon payload (keyed archive or plist) to JSON |
| `scripts/autostart.sh` | `on` / `off` / `status`: BlueBubbles at login plus caffeinate via launch agents (`off` after the hackathon) |
| `scripts/build-helper.sh` | Builds the helper from `helper-src/` with clang (no Xcode needed) |
| `helper-patches/PollSupport.m` | Troy's addition to the helper (tracked copy; the build uses the one in `helper-src/`) |
| `helper-src/` | Clone of BlueBubblesApp/bluebubbles-helper with PollSupport.m added. Gitignored |
| `build/`, `backups/` | Built helper and the original 1.9.12 helper. Gitignored |

## Troy control channel

Messages is sandboxed (outgoing connections only), so the helper connects **out** to Troy on `127.0.0.1:45699`. Protocol: newline JSON. The helper says hello, Troy sends `{"id", "token", "cmd", "chatGuid", ...}`, and the helper replies with the same `id`. Every command needs `TROY_HELPER_TOKEN`, and the helper refuses any chat not in its own allowlist at
`~/Library/Containers/com.apple.MobileSMS/Data/Library/Application Support/troy-helper/config.json`.

**Adding opted-in students (runtime allowlist).** John chose automatic, 1:1 only (2026-11-14):

```ts
await helper.allowChat("any;-;+15551234567");   // on opt-in ("hey troy"):  { ok, changed, count }
await helper.removeChat("any;-;+15551234567");  // on opt-out
```

The helper refuses group chats (`1:1 chat guid required`) and chats that don't exist in Messages yet (`chat does not exist in Messages yet`). Since the student texts first, their chat always exists by opt-in time. Changes are saved to the helper's `config.json`, so they survive restarts, and each one is logged with a count but no address. On startup the Troy server should call `allowChat` for every chat in its `allow_list` table, so both lists match. Tested: group chat and nonexistent chat refused, remove blocks immediately, re-add restores.

Only one program can hold port 45699 at a time. When the Troy server takes over, it should run this listener itself (see `helperRequest` in `scripts/troy-control.ts`).

## Location (helper commands, 1:1 chats only)

All three act only on the other person in `chatGuid` (must be an allowed 1:1 chat). Don't log coordinates.

**Request someone's location**

```ts
const r = await helper.request("location-request", chatGuid, {});            // add { bubble: false } to skip the chat bubble
// -> { ok: true, requested: "test-phone@example.com", invite: "ok" | "error: …" | "no answer from Find My within 10s" | "completed with value N", bubbleGuid: "…" }
```

It does what an iPhone does: a Find My "ask to share" request (`sendFriendshipInviteToHandle`) **plus** a "Requested Location" Find My bubble in the chat (built like iOS 26's: `kind.request`, Apple-epoch timestamp, uppercase UUID). The webhook will show the bubble as an `isFromMe` new-message with `balloonBundleId === FINDMY_BALLOON_ID`.

Status (2026-11-14): **the Find My request works.** It shows up on the other phone in **Find My → People** as a request to see their location (no notification). Accepting it started sharing, and `location-get` had a location about 45 s later. The chat bubble renders as "Requested your location" but has **no Share button**, probably because its `id` isn't the real request's ID (which Find My doesn't return to us). So call `location-request` with `{ bubble: false }` (a bubble without a button only confuses people) and have Troy say in text: "I sent you a location request: open Find My → People to accept it." Re-tested after sharing stopped: request arrived in Find My, still no button on the bubble. Also tried giving the bubble each request-related ID Find My logs publicly (the sendFriendshipInvite transaction ID and two work-item IDs, sent with `--bubble-only <id>`): still no button. The real request ID only appears as `<private>` in the logs. Accepted limitation (2026-11-14). A repeat request while one is pending returns `invite: "error: … FMLSession.ErrorDomain error 7"` (Apple's server answers 200; error 7 appears to mean already pending). Opening the Find My app on the Mac clears a stale "sharing" status.

**When they share** (reply to a request, or on their own): an incoming `new-message` with `balloonBundleId === FINDMY_BALLOON_ID` and Apple text "Started Sharing Location".

```ts
const p = await helper.request("get-payload", chatGuid, { messageGuid: event.data.guid });
const share = decodeFindMyPayload(p.payloadBase64);
// share.kind.share = { isFromRequest: boolean, duration: { indefinitely: {} } | … }
// share.initialLocation = { latitude, longitude, horizontalAccuracy, verticalAccuracy, altitude, speed, course, timestamp, … }
```

**Live updates while they're sharing**

```ts
const g = await helper.request("location-get", chatGuid, {}, 30_000);
// -> { ok: true, handle, sharingWithMe: boolean, location: null | { latitude, longitude, horizontalAccuracy, altitude, speed, timestamp /* unix seconds */, locationType, coarseAddressLabel, address } }
await helper.request("location-friends", chatGuid, {});   // -> { ok, handle, sharingWithMe }  (never lists anyone else)
```

`location-get` asks Find My to refresh that person, then returns the cached fix (it waits up to about 10 s). Poll it every 30 to 60 s while `sharingWithMe` is true, and use `timestamp` to tell new fixes from old ones. Notes from testing:
- Measured cadence (2026-11-14, a consenting friend's phone that was sharing): a **new fix about every 2 to 3 minutes** (`locationType` 1), accuracy 8 to 17 m. Find My's faster "live" mode (type 2, seconds apart) isn't reachable: the `priority` passed to `startRefreshingLocationForHandles` only maps to `.shallow` (0) or `.backgroundProactive` (anything else), and Find My throttles repeat refreshes. Polling faster than every 30 to 60 s gains nothing.
- An idle phone may go much longer between fixes (the test phone gave none for 15+ minutes).
- The Mac's Find My cache can be stale (it kept saying "sharing" after a share ended). Opening the Find My app on the Mac refreshes it.
- The last known location stays readable after sharing ends, so check `timestamp` before treating it as current.

## Rebuilding the helper from scratch

`helper-src/` isn't committed. To recreate it on a fresh checkout:

```bash
git clone https://github.com/BlueBubblesApp/bluebubbles-helper.git helper-src/bluebubbles-helper
```

```bash
git -C helper-src/bluebubbles-helper checkout 1ee57f3
```

```bash
git -C helper-src/bluebubbles-helper apply ../../helper-patches/BlueBubblesHelper-transaction-fix.patch
```

```bash
cp helper-patches/PollSupport.m "helper-src/bluebubbles-helper/Messages/MacOS-11+/BlueBubblesHelper/"
```

```bash
./scripts/build-helper.sh
```

`BlueBubblesHelper-transaction-fix.patch` stops Messages crashing when BlueBubbles Server 1.9.12 sends typing or read commands without a `transactionId`. `PollSupport.m` adds Troy's control channel (polls, location, allowlist). BlueBubbles auto-updates and update checks are turned off (in its config.db) so an update can't overwrite the patched helper.

## Maintenance

- **A BlueBubbles update overwrites the patched helper.** Rebuild and reinstall:
  ```bash
  ./scripts/build-helper.sh
  ```
  Then quit BlueBubbles, copy `build/BlueBubblesHelper.dylib` to `/Applications/BlueBubbles.app/Contents/Resources/appResources/private-api/macos11/`, and reopen it.
- **Undo the patch:** same steps, but copy `backups/BlueBubblesHelper.original.dylib` instead.

## After the hackathon (checklist)

1. **Turn off auto-start** (BlueBubbles at login, caffeinate, and the Troy server agent if it was added):
   ```bash
   ./scripts/autostart.sh off
   ```
2. **Website notices:** add the notices the public site needs (privacy notice and terms covering iMessage data, location, polls and email; what Troy stores and how to opt out).
3. **Turn SIP back on:** shut down, hold power for startup options, Options → Continue, Utilities → Terminal, run `csrutil enable`, restart.
4. **Turn library validation back on:**
   ```bash
   sudo defaults delete /Library/Preferences/com.apple.security.libraryvalidation.plist DisableLibraryValidation
   ```
5. **Change the BlueBubbles password** (BlueBubbles settings), then update `.env`. Rotate `TROY_HELPER_TOKEN` too.
6. **Clear the helper allowlist** (or put back the stock helper: quit BlueBubbles, copy `backups/BlueBubblesHelper.original.dylib` into the app, reopen).
7. **Remove the BlueBubbles webhooks** if Troy isn't running anymore.
8. **Delete local test data:** `tmp-captures/` (includes the test phone's location) and `tmp-downloads/`.
9. **Turn BlueBubbles update checks back on** if you keep using it.

