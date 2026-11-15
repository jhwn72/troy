# Troy

**He knows a guy.** Troy is an AI you text over iMessage that connects USC students to the right person, office or item, then steps back.

Built for the AI@USC Hackathon, November 14 to 15, 2026. Try it at [texttroy.vercel.app](https://texttroy.vercel.app). On iMessage, text "hey troy". Without an iPhone, use the web simulator on the same site.

## What it does

One engine, five steps: understand the text or photo, find the right person, verify, connect, follow up.

- **Lost and found.** A finder sends a photo. An owner texts that they lost something. Troy matches them, asks the owner to describe the item without showing them anything first, lets the finder choose how to hand it back (meet up or drop it at DPS), and only shares contact info once both say yes.
- **Free food.** A club with leftovers posts a photo. Only students close enough to walk over get a text, and the count goes down live as people claim.
- **Something broken.** A photo of a broken door or a leaking fountain goes to the right office, and Troy texts the student when the status changes.
- **Concerns for student government.** Troy groups similar complaints and passes them to the right USG committee, anonymously if the student wants.
- **Rides and topics.** Students heading to LAX, pickup games, extra tickets and more, matched by time and place.

No app, no sign-up form. Students verify with a USC email code inside the chat.

## How it is built

- **Node 24 running TypeScript directly**, no build step. Hono for the web server, the built-in `node:sqlite` for storage.
- **Claude** through the Anthropic API. A stronger model reads photos, matches and verifies; a faster one handles chat. All Claude calls live in `src/ai.ts`.
- **iMessage through BlueBubbles** on a Mac, behind one messaging interface (`src/adapters/`) so the same engine runs in a browser simulator and on real iMessage.
- **Code owns the facts, the model owns the wording.** Pickup codes, counts, walking times, verification results and every office name or link come from code. Troy's voice comes from three plain-English files in `brain/`.
- **A privacy gate** (`src/adapters/gate.ts`) decides before anything else whether a chat is allowed. Troy runs on a personal number, so every other conversation is ignored completely: never saved, read, answered or sent to the model.
- **A static site on Vercel** (`public/`, built into `vercel-landing/` by `scripts/build-landing.ts`), including the web simulator, which gets real replies from one small function and stores nothing.

## Running it

```bash
npm install
cp .env.example .env    # then fill in the values you need
npm test                # node:test, about 1,000 tests
npm run typecheck
MESSAGING_PROVIDER=webchat PORT=3100 npm run dev
```

With `MESSAGING_PROVIDER=webchat`, open `http://localhost:3100/webchat` to talk to Troy from several simulated phones. The staff dashboard is at `/dashboard.html` and the "under the hood" panel at `/panel.html`.

`npm run sim` runs the public web simulator locally. `node scripts/eval.ts` runs the lost and found matching eval.

## Layout

| Path | What it is |
|---|---|
| `src/types.ts` | Shared contracts. Start here. |
| `src/pipeline.ts` | Every message goes through this. |
| `src/flows/` | One handler per flow. Lost and found is in `src/flows/lostfound/`. |
| `src/adapters/` | Messaging providers and the privacy gate. |
| `brain/` | Troy's persona, what he knows about himself, and his playbook. |
| `docs/` | The build spec, design decisions and flow transcripts. |
| `simulator/` | The web simulator's serverless function. |
| `tests/` | Tests, including a rehearsal of the full two-phone demo. |

## Status

A student prototype. It has not been adopted by or shared with USC, DPS, Facilities, Housing or USG. The links into office work-order systems are mocked, and ride matches, USG members and technicians run as labeled examples until real people are on it.

Built by John Wang.
