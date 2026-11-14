# Troy flow transcripts

Every bubble below was sent by the running server on Nov 14, 2026 (evening run, after the welcome copy, texting timing, native polls and saved locations landed), driven through the web chat routes with simulated phones. Nothing here is hand written.

How it was run:

- `PORT=3112 MESSAGING_PROVIDER=webchat SEED_EXAMPLES=true DATABASE_URL=<temp db> ALLOWED_HANDLES= node src/server.ts`, with no `.env` and no API key. So every reply is fixed copy, intent comes from the keyword rules, and matching and verification use the rule scores. The temp database was deleted afterwards.
- Routes used: `/webchat/send` (texts, photos, a dropped pin), `/webchat/vote` (a vote on a native poll card), `/webchat/react` (tapbacks), `/webchat/share` (tapping Share on the "Requested Location" bubble) and `/webchat/location` (to stop a phone sharing). The verification code was read from the server's console output, where it is logged in development.
- Because there is no AI check, Troy never hands an item over on the rule score alone. The finder is shown the claimant's own words and decides. That is why the finder gets a "sound like what u found?" question in every lost and found conversation here. With the API on, a strong blind description passes without that step.
- Phones: A (+1 213 555 0201), B (0202), C (0203), D (0204), and E (0205, only for the tapback version of the judge poll).
- `troy -> A` is a bubble in A's own chat with Troy. Lines in backticks are dashboard API calls, or a database check, and their answers.
- Everything ran in one server session in the order below, with real pacing (nothing sped up). The one exception is phone E, which ran in a second session started with `WEBCHAT_POLLS=tap` so polls fall back to tap-to-pick bubbles.
- Read receipts and typing indicators are left out of the conversations to keep them readable. The welcome timing section shows them with timestamps.
- A like tapback from Troy on someone's text is his "got it" when his own reply is more than 3 seconds away, usually because he is texting the other person first.

## Welcome timing

Measured from the transcript timestamps of the four welcomes in section 0 (phones A to D). Order on every incoming text: Read shows, a pause, typing starts, the bubble lands, a short gap, typing starts again.

| Step | Measured range | Average | Samples | What John asked for |
| --- | --- | --- | --- | --- |
| Read, then the pause before typing starts | 0.96 to 1.34 s | 1.20 s | 4 | about a second |
| Typing before a normal bubble (80 characters or fewer) | 1.13 to 1.98 s | 1.63 s | 24 | 1 to 2 s |
| Typing before a long bubble (over 80 characters) | 3.30 to 3.99 s | 3.65 s | 4 | 3 to 4 s |
| Typing before the contact card or a poll | 0.72 to 0.96 s | 0.82 s | 8 | short (0.6 to 1.0 s by design) |
| Gap after a bubble before typing starts again | 0.41 to 0.89 s | 0.62 s | 32 | a short beat (0.4 to 0.9 s by design) |
| Whole welcome, "hey troy" to the judge poll | 20.18 to 21.89 s | 21.20 s | 4 | not specified |

All four checks John asked for hold: Read shows first, typing starts about a second later (never before), normal bubbles get 1 to 2 seconds of typing and the one long welcome bubble gets 3 to 4.

Phone A's welcome, event by event:

| Seconds after "hey troy" | What the phone shows | Typing shown before it |
| --- | --- | --- |
| 0.01 | Read shows |  |
| 1.33 | typing starts |  |
| 2.76 | "hey i'm troy" | 1.43s of typing, 12 chars |
| 3.41 | typing starts |  |
| 5.03 | "i'm an ai, but i know a guy for everything" | 1.62s of typing, 42 chars |
| 5.92 | typing starts |  |
| 9.22 | "send me a photo of anything on campus and i'll get it to the…" | 3.30s of typing, 123 chars |
| 9.94 | typing starts |  |
| 11.66 | "reply STOP anytime and i'll leave u alone until u want to ta…" | 1.73s of typing, 68 chars |
| 12.09 | typing starts |  |
| 13.81 | "save my contact if u haven't so u know it's me" | 1.72s of typing, 46 chars |
| 14.35 | typing starts |  |
| 15.20 | [contact card] | 0.84s of typing |
| 15.73 | typing starts |  |
| 17.00 | "quick thing, gotta make sure ur a trojan. what's ur usc emai…" | 1.26s of typing, 61 chars |
| 17.86 | typing starts |  |
| 19.69 | "hackathon judges can skip this. not a judge? pls don't tap i…" | 1.84s of typing, 77 chars |
| 20.17 | typing starts |  |
| 20.93 | "which one are u?" | 0.76s of typing, 16 chars |
| 20.93 | [poll card] | lands with its question |

