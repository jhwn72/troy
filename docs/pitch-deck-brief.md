# Brief: build the Troy pitch deck

You are making a pitch deck for a hackathon project called Troy. Everything you need is in this brief and the attached reference images. Build the deck in the same design language as Troy's landing page (described in section 8, shown in the attachments). Do not invent facts, numbers, quotes or features. If something you want to say isn't in this brief, leave it out or mark it `[John to confirm]`.

## 1. The event

- AI@USC Hackathon (HackSC, USC AI Committee, USC Student Government). Ginsburg Hall, USC, Nov 14 to 15, 2026.
- Prompt: "Build an AI-powered tool, prototype, or solution that makes campus life better for USC students or student organizations."
- Judging: Impact and Campus Relevance 30%, Technical and AI Execution 25%, Feasibility and Implementation 25%, User Experience and Design 20%.
- USG plans to implement the strongest projects. Judges and speakers come from AWS, Replit, Google, K1 and Inspective.
- Presenter: John Wang, solo. USC Marshall, Business Administration.
- Pitch length: `[John to fill in: minutes and whether there is Q&A]`. Until then, design for a 3 minute talk with a live demo in the middle, and keep extra material in an appendix.

## 2. Troy in one breath

Troy is an AI that USC students text over iMessage. Send a photo or a message and he connects you to the right person, office or item, then steps back. No app, no website, no sign-up.

- Tagline: **He knows a guy.**
- Contrast line: "ChatGPT gives you information. Troy gets you connected."
- Other lines that are approved: "The person you need is probably five minutes away. Neither of you knows it." / "USC already built the programs. Troy makes sure students find them." / "Troy is the front door. The offices stay in charge." / "If two Trojans need each other, Troy can find them."

## 3. Why it exists (true story, John's own)

John built Troy because of one terrible day. The cherry on top was losing his wallet. He retraced every step, asked every staff member and student nearby, and checked lost and found. Nothing. Three weeks later someone bumped into him, recognized his face, and handed it back. He kept thinking about how much sooner and more easily he could have found that person. The first version of Troy was that: you find something, you text a photo, and the owner gets connected to you right away, safely. Then he saw the same engine could handle a lot more.

Use this as the opening. Keep it short and in John's voice. Do not embellish it.

## 4. The problem

- Campus runs on shouting: group chats, story posts and mass emails nobody reads. You post and hope the right person sees it.
- From the opening session: a speaker noted that students don't read email; USC added three new AI-focused classes and nobody in the room knew.
- Daily Trojan (May 2026): students said USC's challenge is "less about the availability of opportunities and more about awareness and accessibility."
- DPS Lost and Found has no online system; other desks (Leavey, Rec Sports, housing) each have different rules. UCLA has an online lost and found portal; USC doesn't.
- The USG president said at the opening that USG runs an LAX shuttle, a farmers market and a thrift, and funds student orgs. Most students don't know.

Four pairs that show the gap (from the landing page):
- You need a ride to LAX / Three people in your building do too
- You found someone's AirPods / The owner is in the next building
- A club has 40 extra burritos / 40 hungry students are a block away
- Your door won't lock / A technician is five minutes away

## 5. What Troy does

