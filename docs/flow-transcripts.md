# Troy flow transcripts

Every bubble below was sent by the running server on Nov 14, 2026, driven through the web chat routes (`/webchat/send`, `/webchat/react`) with simulated phones. Nothing here is hand written.

How it was run:

- `PORT=3102 MESSAGING_PROVIDER=webchat SEED_EXAMPLES=true DATABASE_URL=/tmp/claude-troy-flows.db ALLOWED_HANDLES= node src/server.ts`, with no `.env` and no API key. So every reply is fixed copy, intent comes from the keyword rules, and matching and verification use the rule scores.
- Because there is no AI check, Troy never hands an item over on the rule score alone. The finder is shown the claimant's own words and decides. That is why the finder gets a "sound like what u found?" question in every lost and found conversation here. With the API on, a strong blind description passes without that step. Every claim starts with the same blind question ("describe it for me in ur own words"), and the finder is shown only that answer.
- Phones: A (+1 213 555 0201), B (0202), C (0203), and D (0204, only used as the late arrival in the food flow). Each opted in with "hey troy" and skipped email verification with JUDGE.
- `troy -> A` is a bubble in A's own chat with Troy. Lines in backticks are dashboard API calls and their answers.
- All conversations ran in one server session, in the order below.
- Sections a, a2, b and the handoff in f were run again later on Nov 14 after the lost and found fixes (same command on `PORT=3103` with a fresh temp database), because their replies changed. Sections 0, c, d, e and g are from the first run; the match ids and counts in g belong to that run.

## 0. Opting in

_Phone A opts in and skips verification as a judge_

**A:** hey troy  
**troy -> A:** hey i'm troy  
**troy -> A:** i'm an ai that connects trojans. lost something, found something, free food nearby? i know a guy  
**troy -> A:** reply STOP anytime  
**troy -> A:** [contact card: Troy]  
**troy -> A:** quick thing, gotta make sure ur a trojan. what's ur usc email  
**troy -> A:** judging the hackathon? reply JUDGE to skip this. demo only, the real campus version wouldn't have it  
**A:** JUDGE  
**troy -> A:** ur in as a guest for the demo. the real campus version always checks a usc email  
**troy -> A:** what do u want texts about?  
**troy -> A:** free food  
**troy -> A:** free stuff  
**troy -> A:** events  
**troy -> A:** help others with classes  
**troy -> A:** tap a heart or thumbs up on the ones u want, then text done. or reply skip  
**A:** skip  
**troy -> A:** no alerts then. u can always text me first  
**troy -> A:** want alerts for stuff near u? tap the + in this chat, then Location, then Share to share with me, or just tell me ur usual spots  
**troy -> A:** or reply skip  
**A:** skip  
**troy -> A:** no worries, i'll just ask where u are when it matters  
**troy -> A:** ur all set. try sending me a pic of something u found, or ask "who do i talk to about dining hall hours"  

_Phone B opts in, picks free food alerts, gives a usual spot_

**B:** hey troy  
**troy -> B:** hey i'm troy  
**troy -> B:** i'm an ai that connects trojans. lost something, found something, free food nearby? i know a guy  
**troy -> B:** reply STOP anytime  
**troy -> B:** [contact card: Troy]  
**troy -> B:** quick thing, gotta make sure ur a trojan. what's ur usc email  
**troy -> B:** judging the hackathon? reply JUDGE to skip this. demo only, the real campus version wouldn't have it  
**B:** JUDGE  
**troy -> B:** ur in as a guest for the demo. the real campus version always checks a usc email  
**troy -> B:** what do u want texts about?  
**troy -> B:** free food  
**troy -> B:** free stuff  
**troy -> B:** events  
**troy -> B:** help others with classes  
**troy -> B:** tap a heart or thumbs up on the ones u want, then text done. or reply skip  
**B:** _(love tapback on "free food")_  
**troy -> B:** got it. tap any others u want, then text done  
**B:** done  
**troy -> B:** bet, i'll text u about free food  
**troy -> B:** want alerts for stuff near u? tap the + in this chat, then Location, then Share to share with me, or just tell me ur usual spots  
**troy -> B:** or reply skip  
**B:** leavey  
**troy -> B:** saved ur usual spots  
**troy -> B:** ur all set. try sending me a pic of something u found, or ask "who do i talk to about dining hall hours"  

