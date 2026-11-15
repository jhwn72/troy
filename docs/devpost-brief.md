# Addendum for the Devpost write-up

You already have the Troy pitch deck brief. Use it for the facts, the story, the numbers, the design decisions and what is real versus example versus mocked. This addendum adds what the Devpost write-up needs that the deck brief did not cover. Same rules: do not invent facts, numbers or features; mark anything uncertain `[John to confirm]`.

## What to write

A Devpost project page for the AI@USC Hackathon (Nov 14 to 15, 2026). Use Devpost's usual sections, in this order: Inspiration, What it does, How we built it, Challenges we ran into, Accomplishments that we're proud of, What we learned, What's next for Troy, Built with. Add a one-line tagline and a short "Try it" block at the top.

Voice: John's. First person singular ("I"), since he built it solo. Casual and direct, plain words, short paragraphs, no buzzwords, no em dashes. It should read like a founder explaining what he made, not marketing copy. Aim for something a judge can read in three minutes.

Judging weights to write toward: Impact and Campus Relevance 30%, Technical and AI Execution 25%, Feasibility and Implementation 25%, User Experience and Design 20%. Each section should earn points in at least one of these.

## Top of the page

- Name: Troy
- Tagline: He knows a guy.
- One line: Troy is an AI you text over iMessage that connects USC students to the right person, office or item, then steps back.
- Try it: the landing page is https://texttroy.vercel.app. It has the "Text Troy" button and a QR code. iMessage only for now.
- Repo: `[John to add the GitHub link once the repo is public]`
- Video: `[John to add]`

## Inspiration

Use the wallet story from the deck brief, in John's voice, unembellished. Then one or two lines on the bigger pattern he noticed: USC already has the programs and the people, but students find out by luck. Two details from the opening session support this: a speaker pointed out that students don't read email, and the USG president listed programs (an LAX shuttle, a farmers market, a thrift, funding for student orgs) that most of the room didn't know about.

## What it does

Lead with the one engine and five steps (Understand, Find, Verify, Connect, Follow up), then the flows from the deck brief. Keep each flow to two sentences. Make these points land:

- No app, no website, no sign-up. You text a number. Verification happens in the chat.
- A photo replaces the form.
- Location decides who hears about it: only people close enough to act get a text.
- Troy connects, then steps back. The offices stay in charge.
- He sounds like a person and keeps it short. Outside a small set of safety lines, nothing he says is scripted.

Mention the judge experience briefly: judges skip USC verification, get short behind-the-scenes notes after each step, and can ask Troy to play the other person's side since there are no other users yet.

## How we built it

Write this as how it actually happened.

- **Built by directing AI agents.** John built Troy solo by directing Claude Code. Work was split across parallel agents that each owned their own files, built against shared contracts written first. After each build, separate reviewer agents were assigned only to break it (one acting as a scammer, one hunting for conversations that get stuck, several attacking the privacy gate), and a fixer applied what they found, each fix with a test.
- **The stack.** Node and TypeScript running directly with no build step, SQLite, the Claude API (a stronger model for photos, matching and verification, a faster one for understanding messages), iMessage through BlueBubbles running on a Mac, Resend for USC email codes, a static landing page on Vercel.
- **Code owns the facts, the AI owns the wording.** Pickup codes, counts, walking times, verification results, office names and links come from code. The model decides how to say it, working from three plain-English files that describe who Troy is, what he knows about himself, and what his job is. Those files can be edited without touching code.
- **A provider-neutral messaging layer.** One interface, one file per provider, so the same engine runs in a browser simulator for testing and on real iMessage. Moving to a hosted iMessage line later is a new adapter, not a rewrite.
- **The landing page** tells "a day at USC": the painted campus goes from morning to night while five moments play out, with a gold thread connecting the sections.

## Challenges we ran into

These all happened. Pick the five or six that make the best story and keep each to two or three sentences.

