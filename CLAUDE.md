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
- `src/flows/<name>.ts`: one `FlowHandler` per flow, registered in `src/flows/index.ts`. Lost and found lives in `src/flows/lostfound/` (`handler.ts` has the state table at the top, `match.ts`, `verify.ts`, `vision.ts`).
- `src/pending.ts`: one open question per person. A question for someone who is busy with another one waits in `pending_asks` and is asked when they are free. Use it instead of overwriting someone's `flow_state`.
- `src/outbox.ts`: dashboard texts held back by quiet hours or pause wait in `outbox` and go out later, in order. STOP drops them.
- `src/location.ts`: `saveUserLocation`, `forgetUserLocation`, `getUserLocation` (saved fix first, stale after 3 hours, then the first usual spot).
- `src/eval.ts` and `scripts/eval.ts`: the lost and found eval. `latestEval()` feeds the dashboard and the panel.
- `docs/flow-transcripts.md`: what Troy says today, captured from the running server.
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

- **Edits are allowed again** (John, Nov 14 evening). The stock BlueBubbles 1.9.12 helper crashed Messages on edits; the patched helper in `bluebubbles/` fixes it. `editMessage` only calls the endpoint when `BLUEBUBBLES_EDITS=true`, and returns false otherwise or on failure. Callers must always have the fallback: Flow 2 edits the alert count when it can and sends a new short text ("last one", "all gone") when it can't.
- **`bluebubbles/` belongs to the BlueBubbles setup session.** Don't edit or commit it from here. Port 45699 is reserved for its helper channel.
- **No-AI verification leans on the finder** (John, Nov 14 evening). When `scoreDescription` comes back with source `fallback` (the Claude API was down or slow), Troy never passes a claimant on that score alone. Instead the finder decides: Troy shows the finder the owner's own description (never the other way around) and asks if it sounds like the item's owner; the finder's yes verifies (method `finder_confirm`), a no counts as a miss. The fallback score is only a hint and a safety brake: a clear contradiction (wrong name, wrong color or size) still counts as a miss without bothering the finder. Items already at DPS go to "dps can help u in person".
- **Trust USG's own statements** (John, Nov 14 evening). The USG president said at the opening session that USG runs an LAX shuttle, a farmers market and thrift, and funds RSOs. Troy states those programs exist plainly, without hedging. Dates, prices and links still only come from confirmed sources; when there isn't one, Troy says to ask USG for this year's dates.
- **Welcome copy and texting feel** (John, Nov 14 evening, after the first live test). Welcome bubbles, John's words: "hey i'm troy" / "i'm an ai, but i know a guy for everything" / "send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'". STOP line: "reply STOP anytime and i'll leave u alone until u want to talk again". Before the contact card: "save my contact if u haven't so u know it's me"; the card carries the mascot photo. The judge skip is a poll ("usc student" / "hackathon judge"), not a typed JUDGE reply. "Read" must show before Troy starts typing; typing shows 1 to 2 seconds for normal bubbles and 3 to 4 for longer ones; long replies are split into smaller chunks.
- **Browser demo limits** (John, Nov 14 evening). The public browser demo allows 25 messages per visitor and 100 for judges. Judge status is honor system: the line above the judge poll or button asks non-judges kindly not to press it. At the limit Troy says it's a hackathon demo and offers to ask John for more. Each visitor can send exactly one request for more; it emails OWNER_EMAIL a link where John approves a specific amount. Emergency and crisis replies still go out after STOP, and self-harm messages get the fixed 988 reply (John confirmed both). The GitHub repo goes public right before submission, not earlier.
- **Hosting** (John, Nov 14 evening). Public pages go on Vercel, not Replit. The iMessage server stays on John's Mac. The landing page is static and deploys as is; a public browser demo on Vercel needs a hosted database because serverless functions don't keep files or memory between requests.
- **Troy's chat brain** (John, Nov 14 night). Outside locked steps Troy talks freely from the files in `brain/` (persona, about-troy, playbook), never from canned replies. Locked steps lock the facts, not the wording. `brain/origin-story.md` is background only: he never quotes or recites it, he answers in his own words.
- **Explaining how he works** (John). High level and generic, never specifics. He says his brain runs on ai, not which model or company; that he texts over imessage, not how the messaging is wired; that there's a quick check before a handoff, never how many tries, what passes, or which details are hidden. If pressed he stays friendly and stays general.
- **Quick lookup for things he doesn't know** (John). For a factual campus question the directory can't answer, Troy may do one cheap, fast web lookup and give a best guess with "double check". Keep compute low: one search at most, the fast model, official USC pages preferred, a per-student daily cap, and never for anything a hard rule covers.
- **Location ask** (John, via the BlueBubbles session). Default is a text plus the how-to GIF at `bluebubbles/gif/share-location.gif`: "btw, i work best when i know where u are. here's how to share ur location with me (takes 10 seconds, turn it off anytime) 👇". Then one bubble saying he keeps the last spot they share and that "forget my location" erases it. The Find My request is a fallback only. Troy always writes "u" and "ur".
- **Judge skip.** At the USC email step Troy offers a clearly labeled skip for hackathon judges. It is a poll ("usc student" / "hackathon judge"), not a typed reply, with a visible button in web forms. Sets `verifiedVia = 'judge_skip'`. Copy must say it's for this demo only and wouldn't exist in the real campus version.
- **Polls work natively** through the patched helper when it is connected (`sendPoll` returns mode `native`, votes arrive as `pollVote`). The fallback is tap to pick (one bubble per option, a heart or thumbs up picks it), then a numbered list. Callers handle all three modes.
- **Adapter additions.** `requestLocation(chatId)` sends the Find My request bubble when it can and returns false when it can't (then Troy just asks). Optional `onAllowed(chatId)` and `onDisallowed(chatId)` are called by the pipeline right after opt-in and on STOP or "delete my data".
- **Lost and found: what the owner is told never depends on the match score.** Every claim opens with the same bubbles and the same blind question. The old "80+ verifies, 50 to 79 gets one more question" wording is gone. The AI score only orders candidates and shows on the dashboard; whether a pair is acted on is decided by a public score (kind, color, brand, place, time) of 50 or more.
- **Every scored description is a counted try.** Tries are counted per found item and person, two at most. Backing out, "nvm" or a new report resets nothing.
- **Silent claimants are released.** After 1 hour when someone else is waiting on the item, after 24 hours otherwise. STOP and "delete my data" release at once, and every release looks for the next owner.
- **Lost and found texts to the other person ignore quiet hours** (`sayToOwed`): the question for the finder, the match for the owner, the contact warning and the pickup code are owed, and a dropped one would leave a step open on words nobody saw. Nothing is ever sent after STOP.
- **Pending questions and the outbox.** One open step per person. A question for someone mid-question is parked and asked when they are free (`src/pending.ts`). Dashboard texts held by quiet hours or pause wait in the outbox (`src/outbox.ts`).
- **Eval in fallback mode** reports a rule-score pass as "sent to the finder", never as a handoff. `EvalResult` has `sentToFinder` and `sentToFinderNotOwner` next to the older fields.
- **Location is kept** (John, Nov 14 evening; see "Location" in the spec). A share in the chat gives one fix, read through the patched helper; there are no continuous updates. Troy saves each user's last known location (lastLat, lastLng, lastLocationAt, lastLocationSource) and uses it for walking times, refreshing it on every new share, pin or "where are u rn?" answer, with usual spots as the fallback. Never show a saved location to another student or on a dashboard. STOP, "delete my data" and "forget my location" erase it.
- **Emergency words** match phrases ("there's a fire", "i'm hurt", "being followed"), not bare words. "that's fire" must not trigger it.
- **Redaction** on dashboards is a full-image blur for wallets, IDs and cards, with click to reveal.
- **Cut rules** in the spec are reminders, not hard cutoffs.

## Hard rules (code decides, never the model)

The gate, send lock and kill switch; welcome and STOP text; emergency replies; pickup codes; servings counts and claims; walking times; verification results and attempt limits; dangerous-item routing; what claimants see before verification; contact rules; posting bans; any office, committee or program name, contact detail, date or link.

## Voice

All lowercase, texts like a friend, short bubbles, at most one emoji per bubble and none in stressful moments. Troy says he's an AI up front. Fixed templates (welcome, STOP, emergency) live in code.

## Git

Commit after every step that works. Commit as John only. No AI co-author lines or "generated with" text anywhere.