_Phone C opts in and skips the alert picks (it subscribes later through the notes flow)_

**C:** hey troy  
**troy -> C:** hey i'm troy  
**troy -> C:** i'm an ai that connects trojans. lost something, found something, free food nearby? i know a guy  
**troy -> C:** reply STOP anytime  
**troy -> C:** [contact card: Troy]  
**troy -> C:** quick thing, gotta make sure ur a trojan. what's ur usc email  
**troy -> C:** judging the hackathon? reply JUDGE to skip this. demo only, the real campus version wouldn't have it  
**C:** JUDGE  
**troy -> C:** ur in as a guest for the demo. the real campus version always checks a usc email  
**troy -> C:** what do u want texts about?  
**troy -> C:** free food  
**troy -> C:** free stuff  
**troy -> C:** events  
**troy -> C:** help others with classes  
**troy -> C:** tap a heart or thumbs up on the ones u want, then text done. or reply skip  
**C:** skip  
**troy -> C:** no alerts then. u can always text me first  
**troy -> C:** want alerts for stuff near u? tap the + in this chat, then Location, then Share to share with me, or just tell me ur usual spots  
**troy -> C:** or reply skip  
**C:** skip  
**troy -> C:** no worries, i'll just ask where u are when it matters  
**troy -> C:** ur all set. try sending me a pic of something u found, or ask "who do i talk to about dining hall hours"  

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
**troy -> B:** checking how the finder wants to hand it off. i'll text u right back  
**troy -> A:** the owner of the hydro flask u found just checked out  
**troy -> A:** how do u wanna hand it off? 1) hold it and meet them, 2) drop it at dps  

_A picks DPS this time_

**A:** 2  
**troy -> A:** drop it at dps lost and found when u can  
**troy -> A:** dps lost and found is at 3667 mcclintock ave, los angeles, ca 90089  
**troy -> A:** tell them it's for pickup code M4WKYM  
**troy -> B:** the finder's dropping it at dps lost and found  
**troy -> B:** dps lost and found is at 3667 mcclintock ave, los angeles, ca 90089  
**troy -> B:** ur pickup code is M4WKYM  
**troy -> B:** text me got it once it's back with u  

_B acknowledges, asks for the code again, then picks it up_

**B:** ok thanks  
**troy -> B:** sounds good  
**troy -> B:** text me got it once it's back with u  
**B:** whats my pickup code  
**troy -> B:** ur pickup code is M4WKYM  
**troy -> B:** dps lost and found is at 3667 mcclintock ave, los angeles, ca 90089  
**B:** got it  
**troy -> B:** love that  
**troy -> B:** want to send the finder a quick thank-you? text it here and i'll pass it on. or say skip  
**B:** skip  
**troy -> A:** that's a win. fight on 🎉  _(sent with confetti)_  
**troy -> B:** that's a win. fight on 🎉  _(sent with confetti)_

## b. Flow 1, fraud: a vague claim

C never sees a hidden detail (the gold star sticker, the name inside the lid). Backing out with "nvm" and reporting again gets the same first reply and does not reset the tries: two misses and C is done with that item. The finder sees C's words and keeps holding it, and C's third report does not reopen it.

_A finds another pair of airpods_

**A:** [photo] found airpods at doheny  
**troy -> A:** anything on it only the owner would know? stickers, marks, a case, a name. that part stays between us  
**A:** black case with a gold star sticker, the name priya is written inside the lid  
**troy -> A:** logged it: earbuds  
**troy -> A:** hang onto it for now. i'll text u when the owner turns up  

_C tries to claim them with nothing specific_

**C:** lost my airpods at doheny today  
**troy -> C:** on it. checking what's been turned in  
**troy -> C:** might have something  
**troy -> C:** quick check first  
**troy -> C:** describe it for me in ur own words. anything only the owner would know, like marks, stickers or what's on it  
**C:** theyre just normal airpods in a case  
**troy -> C:** hmm, that doesn't line up with what i have  
**troy -> C:** one more try. describe it again, anything specific u remember  
**C:** nvm  
**troy -> C:** ok, stopped. ur report's still open and i'll text u if something turns up  

