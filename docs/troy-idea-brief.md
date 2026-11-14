# Troy: idea brief (for Claude Code)
Updated Nov 14, 2026, late morning (event day). This is the "why." For what to build, read troy-build-spec.md. When the two disagree, the build spec wins.

## The event
- AI@USC Hackathon (HackSC, USC AI Committee, USC Student Government). Ginsburg Hall, USC. Nov 14 to 15, 2026.
- Prompt: "Build an AI-powered tool, prototype, or solution that makes campus life better for USC students or student organizations."
- Devpost submission due Sunday 11:00 AM. John submits by 10:30 AM. Building closes 10 PM Saturday; work continues at home. Feature freeze about 1 AM.
- Rule: all code, design assets and functional prototypes must be created Nov 14 to 15. Don't copy code from earlier practice projects.
- Judging: Impact & Campus Relevance 30%, Technical & AI Execution 25%, Feasibility & Implementation 25%, User Experience & Design 20%.
- USG plans to implement the strongest projects. Judges and speakers from AWS, Replit, Google, K1, Inspective.
- John competes solo and builds by directing Claude Code.

## What Troy is
Troy is an iMessage agent that connects Trojans. Snap a photo or send a text, and Troy gets you to the right person, office or item, then steps back. No app, no portal, no signup page.

- Tagline: "He knows a guy."
- Pitch lines: "USC already built the programs. Troy makes sure students find them." "He knows a guy. The guy is still DPS." "Every leftover tray gets eaten."
- Lost and found (FoundSC) is the hero flow. Other flows show that the same engine does more.

## Demo scope and priority
1. **Lost and found (hero, about 70% of the demo).** Photo in, vision profile, two-sided matching, blind-description verification, handoff (meet or DPS), thank-you close.
2. **Free food and items (cameo).** Photo in, nearby students alerted, tapback claims, live count by editing.
3. **Broken things (cameo).** Photo in, routed to FMS or Housing, status texts back when staff click the dashboard.
4. **Who do I talk to (USG) (short closing moment).** Concern in, routed to the right USG committee or program, status texts back.
- Stretch: LAX rides. Route to USG's LAX shuttle first; peer ride matching is the fallback.
- Out of scope: dating, general chatbot answers.

## Why this wins (keep these true in the build)
- Judges text it live on their own phones. Two real phones show two people meeting.
- The AI does visible work: vision profiles, ranked matches with confidence scores, verification scores, an eval score. Show it in the under-the-hood panel.
- Trust and safety: blind verification, dangerous items to DPS, contact info shared only after both say yes, privacy gate on John's number.
- Offices stay in charge. Troy is the front door; DPS, FMS, Housing and USG stay the back end.
- A deterministic fallback so the demo can't die.

## Biggest judge risks to avoid
- Looking like "another campus AI assistant." Keep Troy anchored on real objects, people and offices.
- Many half-working flows. Flow 1 must be flawless before anything else.
- Feasibility of running on a personal number. The pitch answer: move to Linq for launch ($260/month for a 200-student pilot).

## Speaker notes from the opening session (Nov 14)
- Geoff Garrett: students don't read emails. USC added 3 new AI-focused classes and nobody in the room knew. Problem hook: email doesn't reach students; a text does.
- Syrabi Nur Rahman (USG president): USG runs an LAX shuttle, a farmers market and thrift, and RSOs can get USG funding because it's funded by students. Add these to the routing directory. Find real details and links first; never invent them. Pitch line: "USG already runs the programs. Troy makes sure students find them."

## Research lines for the pitch
- Daily Trojan (May 2026): students said USC's challenge is "less about the availability of opportunities and more about awareness and accessibility."
- A senate aide called USG "very disconnected" from the student body (Feb 2026). Use carefully; USG may be judging.
- DPS reported four e-scooters stolen from bike racks in one evening (Feb 2025). Scooters are the top stolen item on campus.

## USC facts the build relies on
- DPS Lost & Found: 3667 McClintock Ave, 213-740-9759, lostandfound@dps.usc.edu, 90-day hold, no online system. Verification today is mostly the worker's judgment.
- Other desks with different rules: Leavey Circulation, Rec Sports (14-day hold then discard, no valuables), Village lobby desks, housing desks.
- UCLA has an online lost and found portal. USC doesn't.
- Food context: Tommy's Table (Student Basic Needs) already sends surplus food alerts to enrolled food-insecure students. Present Troy as a possible partner, not a replacement.

## Voice
All lowercase, texts like a friend, warm first and funny second, short bubbles. One USC touch per conversation at most ("fight on" after a win). At most one emoji per bubble, none in stressful moments. Catchphrases: "i know a guy", "on it 👀", "pretty sure i found them", "quick check first", "handing you off", "that's a win. fight on". Troy says he's an AI up front and never claims to be a person. Full voice guide: https://claude.ai/artifact/16HxjmEsRC73UmfAV6pFL4

## Design
Classical world, modern tool. Oil-painting backgrounds of real campus spots behind a clean UI. Palette: ink #1C1917, paper #FAF7F2, stone #78716C, line #E7E2DA, cardinal #990000 (primary action), gold #FFCC00 (mascot, tiny highlights), laurel green #4D7C5B (success), amber #B7791F (pending). Fonts: Instrument Serif headlines, Inter UI. Big soft corners, pill buttons, circles as the motif. No Trojan Horse image.

Mascot: a black circle with two white pill eyes wearing a detailed gold Trojan helmet with a cardinal crest. Emotion through eyes, motion and the helmet.

## Framing rules for any copy
- Use: connects, routes, hands off. Avoid: replace, consolidate, one app for everything.
- Name partners: DPS Lost & Found, FMS, USC Housing maintenance, USG.
- Label mocked integrations and example data as such.
