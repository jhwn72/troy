# Troy

iMessage agent that connects USC students to the right person, office or item. Built Nov 14 to 15, 2026 for the AI@USC Hackathon. The full spec is `docs/troy-build-spec.md`; the why is `docs/troy-idea-brief.md`. When they disagree with this file, this file wins (it records later decisions).

## Run

- Node 24 runs TypeScript directly. No build step. Imports use `.ts` extensions. No enums, no parameter properties, no namespaces (type stripping only).
- `npm run dev` (server), `npm test` (node:test), `npm run typecheck`.
- SQLite through the built-in `node:sqlite` (`DatabaseSync`). Schema in `src/db/schema.sql`, helpers in `src/db/index.ts`.
- Web server is Hono on `@hono/node-server`. It must bind loopback only, on both `::1` and `127.0.0.1` (BlueBubbles resolves localhost to IPv6).
- `MESSAGING_PROVIDER=webchat` for development, `bluebubbles` for the real thing.
- Port 3000 is the BlueBubbles webhook target. While the old test listener holds it, develop on `PORT=3100`.

## Layout and ownership

- `src/types.ts`: shared contracts. Read it first. Don't change it casually.
- `src/adapters/`: one file per provider, plus `gate.ts` (pure privacy-gate functions) and `index.ts` (picks the provider).
- `src/pipeline.ts`: the message pipeline. `src/commands.ts`: code commands (STOP, HELP, emergency...). `src/onboarding.ts`.
- `src/ai.ts`: the only file that calls the Claude API.
- `src/flows/<name>.ts`: one `FlowHandler` per flow, registered in `src/flows/index.ts`.
- `public/`: static pages. `tests/`: node:test files. `scripts/`: one-off scripts.

## Privacy rules (never weaken these)

Troy runs on John's personal Apple ID, so BlueBubbles sees all of his iMessages.

1. Drop every event that is from John (`isFromMe`) before anything else.
2. A chat is allowed only if: its first message after go-live starts with "hey troy", or its handle is on the manual list (`ALLOWED_HANDLES` or the dashboard), or it's a group chat Troy created.
3. Everything else is ignored completely: no save, no read receipt, no typing, no tapback, no reply, never sent to Claude, never logged. At most log the literal string `ignored event`, with no handle and no text.
4. A chat with any message from before go-live can never be allowed by the "hey troy" rule. Look up only the date of its earliest message, never the text.
5. The adapter itself refuses to send, react, edit, mark read or type in a chat that isn't allowed. This check lives inside the adapter.
6. `TROY_ENABLED` (env and the `troy_enabled` setting) stops all sending and processing.
7. Never print or commit secrets. Never paste BlueBubbles' own log anywhere (it has previews from every chat).
8. When testing against the real BlueBubbles server, touch only the test chat (the handles in `ALLOWED_HANDLES`).

## Decisions (John, Nov 14 afternoon)

- **Edits are off.** The BlueBubbles edit endpoint crashes Messages on macOS 27. The adapter's `editMessage` returns false and never calls it. Flow 2 sends new short texts at "last one" and "all gone" instead of editing the alert.
- **Judge skip.** At the USC email step Troy offers a clearly labeled skip for hackathon judges: reply `JUDGE` (and a visible button in web forms). Sets `verifiedVia = 'judge_skip'`. Copy must say it's for this demo only and wouldn't exist in the real campus version.
- **Location.** Troy needs live location. Order: (1) Find My sharing read through the adapter's `getLiveLocation` (student taps "Share My Location" in the iMessage chat), (2) an iMessage location pin, (3) "where are u rn?" matched against `campus_places`, (4) saved usual spots. Location is used to compute walking time and then not kept.
- **Emergency words** match phrases ("there's a fire", "i'm hurt", "being followed"), not bare words. "that's fire" must not trigger it.
- **Redaction** on dashboards is a full-image blur for wallets, IDs and cards, with click to reveal.
- **Cut rules** in the spec are reminders, not hard cutoffs.

## Hard rules (code decides, never the model)

The gate, send lock and kill switch; welcome and STOP text; emergency replies; pickup codes; servings counts and claims; walking times; verification results and attempt limits; dangerous-item routing; what claimants see before verification; contact rules; posting bans; any office, committee or program name, contact detail, date or link.

## Voice

All lowercase, texts like a friend, short bubbles, at most one emoji per bubble and none in stressful moments. Troy says he's an AI up front. Fixed templates (welcome, STOP, emergency) live in code.

## Git

Commit after every step that works. Commit as John only. No AI co-author lines or "generated with" text anywhere.