After the poll lands the typing indicator turns off. (In the first replay it stayed on after the poll; that was fixed in `src/pipeline.ts` and this run is from after the fix.)

## 0. Opting in

_Phone A is a student: answers the poll, verifies a USC email, taps Share on the location request_

**A:** hey troy  
**troy -> A:** hey i'm troy  
**troy -> A:** i'm an ai, but i know a guy for everything  
**troy -> A:** send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'  
**troy -> A:** reply STOP anytime and i'll leave u alone until u want to talk again  
**troy -> A:** save my contact if u haven't so u know it's me  
**troy -> A:** [contact card: Troy]  
**troy -> A:** quick thing, gotta make sure ur a trojan. what's ur usc email  
**troy -> A:** hackathon judges can skip this. not a judge? pls don't tap it, i'm trusting u  
**troy -> A:** which one are u?  
**troy -> A:** [poll: usc student / hackathon judge]  
**A:** _(votes "usc student" in the poll)_  
**troy -> A:** bet. what's ur usc email?  
**A:** tommy.trojan@usc.edu  
**troy -> A:** sent a 6 digit code to tommy.trojan@usc.edu  
**troy -> A:** text it back to me. might be in spam since i'm new 👀  
**A:** 000000  
**troy -> A:** that's not the code. 4 tries left  
**A:** 427631  
**troy -> A:** ur verified. welcome in  
**troy -> A:** what do u want texts about?  
**troy -> A:** [poll: free food / free stuff / events / help others with classes]  
**troy -> A:** pick one in the poll, or text me a few like 1 and 3. or reply skip  
**A:** _(votes "free food" in the poll)_  
**troy -> A:** got it. want more? text the numbers like 1 and 3. or text done  
**A:** done  
**troy -> A:** bet, i'll text u about free food  
**troy -> A:** last thing. i keep the last location u share so alerts and walking times are accurate. text forget my location anytime to erase it  
**troy -> A:** [Requested Location bubble with a Share button]  
**troy -> A:** sent u a location request, tap it to share  
**troy -> A:** or just tell me ur usual spots, or reply skip  
**A:** _(taps Share on the location request)_  
**troy -> A:** got it, thx  
**troy -> A:** ur all set. try sending me a pic of something u found, or ask "who do i talk to about dining hall hours"  

_Phone B is a judge: votes "hackathon judge" in the poll, picks alerts by typing numbers, shares location_

**B:** hey troy  
**troy -> B:** hey i'm troy  
**troy -> B:** i'm an ai, but i know a guy for everything  
**troy -> B:** send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'  
**troy -> B:** reply STOP anytime and i'll leave u alone until u want to talk again  
**troy -> B:** save my contact if u haven't so u know it's me  
**troy -> B:** [contact card: Troy]  
**troy -> B:** quick thing, gotta make sure ur a trojan. what's ur usc email  
**troy -> B:** hackathon judges can skip this. not a judge? pls don't tap it, i'm trusting u  
**troy -> B:** which one are u?  
**troy -> B:** [poll: usc student / hackathon judge]  
**B:** _(votes "hackathon judge" in the poll)_  
**troy -> B:** ur in as a judge. this skip is demo only, the real campus version wouldn't have it  
**troy -> B:** what do u want texts about?  
**troy -> B:** [poll: free food / free stuff / events / help others with classes]  
**troy -> B:** pick one in the poll, or text me a few like 1 and 3. or reply skip  
**B:** 1 and 3  
**troy -> B:** bet, i'll text u about free food, events  
**troy -> B:** last thing. i keep the last location u share so alerts and walking times are accurate. text forget my location anytime to erase it  
**troy -> B:** [Requested Location bubble with a Share button]  
**troy -> B:** sent u a location request, tap it to share  
**troy -> B:** or just tell me ur usual spots, or reply skip  
**B:** _(taps Share on the location request)_  
**troy -> B:** got it, thx  
**troy -> B:** ur all set. try sending me a pic of something u found, or ask "who do i talk to about dining hall hours"  

_Phone C is a judge by typing, asks why Troy wants a location, then shares one_

