# Troy landing page: design reference

John's reference (Nov 14, 2026), saved word for word below the amendments. Build exactly this. Ask before adding anything not listed.

## Amendments (read first; these win over the text below)

1. **Assets.** The three paintings are already converted, all from 3840x1648 originals of identical size: `public/img/campus-day.webp`, `campus-golden.webp`, `campus-night.webp` (2560px wide, under 450 KB each) and `-1600.webp` versions for phones. Originals are in `design/paintings/` (not committed). Never edit the paintings; crop and tint in CSS only.
2. **Mascot.** Use `public/assets/troy-mascot.svg` and `public/assets/troy-avatar.svg` / `.png`. Do not redraw. New expressions (landing, blink, asleep, one eye open) are made by animating or lightly adjusting that SVG.
3. **Location copy must match the product.** John decided after writing this reference that Troy keeps each student's last shared location so alerts and walking times are accurate, and that "forget my location" erases it. So:
   - Safe by design card: **Your location stays yours.** "Troy keeps the last spot you share so walking times are right. It's never shown to another student, and 'forget my location' erases it."
   - FAQ: **Does Troy track my location?** "Only if you share it. He keeps the last spot you shared to work out walking distance, never shows it to anyone, and 'forget my location' erases it."
4. **Number.** The sms link uses the configured number (`TROY_NUMBER`, baked in at build time by `scripts/build-landing.ts`), never a placeholder.
5. **FAQ "Is this run by USC?"** "No. A student built it at a hackathon. It isn't an official USC service yet."
6. Everything else, including sections that show where Troy is going (a USG member's phone, a technician's phone, LAX rides), is built as written. John knows those go beyond the current build.

---

## The idea in one line
"A day at USC." As the visitor scrolls, the painted campus goes from morning to golden hour to night, while a phone in the middle plays real Troy conversations.

Inspiration: the scroll motion and simplicity of Ditto's landing page, and the classical-painting-behind-clean-UI look of Appthetics. Do not copy either site's art, layout or code.

## Assets (provided by John)
Put these in `public/img/`:
- `campus-day.png` (morning)
- `campus-golden.png` (golden hour)
- `campus-night.png` (night)
- Troy mascot: use the mascot already generated in this repo. Do not redraw or replace it. If an expression this page needs (landing, idle blink, asleep) doesn't exist yet, make it by animating or lightly adjusting the existing mascot, keeping its look.

Before using the paintings:
1. Check that all three have the exact same pixel size. If not, stop and tell John. A mismatch makes the fade jump.
2. Convert each to WebP at about 80% quality. Target under 500 KB each. Keep a 1600px-wide version for phones too.
3. Never edit the paintings themselves (no cropping files, no filters baked in). All cropping and tinting happens in CSS.

## Design rules

**Colors** (CSS variables, use only these)
| Name | Hex | Use |
|---|---|---|
| ink | #1C1917 | main text |
| paper | #FAF7F2 | page and card background |
| stone | #78716C | secondary text |
| line | #E7E2DA | borders, dividers |
| cardinal | #990000 | primary buttons, key actions |
| gold | #FFCC00 | mascot and tiny highlights only |
| laurel | #4D7C5B | success states |
| amber | #B7791F | pending states |
| imessage-blue | #0A84FF | the student's chat bubbles only |