_C reports again with a guess. The first reply is the same, and the miss from before still counts_

**C:** lost my airpods at doheny today, they have a sticker  
**troy -> C:** on it. checking what's been turned in  
**troy -> C:** might have something  
**troy -> C:** quick check first  
**troy -> C:** describe it for me in ur own words. anything only the owner would know, like marks, stickers or what's on it  
**C:** black case with a sticker on it  
**troy -> C:** couldn't confirm it from ur description  
**troy -> C:** got an old photo of it, or a find my screenshot? send it here, or say no  
**C:** no  
**troy -> C:** i'll ask the person holding it and text u back either way  
**troy -> A:** someone's trying to claim the earbuds u found  
**troy -> A:** here's how they described it:  
**troy -> A:** "lost my airpods at doheny today, they have a sticker"  
**troy -> A:** "theyre just normal airpods in a case"  
**troy -> A:** "black case with a sticker on it"  
**troy -> A:** couldn't confirm this person. ur call: 1) meet them anyway, 2) drop it at dps, 3) keep holding it in case someone else claims it  
**C:** hello?? pls i really need them back  
**troy -> C:** still waiting to hear back from the person holding it. i'll text u either way  

_A reads C's words and keeps holding it_

**A:** 3  
**troy -> A:** ok, hang onto it. i'll text u if someone else claims it  
**troy -> C:** couldn't confirm this one's urs, so i can't connect u  
**troy -> C:** ur report stays open in case another one turns up  

_C tries a third time with a new report_

**C:** i lost my airpods at doheny library today, black case  
**troy -> C:** on it. checking what's been turned in  
**troy -> C:** nothing yet, still looking  
**troy -> C:** i'll text u the second something turns up  
**C:** can u just tell me whats on the case  
**troy -> C:** hey, troy here  
**troy -> C:** i can help with lost or found stuff, free food, broken things on campus, or who to talk to about a campus issue

## c. Flow 2: free food

C turns on food alerts through the notes flow. B subscribed during onboarding. The first alert bubble is edited as the count changes.

_C turns on food alerts through the notes flow_

**C:** text me about free food  
**troy -> C:** done. ur alerts now: free food  

_A fourth phone (D) joins so there is someone to arrive late_

**D:** hey troy  
**troy -> D:** hey i'm troy  
**troy -> D:** i'm an ai that connects trojans. lost something, found something, free food nearby? i know a guy  
**troy -> D:** reply STOP anytime  
**troy -> D:** [contact card: Troy]  
**troy -> D:** quick thing, gotta make sure ur a trojan. what's ur usc email  
**troy -> D:** judging the hackathon? reply JUDGE to skip this. demo only, the real campus version wouldn't have it  
**D:** JUDGE  
**troy -> D:** ur in as a guest for the demo. the real campus version always checks a usc email  
**troy -> D:** what do u want texts about?  
**troy -> D:** free food  
**troy -> D:** free stuff  
**troy -> D:** events  
**troy -> D:** help others with classes  
**troy -> D:** tap a heart or thumbs up on the ones u want, then text done. or reply skip  
**D:** 1  
**troy -> D:** bet, i'll text u about free food  
**troy -> D:** want alerts for stuff near u? tap the + in this chat, then Location, then Share to share with me, or just tell me ur usual spots  
**troy -> D:** or reply skip  
**D:** skip  
**troy -> D:** no worries, i'll just ask where u are when it matters  
**troy -> D:** ur all set. try sending me a pic of something u found, or ask "who do i talk to about dining hall hours"  

_A posts food with a photo_

**A:** [photo] 3 bowls of chipotle at leavey  
**troy -> A:** who's it from? a club or org name, or reply skip  
**A:** acm  
**troy -> B:** yo acm is giving away free chipotle at leavey, about 3 bowls left  
**troy -> C:** yo acm is giving away free chipotle at leavey, about 3 bowls left  
**troy -> D:** yo acm is giving away free chipotle at leavey, about 3 bowls left  
**troy -> C:** react if u want one  
**troy -> B:** it's about a 1 min walk from u  
**troy -> D:** react if u want one  
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
`GET /api/panel -> {"id":3,"clubName":"acm","description":"chipotle","locationText":"leavey","servingsTotal":3,"servingsLeft":2,"status":"live","reports":0,"isExample":false,"claims":{"held":1,"picked_up":0,"released":0},"expiresAt":1794699496447,"createdAt":1794692296447}`  

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
`GET /api/panel -> {"id":3,"clubName":"acm","description":"chipotle","locationText":"leavey","servingsTotal":3,"servingsLeft":0,"status":"ended","reports":0,"isExample":false,"claims":{"held":0,"picked_up":2,"released":0},"expiresAt":1794699496447,"createdAt":1794692296447}`  

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