**C:** hey troy  
**troy -> C:** hey i'm troy  
**troy -> C:** i'm an ai, but i know a guy for everything  
**troy -> C:** send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'  
**troy -> C:** reply STOP anytime and i'll leave u alone until u want to talk again  
**troy -> C:** save my contact if u haven't so u know it's me  
**troy -> C:** [contact card: Troy]  
**troy -> C:** quick thing, gotta make sure ur a trojan. what's ur usc email  
**troy -> C:** hackathon judges can skip this. not a judge? pls don't tap it, i'm trusting u  
**troy -> C:** which one are u?  
**troy -> C:** [poll: usc student / hackathon judge]  
**C:** i'm a judge  
**troy -> C:** ur in as a judge. this skip is demo only, the real campus version wouldn't have it  
**troy -> C:** what do u want texts about?  
**troy -> C:** [poll: free food / free stuff / events / help others with classes]  
**troy -> C:** pick one in the poll, or text me a few like 1 and 3. or reply skip  
**C:** free food  
**troy -> C:** bet, i'll text u about free food  
**troy -> C:** last thing. i keep the last location u share so alerts and walking times are accurate. text forget my location anytime to erase it  
**troy -> C:** [Requested Location bubble with a Share button]  
**troy -> C:** sent u a location request, tap it to share  
**troy -> C:** or just tell me ur usual spots, or reply skip  
**C:** why do u need that  
**troy -> C:** it's so alerts and walking times fit where u actually are. i only keep the last one u share, and forget my location erases it  
**troy -> C:** share it, tell me ur usual spots, or reply skip  
**C:** _(taps Share on the location request)_  
**troy -> C:** got it, thx  
**troy -> C:** ur all set. try sending me a pic of something u found, or ask "who do i talk to about dining hall hours"  

_Phone D answers the poll by number, and gives a usual spot instead of sharing_

**D:** hey troy  
**troy -> D:** hey i'm troy  
**troy -> D:** i'm an ai, but i know a guy for everything  
**troy -> D:** send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'  
**troy -> D:** reply STOP anytime and i'll leave u alone until u want to talk again  
**troy -> D:** save my contact if u haven't so u know it's me  
**troy -> D:** [contact card: Troy]  
**troy -> D:** quick thing, gotta make sure ur a trojan. what's ur usc email  
**troy -> D:** hackathon judges can skip this. not a judge? pls don't tap it, i'm trusting u  
**troy -> D:** which one are u?  
**troy -> D:** [poll: usc student / hackathon judge]  
**D:** 2  
**troy -> D:** ur in as a judge. this skip is demo only, the real campus version wouldn't have it  
**troy -> D:** what do u want texts about?  
**troy -> D:** [poll: free food / free stuff / events / help others with classes]  
**troy -> D:** pick one in the poll, or text me a few like 1 and 3. or reply skip  
**D:** 1  
**troy -> D:** bet, i'll text u about free food  
**troy -> D:** last thing. i keep the last location u share so alerts and walking times are accurate. text forget my location anytime to erase it  
**troy -> D:** [Requested Location bubble with a Share button]  
**troy -> D:** sent u a location request, tap it to share  
**troy -> D:** or just tell me ur usual spots, or reply skip  
**D:** tcc  
**troy -> D:** saved ur usual spots  
**troy -> D:** ur all set. try sending me a pic of something u found, or ask "who do i talk to about dining hall hours"  

_Phone E is a judge on a phone without native polls (run separately with `WEBCHAT_POLLS=tap`): tapbacks pick the options_

**E:** hey troy  
**troy -> E:** hey i'm troy  
**troy -> E:** i'm an ai, but i know a guy for everything  
**troy -> E:** send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'  
**troy -> E:** reply STOP anytime and i'll leave u alone until u want to talk again  
**troy -> E:** save my contact if u haven't so u know it's me  
**troy -> E:** [contact card: Troy]  
**troy -> E:** quick thing, gotta make sure ur a trojan. what's ur usc email  
**troy -> E:** hackathon judges can skip this. not a judge? pls don't tap it, i'm trusting u  
**troy -> E:** which one are u?  
**troy -> E:** usc student  
**troy -> E:** hackathon judge  
**E:** _(love tapback on "hackathon judge")_  
**troy -> E:** ur in as a judge. this skip is demo only, the real campus version wouldn't have it  
**troy -> E:** what do u want texts about?  
**troy -> E:** free food  
**troy -> E:** free stuff  
**troy -> E:** events  
**troy -> E:** help others with classes  
**troy -> E:** tap a heart or thumbs up on the ones u want, then text done. or reply skip  
**E:** _(love tapback on "free food")_  
**troy -> E:** got it. tap any others u want, then text done  
**E:** _(like tapback on "events")_  
**E:** done  
**troy -> E:** bet, i'll text u about free food, events  
**troy -> E:** last thing. i keep the last location u share so alerts and walking times are accurate. text forget my location anytime to erase it  
**troy -> E:** [Requested Location bubble with a Share button]  
**troy -> E:** sent u a location request, tap it to share  
**troy -> E:** or just tell me ur usual spots, or reply skip  
**E:** skip  
**troy -> E:** no worries, i'll just ask where u are when it matters  
**troy -> E:** ur all set. try sending me a pic of something u found, or ask "who do i talk to about dining hall hours"  

## a. Flow 1, happy path: found airpods, meet up, group chat