One engine, five steps: **Understand** (reads your text or photo), **Find** (the right person or office, by need, time and distance), **Check** (makes sure it's a real match), **Connect** (group chat, alert or routing), **Follow up** (texts you when something changes).

The flows built this weekend:

| Flow | What happens | Connects you to |
| --- | --- | --- |
| Lost and found (the hero) | Finder texts a photo. Owner texts what they lost. Troy matches them, the owner describes the item before seeing anything, the finder chooses to meet or drop it at DPS. | The student who found it |
| Free food and stuff | A club texts a photo of leftovers. Troy counts it, texts students within a 15-minute walk, they claim with a tap, the count updates live. | Students close enough to get there |
| Broken things | Text a photo. Troy routes it to FMS or Housing and texts you when the status changes. | The office or technician who fixes it |
| Raise a concern (USG) | Text a complaint or question. Troy groups students with the same issue, routes it to the right USG committee, with your name or anonymously. | USG and students with the same issue |
| Topics | Students follow or create topics (pickup games, extra tickets, rides, experienced Trojans) and post to them; nearby followers get a text. | Whoever nearby wants the same thing |
| Rides | "Find me people going to LAX." Troy matches people leaving around the same time. | Trojans leaving when you are |

What a judge sees that a student doesn't (useful for the demo slide and Q&A):
- Judges skip USC email verification with a one-tap poll, clearly labeled as demo only.
- Troy tells them up front what's different for them: he types faster to save their time (a student sees a normal texting pace), and he texts casually because he's built for students. One tap switches him to plain, spelled-out English.
- After each step he adds one short aside in parentheses: either what the AI just did, with real numbers from that run, or the reason behind a design choice.
- Since there are no other users yet, when Troy finds nobody to connect a judge with he says so and offers to play the other person's side in real time ("show me"), with labeled example people.
- It ends with a wrap-up and John's contact: johnwang@usc.edu.
- For the hackathon Troy is tuned to keep the conversation going so judges see more of it. One setting dials that down for a real campus launch.

A day at USC (the landing page's story, good for one slide): 8:40 am lost AirPods, 12:15 pm the shuttle is late again, 5:30 pm a club has 20 extra bowls, 9:10 pm your door won't lock, 11:45 pm three of you are headed to LAX.

## 6. Honesty about what is real

The deck must not overclaim. Use these labels where they apply.

- **Real and working:** the iMessage agent on a real phone number; the privacy gate; onboarding with USC email verification; photo reading; matching and blind verification; free food alerts with claims; routing to a staff dashboard; personal notes and settings; free conversation in Troy's voice.
- **Example mode (says so in the product):** there are no other real users yet, so when Troy finds nobody to connect a judge with, he says it's a demo and offers to play the other person's side. Ride matches, the USG member and the technician use example people until real ones are assigned.
- **Mocked:** the link from Troy into FMS's and Housing's own work order systems. Reports land on Troy's staff dashboard.
- **Not done:** nobody at USC has been told or has approved anything. It is a hackathon project John hopes USC will adopt. Troy is not an official USC service.
- It runs on John's personal Mac and phone number for the weekend. That is a demo setup, not the launch plan.

## 7. Proof, numbers and decisions

Numbers from the build on Nov 14 (John will refresh them before submitting; keep them easy to edit):

- Evaluation on 40 written test cases, including look-alike items and fraud attempts: 36 of 40 correct with the AI, 37 of 40 on rules alone, and **zero wrong handoffs** in both. Every miss was a real owner who described their item too vaguely, and those fall through to a proof photo or the finder's call.
- Over 1,000 automated tests passing (1,061 at the last count).
- Separate AI reviewers were assigned only to break it: one acting as a scammer, one hunting for stuck conversations, one checking the privacy gate. Their findings were fixed with tests.
- A red-team run produced 175 attempts to break Troy's conversation, turned into ten principles and a test set.
- Reply speed: about one second for the AI call.

The decisions behind the design (pick the five or six that fit; each is one line plus its reason):

1. No app, no website, no sign-up. Students already check their texts all day.
2. Troy connects, then steps back. The offices stay in charge.
3. A photo replaces the form.
4. Location decides who hears about it, so alerts stay useful.
5. The finder chooses the handoff, because it's their time.
6. Troy texts first. Nobody chases an office.
7. He sounds like a person. Outside a short list of safety lines, nothing is scripted.
8. Short on purpose. A chatbot gives a wall of text; Troy answers in one to three short bubbles.
9. Prove it before you see it. The owner describes the item before seeing any detail.
10. Contact info is shared only after both people say yes.
11. Dangerous items always go to DPS.
12. A privacy gate in front of everything: every message is checked against an allow-list before it is saved, read by the AI or answered.
13. Code owns the facts, the AI owns the wording. Pickup codes, counts, walking times and office names come from code.
14. Two models, each for what it's good at: a stronger one for photos, matching and verification; a faster one for understanding messages.
15. It keeps working when the AI is down. When the AI can't score a claim, the finder decides.
16. One engine, five steps. A new use is a new connection, not a new product.
17. Tested like software, not a prompt.

Built with (for a small "how it's built" slide or the appendix): Claude (Anthropic API), iMessage through BlueBubbles on a Mac, Node and TypeScript, SQLite, Resend for verification email, built by directing Claude Code. Campus paintings and chat photos were generated during the event.

Feasibility and cost:
- Today: runs on John's Mac, so the texting line costs nothing.
- To launch: move to a hosted iMessage line (Linq, the infrastructure behind Poke). $260 a month for a 200-student pilot, plus $79 a month for live location.
- AI usage: about 1 cent per conversation, estimated (see "Cost estimate" below). At 8 conversations per student per month that is roughly 10 cents per student, or about $20 a month for 200 students.
- Two ways to run the texting line for a 200-student pilot (details in "Cost estimate"):
  - Hosted line (Linq): about $360 a month all in, roughly $1.80 per student per month.
  - Own hardware (two Mac minis running the same setup as the demo): about $1,600 in the first year including the machines, then about $400 a year. That is under 70 cents per student per month in year one and under 20 cents after.
  `[John to confirm before quoting: estimates from prompt sizes and list prices, not a measured bill]`
- Free for students.
- Partners, not replacements: DPS Lost and Found, FMS, USC Housing maintenance, USG. Student Basic Needs already runs Tommy's Table for surplus food; present Troy as a possible partner.

**Cost estimate (how the numbers were worked out)**

*AI cost per conversation.* The real version would run everyday chat on the faster model (Claude Haiku 5.5: $0.10 per million input tokens, $0.50 output; cached input is re-read at about a tenth of the input price). Photos, matching and the ownership check stay on the stronger model (Claude Sonnet 5.5: $2 input, $10 output), because that is where accuracy matters.

One student message on the faster model:
- Troy's standing instructions, about 11,000 tokens, re-read from the cache: about $0.0001.
- The new part of the message (recent chat plus looked-up facts), about 900 tokens: $0.0001.
- His reply, about 250 tokens: $0.0001.
- Working out what the message is asking for: $0.0002.
- Total: about a twentieth of a cent. The first message after a quiet spell re-caches the instructions and costs about a fifth of a cent.

One conversation of 6 messages: under half a cent. A conversation with a photo adds about 3 cents on the stronger model (reading the photo, ranking matches, checking the description). Assuming one conversation in four involves a photo, the average is about 1.2 cents.

Per month, assuming 8 conversations per student (about two a week): about 10 cents per student, about $20 for 200 students. Alerts Troy sends on his own use fixed wording and cost nothing in AI.

*The texting line, two options for 200 students.*

| | Hosted line (Linq) | Own hardware (Mac minis) |
| --- | --- | --- |
| Up front | $0 | 2 Mac minis at about $600 each = $1,200 (one runs it, one is a spare) |
| Monthly | $260 line + $79 live location | about $15 for a phone line, plus a few dollars of electricity; location comes free through Find My |
| AI | about $20 a month | about $20 a month |
| Year one | about $4,300 | about $1,600 |
| Each year after | about $4,300 | about $400 |
| Per student per month | about $1.80 | about 67 cents in year one, about 17 cents after |

Counting the Mac minis entirely in year one is the conservative way to show it. Spread over a three-year life they are $400 a year, which makes every year about $800, or 33 cents per student per month.

What the cheaper option costs in other ways (say this if asked):
- It relies on the same unofficial setup as the demo: a tool that drives the Messages app, with some of the Mac's built-in protections turned off. Apple does not support it and can break it with an update.
- One Apple account sending a lot of messages can be limited or blocked by Apple, with no one to call. A hosted line exists to carry that risk and volume.
- Someone has to keep the machines up, updated and physically secure, because they can read every conversation.
- It suits a pilot. A hosted line is the safer choice once it is campus-wide.

What would change the AI number: running everything on the stronger model raises it to about 6 to 9 cents per conversation (about $110 a month for 200 students); heavier use or more photos raises it roughly in proportion; the reasoning tokens in each reply are the least certain part.

What's next (from the landing page; no fake numbers): pickup games and study buddies nearby, class help from students who aced it, ticket and textbook swaps, closing the loop with offices on housing requests and deadlines, voice messages, and non-Apple devices (the landing page already tells Android visitors it's coming).

The ask: a pilot with USG and one office (DPS Lost and Found is the natural first), a hosted line, and 200 students. `[John to confirm the exact ask]`

## 8. Design language (match the landing page)

Attached: six screenshots of the landing page, the three campus paintings and the mascot. Treat them as the reference. Take colors, type and devices from them and from this section. Do not add your own stylistic picks.

**Palette (use only these)**
| Name | Hex | Use |
| --- | --- | --- |
| ink | #1C1917 | main text, dark panels |
| paper | #FAF7F2 | light slide background, cards |
| stone | #78716C | secondary text |
| line | #E7E2DA | borders, dividers |
| cardinal | #990000 | primary accents, one full-bleed slide at most |
| gold | #FFCC00 | the connecting line and tiny highlights only |
| laurel | #4D7C5B | success |
| amber | #B7791F | pending |
| iMessage blue | #0A84FF | the student's chat bubbles only |
| bubble gray | #E9E9EB | Troy's chat bubbles |

**Type**
- Headlines: Space Grotesk, medium weight, tight tracking, sentence case.
- Body: Inter.
- Troy's own lines are lowercase, like a friend texting, and appear only inside chat bubbles.

**Devices**
- **The gold thread.** A single gold line that wanders (curves, not straight) and connects things. It is the signature: use it to join two people, two phones, or one slide's idea to the next. One thread per slide at most.
- **Campus paintings as full-bleed backgrounds** for the title and closing slides: day for the opening, golden hour mid-deck if needed, night for the close. Text sits directly on the painting only on those slides, in ink on the day sky or paper on the night sky.
- **Four slide treatments**, so the deck doesn't feel like one white box repeated: a paper slide (default), a dark ink panel slide (for the engine or the technical proof), one cardinal slide (for "what's next" or the ask), and painting slides (open and close).
- **iMessage phones.** Show conversations as real iMessage: blue bubbles for the student, gray for Troy, typing dots, tapbacks, "Delivered". Two phones tilted slightly toward each other with the gold line between them is the hero image.
- **The map.** A simple drawn campus map in paper and line colors with gold dots lighting up inside a circle. Use it for the free food story or "location decides who hears about it".
- **Classical details, sparingly:** small laurel sprigs above a headline, Roman numerals for numbered steps (I to V for the engine), a thin Greek key border on the cardinal slide. Nothing else classical: no busts, no columns, no marble, no Trojan Horse.
- **Shapes:** big soft corners (24 to 32px), pill buttons, circles as the motif, 1px borders, soft low shadows.
- **The mascot.** Troy is a black circle with two white pill eyes under a gold Trojan helmet with a cardinal crest. Use the attached image as is. He can sit on a phone or perch at a slide corner. Do not redraw him.

**Never**
- No USC logos or the interlocking SC, no Trojan Horse.
- No gradients, no purple "AI" glow, no stock photos, no clip-art icons.
- No fake statistics, user counts or testimonials.
- No em dashes. No buzzwords ("revolutionary", "seamless", "AI-powered").
- Don't copy another startup's deck or site. The reference is Troy's own landing page.

## 9. Voice for slide copy

- Short, plain, friendly. One idea per slide. A headline of ten words or fewer and at most three short supporting lines.
- Use: connects, routes, hands off. Avoid: replace, consolidate, "one app for everything".
- Name the partners: DPS Lost and Found, FMS, USC Housing maintenance, USG.
- The deck depends on John talking, so slides carry the image and the line, not the script. Put what John says in speaker notes.

## 10. Suggested slide order

Adjust to the real time limit. For a 3 minute talk, slides 1 to 8 are the talk and the rest is appendix for Q&A.

1. **Title.** Day painting. "He knows a guy." Troy on a phone. John's name.
2. **The wallet.** The origin story in three short lines.
3. **The problem.** "The person you need is probably five minutes away. Neither of you knows it." The four pairs with broken dotted lines between them.
4. **Troy.** One line: text him, he connects you, he steps back. Two phones with the gold line joining them.
5. **Live demo.** A slide that just says to take out your phone, with the number and QR code. `[John to supply the QR image; the number is on the landing page]` Backup: screenshots of the lost and found conversation from both sides.
6. **One engine, five steps.** Ink panel, I to V. Under it: lost items, free food, repairs, concerns and rides all run on these steps.
7. **Why you can trust it.** Three decisions with proof: prove it before you see it (zero wrong handoffs on 40 cases), contact info only after both say yes, code owns the facts.
8. **The ask and what's next.** Cardinal slide. The pilot, the cost line, and "If two Trojans need each other, Troy can find them." Night painting to close if there's a ninth slide.

Appendix: built on purpose (the technical decisions), how it's built, what's real versus example versus mocked, cost and the path to launch, a day at USC, safety and privacy, what's next.

## 11. What to deliver

- A complete, presentable deck in this design language, 16:9.
- Speaker notes on every slide with what John says, in his voice: casual, direct, no jargon.
- Every `[John to confirm]` item collected in a short list at the end so he can fill them in fast.
