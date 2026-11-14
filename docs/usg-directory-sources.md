# USG directory sources

Sources for every row in `src/db/seed-data/directory.json`. All pages were fetched on 2026-11-14. Pages were read through an automated fetch that summarizes the page, so anything Troy will text to many people is worth one human look at the linked page first.

Rows with `isExample: true` have something unconfirmed and their details tell the student to check with USG.

Two rows, the USG LAX shuttle and USG thrift, rest on USG's own statement: the USG president said at the hackathon opening session on Nov 14, 2026 that USG runs an LAX shuttle, a farmers market and a thrift, and funds RSOs. John's decision that evening ("Trust USG's own statements" in `CLAUDE.md`) is that Troy states those programs exist plainly, without hedging. Dates, prices and links still only come from confirmed sources. Neither row has one, so both tell the student to ask USG and give only the general contact.

## usg_program rows

### USG LAX shuttle (isExample false, url null)

- Stored text: "usg runs a shuttle to lax around breaks. hit up usg for this year's dates and how to sign up."
- That USG runs it: the USG president's statement at the Nov 14 opening session. The pages below back it up for earlier years.
- USG has run a shuttle between LAX and campus around breaks: https://usg.usc.edu/blog/2024/04/02/scup-update/ (USG post dated Apr 2, 2024, about the SCUP shuttle pilot that started in 2022-23). Secondary: https://dailytrojan.com/2025/01/15/usg-presents-fire-response-shuttle-services/ (USG hosted a return shuttle from LAX on Jan 11 to 12, 2025).
- A March 2026 USG press release mentions a "USC Transportation Shuttle Program" presented to the senate: https://usg.usc.edu/blog/2026/03/11/march-3rd-2026-senate-press-release/
- General contact usg@usc.edu: https://usg.usc.edu/contact/
- Not confirmed: any USG shuttle dates, price, ticket link or pickup spot for 2026-27. Nothing on usg.usc.edu (home, resources, newsroom, calendar page) lists one. So the row has no date, price or link and its url stays null.

Related and confirmed, but run by USC Transportation, not USG (not in the JSON because it is an office, not a USG program):