A sends a photo. With no AI to read it, Troy asks A once for what only the owner would know. That answer is stored as the hidden details and is never shown to anyone else. B's first reply is the same for every plausible report: it depends only on kind, color, brand, place and time, never on the hidden details.

_A finds airpods and sends a photo_

**A:** [photo] found these airpods at leavey  
**troy -> A:** anything on it only the owner would know? stickers, marks, a case, a name. that part stays between us  
**A:** white case with a dinosaur sticker on the lid, initials MK engraved on the back  
**troy -> A:** logged it: earbuds  
**troy -> A:** hang onto it for now. i'll text u when the owner turns up  

_B reports airpods lost_

**B:** lost my airpods near leavey yesterday  
**troy -> B:** on it. checking what's been turned in  
**troy -> B:** might have something  
**troy -> B:** quick check first  
**troy -> B:** describe it for me in ur own words. anything only the owner would know, like marks, stickers or what's on it  
**B:** white case, theres a dinosaur sticker on the lid and my initials mk engraved on the back  
**troy -> B:** ok. running that by the person who found it  
**troy -> B:** i'll text u back either way  
**troy -> A:** someone says the earbuds u found are theirs  
**troy -> A:** here's how they described it:  
**troy -> A:** "white case, theres a dinosaur sticker on the lid and my initials mk engraved on the back"  
**troy -> A:** sound like what u found? yes or no  
**A:** yes  
**troy -> B:** good news. the person who found it says it sounds like urs  
**troy -> B:** checking how the finder wants to hand it off. i'll text u right back  
**troy -> A:** the owner of the earbuds u found just checked out  
**troy -> A:** how do u wanna hand it off? 1) hold it and meet them, 2) drop it at dps  
**A:** 1  
**troy -> A:** i'll add u both to a group chat. heads up, that shares ur contact info. ok?  
**troy -> B:** the finder's down to meet up and hand it back  
**troy -> B:** i'll add u both to a group chat. heads up, that shares ur contact info. ok?  
**A:** yes  
**troy -> A:** cool. waiting on them to ok it too  
**B:** yes  
**troy -> group(A+B):** handing you off. one of u found it and one of u lost it, so pick a busy spot to meet. i'll step back now  
**troy -> A:** ur both in a group chat now. thanks for looking out  
**troy -> B:** ur both in a group chat now  
**troy -> B:** text me got it once it's back with u  
**B:** got it  
**troy -> B:** love that  
**troy -> B:** want to send the finder a quick thank-you? text it here and i'll pass it on. or say skip  
**B:** thank u so much, u saved my week  
**troy -> A:** the owner of the earbuds wanted u to have this:  
**troy -> B:** _(like tapback on "thank u so much, u saved my week")_  
**troy -> A:** "thank u so much, u saved my week"  
**troy -> A:** that's a win. fight on 🎉  _(sent with confetti)_  
**troy -> B:** that's a win. fight on 🎉  _(sent with confetti)_  

## a2. Flow 1 again, DPS handoff with a pickup code

Both people get the same code. "ok thanks" does not close the handoff, the code can be asked for again, and only "got it" marks the item returned.

_A finds a water bottle_

**A:** [photo] found this water bottle at tcc  
**troy -> A:** anything on it only the owner would know? stickers, marks, a case, a name. that part stays between us  
**A:** blue hydro flask, corgi sticker on the side and a dent on the bottom  
**troy -> A:** logged it: hydro flask  
**troy -> A:** hang onto it for now. i'll text u when the owner turns up  

_B reports one lost_

**B:** i lost my blue hydro flask at tcc this morning  
**troy -> B:** on it. checking what's been turned in  
**troy -> B:** might have something  
**troy -> B:** quick check first  
**troy -> B:** describe it for me in ur own words. anything only the owner would know, like marks, stickers or what's on it  
**B:** it has a corgi sticker and a dent on the bottom  
**troy -> B:** ok. running that by the person who found it  
**troy -> B:** i'll text u back either way  
**troy -> A:** someone says the hydro flask u found is theirs  
**troy -> A:** here's how they described it:  
**troy -> A:** "it has a corgi sticker and a dent on the bottom"  
**troy -> A:** sound like what u found? yes or no  
**A:** yes  
**troy -> B:** good news. the person who found it says it sounds like urs  
**troy -> A:** _(like tapback on "yes")_  
**troy -> B:** checking how the finder wants to hand it off. i'll text u right back  
**troy -> A:** the owner of the hydro flask u found just checked out  
**troy -> A:** how do u wanna hand it off? 1) hold it and meet them, 2) drop it at dps  

_A picks DPS this time_