Chat bubbles: the student's bubbles are iMessage blue with white text. Troy's bubbles are light gray (#E9E9EB) with ink text. That's how real iMessage looks.

**Fonts**
- Instrument Serif for headlines (Google Fonts).
- Inter for everything else.
- Headline sizes: hero 72 to 96px on desktop, 44 to 52px on phones. Section headlines 40 to 56px.
- Body 17 to 19px, line height 1.5.

**Shapes**
- Big soft corners: cards 24 to 32px radius.
- Pill buttons (fully rounded).
- Circles are the motif: Troy's face, small circular icons, round badges.
- Thin 1px borders in `line`. Soft, low shadows only.

**Voice for all page copy**
- Short, plain, friendly. Sentence case for headlines.
- Troy's own chat lines are lowercase, like a friend texting.
- One USC touch per section at most. A little emoji in chats only.
- No em dashes. No buzzwords ("revolutionary," "seamless," "AI-powered").

**Never**
- No Trojan Horse imagery.
- No USC logos, trademarks or the interlocking SC.
- No gradient washes, glowing purple AI look, or left-border accent cards.
- No fake stats or invented user counts. Use real numbers from the build or leave them out.
- No pixel art (Ditto uses it; we don't).

## Page structure (top to bottom)

**Content rule:** every use case shows Troy connecting a student to another person or office, using where people are, then following up. If ChatGPT could do it alone (a plain question and answer), it doesn't go on the page.

**Troy's three strengths. Every section should show at least one:**
1. **Location.** Troy knows who's nearby right now and only pings people close enough to act.
2. **Nothing to download.** No app, no website to log into, no sign-up form. You text a number. Verification happens inside the chat.
3. **It feels like texting a friend.** Real iMessage: typing dots, tapbacks, live-updating counts, group chats. Short lowercase replies.
Supporting strengths to show where they fit:
4. **Troy texts first.** He follows up on his own: "fixed ✅", "update from USG". You never chase anyone.
5. **A photo replaces the form.** Send a picture. Troy figures out what it is, counts it and routes it.

**Connection chip:** under each use case, one small pill naming who Troy connected the student to. Gold dot, ink text. Text for each is listed below.

**Two screens for every use case:** each use case shows two phones (or a phone and a map) side by side: the person asking and the person or people receiving. On phones (narrow screens), stack them vertically with a small "→" between. Build this as ONE reusable component that takes a scripted conversation (JSON: which phone, who's speaking, text, image, delay). Every section reuses it.

### 1. Hero (day painting)
- Full-width day painting fills the top of the screen.
- Headline: **He knows a guy.**
- Subline: "ChatGPT gives you information. Troy gets you connected."
- Button: **Text Troy** (cardinal pill). It's an `sms:` link: `sms:+1JOHNSNUMBER&body=hey%20troy`. Keep the number in one config value so John can change it.
- Small QR code next to the button on desktop (same link). Hide it on phones.
- Troy drops in and lands on top of a phone in the center.

**The hero phone is live, not a static picture.** It should look and behave like a real iPhone in Messages:
- iPhone frame, Messages header with Troy's round avatar and the name "Troy", the message area, and the text input bar at the bottom.
- The student's message types into the input bar letter by letter, then the send button is pressed and the blue bubble slides up.
- Troy's replies show the three-dot typing indicator first, then the gray bubble appears. Realistic gaps (0.6 to 1.5 seconds).
- Small iMessage details: "Delivered" under the last student message, then "Read", a 👍 tapback landing on a Troy bubble once, bubbles grouped with tails only on the last one.
- It cycles through four short scenarios, then loops. Between scenarios, the chat clears with a soft fade.
  1. student: "find me people tryna go to lax first day of break" / troy: "on it 👀" / troy: "3 trojans flying out of lax on the 19th around noon. want a group chat to split a ride?" / student: "yes pls" / troy: "done. say hi 👋"
  2. student: "lost my airpods near leavey 😭" / troy: "someone found airpods near leavey 20 min ago. what's on the case?" / student: "a trojan sticker" / troy: "that's them 🙌 want to meet the finder?"
  3. troy (Troy texts first): "free tacos at the village 🌮 5 min from u. 12 left. react 👍 to claim" / student: 👍 tapback / troy: "saved u one. it's at the table by trader joe's"
  4. student: "the late shuttle to the village is always late" / troy: "4 other trojans said the same thing this week. want me to loop in USG?" / student: "yeah" / troy: "done. i'll text u when they reply 📬"
- Pause the loop while the visitor hovers over or taps the phone. With reduced motion turned on, show scenario 1 fully, no animation.
- Readability: the clouds are busy. Put a soft dark gradient or light blur behind the headline so white text passes 4.5:1 contrast.

### 2. The problem
Headline: **"The person you need is probably five minutes away. Neither of you knows it."**
Body (two short sentences): Campus runs on shouting. Group chats, story posts and mass emails nobody reads. You post and hope the right person sees it.
Then four pairs of small cards. Each pair is two people a short walk apart who never meet. A dotted line runs between the two cards and never connects:
- "You need a ride to LAX." / "Three people in your building do too."
- "You found someone's AirPods." / "The owner is in the next building."
- "A club has 40 extra burritos." / "40 hungry students are a block away."
- "Your door won't lock." / "A technician is five minutes away."
Closing line: **"Troy finds the person and makes the intro."**
Animation: when the section scrolls into view, the dotted lines stay broken. When the visitor scrolls past, one line at a time completes into a solid gold line, as if Troy connected them.

### 3. Lost and found
Headline: "Lost something? He knows who found it."
Left phone: the finder. Right phone: the owner.
- Finder: sends a photo of AirPods. troy: "got it. where'd u find them?" finder: "leavey 2nd floor". troy: "thanks 🙏 i'll find the owner"
- Owner: "lost my airpods near leavey 😭" / troy: "on it 👀" / troy: "someone found airpods near leavey. quick check: what's on the case?" / owner: "a little trojan sticker" / troy: "that's them. meet the finder or pick up at DPS?" / owner: "meet"
- End: both phones switch to the same new group chat. troy: "handing u off. you two got it from here 🤝"
One short line under it: "Troy checks it's really yours before anyone shares anything."
Chip: "Connected you to: the student who found it"

### 4. Raise a concern (USG)
Headline: "Say it once. The right people hear it."
Subline: "Troy groups students with the same issue and brings them to the people who can fix it."
Left phone: a student. Right phone: a USG committee member.
- Student: "the late shuttle to the village is always late" / troy: "that goes to USG's transportation committee. send it with ur name or anonymously?" / student: "with my name"
- USG member's phone: troy: "5 trojans raised late village shuttles this week. 2 want to talk. want a group chat with them?" / USG member: "yes"
- End: a group chat on both phones with the USG member and the students who chose to share their name. troy: "meet Alex from USG transportation. she wants to hear what's going on 🙌"
- Small note under the phones: "Anonymous concerns still count. Troy shares the summary, never the name."
Chip: "Connected you to: USG and 4 students with the same issue"

### 5. Free food
Headline: "Free food finds the people closest to it."
Left phone: a club officer. Right side: **a map**, not a phone.
- Officer's phone: sends a photo of food trays. troy: "looks like 20 bowls, right?" officer: "yep, at leavey till 2" troy: "sending it to trojans nearby 🌯" Then the count in the officer's chat updates live: "20 left" → "14 left" → "6 left".
- The map: a simple drawn campus map in the page palette (paper ground, line-colored paths, soft building shapes). Do NOT use Google Maps, Apple Maps or real map tiles. A pin drops at the food spot. A soft circle spreads out to about a 15-minute walk. Small dots inside the circle light up gold one by one, each with a tiny chat bubble popping above it. Dots outside the circle stay gray and get nothing.
- Under the map, a small caption: "Only students within a 15-minute walk get the text. Everyone else is left alone."
- Use a placeholder club name. Don't name a real club.
Chip: "Connected you to: 20 trojans within a 15-minute walk"

### 6. Broken things
Headline: "Report it once. Hear back when it's fixed."
Left phone: the student. Right phone: an FMS technician.
- Student: sends a photo of a broken door. "the door to my building won't lock" / troy: "got it. letting facilities know now. i'll text u when it's fixed."
- Technician's phone: troy: "someone reported a door that won't lock at [building], about a 5 minute walk from u. can u take it?" / technician: "on it"
- Student's phone (new message): troy: "facilities is on it 🔧"
- Technician's phone: technician: sends a photo of the fixed door. "done"
- Student's phone (new message): troy: "fixed ✅ thanks for flagging it"
Between the phones, a small three-step line: Reported, On it, Fixed. Each step turns laurel green as its text appears.
Chip: "Connected you to: the closest technician"

The painting crossfades from day to golden hour across sections 3 to 6.

### 7. Why it feels different
Three columns, each a circle icon, a short title and one sentence. Keep it simple.
- **Knows who's nearby.** Troy only pings people close enough to act, so alerts stay useful instead of spammy.
- **Nothing to download.** No app, no account page, no forms. Text a number and you're in.
- **Feels like texting a friend.** Typing, reactions, live counts and group chats, all inside iMessage.

### 8. The engine behind every connection
Headline: "One engine behind every connection."
Five circles in a row joined by a thin line. Each has a title and one line. Visitors can tap each circle to see a tiny example; on desktop, the example shows on hover.
1. **Understand.** Reads your text or photo and figures out what you need. Example: a photo of trays becomes "20 bowls of chipotle".
2. **Find.** Looks for the right person or office by need, time and distance. Example: Trojans within a 15-minute walk.
3. **Check.** Makes sure it's a real match before anyone is connected. Example: the owner describes the case before seeing the photo.
4. **Connect.** Starts the group chat, sends the alert or routes it to the right office.
5. **Follow up.** Texts you when something changes, so you never have to chase anyone.
Under it, one line: "Rides, lost items, free food, repairs and student concerns all run on these same five steps. New uses are just new connections."

### 9. Safe by design
Headline: "Built to be safe from the first text."
Six small cards, circle icon each, one or two sentences each:
- **Only Trojans.** Every student verifies a USC email before Troy connects them to anyone.
- **Nothing shared without a yes.** Phone numbers and names are only shared when both sides agree.
- **Your location stays yours.** Troy uses it to work out walking distance, then doesn't keep it. You can share usual spots instead.
- **You choose how you show up.** Send concerns with your name or anonymously.
- **Checked before connected.** Lost items are verified before a handoff. Dangerous items go straight to DPS.
- **No spam, ever.** Only alerts close enough to matter, limits on everything else, and STOP works anytime. People who misuse it get removed.

### 10. What's next
Headline: "Same engine. Endless connections."
Group the ideas under Troy's strengths, as pill rows with a small label above each row. No fake numbers.
- **Nearby, right now:** pickup basketball at Lyon Center, study buddies in Leavey tonight, extra event tickets at the door, free furniture on move-out day
- **Two people who need each other:** class help from students who aced it, roommates, ride shares home, ticket swaps, thrift and textbook trades
- **Closing the loop with offices:** housing requests, new classes that fit you, financial aid deadlines, advising openings
- **A photo is enough:** sell or give away anything with one picture, report anything with one picture
End with one line: "If two Trojans need each other, Troy can find them."

### 11. FAQ
Accordion, six questions, answers one or two sentences:
- **Do I need an app?** No. Troy lives in iMessage. Text the number and you're in.
- **How does Troy know I'm a student?** He asks for your USC email in the chat and sends you a code.
- **Who sees my info?** Only people you say yes to. Troy never shares your number or name without both sides agreeing.
- **Does Troy track my location?** No. You share it once when it helps, and Troy only uses it to work out walking distance.
- **Will I get spammed?** No. You only get alerts close enough to matter, and you choose what you hear about. Text STOP anytime.
- **Is this run by USC?** No. A student built it.
Below the FAQ, a centered line and button:
- Line: "Any other questions?"
- Button: **"Just text Troy"** (cardinal pill). `sms:` link with the body prefilled: `hey troy, i have a question`.

### 12. Footer (night painting)
- Night painting fully visible.
- Troy asleep, curled on a chat bubble.
- Line: "Every connection on campus. Just text him."
- Repeat the **Text Troy** button.
- Animated (see Motion): Troy breathes, small "z" letters float up and fade, stars twinkle, and when the visitor hovers or taps the button, Troy opens one eye.

## Motion

**Where the paintings show**
- The three paintings sit in one fixed layer behind the whole page. The background stays put while content scrolls over it.
- **Hero and footer:** the painting is fully visible, with nothing covering it except the headline, button, phone and Troy.
- **Every section in between:** content sits on large rounded paper panels (#FAF7F2 at about 92 to 96% opacity, 32px radius, max width about 1200px, centered). Leave a strip of painting visible between panels (about 80 to 120px of space) and at the left and right edges on wide screens. Visitors should always see a little sky, so the day-to-night change is noticeable as they scroll.
- Never put body text, phones or cards straight on the painting outside the hero and footer.

**Day to night (most important)**
- Stack the three paintings in the fixed layer described above.
- Scroll position controls opacity: day at the top, golden hour around sections 3 to 6, night from section 9 to the footer.
- Use CSS opacity only. Smooth, no jumps.

**Phones**
- Each section's conversation plays when it scrolls into view (IntersectionObserver). Two-phone sections play in order across both phones, like one story.
- Same realism as the hero: typing dots before Troy bubbles, the student's text typing into the input bar, "Delivered" and "Read", tapbacks.
- Play once per page load. Add a small round "replay" button under each pair.

**Map (free food)**
- Pin drops, circle expands over about 1.5 seconds, then dots light up one by one with tiny bubbles. Outside dots stay gray.

**Problem section lines**
- Dotted lines complete into gold one at a time as the visitor scrolls.

**Troy**
- Hero: lands on the phone with a small bounce. Idle: slow bob and an occasional blink.
- Footer: asleep, slow breathing, floating "z"s, one eye opens on button hover or tap.

**Chips and steps**
- Each connection chip fades in after its conversation finishes.
- Repair steps turn laurel green in sync with their texts.

**Extras (only if everything above works first)**
1. Parallax: cut the campus out of the painting (rembg or similar) so sky and campus move at slightly different speeds.
2. Clouds drifting slowly.
3. Stars fading in near the night section.
4. Subtle paper grain overlay (CSS, very low opacity).

**Motion rules**
- Respect `prefers-reduced-motion`: no parallax, no bounce, conversations show fully without animation, paintings swap with simple fades, the hero shows one scenario.
- Keep it smooth on a phone. Animate only `opacity` and `transform`.
- No scroll-jacking. The page scrolls normally.

## Phone and desktop
- Same painting files for both. On phones, use `object-fit: cover` with `object-position` around 38% from the left so Bovard's tower stays in frame.
- On phones, stack everything in one column. Two-screen sections stack top to bottom with a small arrow between.
- Touch targets at least 44px.
- Test at 390px wide and 1440px wide.

## Accessibility
- Real `<a>` and `<button>` elements. Text Troy buttons are links.
- Paintings are decorative: empty `alt`. Mascot: `alt="Troy"` in the hero, decorative elsewhere.
- Each conversation has a plain-text version for screen readers.
- The map has a text description ("20 students within a 15-minute walk get the alert").
- Text contrast at least 4.5:1 everywhere, including over paintings.

## Build order
1. Static page: all sections, copy, colors, fonts, Text Troy links. Works on phone and desktop.
2. The reusable two-screen conversation component, then the hero phone with typing and the scenario loop.
3. Day-to-night crossfade.
4. Each section's conversation plays on scroll, plus chips and the repair steps.
5. The free food map.
6. Problem section lines, Troy's animations, the footer.
7. Extras, one at a time, only if time allows.
Commit after each step that works.

## Done when
- The page loads fast on a phone, under about 2 MB total.
- The hero phone looks and feels like real iMessage and loops through all four scenarios.
- Every use case shows both sides.
- Scrolling goes from day to golden hour to night smoothly.
- Both Text Troy buttons and the FAQ button open Messages with the right text filled in.
- No text is hard to read over the paintings.