- Thanksgiving LAX shuttles leave Widney Alumni House Nov 24 to 25, 2026, hourly from 8am to 5pm. Reservations are first come, first served and close at 11:59pm on Nov 20 or when seats fill. Winter recess dates "will be announced closer to the winter break." Source: https://dps.usc.edu/services/shuttles/
- Reservation link given on that page: https://transnet.usc.edu/index.php/shuttle-reservations/ (needs USC login, so not read).
- Cost for 2026 is not stated on the page. (2023 and 2024 notices on https://transnet.usc.edu/index.php/news-announcements/ called it free, with a $20 no-show fee in 2024. Not confirmed for 2026.)

### USG farmers market (isExample false)

- Trojan Farmers Market on Nov 18, 2026 and Dec 2, 2026, McCarthy Quad (this page says 10:00 am to 2:00 pm): https://hospitality.usc.edu/upcoming-events/
- Weekly market, a different campus partner featured each week, EBT can be used for fruits, vegetables, nuts, eggs and honey: https://hospitality.usc.edu/event/trojan-farmers-market-36/
- Not confirmed: USG's role in the market this year. The official pages present it as a USC Hospitality event and do not mention USG. The only source tying USG to it is a 2013 Daily Trojan article (https://dailytrojan.com/2013/08/28/quad-hosts-farmers-market/). The details text therefore says "listed by usc hospitality" and makes no USG claim. The row name follows the build spec.
- Time conflict, confirmed in the Nov 14 fact-check: calendar.usc.edu ("Trojan Farmers Market Presented by USC Hospitality", https://calendar.usc.edu/event/trojan-farmers-market-presented-by-usc-hospitality-8341) lists Nov 18 and Dec 2, 2026 as 11am to 3pm, while hospitality.usc.edu lists both as 10:00 am to 2:00 pm. Two official pages disagree, so the row no longer states one time. It tells the student about both and gives the overlap (11am to 2pm). Both pages agree on the dates, McCarthy Quad and the EBT wording.
- The EBT sentence is on the event pages (trojan-farmers-market-36 for Nov 18, -37 for Dec 2) and on calendar.usc.edu, not on the upcoming-events page the row links to.
- The two dates go stale after Dec 2, 2026. Spring 2027 dates were not listed.

### USG thrift (isExample false, url null)

- Stored text: "usg runs a thrift for students. ask usg where and when the next one is."
- That USG runs it: the USG president's statement at the Nov 14 opening session, as recorded in `docs/troy-build-spec.md`. That statement is the only source. It was not found on any official page.
- General contact usg@usc.edu: https://usg.usc.edu/contact/
- Not confirmed: name, dates, location, cost, link. Searches of usg.usc.edu, usc.edu, Daily Trojan and Annenberg Media found no USG thrift for 2026. So the row has no date, place or link and its url stays null.
- Other free or cheap secondhand options turned up in search results only (not fetched, not in the JSON): Tommy's Closet (USC Sustainability with Student Basic Needs) and USC Surplus Sales pop-ups. Neither is a USG program.

### USG RSO funding (isExample false)

All from https://usg.usc.edu/branches/funding/ (page shows a remaining-funding note dated September 28, 2026):

- Who: "Recognized Student Organizations and USC undergraduate students."
- How: USG Funding Application on EngageSC (the Apply link goes to an engage.usc.edu login).
- Deadline: "Applications must be submitted on Wednesdays by 11:59 PM six academic weeks before the event date when using an approved vendor, and or nine academic weeks before the initial payment due date (whichever comes first) for approved USC Vendors."
- Caps: "Each RSO can have up to 4 events funded per semester as long as it remains under $8,000 from the USG Funding Department per year."
- Questions go to usgfunds@usc.edu.
- The page says "under $8,000", so the row now says "stays under $8,000" instead of "up to $8,000". The page was last modified Oct 30, 2026.
- Watch: the Oct 27, 2026 senate considered SB 146-09, which changes funding guidelines and deadlines (https://usg.usc.edu/blog/2026/11/03/oct-27-2026-senate-press-release/). The release does not say whether it passed, so the deadline wording could change. The row now tells the student to double check the page.

## usg_committee rows

Committee names and descriptions: https://usg.usc.edu/branches/standing-committees/ and https://usg.usc.edu/legislative-branch/
Chair role emails: https://usg.usc.edu/meet-our-team-legislative/meet-our-team-committees/

USG has no committee named for dining, safety, housing or transportation. The topic mapping below is Troy's, based on each committee's official description. That mapping is an inference, not something USG states.

| Row | Flow 4 topic | Basis for mapping | Contact source |
| --- | --- | --- | --- |
| Committee on Sustainability and Campus Infrastructure | dining, safety | Description: "infrastructure, safety, hospitality, and sustainable operations on campus" | usgcosaf@usc.edu (committees page) |
| Committee on Affordability and Basic Needs | housing | Description: "student's financial barriers on-campus, access to basic needs". Housing is not named in it. | usgaffbn@usc.edu (committees page) |
| Committee on Academic Affairs | academics | Description: "academic experience and learning environment for undergraduate students" | usgacaf@usc.edu (committees page) |
| Committee on External Affairs (isExample true) | transportation | Description: "the immediate USC surrounding community" and local government; past project "Fryft Expansion". Transportation is not named in it. | The committees page lists usgacaf@usc.edu for this chair too, the same address as Academic Affairs, which looks like a page error. Row uses the general usg@usc.edu instead. |
| Committee on Wellness Affairs | (extra) | Description: well-being and "sexual, mental, spiritual, and physical" health | usgwelaf@usc.edu (committees page) |
| Committee on Accessibility Affairs | (extra) | Description: ADA compliance and needs of students with disabilities | usgaccaf@usc.edu (committees page) |
| USG Funding Department | club funding | https://usg.usc.edu/branches/funding/ | usgfunds@usc.edu (funding page) |
| USG general contact | other | https://usg.usc.edu/contact/ | usg@usc.edu. Senate "every Tuesday at 7pm in TCC 450": https://usg.usc.edu/legislative-branch/ (page last modified Aug 18, 2026). "Anyone can come" was not stated anywhere, so the row now uses the open forum line from the Oct 27, 2026 press release: "Each Senate meeting includes an open forum". That release repeats Tuesday 7 p.m. but gives no room. |

Why most committee rows are `isExample: false`: the name, description and a public role email each come from an official USG page. The build spec says to mark committee entries as example data; flip these to true if you want to follow the spec strictly.

## Fact-check pass, 2026-11-14

Every row with `isExample: false` or a non-null url or contact was re-fetched and the raw HTML was searched for each number, email, date and quoted phrase (not just a summary of the page).

Changed in `directory.json`:

- USG farmers market: removed the single 10am to 2pm time (official pages conflict, see above). Changed "listed by" to "put on by" USC Hospitality (calendar.usc.edu title says "Presented by USC Hospitality").
- USG RSO funding: "up to $8,000" became "stays under $8,000 from usg", plus a line to double check deadlines because of SB 146-09.
- USG general contact: "anyone can come" replaced with the open forum wording.

Checked and left as is:

- All five chair role emails and usgfunds@usc.edu and usg@usc.edu are in the page HTML. The committees team page was last modified Oct 23, 2026, so it reflects this fall.
- External Affairs still shows usgacaf@usc.edu (same as Academic Affairs) on that page, so the row stays `isExample: true` with the general inbox.
- https://usg.usc.edu/branches/standing-committees/ (the url on the committee rows, and the source of the descriptions) was last modified Feb 8, 2024 and lists no emails. The committee names match the Oct 2026 team page, but the descriptions are only as current as that 2024 page.
- `offices.json`: DPS Lost & Found (213-740-9759, lostandfound@dps.usc.edu, 3667 McClintock Ave, 90 days), FMS ((213) 740-6833 for UPC, service request link resolving to https://usc.assetworks.cloud/ready, which the FPM pages wrap in a urldefense.com redirect) and USC Housing (Work Orders link https://hsmtma.usc.edu:444/home.html, (800) 872-4632, housing@usc.edu) all match their pages. No changes.
- DPS numbers in `src/commands.ts` match https://dps.usc.edu/contact/ (UPC 213-740-4321 and 213-740-6000, HSC 323-442-1000 and 323-442-1200).

## Update, Nov 14 evening: USG's own statements

- USG LAX shuttle and USG thrift: `isExample` went from true to false and the "i couldn't confirm" wording came out. Both now say plainly that USG runs the program, on the strength of the USG president's statement at the Nov 14 opening session, and send the student to USG for dates. No date, price or link was added, and `contactMethod` is still usg@usc.edu.
- Why `isExample` is false: the flag marks rows with something unconfirmed in them, and `src/flows/usg.ts` adds "i'd check with usg" to any program row that has it. Nothing left in these two rows is unconfirmed (they state only that the program exists), and the extra line would hedge a sentence that is meant to be plain.
- The farmers market row was left as it was. Its dates, place and EBT details come from USC Hospitality pages, which is why it names Hospitality.

## Could not confirm

- Which of the two farmers market time listings is right (10am to 2pm or 11am to 3pm).
- Whether the 2024 standing-committees descriptions still describe each committee's scope this year.

- Any USG LAX shuttle for 2026-27: dates, price, ticket link, pickup spot. (That USG runs one is taken from the president's statement.)
- Any USG thrift: an official page for it, dates, place, cost, link. (That USG runs one is taken from the president's statement.)
- USG's current role in the Trojan Farmers Market, and spring 2027 market dates.
- The committees team page shows no academic year label, but it was last modified Oct 23, 2026. The Advocacy and Programming pages are labeled 2025-26.
- The External Affairs chair's own email.
- Whether SB 146-09 passed and changed funding deadlines.
- The remaining-funding dollar amount (the page shows the Sept 28, 2026 note, but the number did not load).
- 2026 cost of the USC Transportation LAX shuttle.
- USG Instagram and EngageSC were not read (login walls).

Seen but left out: USG Period Pantry (free menstrual products; only source was Annenberg Media, https://www.uscannenbergmedia.com/2026/09/29/usg-passes-a-bill-to-continue-funding-for-the-period-pantry/, not an official page) and the FMS RSO Cost Waiver Fund (described on https://usg.usc.edu/resources/rsos/ with no visible apply link or date).