**A:** 2  
**troy -> A:** drop it at dps lost and found when u can  
**troy -> A:** dps lost and found is at 3667 mcclintock ave, los angeles, ca 90089  
**troy -> A:** tell them it's for pickup code 6FUETD  
**troy -> B:** the finder's dropping it at dps lost and found  
**troy -> B:** dps lost and found is at 3667 mcclintock ave, los angeles, ca 90089  
**troy -> B:** ur pickup code is 6FUETD  
**troy -> B:** text me got it once it's back with u  

_B acknowledges, asks for the code again, then picks it up_

**B:** ok thanks  
**troy -> B:** sounds good  
**troy -> B:** text me got it once it's back with u  
**B:** whats my pickup code  
**troy -> B:** ur pickup code is 6FUETD  
**troy -> B:** dps lost and found is at 3667 mcclintock ave, los angeles, ca 90089  
**B:** got it  
**troy -> B:** love that  
**troy -> B:** want to send the finder a quick thank-you? text it here and i'll pass it on. or say skip  
**B:** skip  
**troy -> A:** that's a win. fight on 🎉  _(sent with confetti)_  
**troy -> B:** that's a win. fight on 🎉  _(sent with confetti)_  

## b. Flow 1, fraud: a vague claim

D never sees a hidden detail (the gold star sticker, the name inside the lid). Backing out with "nvm" and reporting again gets the same first reply and does not reset the tries: two misses and D is done with that item. The finder sees D's words and keeps holding it, and D's third report does not reopen it.

_A finds another pair of airpods_

**A:** [photo] found airpods at doheny  
**troy -> A:** anything on it only the owner would know? stickers, marks, a case, a name. that part stays between us  
**A:** black case with a gold star sticker, the name priya is written inside the lid  
**troy -> A:** logged it: earbuds  
**troy -> A:** hang onto it for now. i'll text u when the owner turns up  

_D tries to claim them with nothing specific_

**D:** lost my airpods at doheny today  
**troy -> D:** on it. checking what's been turned in  
**troy -> D:** might have something  
**troy -> D:** quick check first  
**troy -> D:** describe it for me in ur own words. anything only the owner would know, like marks, stickers or what's on it  
**D:** theyre just normal airpods in a case  
**troy -> D:** hmm, that doesn't line up with what i have  
**troy -> D:** one more try. describe it again, anything specific u remember  
**D:** nvm  
**troy -> D:** ok, stopped. ur report's still open and i'll text u if something turns up  

_D reports again with a guess. The first reply is the same, and the miss from before still counts_

**D:** lost my airpods at doheny today, they have a sticker  
**troy -> D:** on it. checking what's been turned in  
**troy -> D:** might have something  
**troy -> D:** quick check first  
**troy -> D:** describe it for me in ur own words. anything only the owner would know, like marks, stickers or what's on it  
**D:** black case with a sticker on it  
**troy -> D:** couldn't confirm it from ur description  
**troy -> D:** got an old photo of it, or a find my screenshot? send it here, or say no  
**D:** no  
**troy -> D:** i'll ask the person holding it and text u back either way  
**troy -> A:** someone's trying to claim the earbuds u found  
**troy -> A:** here's how they described it:  
**troy -> A:** "lost my airpods at doheny today, they have a sticker"  
**troy -> A:** "theyre just normal airpods in a case"  
**troy -> A:** "black case with a sticker on it"  
**troy -> A:** couldn't confirm this person. ur call: 1) meet them anyway, 2) drop it at dps, 3) keep holding it in case someone else claims it  
**D:** hello?? pls i really need them back  
**troy -> D:** still waiting to hear back from the person holding it. i'll text u either way  

_A reads D's words and keeps holding it_

**A:** 3  
**troy -> A:** ok, hang onto it. i'll text u if someone else claims it  
**troy -> D:** couldn't confirm this one's urs, so i can't connect u  
**troy -> D:** ur report stays open in case another one turns up  

_D tries a third time with a new report_

**D:** i lost my airpods at doheny library today, black case  
**troy -> D:** on it. checking what's been turned in  
**troy -> D:** nothing yet, still looking  
**troy -> D:** i'll text u the second something turns up  
**D:** can u just tell me whats on the case  
**troy -> D:** hey, troy here  
**troy -> D:** i can help with lost or found stuff, free food, broken things on campus, or who to talk to about a campus issue  

## c. Flow 2: free food, with walking times from saved locations

B, C and D all asked for free food alerts in section 0. The walking bubble is worded by what Troy has for each person: "from u" for a fresh share (B), "from where u last shared" for a share older than 3 hours (C), and "from tcc" for a usual spot (D). The first alert bubble is edited as the count changes.

_Setup: B shared a location minutes ago (fresh). C's share is made 4 hours old and C's phone stops sharing (stale). D only gave a usual spot (tcc)_