1. **Apple wouldn't allow a separate Apple ID for Troy.** So he runs on John's personal number, which means the messaging tool can see every text John gets. The first thing built was a privacy gate: every message is checked against an allow-list before it is saved, read by the AI or answered, and everything else is ignored completely. Reviewer agents attacked it and found real holes (an existing contact could have opted in by typing "hey troy"; international numbers were being treated as US numbers), which were fixed before any real text went through.
2. **Editing a message crashed the Messages app.** The tool's helper was out of date for the current macOS. A newer helper was built from source and patched, which made edits work for live counts.
3. **iMessage polls and location sharing weren't supported.** They had to be worked out from how the messages are stored: polls and location shares arrive as app bubbles with a payload that needed decoding. Native polls and reading a shared location both work now.
4. **The fallback could hand an item to the wrong person.** The first rules-only verifier scored 28 of 40 with 7 wrong handoffs. It passed on one generic word like "case" and ignored contradictions. It was rebuilt to fail safe, and when the AI is unavailable the finder decides. Now: zero wrong handoffs with the AI and without it.
5. **A scammer could read Troy's tone.** A reviewer found that Troy's first reply changed with how good the match was, so someone could report, cancel and re-report to learn hidden details. Every claim now opens the same way and every scored description counts as a try.
6. **He sounded like a help menu.** Early on, anything off-topic got the same list of features. A red-team run of 175 attempts to break him was turned into ten principles, and the scripted replies were replaced with a brief he reasons from. A critic agent then cut the rules that would have made him stiff.
7. **Live testing kept finding what the tests didn't.** On John's own phone Troy went silent after a location share, treated "ok" as the end of a conversation, and once filed a noise complaint with the facilities office without asking. Each became a rule: never go silent, never end on a dead end with a new person, never file anything without a yes.
8. **Only two of four USG programs could be confirmed from official pages.** Troy states the others exist and says to ask USG for dates, because he is not allowed to invent a link, date or price.

## Accomplishments that we're proud of

- Zero wrong handoffs on 40 test cases, including look-alike items and fraud attempts.
- Over 1,000 automated tests (1,074 at the last count), and a rehearsal test of the exact demo that runs on every build.
- A privacy gate that held through every live test on a personal phone number.
- It works on a real iPhone today: text the number and Troy answers.
- Troy has a voice. He is brief on purpose, and people testing him kept talking to him.
- One engine that already runs six kinds of connection.

`[Numbers refreshed Nov 15 morning: 1,074 tests, 40 eval cases]`

## What we learned

- Splitting work across agents only works if the shared contracts are written first. The bottleneck was never code; it was testing on a real phone.
- Tests pass long before a conversation feels right. The biggest improvements came from John texting Troy himself.
- For anything involving trust, lock the facts and free the wording. The opposite, scripting everything, made him feel like a bot.
- A review agent whose only job is to attack finds things a builder won't.
- Students don't need another app. The hard part of campus services is reaching people, and a text does that.

## What's next for Troy

- A pilot with USG and one office. DPS Lost and Found is the natural first partner. `[John to confirm the ask]`
- Real connections into office systems, replacing the mocked link.
- A hosted iMessage line, or dedicated Mac minis for a pilot (cost comparison is in the deck brief).
- More connections on the same engine: pickup games, class help from students who aced it, ticket and textbook swaps, study groups.
- Voice messages, and non-Apple devices.

## Built with

List as tags: Claude (Anthropic API), Claude Code, TypeScript, Node.js, SQLite, Hono, BlueBubbles, iMessage, Resend, Vercel, Higgsfield (campus paintings and chat photos), HTML, CSS, JavaScript.

## Honesty checks before publishing

- Nothing claims USC, DPS, FMS, Housing or USG has approved or adopted Troy. Nobody at USC has been told yet. It is a student prototype John hopes USC will pick up.
- The link into FMS and Housing work order systems is described as mocked.
- Ride matches, the USG member and the technician are described as example mode until real people are on it.
- No user counts, testimonials or usage statistics. There are no real users yet.
- Every `[John to confirm]` item is collected in a short list at the end.
