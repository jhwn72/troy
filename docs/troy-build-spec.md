# Troy build spec (for Claude Code)
Updated Nov 14, 2026, late evening (event day), to match what was built. `CLAUDE.md` records the decisions made during the build and wins where the two differ. `docs/flow-transcripts.md` shows what Troy says today. This is what to build. For why, read troy-idea-brief.md. For Troy's voice, see the voice guide: https://claude.ai/artifact/16HxjmEsRC73UmfAV6pFL4. Submission drafts (Devpost write-up, video outline, deck outline): https://claude.ai/artifact/QLtHA92XwCY7z2DV3wvM5o

Event rule: all code and design assets for the submission are created Nov 14 to 15. Build from scratch; don't copy code from earlier practice projects.

## Status at kickoff
- BlueBubbles Server is installed and running on John's Mac, signed in with John's Apple ID, local connection at BLUEBUBBLES_URL (usually http://localhost:1234), password in .env. The API was checked during setup. If a docs/bluebubbles-status.md file exists, read it for which features work.
- Test handle: John's second iPhone with a new prepaid eSIM number, signed out of John's Apple ID. Its number goes in ALLOWED_HANDLES.
- Private API: on and working (server 1.9.12, private API true, helper true). Check its status through the API at startup anyway, and use the fallbacks below if it's ever off.
- Feature test results (Nov 14, see docs/bluebubbles-status.md): receive text, receive photo (HEIC arrives converted to JPEG), send text, send image, typing indicators, tapbacks and send effects all work.
- Read receipts: work. John turned on "Send Read Receipts" globally in Messages, so markRead shows "Read" for anyone who texts Troy. The adapter must still never call markRead on a chat that isn't allowed. Turn this setting back off after the hackathon (see the revert checklist in guardrail 7).
- Edits: allowed again, behind a switch. The stock 1.9.12 helper crashed Messages on edits; the patched helper in `bluebubbles/` fixes it. `editMessage` only calls the endpoint when `BLUEBUBBLES_EDITS=true` and returns false otherwise or on failure, so every caller keeps a fallback (Flow 2 sends a new short text: "last one", "all gone").
- Group chat creation: not tested yet (endpoint POST /api/v1/chat/new with addresses, message, method 'private-api'). Test with a friend's phone; if it fails, handoffs use relay mode.
- Polls: native iMessage polls work through the patched helper when it is connected (`sendPoll` returns mode `native`, and votes arrive as `pollVote`). When the helper isn't connected the fallback is "tap to pick": each option is its own short bubble and the student tapbacks (❤️ or 👍) the one they want; Troy reads the tapback and confirms. A numbered list ("reply 1, 2 or 3") is the last fallback, for providers without tapbacks.
- Handles can be emails. The test phone's chat came in as an Apple ID email (test-phone@example.com), not its phone number. ALLOWED_HANDLES and the allow-list must accept both phone numbers (+1XXXXXXXXXX) and emails, normalized (lowercase emails, E.164 numbers).

## What Troy is
An iMessage agent that connects USC students to the right person, office or item. Students text Troy; Troy matches, verifies, connects, then steps back. Four flows: lost and found (the hero), free food and items, broken things, and "who do I talk to" for student government. LAX rides are a stretch flow. Staff use a web dashboard. Students never need the website.

## Stack
- Node + TypeScript, one server (Express or Hono).
- SQLite (one file, zero setup).
- Claude API (@anthropic-ai/sdk): claude-sonnet-5-5 for photos, matching and verification; claude-haiku-5-5 for intent detection and casual replies. Always ask for JSON when code needs to read the answer. Set max_tokens to at least 2048 for photo calls (1024 cut off a long wallet reply in testing).
- Resend for USC email verification codes. Sending domain troy.johncwang.me is verified and delivers, but new-domain emails land in spam; add DMARC and keep the email body plain and specific.
- Messaging: BlueBubbles on John's Mac (main). Local web chat for development. Linq only if Linq support opens up the sandbox.
- Hosting: run the Troy server on the same Mac as BlueBubbles (keeps personal messages off any outside host). Public pages go on Vercel. The landing page is static and deploys as is. A public browser demo on Vercel needs a hosted database, because serverless functions don't keep files or memory between requests.
- Secrets only in environment variables: ANTHROPIC_API_KEY, BLUEBUBBLES_URL, BLUEBUBBLES_PASSWORD, ALLOWED_HANDLES, LINQ_API_KEY, RESEND_API_KEY, DATABASE_URL, APP_URL, TROY_ENABLED, BLUEBUBBLES_EDITS. Never commit keys and never print them.

## Messaging plan
**Main: BlueBubbles on John's Mac, using John's personal Apple ID and phone number.**
Creating a separate Apple ID for Troy was blocked by Apple. So Troy sends and receives from John's real number, and the BlueBubbles server can see every iMessage John gets. The guardrails below are mandatory and must be enforced in code, before anything reaches Claude or gets a reply.

**Privacy guardrails (build these first, before any flow):**
1. **Ignore John's own messages.** Drop every event where the message is from John (isFromMe or the BlueBubbles equivalent) before anything else. Troy must never react to texts John sends from his phone or Mac, and must never loop on his own replies. Exception: messages Troy itself sent are tracked by their message IDs for edits and tapbacks, but never processed as input.
2. **Allow-list gate.** Every remaining incoming event is checked against an allow-list. A chat is allowed only if:
   - its first message in the conversation (after Troy went live) starts with the opt-in phrase "hey troy" (the landing page button prefills this), or
   - its handle is on a manual list John controls (ALLOWED_HANDLES: his second phone, test phones, judges added during the demo; also editable from the dashboard), or
   - it's a group chat Troy created.
3. **Everything else is ignored completely.** No save, no read receipt, no typing indicator, no tapback, no reply, and the message text is never sent to Claude or logged. At most log "ignored event" with no handle and no text. This protects John's friends, family and NIGHTMARKET customers.
4. **Only chats that start after go-live.** Store the go-live time. Any chat with messages from before that time is never allowed through the "hey troy" rule, even if someone types "hey troy" later; it can only be added by hand.
5. **Sending is locked to allowed chats.** The adapter refuses to send, react, edit or mark read in any chat that isn't on the allow-list. This check lives in the adapter itself, so no bug elsewhere can bypass it.
6. **Kill switch.** TROY_ENABLED (env var and dashboard toggle) stops all sending and processing instantly.
7. **After the hackathon (revert checklist):**
   - Turn read receipts back off: Messages > Settings > iMessage > uncheck "Send Read Receipts" (on the Mac, and on John's iPhone if it was changed there).
   - Turn off the BlueBubbles server and remove its webhook.
   - Turn the Private API off in BlueBubbles, then re-enable SIP: Recovery Mode > Terminal > `csrutil enable` > restart.
   - Re-enable Library Validation: `sudo defaults delete /Library/Preferences/com.apple.security.libraryvalidation.plist DisableLibraryValidation`.
   - Stop `caffeinate` and restore normal sleep settings.
   - Delete stored test data and downloaded photos, and rotate the BlueBubbles password and API keys.

**Other facts:**
- Students reach Troy at John's number through an sms: link on the landing page and a QR code: `sms:+1JOHNSNUMBER&body=hey%20troy`. Troy sends his contact card (name "Troy" and the mascot photo) in the first reply.
- Students and judges will have John's personal number. John accepts this for the weekend.
- No contact cap and no daily message cap. Keep volume modest so Apple doesn't flag the account.
- The BlueBubbles server exposes a REST API and webhooks. Use its docs (docs.bluebubbles.app) for exact endpoints; build the bluebubbles adapter against them.
- Tapbacks, typing indicators, read receipts, message editing, send effects and probably new group chat creation need BlueBubbles' Private API (now on). Read receipts also depend on the Messages "Send Read Receipts" setting, which John turned on for everyone. If the Private API ever goes off, the adapter falls back: no tapbacks or typing, edits become new messages, effects are skipped, and handoffs use relay mode instead of group chats.
- Polls are native when the patched helper is connected, and tap to pick otherwise (see Status at kickoff).
- The Mac must stay plugged in, awake (`caffeinate -dimsu`) and online, with the lid open, the whole weekend.

**Fallback: Linq CLI line (facts confirmed by Linq support, Nov 13).**
- iMessage only; no RCS or SMS fallback.
- Up to 20 contacts. Each person must be added by phone number (`linq contacts add`) and text the line first; texts from anyone else are dropped silently. Apple ID emails are not accepted.
- Reactions, typing indicators and polls work. Typing indicators only show after some back and forth. Polls can't receive reactions through the API.
- Live location is NOT available on the CLI or sandbox line.
- Production pricing for the pitch: Pro is $260/month for 200 contacts; location sharing is $79/month extra.
- Pitch line: "Running on my Mac today to keep costs at zero. To launch, we'd move to Linq, the same iMessage infrastructure behind Poke: $260 a month for a 200-student pilot, plus $79 for live location."

## Location (updated Nov 14 evening)
Decision (John): Troy keeps each student's last known location so alerts and walking times are accurate. This replaces the earlier "used once, then not kept" rule.

What testing showed: on iOS 26 a location share in the chat arrives as one Find My message with a single location fix. BlueBubbles' Find My friends list stayed empty, so there are no continuous live updates. Stock BlueBubbles cannot send a location request; the adapter's `requestLocation` sends the Find My "Requested Location" bubble when the patched helper can and returns false when it can't, and Troy then just asks.

1. **Share in the chat (main).** During onboarding Troy asks the student to tap + > Location > Share in the chat. Troy reads the fix through the patched helper (`bluebubbles/scripts/helper-client.ts`, `decodeFindMyPayload`) and saves it on the user: lastLat, lastLng, lastLocationAt, lastLocationSource.
2. **Refresh.** Every new share or location pin replaces the saved fix. If BlueBubbles' Find My friends list starts returning the student, that fix is used and saved too.
3. **Just ask.** "where are u rn?" Troy matches the reply to the campus_places table and saves that as the fix (source "asked").
4. **Usual spots** from the profile are the fallback when there is no saved fix.

One function answers "where is this student" for every flow: `getUserLocation` in `src/location.ts` returns the saved fix first (marked stale when it is more than 3 hours old), then the first usual spot that resolves to a campus place, then nothing.

Rules:
- Walking times use the saved fix. When it is more than 3 hours old, Troy still uses it but words it as "from where u last shared", and may ask "still near [place]?" before a time-sensitive handoff.
- A saved location is never shown to another student. Other people only ever see a walking time or a meeting place both sides agreed to. Staff dashboards don't show it.
- "delete my data" and STOP erase the saved location. "forget my location" erases just the location.
- Only allowed chats ever have a location saved; the gate runs first, as for every other message.

## Architecture
**Messaging adapter (the most important design rule).** One interface, one file per provider. Nothing outside the adapter knows which provider is in use. The isFromMe filter, allow-list check and send lock live inside the adapter for BlueBubbles.
- Methods: sendMessage(chat, text or parts), sendImage, sendContactCard, markRead, startTyping, stopTyping, react(messageId, type), editMessage(messageId, text), sendPoll(chat, question, options), sendEffect(messageId or text, effect), createGroupChat(members, firstMessage), requestLocation(chat). Optional onAllowed(chat) and onDisallowed(chat) let a provider register a chat right after opt-in and drop it on STOP or "delete my data".
- Providers: webchat (build first for fast testing), bluebubbles (main), linq (fallback). Any method a provider can't do falls back gracefully (a poll becomes tap to pick, then a numbered text list; an edit becomes a new message; an effect is skipped; a group chat becomes relay; a location request becomes a plain question).
- One webhook route per provider converts incoming events into one internal shape: { userHandle (phone or email), chatId, messageId, text, images[], location?, reaction?, pollVote? }. For BlueBubbles, the isFromMe filter and allow-list gate run before this conversion.

**Message pipeline (in order, every incoming message that passed the gate):**
1. Save the message. Call markRead right away.
2. Code commands first, before any AI: STOP, HELP, "pause", "human", "delete my data", "forget my location", "settings". Emergency phrases ("there's a fire", "i'm hurt", "being followed") get a fixed reply with DPS emergency numbers instantly. They match phrases, not bare words, so "that's fire" doesn't trigger it. Emergency and crisis replies still go out after STOP, and self-harm messages get the fixed 988 reply.
3. Load the user, their open flow state and their personal notes and rules.
4. Start typing. If the reply will likely take more than about 3 seconds, send one quick acknowledgement first (see "Feeling fast").
5. Intent detection (Haiku, JSON): which flow, and what details were given.
6. The flow's handler runs its state machine and decides the next step.
7. Compose the reply: the model writes the tone; code inserts every exact value (pickup codes, counts, walking times, names of offices, verification results).
8. Send as short bubbles with typing between them: 1 to 2 seconds for a normal bubble, 3 to 4 for a longer one. Long replies are split into smaller chunks.

**One open question per person (`src/pending.ts`).** `flow_state` holds one open step per user. A question for someone who is in the middle of another one is parked in `pending_asks` and delivered, bubbles and step together, when they are free, so their next "yes" can't land on the wrong question. A protected question that another flow displaces is parked the same way and asked again afterwards.

**Outbox (`src/outbox.ts`).** Texts Troy starts from the dashboard (a report's status changed, a pickup was completed) are not dropped during quiet hours or pause. They wait in the `outbox` table and go out in order once the person can get alerts again. STOP drops them for good.

## Feeling fast (response UX)
- markRead the second a message arrives. "Read" must show before Troy starts typing.
- Typing indicator whenever Troy is working: 1 to 2 seconds for normal bubbles, 3 to 4 for longer ones.
- Photo calls took about 3 seconds in testing (up to about 10 seconds for long answers). If work will take longer than about 3 seconds, send exactly one acknowledgement: a tapback on the student's message (👍 for a plain request, 👀 for a photo or "help me find") or a short line ("gimme a sec", "lemme check that", "on it 👀").
- Rotate them so they don't repeat. Never more than one acknowledgement per incoming message, and none when the real reply is ready in under 2 seconds.
- Don't stack reactions. Troy reacts to at most one message per exchange.

## Personal notes and rules (per user)
Each user has a notes list Troy keeps from things they say about how they want Troy to behave.
- Example: a USG board member says "don't let people text me directly about usg stuff or add me to group chats." Troy saves the rule and replies: "got it. want me to relay their requests to u instead? they won't get ur number."
- Rules that affect contact or privacy are enforced in code, not left to the model: contactMode = direct | relay_only | no_contact, plus groupChatsAllowed = true | false. The matcher and the handoff step check these before anything is sent.
- Profile settings changed by asking Troy: alert distance ("only tell me about food within 5 min"), quiet hours ("don't text me after midnight").
- Softer preferences ("keep it short", "no emoji") are saved as text notes and added to the model's context.
- "what do u know about me" lists the notes. "forget that" removes one.
- Relay mode: Troy passes messages between two people without sharing numbers.

## Rule decisions (John, Nov 13)
- **Handoff: the finder chooses.** The finder holds the item, so they pick: hold it and meet the owner, or drop it at DPS. The owner gets whichever path the finder picked. For wallets and phones Troy can nudge ("dps is safest for wallets, but ur call") but doesn't force it.
- **Dangerous items always go to DPS.** Weapons or anything that looks dangerous: no student-to-student handoff, fixed reply ("that one goes to dps, please don't carry it around"), enforced in code from the vision category.
- **What people can see.** The finder can see everything (they're holding the item). Claimants and everyone else see nothing identifying (names on cards, engravings, card numbers, distinguishing details) until they pass verification, so a scammer can't read the answer. Dashboards and the demo panel blur card numbers and faces.
- **Contact sharing.** Group chats share phone numbers or emails. Before adding anyone, Troy says so and gets a yes: "i'll add u both to a group chat. heads up, that shares ur contact info. ok?" Relay-only users never get added.
- **Free food posting.** Any verified student can post. Staff can ban a user from posting (bannedFromPosting), for spam or fake drops. Students can report a drop ("this was fake").
- **Alert distance.** Default 15-minute walk. Changeable per student through their profile notes.
- **Claim hold time.** The poster decides ("hold each one for 10 min"). Default 15 minutes if they don't say.
- **Quiet hours.** Off by default. A student can ask Troy or set them on the student page. Lost and found texts to the other person in a claim (the question for the finder, the match for the owner, the contact warning, the pickup code) ignore quiet hours: they are answers on that person's own report or found item, and a dropped one would leave a step open on words nobody saw.
- **USG concerns.** The student chooses: send with their name or anonymously. Troy asks once per concern.
- **Out-of-scope questions.** Troy gives an honest best guess, says to confirm, and adds a link: "i'm not sure, my guess is [x], but i'd double check" / "here's the link to my best guess: [link]". Links must come from the directory or a real source; never invent a URL. Keep it to one or two bubbles so Troy doesn't turn into a general chatbot. If there's a real person, office or program to connect to, offer that too.
- **Failed verification when the finder still has the item.** See Flow 1, step 6. The finder stays in control: proof photo, the finder's own call, DPS, or keep it listed.

## Data model
- allow_list: id, handle or chatId, reason (opt_in_phrase | manual | troy_group), addedAt.
- users: id, handle (phone or email), name, uscEmail, verifiedAt, contactMode, groupChatsAllowed, subscriptions (json), usualSpots (json), lastLat, lastLng, lastLocationAt, lastLocationSource (find_my | pin | asked), alertMinutes (default 15), quietHours (default null), bannedFromPosting (bool), createdAt.
- user_notes: id, userId, kind (rule | preference), text, createdAt.
- messages: id, userId, chatId, direction (in | out), providerMessageId, text, media (json), createdAt. (Only allowed chats are ever stored.)
- listings: id, userId, type (found | lost | ride), category, title, details (json from vision or text; for rides: destination and departure window), photoUrl, locationText, lat, lng, happenedAt, status (open | matched | verifying | verified | handed_off | returned | expired), isValuable, isDangerous, heldBy (finder | dps), createdAt.
- matches: id, foundListingId, lostListingId, confidence, reasons (json), status (proposed | clarifying | finder_check | verifying | proof_requested | finder_deciding | verified | rejected), parked (the claimant backed out or timed out; not offered again until they report again), touchedAt (last movement, used to release silent claims).
- verifications: id, matchId, method (blind_description | name_match | finder_confirm | proof_photo | finder_judgment), ownerAnswer, score, result, attempts.
- handoffs: id, matchId, chosenBy (finder), method (group_chat | relay | dps_code), pickupCode, completedAt, thankYouNote.
- food_drops: id, posterUserId, clubName, description, photoUrl, locationText, lat, lng, servingsTotal, servingsLeft, holdMinutes (default 15), alertMessageIds (json), status (live | ended | removed), reports (int), expiresAt, createdAt.
- claims: id, foodDropId, userId, status (held | picked_up | released), heldUntil.
- reports: id, userId, kind (repair | usg_concern), anonymous (bool), category, description, photoUrl, locationText, routedTo (FMS | Housing | USG committee or program name), status (received | in_progress | on_agenda | fixed | acted_on | closed), duplicateOf, followers (json), createdAt.
- directory: id, kind (office | usg_committee | usg_program), name, topics (json), contactMethod, url, details (the stored text Troy sends, word for word), isExample (bool).
- pending_asks: a question (flow, step, data and its fixed bubbles) waiting for someone who is busy with another one. Deleted on delivery, STOP and "delete my data".
- outbox: dashboard texts held back by quiet hours or pause, sent in order when the person can get alerts again.
- campus_places: id, name, nicknames (json), lat, lng (for "just ask" location and walking times).

## Directory: USG programs (new, Nov 14)
From the USG president at the opening session: USG runs an LAX shuttle, a farmers market and thrift, and RSOs (student orgs) can apply for USG funding because it's funded by students. Add these as kind usg_program:
- USG LAX shuttle (topics: lax, airport, break travel)
- USG farmers market (topics: farmers market, produce, food)
- USG thrift (topics: thrift, free clothes, free stuff, secondhand)
- USG RSO funding (topics: club money, funding, budget, event funding)
Find the real details (dates, sign-up links, how to apply) on usg.usc.edu or official USC pages before adding them. Never invent a link, date or price.

Decision (John, Nov 14 evening): trust USG's own statements. Troy states plainly that these programs exist, without hedging. Dates, prices and links still only come from confirmed sources. The LAX shuttle and thrift rows have no confirmed page, so their url is empty and their text says USG runs the program and to ask USG for this year's dates ("usg runs a shuttle to lax around breaks. hit up usg for this year's dates and how to sign up."). They are not marked as example data, because a program row with isExample true gets "i'd check with usg" added. Sources for every row: `docs/usg-directory-sources.md`.

## Flow 1: Lost and found (the hero)
1. Finder texts a photo (and maybe a place). Sonnet reads the photo into a profile: category, brand, color, distinguishing details (stickers, engravings, cases), isValuable, isDangerous. Distinguishing details are hidden from claimants until verified.
2. Dangerous items go straight to DPS (fixed reply). Auto-redact card numbers and faces in any image shown on a dashboard.
3. Owner texts a loss ("lost my airpods near leavey yesterday"). Ask one question at a time until category, rough place and rough time are known.
4. Matching: code filters candidates (same category, reported within 7 days of each other, location roughly close). Sonnet ranks the top 5 to 10 and returns a confidence from 0 to 100 with reasons. Re-run matching whenever a new listing arrives (two-sided). Deterministic fallback if the AI call fails or is slow: rule-based scoring on category, color, brand, place and time.
5. What the match score does (no staff review queue). The AI score only puts candidates in order and shows on the dashboard. Nothing the owner is told depends on it: the earlier "80+ goes to verification, 50 to 79 gets one more question" wording is gone.
   - Whether Troy acts on a pair at all is decided by a public score built only from kind, color, brand, place and time. The finder's hidden details never move anything a claimant sees before they describe the item, so reporting again with different words tells a claimant nothing.
   - **Public score 50 or more:** the claim opens, with the same bubbles for everyone: "might have something" (or "something like what u lost just turned up" when the found item came in later) / "quick check first" / "describe it for me in ur own words...".
   - **Under 50:** stay open ("nothing yet, still looking").
6. Verification, blind description: before showing anything, the owner describes the item in their own words. Sonnet scores the description against the finder's hidden details; 70 or more passes. Every description that is scored counts as a try. Tries are counted per found item and person, across all of that person's reports, so backing out or reporting again resets nothing. Up to 2 tries. An ID or card with a full name on it is checked against the claimant's verified USC account instead, without asking anything. In testing, a correct owner description scored 90 and a wrong one scored 10.
   **When the AI check is down or slow (rule score only):** Troy never passes a claimant on the rule score alone. A description that would pass goes to the finder: Troy shows the finder the owner's own words (never the other way around) and asks "sound like what u found? yes or no". Yes verifies (method finder_confirm), no counts as a miss. A clear contradiction found by the rules (a different name, a wrong color, brand, size or count) is a miss without bothering the finder. An item already at DPS gets "can't confirm this one by text, dps can help u in person". The same finder check is used when there is nothing on file only the owner would know.
   **After 2 misses:**
   - **If the item is already at DPS:** "can't confirm this one by text, dps can help u in person." DPS staff decide at the counter, as they do today.
   - **If the finder still has it:** Troy tells the owner "couldn't confirm it from ur description" and offers one more way to prove it: "got an old photo of it, or a find my screenshot?" Troy compares the proof photo to the finder's photo (same-item check).
     - Proof matches: verified, go to handoff.
     - No proof, or it doesn't match: Troy asks the finder, showing them the owner's descriptions (never the other way around): "couldn't confirm this person. ur call: 1) meet them anyway, 2) drop it at dps, 3) keep holding it in case someone else claims it." The finder's choice wins. If the finder picks 1, Troy reminds them to meet somewhere busy.
   - Either way, the listing stays open for other claimants until the item is returned, and the failed claimant can't try the same item again.
   **Nothing stays locked.** A claimant who goes silent is released: after 1 hour when someone else is waiting on the item, after 24 hours otherwise. STOP and "delete my data" release at once. Every release looks for the next owner. "still looking" picks a released claim back up.
   **One question at a time.** A question for a finder who is already answering another one waits its turn (see "One open question per person"). Texts to the other person in a claim ignore quiet hours.
7. Handoff: the finder chooses hold-and-meet or DPS (see rule decisions). Meet: Troy warns that a group chat shares contact info, both say yes, createGroupChat (or relay if group chats aren't available), "handing you off", Troy steps back; relay-only users get relay. DPS: generate a pickup code in code and text it to both.
8. Close the loop: owner confirms they got it, Troy relays a thank-you to the finder, confetti effect on "that's a win. fight on 🎉".

## Flow 2: Free food and items
1. Any verified student (not banned from posting) texts a photo plus what and how many ("3 bowls of chipotle at leavey"). Troy counts from the photo and confirms: "looks like 3 bowls, right?" Ask for the spot and hold time only if missing (default hold 15 minutes).
2. Find opted-in students within each one's alert distance (default 15-minute walk) using the location fallbacks. No daily cap on these alerts. Quiet hours only for students who turned them on.
3. Alert, one idea per bubble: "yo [club] is giving away free chipotle at leavey, about 3 bowls left" / "it's about an 8 min walk from u" / "react if u want one". Walking time is computed in code. If tapbacks aren't available, use "reply 'me' if u want one".
4. A tapback (or reply) on the alert claims one serving for the poster's hold time. Troy sends a new text: "it's yours, grab it in the next [hold] min."
5. The count lives in the alert itself when edits are on (`BLUEBUBBLES_EDITS=true`): editMessage on every alert to "2 left", "last one", "all gone 😔". Edits are silent on purpose. When an edit can't be made (edits off, not supported, or it fails), Troy sends a new short text instead ("last one", "all gone").
6. Late reaction after it's gone: new text "all gone, sorry". Held claims not picked up release back to the pool.
7. Poster can text "6 left" or "we're out" anytime. "lmk if u want to talk to [club]" opens a double opt-in relay with the poster. Students can text "that was fake" to report a drop; staff see reports and can ban the poster.
8. Free clothes or secondhand items can also point to USG thrift from the directory.

Vision counting in testing: burgers exact, cookies within 2, steak pieces low confidence. Use clearly separated items in the demo photo, and always confirm the count with the poster.

## Flow 3: Broken things
1. Student texts a photo. Sonnet fills in category and location ("broken light, taper hall, 2nd floor hallway") and asks one question if the spot is unclear.
2. Route: campus buildings to FMS, dorms to Housing. Merge duplicates: if a matching open report exists, add the student as a follower instead of a new report.
3. Confirm with a new text: "reported to fms ✅ i'll text u when it moves."
4. Staff dashboard sets status. Every status change is a NEW text to every follower: "in progress 🔧", "fixed".
5. The link from the dashboard into FMS's or Housing's own systems is mocked and labeled as mocked.

## Flow 4: Who do I talk to (USG)
1. Student texts a concern or question ("why does village dining close so early", "how does my club get funding"). Haiku picks a topic (dining, safety, housing, academics, transportation, club funding, other).
2. If a USG program fits (RSO funding, LAX shuttle, thrift, farmers market), Troy points to it first with its confirmed details from the directory.
3. For concerns, Troy asks once: "want me to send it with ur name or anonymously?"
4. Route to the matching USG committee from the directory. Use roles, not real people's contact info, and mark committee entries as example data.
5. Respect the receiving member's contact rules: relay_only means Troy relays, no contact info and no group chats.
6. Confirm: "sent to usg's dining committee. i'll text u when they pick it up."
7. USG tab on the dashboard sets status: received, on the agenda, acted on. Each change is a new text to the student and any followers. Similar concerns merge like repairs.
8. Bonus if time: send a USG question as a poll (or numbered list) to opted-in students and show results on the dashboard.

## Stretch flow: LAX rides
Only if flows 1 to 4 work.
1. Student texts "find me people tryna go to lax first day of break". Haiku pulls destination and departure window; ask one question if the time is missing.
2. First, point to USG's LAX shuttle from the directory if its dates fit.
3. Fallback: save as a listing of type ride. Code matches other open ride listings with the same destination and departures within about an hour.
4. Troy: "found 2 trojans leaving around 2pm. want me to start a gc? heads up, it shares ur contact info." Everyone must say yes, then createGroupChat (or relay). Troy steps back; the rideshare app does the ride.

## Onboarding
1. Student texts "hey troy" (usually by tapping the landing page button). That phrase adds them to the allow-list. Welcome (fixed template from code, John's words): "hey i'm troy" / "i'm an ai, but i know a guy for everything" / "send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'" / "reply STOP anytime and i'll leave u alone until u want to talk again". Then "save my contact if u haven't so u know it's me" and Troy's contact card, which carries the mascot photo.
2. "quick thing, gotta make sure ur a trojan. what's ur usc email" then send a 6-digit code with Resend; they text it back. Troy adds: "might be in spam since i'm new 👀". Hackathon judges can skip this step: the skip is a poll ("usc student" / "hackathon judge"), not a typed reply, and the line above it asks non-judges kindly not to press it. It sets verifiedVia = 'judge_skip' and says it's for this demo only.
3. Subscriptions: a native iMessage poll when the helper is connected, otherwise tap to pick (a numbered list as the last fallback): free food, free stuff, events, help others with classes.
4. Location: ask them to share location in the chat (+ > Location > Share), or let them tell Troy their usual spots. Troy says plainly that he keeps the last location they share so alerts are accurate, and that "forget my location" erases it.

## Texting budget
- Instant, uncapped: time-sensitive alerts within each student's alert distance, and every reply to the student's own request.
- Capped: requests to help others (2 a week per person).
- Quiet hours off by default; respected when a student sets them. After several ignored alerts, send fewer and ask once "want fewer of these?"

## Web pages
- Staff dashboard with tabs: DPS (items in custody, 90-day hold, pickup code check), FMS and Housing (reports, status buttons), USG (concerns by committee, status buttons, poll results), Moderation (reported food drops, ban from posting), Settings (TROY_ENABLED kill switch, manual allow-list).
- Under-the-hood panel (demo only): live listings, candidate matches with confidence and reasons, verification scores, food drop counts updating, eval score. Blur card numbers and faces.
- Landing page with the "He knows a guy." headline, a "Text Troy" button using an sms: link to Troy's number with "hey troy" prefilled, and a QR code for the same link. Hosted on Vercel as a static page.
- Public browser demo: 25 messages per visitor and 100 for judges (honor system). At the limit Troy says it's a hackathon demo and offers to ask John for more; each visitor can send one such request.
- Optional student page: reports, settings (alert distance, quiet hours, subscriptions), privacy. Never pushed in chat.
- Design: paper #FAF7F2 background, ink #1C1917 text, stone #78716C, line #E7E2DA, cardinal #990000 buttons, gold #FFCC00 tiny highlights, laurel #4D7C5B success, amber #B7791F pending. Instrument Serif headlines, Inter for UI. Big soft corners, pill buttons.

## Seed data and eval
- Seed 20 to 30 example listings, 2 food drops, 5 repair reports, 4 USG concerns, the USG programs and a campus_places table, labeled as examples.
- Vision test results (Nov 13, 13 real photos, Sonnet): item profiles 13/13, same-item 3/3, ownership 2/2, counting 3/3 on scored photos, details 14/14, about 3 seconds per call. Rerun at the event so submitted numbers come from the real build.
- Eval script: run 20 to 50 written test pairs (found vs lost, with the right answer, including look-alikes and fraud attempts) through the matcher and verifier. Print correct, wrong and wrong handoffs. Without the model (fallback mode) a passing description is never a handoff: it is a third outcome, "sent to the finder", shown in its own column and in the final line ("37 of 40 correct, 3 wrong, 0 wrong handoffs, 14 sent to the finder (fallback mode)"). Show the score on the dashboard and the under-the-hood panel.

## Build order (Saturday, in this order)
Commit after every step that works. Don't start the next step until the current one meets its "done when."

1. **Privacy gate.** BlueBubbles adapter with the isFromMe filter, allow-list gate, send lock and kill switch.
   Done when: "hey troy" from the second phone gets a reply, and a text from any other chat gets no reply, no read receipt and never appears in logs. John's own outgoing texts are ignored.
2. **Core.** Server, webchat adapter, message pipeline with code commands (STOP, HELP, emergency), onboarding with USC email verification (the code can log to the console at first).
   Done when: a new number can text "hey troy", get verified and land in the database.
3. **Flow 1 end to end.** Photo profile, lost reports, two-sided matching with the deterministic fallback, blind verification, both handoff options, thank-you close.
   Done when: a photo from one phone and a loss report from the other produce a match, a verification and a handoff.
4. **Proof layer.** Under-the-hood panel, seed data, eval script. Then John records a backup video of Flow 1.
   Done when: the panel shows a live match with confidence and verification scores, and the eval prints a score.
5. **Flow 2.** Food posts, nearby alerts, tapback claims, live count.
   Done when: two users get the alert, one claims, the count changes, a late claim gets "all gone".
6. **Flows 3 and 4 plus the staff dashboard (thin, one clean path each).** Include the USG programs directory.
   Done when: a dashboard status click texts the student, and "how does my club get funding" points to USG funding.
7. **Polish (at home after 10 PM).** Landing page, mascot, UX fixes, bug fixes. Feature freeze about 1 AM.

**In parallel (subagents, each owns its own files), during steps 3 and 4:** landing page, staff dashboard UI, seed data and campus_places, eval cases and script, USG program research for the directory.

**Cut rules:** behind at 4:30 PM, keep the panel minimal and record the video. Behind at 8 PM, Flows 3 and 4 become a slide. Never cut the privacy gate, Flow 1 or the backup video. LAX rides only if everything else works.

## Final step (Sunday morning, submit by 10:30 AM)
Do a final pass on the Devpost write-up in the submission drafts doc (https://claude.ai/artifact/QLtHA92XwCY7z2DV3wvM5o). Update:
- every [bracketed] placeholder (messaging provider, database, framework, built-with list)
- the eval result (X of N correct, wrong handoffs)
- "Challenges we faced" with what actually happened
- remove any feature that didn't make it into the final build, and label anything mocked
- the video and deck so they match the write-up

## Verify with your provider (BlueBubbles)
isFromMe filter and allow-list gate block everything they should; incoming text and photo reach the webhook and the photo can be downloaded (works); sending text and images (works); contact card; read receipts (works); typing indicators (works); tapbacks sent (works) and received (and which message they're on); message editing (works with the patched helper, only when BLUEBUBBLES_EDITS=true); send effects (works); polls (native through the patched helper, tap-to-pick when it isn't connected); group chat creation with the second phone (may need Private API; otherwise relay); location pins; reliability after the Mac sleeps or the network drops.

## Hard rules (never let the model decide these)
The isFromMe filter, allow-list gate and send lock, the kill switch, welcome and STOP text, emergency replies, pickup codes, servings counts and claims, walking times, verification results and attempt limits, dangerous-item routing, what claimants can see before verification, contact rules (relay_only, no group chats, the contact-info warning before group chats), posting bans, and any office, committee or program name, contact detail, date or link.