_A posts food with a photo_

**A:** [photo] 3 bowls of chipotle at leavey  
**troy -> A:** who's it from? a club or org name, or reply skip  
**A:** acm  
**troy -> D:** yo acm is giving away free chipotle at leavey, about 3 bowls left  
**troy -> B:** yo acm is giving away free chipotle at leavey, about 3 bowls left  
**troy -> C:** yo acm is giving away free chipotle at leavey, about 3 bowls left  
**troy -> A:** _(like tapback on "acm")_  
**troy -> D:** it's about a 6 min walk from tcc  
**troy -> C:** it's about a 4 min walk from where u last shared  
**troy -> B:** it's about a 1 min walk from u  
**troy -> D:** react if u want one  
**troy -> C:** react if u want one  
**troy -> B:** react if u want one  
**troy -> A:** posted. i texted 3 people nearby  
**troy -> A:** text me how many are left anytime, or 'we're out' when it's done  

_B claims with a tapback_

**B:** _(love tapback on "react if u want one")_  
**troy -> B:** it's yours, grab it in the next 15 min  
**troy -> B:** text 'got it' once u have it  
**troy -> B:** lmk if u want to talk to acm  
**troy -> B:** _(edited an earlier bubble to)_ yo acm is giving away free chipotle at leavey, 2 left  
**troy -> C:** _(edited an earlier bubble to)_ yo acm is giving away free chipotle at leavey, 2 left  
**troy -> D:** _(edited an earlier bubble to)_ yo acm is giving away free chipotle at leavey, 2 left  
`GET /api/panel -> {"id":3,"clubName":"acm","description":"chipotle","locationText":"leavey","servingsTotal":3,"servingsLeft":2,"status":"live","reports":0,"isExample":false,"claims":{"held":1,"picked_up":0,"released":0},"expiresAt":1794705519868,"createdAt":1794698319868}`  

_C claims by text_

**C:** me  
**troy -> C:** it's yours, grab it in the next 15 min  
**troy -> C:** text 'got it' once u have it  
**troy -> C:** lmk if u want to talk to acm  
**troy -> B:** _(edited an earlier bubble to)_ yo acm is giving away free chipotle at leavey, last one  
**troy -> C:** _(edited an earlier bubble to)_ yo acm is giving away free chipotle at leavey, last one  
**troy -> D:** _(edited an earlier bubble to)_ yo acm is giving away free chipotle at leavey, last one  
**B:** got it  
**troy -> B:** nice, enjoy 🙌  
**C:** got it  
**troy -> C:** nice, enjoy 🙌  

_A walk-up took the last bowl, so the poster updates the count_

**A:** we're out  
**troy -> A:** got it, closed it out. thanks for sharing  
**troy -> B:** _(edited an earlier bubble to)_ yo acm is giving away free chipotle at leavey, all gone 😔  
**troy -> C:** _(edited an earlier bubble to)_ yo acm is giving away free chipotle at leavey, all gone 😔  
**troy -> D:** _(edited an earlier bubble to)_ yo acm is giving away free chipotle at leavey, all gone 😔  

_D arrives late_

**D:** _(like tapback on "react if u want one")_  
**troy -> D:** all gone, sorry  
**D:** me  
**troy -> D:** all gone, sorry  

## d. Flow 3: repair report, a duplicate, and status updates

_B reports a broken light_

**B:** the light is out on the 2nd floor of taper hall  
**troy -> B:** reported to fms ✅ i'll text u when it moves.  
**troy -> B:** demo note: it's logged on troy's staff dashboard for fms. the link into their real work order system is mocked, so nothing was filed there  

_C reports the same thing_

**C:** the light is out on the 2nd floor of taper hall  
**troy -> C:** 1 other person already reported that to fms, so i added u to it  
**troy -> C:** i'll text u when it moves  
**troy -> C:** demo note: it's logged on troy's staff dashboard for fms. the link into their real work order system is mocked, so nothing was filed there  

_Staff move the report on the dashboard_

`POST /api/reports/10/status {"status":"in_progress"} -> {"ok":true,"changed":true,"status":"in_progress","notified":2,"failed":0}`  
**troy -> B:** update on "the light is out on the 2nd floor of taper hall" at taper hall, 2nd floor: in progress 🔧  
**troy -> C:** update on "the light is out on the 2nd floor of taper hall" at taper hall, 2nd floor: in progress 🔧  
`POST /api/reports/10/status {"status":"fixed"} -> {"ok":true,"changed":true,"status":"fixed","notified":2,"failed":0}`  
**troy -> B:** update on "the light is out on the 2nd floor of taper hall" at taper hall, 2nd floor: fixed ✅  
**troy -> C:** update on "the light is out on the 2nd floor of taper hall" at taper hall, 2nd floor: fixed ✅  