## e. Flow 4: USG question and concern

_A question the directory answers_

**B:** how does my club get funding  
**troy -> B:** recognized student orgs and usc undergrads can apply for usg funding on engagesc.  
**troy -> B:** apps are due wednesdays by 11:59pm, six academic weeks before the event (or nine before the first payment is due, whichever comes first), and an rso can get up to 4 events funded a semester as long as it stays under $8,000 from usg a year.  
**troy -> B:** the senate was looking at changing the deadline rules in oct 2026, so double check the page before u plan around them.  
**troy -> B:** https://usg.usc.edu/branches/funding/  

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
**troy -> B:** alerts: on. topics: free food. within a 15 min walk. quiet hours: off  
**troy -> B:** usual spots: leavey  
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

## g. Demo panel data after all of the above (`/api/panel`)

The public payload has no hidden details and no pickup codes (checked). The first matches listed are the live ones from the conversations above, then the seeded example pairs.

```
counts: {"found": 19, "lost": 20, "matches": 47, "returned": 3}

matches (first 7 of 40 returned):
- #47 keys <-> keys | confidence 75 (fallback) | verified | same kind of item (keys); 2 specific details line up with the owner's description; found right where it was lost; lost and found within two days
- #45 hydro flask <-> water bottle | confidence 90 (fallback) | verified | same kind of item (water bottle); same brand; 2 specific details line up with the owner's description; found right where it was lost; lost and found within two days
- #44 earbuds <-> earbuds | confidence 83 (fallback) | verified | same kind of item (earbuds); 4 specific details line up with the owner's description; found right where it was lost; lost and found within two days
- #46 earbuds <-> earbuds | confidence 55 (fallback) | rejected | same kind of item (earbuds); found right where it was lost; lost and found within two days
- #37 gray patagonia fleece <-> gray patagonia fleece | confidence 100 (fallback) | proposed | same kind of item (clothing); same color (gray); same brand; 3 specific details line up with the owner's description; found right where it was lost; lost and found within two days
- #11 blue hydro flask <-> blue hydro flask | confidence 100 (fallback) | proposed | same kind of item (water bottle); same color (blue); same brand; 2 specific details line up with the owner's description; found right where it was lost; lost and found within two days
- #1 black airpods pro case <-> black airpods pro case | confidence 100 (fallback) | proposed | same kind of item (earbuds); same color (black); same brand; 2 specific details line up with the owner's description; found right where it was lost; lost and found within two days

verifications:
- match #47 finder_confirm | score None | pass | try 1
- match #46 finder_confirm | score None | fail | try 1
- match #45 finder_confirm | score None | pass | try 1
- match #45 blind_description | score 87 | pass | try 1
- match #44 finder_confirm | score None | pass | try 1
- match #44 blind_description | score 90 | pass | try 1

handoffs:
- match #47 relay | pickup code on file: False | completed: True | thank-you: None
- match #45 dps_code | pickup code on file: True | completed: True | thank-you: None
- match #44 group_chat | pickup code on file: False | completed: True | thank-you: thank u so much, u saved my week

food drops:
- acm, chipotle at leavey | 0 of 3 left | ended | claims {"held": 0, "picked_up": 2, "released": 0}
- Dumpling Night Collective (example club), boxes of veggie fried rice and potstickers left over from our meeting at tcc 2nd floor | 12 of 20 left | live | claims {"held": 0, "picked_up": 0, "released": 0} | example
- Cardinal Robotics Build Team (example club), bagels, cream cheese and fruit from our morning workshop at ronald tutor hall lobby | 0 of 30 left | ended | claims {"held": 0, "picked_up": 0, "released": 0} | example
hidden keys in public payload: [] False False
```