## e. Flow 4: USG questions and a concern

_Club funding_

**B:** how does my club get funding  
**troy -> B:** recognized student orgs and usc undergrads can apply for usg funding on engagesc.  
**troy -> B:** apps are due wednesdays by 11:59pm, six academic weeks before the event (or nine before the first payment is due, whichever comes first)  
**troy -> B:** and an rso can get up to 4 events funded a semester as long as it stays under $8,000 from usg a year.  
**troy -> B:** the senate was looking at changing the deadline rules in oct 2026, so double check the page before u plan around them.  
**troy -> B:** https://usg.usc.edu/branches/funding/  

_The LAX shuttle and the thrift (USG's own statement, no dates invented)_

**B:** does usg have an lax shuttle  
**troy -> B:** usg runs a shuttle to lax around breaks. hit up usg for this year's dates and how to sign up.  
**troy -> B:** u can reach them at usg@usc.edu  
**B:** is there a usg thrift  
**troy -> B:** usg runs a thrift for students. ask usg where and when the next one is.  
**troy -> B:** u can reach them at usg@usc.edu  

_A concern that gets routed_

**C:** why does village dining close so early  
**troy -> C:** want me to send it with ur name or anonymously?  
**C:** anonymously  
**troy -> C:** sent to the USG Committee on Sustainability and Campus Infrastructure. i'll text u when they pick it up.  
**troy -> C:** sent anonymously, ur name isn't on it  

_B has the same concern_

**B:** village dining closes way too early  
**troy -> B:** 1 other person already sent that to the USG Committee on Sustainability and Campus Infrastructure, so i added u to it  
**troy -> B:** i'll text u when they pick it up  

## f. Notes: "don't add me to group chats", then a handoff that uses relay

A picks "meet", but B's rule means Troy never offers a group chat and passes messages instead. B's "got it" closes the handoff and the relay.

_B sets a privacy rule_

**B:** don't add me to group chats  
**troy -> B:** got it. i won't add u to group chats  
**troy -> B:** if a handoff comes up i'll pass messages along instead  
**B:** what do u know about me  
**troy -> B:** here's what i have  
**troy -> B:** contact: people i connect u with can text u directly. group chats: off  
**troy -> B:** alerts: on. topics: free food, events. within a 15 min walk. quiet hours: off  
**troy -> B:** location: near leavey library. u shared it 11 min ago. say "forget my location" to erase it  
**troy -> B:** notes: 1. "don't add me to group chats"  
**troy -> B:** say "forget that" to drop the last one  

_A finds B's keys_

**A:** [photo] found some keys by tommy trojan  
**troy -> A:** anything on it only the owner would know? stickers, marks, a case, a name. that part stays between us  
**A:** red lanyard with a honda fob and a tiny flashlight  
**troy -> A:** logged it: keys  
**troy -> A:** hang onto it for now. i'll text u when the owner turns up  
**B:** lost my keys near tommy trojan today  
**troy -> B:** on it. checking what's been turned in  
**troy -> B:** might have something  
**troy -> B:** quick check first  
**troy -> B:** describe it for me in ur own words. anything only the owner would know, like marks, stickers or what's on it  
**B:** red lanyard, honda fob, little flashlight on it  
**troy -> B:** ok. running that by the person who found it  
**troy -> B:** i'll text u back either way  
**troy -> A:** someone says the keys u found are theirs  
**troy -> A:** here's how they described it:  
**troy -> A:** "red lanyard, honda fob, little flashlight on it"  
**troy -> A:** sound like what u found? yes or no  
**A:** yes  
**troy -> B:** good news. the person who found it says it sounds like urs  
**troy -> B:** checking how the finder wants to hand it off. i'll text u right back  
**troy -> A:** the owner of the keys u found just checked out  
**troy -> A:** how do u wanna hand it off? 1) hold it and meet them, 2) drop it at dps  

_A picks meet, but B's rule means no group chat_

**A:** 1  
**troy -> A:** i'll pass messages between u two right here. no numbers shared  
**troy -> A:** just text me what u want them to know. text done when ur finished  
**troy -> B:** i'll pass messages between u two right here. no numbers shared  
**troy -> B:** just text me what u want them to know. text done when ur finished  
**troy -> B:** text me got it once it's back with u  
**A:** im by the statue til 3, wearing a red hoodie  
**troy -> B:** from the finder: im by the statue til 3, wearing a red hoodie  
**troy -> A:** _(like tapback on "im by the statue til 3, wearing a red hoodie")_  
**B:** omw, 5 min  
**troy -> A:** from the owner: omw, 5 min  
**troy -> B:** _(like tapback on "omw, 5 min")_  
**B:** got it  
**troy -> B:** love that  
**troy -> B:** want to send the finder a quick thank-you? text it here and i'll pass it on. or say skip  
**B:** skip  
**troy -> A:** that's a win. fight on 🎉  _(sent with confetti)_  
**troy -> B:** that's a win. fight on 🎉  _(sent with confetti)_  

## h. Saved location: ask, forget, tell

Troy only ever names a campus place and how old the fix is, never coordinates. "u shared it" is a Find My share or a pin; "u told me" is something the student typed.

**A:** do u have my location?  
**troy -> A:** location: near leavey library. u shared it 14 min ago. say "forget my location" to erase it  
**A:** what do u know about me  
**troy -> A:** here's what i have. ur tommy trojan, usc email tommy.trojan@usc.edu  
**troy -> A:** contact: people i connect u with can text u directly. group chats: ok  
**troy -> A:** alerts: on. topics: free food. within a 15 min walk. quiet hours: off  
**troy -> A:** location: near leavey library. u shared it 14 min ago. say "forget my location" to erase it  
**troy -> A:** no notes yet. tell me stuff like "keep it short" and i'll remember it  
**A:** forget my location  
**troy -> A:** done, i erased ur saved location. share it again anytime if u want walking times  
**A:** do u have my location?  
**troy -> A:** location: none saved  
**A:** i'm at leavey rn  
**troy -> A:** got it, ur at leavey library  
**troy -> A:** i'll use that for walking times. say "forget my location" anytime  
**A:** do u have my location?  
**troy -> A:** location: near leavey library. u told me just now. say "forget my location" to erase it  

_A drops a pin with no words_

**A:** _(drops a pin)_  
**troy -> A:** got it, thx  
**A:** do u have my location?  
**troy -> A:** location: near ronald tutor campus center. u shared it just now. say "forget my location" to erase it  

## i. STOP, then "hey troy"

STOP also erases the saved location. START or any text that opens with "hey troy" brings Troy back.

**C:** STOP  
**troy -> C:** ok, i'll leave u alone. text START or hey troy whenever u want to talk again  

_Texts after STOP get nothing back, and nothing is kept_

**C:** lost my keys at leavey  
**C:** hey troy  
**troy -> C:** welcome back. ur getting texts from me again  
**C:** do u have my location?  
**troy -> C:** location: none saved  
`users row for C (stopped, location erased) -> +12135550203|0|1`  

## g. Demo panel data after all of the above (`/api/panel`)

The public payload has no hidden details, no pickup codes and no saved locations (checked by the last line).

```
counts: {"found":19,"lost":19,"matches":47,"returned":3}

matches (the 4 acted on, of 40 returned):
- #47 keys <-> keys | confidence 55 (fallback) | verified | same kind of item (keys); found right where it was lost; lost and found within two days
- #45 hydro flask <-> water bottle | confidence 70 (fallback) | verified | same kind of item (water bottle); same brand; found right where it was lost; lost and found within two days
- #44 earbuds <-> earbuds | confidence 55 (fallback) | verified | same kind of item (earbuds); found right where it was lost; lost and found within two days
- #46 earbuds <-> earbuds | confidence 55 (fallback) | rejected | same kind of item (earbuds); found right where it was lost; lost and found within two days

verifications:
- match #47 finder_confirm | score null | pass | try 1
- match #47 blind_description | score 86 | pass | try 1
- match #46 finder_judgment | score null | fail | try 1
- match #46 blind_description | score 25 | fail | try 2
- match #46 blind_description | score 5 | fail | try 1
- match #45 finder_confirm | score null | pass | try 1
- match #45 blind_description | score 72 | pass | try 1
- match #44 finder_confirm | score null | pass | try 1
- match #44 blind_description | score 90 | pass | try 1

handoffs:
- match #47 relay | pickup code on file: false | completed: true | thank-you: null
- match #45 dps_code | pickup code on file: true | completed: true | thank-you: null
- match #44 group_chat | pickup code on file: false | completed: true | thank-you: thank u so much, u saved my week

food drops:
- acm, chipotle at leavey | 0 of 3 left | ended | claims {"held":0,"picked_up":2,"released":0}
- Dumpling Night Collective (example club), boxes of veggie fried rice and potstickers left over from our meeting at tcc 2nd floor | 12 of 20 left | live | claims {"held":0,"picked_up":0,"released":0} | example
- Cardinal Robotics Build Team (example club), bagels, cream cheese and fruit from our morning workshop at ronald tutor hall lobby | 0 of 30 left | ended | claims {"held":0,"picked_up":0,"released":0} | example

in the public payload: hidden details false, pickup codes false, coordinates or saved locations false
```
