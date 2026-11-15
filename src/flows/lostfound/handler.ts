// Flow 1, lost and found: the conversation on top of match.ts, verify.ts and vision.ts.
// Every reply here is a fixed lowercase template, so the whole flow works with no API key.
// The facts are locked and the wording is varied: see LF_POOLS for which lines have variants and which never do.
// Code decides every threshold, attempt limit, pickup code, contact rule and DPS detail.
//
// STATE MACHINE (flow_state.flow = "lost_found", one open step per user, data always carries what it needs)
//
// Every step accepts "nvm" / "cancel" (see cancelStep). "free text" steps take any words as the answer.
// "choice" steps reprompt on something they can't read, and stay silent (state kept) when the message is
// for another flow, so the pipeline hands it to that flow and the question is still pending afterwards.
//
// FINDER
// step            | Troy asked                               | accepts                    | goes to
// ----------------|------------------------------------------|----------------------------|------------------------------------------
// (none)          | -                                        | photo, or "found a ..."    | dangerous: saved for dps, done. no item named: found_what.
//                 |                                          |                            | no place: found_place. else listing saved, matching runs.
// found_what      | "what is it?"                            | free text (new photo: restart) | found_place, or listing saved
// found_place     | "where'd u find it?"                     | a place, or idk            | found_marks, or listing saved, matching runs
// found_marks     | "anything on it only the owner would know?" | free text, or idk       | listing saved, matching runs. only asked when no photo could be
//                 |                                          |                            | read and the finder's words say nothing specific about the item.
// finder_check    | owner's words + "sound like what u found?" | yes / no (or a tapback)  | yes: verified, handoff. no: match rejected, owner keeps looking.
// finder_decide   | "couldn't confirm this person. ur call"  | 1 / 2 / 3                  | 1: meet (consent or relay). 2: dps. 3: keep holding. 2 and 3 reject the match.
// handoff_choice  | "1) hold it and meet them, 2) drop it at dps" | 1 / meet, 2 / dps     | meet: gc_consent for both, or relay. dps: pickup code to both.
// gc_consent      | "that shares ur contact info. ok?"       | yes / no (or a tapback)    | both yes: group chat (relay if it fails). any no: relay.
//
// OWNER
// step            | Troy asked                               | accepts                    | goes to
// ----------------|------------------------------------------|----------------------------|------------------------------------------
// (none)          | -                                        | "lost my ..."              | lost_category / lost_place / lost_time, one at a time, then saved + matched
// lost_category   | "what'd u lose?"                         | the item, or idk           | next missing question, or saved
// lost_place      | "where do u think u lost it?"            | a place, or idk            | next missing question, or saved
// lost_time       | "when'd u last have it?"                 | a rough time, or idk       | saved. a fit on kind, color, brand, place and time: verify_describe. else stays open.
// verify_describe | "describe it for me in ur own words"     | free text                  | pass: verified, handoff. miss with tries left: stays. out of tries:
//                 |                                          |                            | item at dps: dps in person, match rejected. finder has it: proof.
//                 |                                          |                            | pass on the rule score only (AI down), or nothing on file to check
//                 |                                          |                            | against: never verified on that alone. finder has it: finder_check
//                 |                                          |                            | (finder). item at dps: dps in person.
// proof           | "old photo of it, or a find my screenshot?" | a photo, or no          | same item: verified. no / no match / can't check: finder_decide (finder).
// await_finder    | "i'll text u back either way"            | (nothing to answer)        | any text gets "still waiting to hear back". ends when the finder answers.
// gc_consent      | (same as the finder's)                   | yes / no (or a tapback)    | stays (answered) until the finder answers too, then await_pickup
// await_pickup    | "text me got it once it's back with u"   | got it                     | listings returned, thanks_note. "code" sends the pickup code again.
// thanks_note     | "want to send the finder a thank-you?"   | free text, or skip         | note relayed, "that's a win. fight on" with confetti to both, done
//
// WHAT A CLAIMANT CAN LEARN
// Whether Troy acts on a report, and what it says first, depends only on kind, color, brand, place and time
// (publicScore). The finder's hidden details never move anything a claimant sees before they describe the item,
// so re-reporting with different words tells them nothing. Every description that is scored counts as a try,
// tries are counted per found item and person (never per report), and backing out resets nothing.
//
// ONE OPEN STEP PER PERSON
// A question for someone who is busy with another step waits in pending_asks (src/pending.ts) and is asked
// when they are free. Another person's step is only ever cleared when it belongs to the same match.
//
// NOTHING STAYS LOCKED
// A claim nobody is moving is released (sweepClaims): after an hour when someone else is waiting on the item,
// after a day otherwise. STOP and "delete my data" release at once. Every release looks for the next owner.
//
// A claimant sees only the public summary of a found item (and after they pass, still nothing hidden).
// The finder is the only one who is ever shown the other person's description.

import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowContext, FlowHandler, FlowState, IncomingImage, MessagingAdapter, User } from "../../types.ts";
import { getFlowState, getSetting, getUserById, setFlowState, setSetting } from "../../db/index.ts";
import type { SweepIo } from "../../pending.ts";
import { dropPending, isBusy, isProtected, onSweep, onUserGone, parkAsk, registerPendingHooks } from "../../pending.ts";
import { pullDetails } from "../../ai.ts";
import { findPlace } from "../../places.ts";
import { RELAY_COPY, endRelayByContext, onRelayEnd, startRelay } from "../../relay.ts";
import type { Pools, Voice } from "../reports-shared.ts";
import { makeVoice } from "../reports-shared.ts";
import type { Category, ItemProfile, LostReport } from "./types.ts";
import { canonTokens, isColorWord, isGenericWord, normalizeCategory } from "./types.ts";
import type { MatchResult } from "./match.ts";
import { findCandidates, loadListing, matchListing, publicScore } from "./match.ts";
import { THRESHOLDS, generatePickupCode, nameMatches, scoreDescription } from "./verify.ts";
import { profileItem, sameItem, sanitizeProfile } from "./vision.ts";

// ---------- fixed copy ----------

export const COPY = {
  askWhat: "what is it?",
  askFoundPlace: "where'd u find it?",
  askMarks: "anything on it only the owner would know? stickers, marks, a case, a name. that part stays between us",
  dangerous: "that one goes to dps, please don't carry it around",
  holdOnto: "hang onto it for now. i'll text u when the owner turns up",
  finderHeadsUp: "someone might already be looking for this. checking with them now",
  askLostWhat: "oh no. what'd u lose?",
  askLostPlace: "where do u think u lost it? idk is fine",
  askLostTime: "when'd u last have it? rough is fine",
  checking: "on it. checking what's been turned in",
  nothingYet: "nothing yet, still looking",
  willText: "i'll text u the second something turns up",
  mightHave: "might have something",
  turnedUp: "something like what u lost just turned up",
  quickCheck: "quick check first",
  describe: "describe it for me in ur own words. anything only the owner would know, like marks, stickers or what's on it",
  passed: "that checks out. it's urs",
  retry: ["hmm, that doesn't line up with what i have", "one more try. describe it again, anything specific u remember"],
  cantConfirmDescription: "couldn't confirm it from ur description",
  cantConfirm: "something like it turned up, but i couldn't confirm it's urs",
  askProof: "got an old photo of it, or a find my screenshot? send it here, or say no",
  dpsInPerson: "can't confirm this one by text, dps can help u in person",
  askingHolder: "i'll ask the person holding it and text u back either way",
  stillWaiting: "still waiting to hear back from the person holding it. i'll text u either way",
  checkingHolder: ["ok. running that by the person who found it", "i'll text u back either way"],
  finderCheck: "sound like what u found? yes or no",
  finderCall: "couldn't confirm this person. ur call: 1) meet them anyway, 2) drop it at dps, 3) keep holding it in case someone else claims it",
  meetBusy: "meet somewhere busy, in the daytime if u can",
  handoffAsk: "how do u wanna hand it off? 1) hold it and meet them, 2) drop it at dps",
  consent: "i'll add u both to a group chat. heads up, that shares ur contact info. ok?",
  groupFirst: "handing you off. one of u found it and one of u lost it, so pick a busy spot to meet. i'll step back now",
  gotItHint: "text me got it once it's back with u",
  waitingConsent: "still waiting on them to ok it. i'll text u when they do",
  timedOut: ["that check timed out, so i let it go for now", "text me still looking and i'll pick it right back up"],
  holderQuiet: ["the person holding it never got back to me, so i couldn't confirm it", "ur report's still open and i'll keep looking"],
  lostTouch: ["lost touch with the person on the other end of that one, sorry", "ur report's still open and i'll text u if it turns up again"],
  claimDropped: "the person asking about that one dropped it. i'll text u if someone else asks",
  askThanks: "want to send the finder a quick thank-you? text it here and i'll pass it on. or say skip",
  win: "that's a win. fight on 🎉",
  sorted: "that one's already sorted. text me if u need anything",
  which: "did u lose something or find something? if u found it, send me a pic",
  needWords: "tell me in words and i'll take it from there",
  describeWords: "describe it in words for me",
  nameMatched: "the name on it matches ur usc account, so ur good",
  howDescribed: "here's how they described it:",
  finderNo: "ok, not a match. i'll keep looking for the owner",
  finderYes: "good news. the person who found it says it sounds like urs",
  proofSame: "that's the same one. it's urs",
  proofUnsettled: "that pic didn't settle it",
  proofCantCheck: "can't check photos rn",
  proofHow: "send a pic of it if u have one, or say no",
  cantConnect: "couldn't confirm this one's urs, so i can't connect u",
  reportStaysOpen: "ur report stays open in case another one turns up",
  okToMeet: "the person holding it is ok to meet u",
  dropAtDpsOk: "ok, drop it at dps lost and found when u can",
  dropAtDps: "drop it at dps lost and found when u can",
  takeFromThere: "they'll take it from there",
  holderDropping: "the person holding it is dropping it there",
  keepHolding: "ok, hang onto it. i'll text u if someone else claims it",
  checkingHandoff: "checking how the finder wants to hand it off. i'll text u right back",
  atDps: "it's at dps lost and found",
  finderDropping: "the finder's dropping it at dps lost and found",
  finderDown: "the finder's down to meet up and hand it back",
  /** Goes with the contact-sharing warning, so it stays word for word too. */
  consentHow: "reply yes for the group chat, or no and i'll pass messages between u instead",
  noGroup: "no group chat then",
  groupFailed: "couldn't start the group chat",
  waitingThem: "cool. waiting on them to ok it too",
  inGroupFinder: "ur both in a group chat now. thanks for looking out",
  inGroupOwner: "ur both in a group chat now",
  loveThat: "love that",
  gladBack: "glad u got it back",
  closedReport: "closed out ur report",
  didYouGet: "did u get it back? text me got it when u do",
  noHandoffAnswer: "didn't hear back on the handoff, so dps it is",
  dropped: "ok, dropped it. text me if u need me",
  stoppedOpen: "ok, stopped. ur report's still open and i'll text u if something turns up",
  stillTextIfYes: "ok. i'll still text u if the person holding it says it's urs",
  skipping: "ok, skipping that one",
  ownerWaitingDps: "ok. the owner's waiting on it tho, so dps it is",
  gotItWhenever: "ok. text me got it back whenever u have it",
  reply123: "reply 1, 2 or 3",
  reply12: "reply 1 to meet them or 2 to drop it at dps",
  noCode: "no code on this one. u two are sorting the handoff directly",
  noRush: "no rush. text me got it when u do",
  soundsGood: "sounds good",
};

/** Lines with a value in them (a summary, a pickup code). Code puts the value in; these only hold the words around it. */
const T = {
  logged: (summary: string) => `logged it: ${summary}`,
  finderClaims: (summary: string, theirs: string) => `someone says the ${summary} u found ${theirs}`,
  tryingToClaim: (summary: string) => `someone's trying to claim the ${summary} u found`,
  nudge: (things: string) => `dps is safest for ${things}, but ur call`,
  ownerCheckedOut: (summary: string) => `the owner of the ${summary} u found just checked out`,
  ownerCheckedOutDps: (summary: string) => `the owner of the ${summary} u turned in just checked out`,
  theirCode: (code: string) => `their pickup code is ${code}`,
  tellCode: (code: string) => `tell them it's for pickup code ${code}`,
  urCode: (code: string) => `ur pickup code is ${code}`,
  thanksFrom: (summary: string) => `the owner of the ${summary} wanted u to have this:`,
};

// ---------- wording variants (facts locked, wording varied) ----------
//
// Variant 0 of every pool is the line the code writes. The others say the same thing with the same values.
// NOT in any pool, so always word for word: COPY.dangerous (the dangerous-item line), COPY.consent and
// COPY.consentHow (the contact-sharing warning and its yes/no), COPY.groupFirst (the group chat's first
// message), COPY.win (the confetti line), the dps address / hours / contact lines (directory text), relay
// copy, and anyone's quoted words.
//
// SECURITY (what a claimant can learn): which variant goes out is picked from the person and the pool's name
// by the picker's own rotation. Nothing about the match score, the description score or the hidden details
// is ever an input, and no pool is chosen by score either: a miss always reads from the same pools whether it
// was off by a little or a lot. None of the miss wordings say or hint which part was wrong or how close it was.
export const LF_POOLS: Pools = {
  // finder: reporting
  askWhat: [COPY.askWhat, "what'd u find?", "what kind of thing is it?"],
  askFoundPlace: [COPY.askFoundPlace, "where was it?", "where'd u spot it?", "whereabouts did u find it?"],
  askMarks: [
    COPY.askMarks,
    "is there anything on it only the owner would know? a sticker, a mark, a case, a name. i keep that part between us",
    "what's on it that only the owner would know? stickers, marks, a case, a name. that stays between us",
  ],
  logged: (summary) => [T.logged(summary), `got it logged: ${summary}`, `ok, it's logged: ${summary}`],
  holdOnto: [COPY.holdOnto, "keep it with u for now. i'll text u when the owner turns up", "hold onto it for now, and i'll text u once the owner turns up"],
  finderHeadsUp: [COPY.finderHeadsUp, "i think someone's already looking for this. checking with them now", "someone may be looking for this already. checking with them now"],

  // owner: reporting
  askLostWhat: [COPY.askLostWhat, "ah no. what'd u lose?", "oh no, what's missing?"],
  askLostPlace: [COPY.askLostPlace, "any idea where u lost it? idk is fine", "where do u think it went missing? idk is fine"],
  askLostTime: [COPY.askLostTime, "when did u last see it? rough is fine", "when's the last time u had it? rough is fine"],
  checking: [COPY.checking, "on it. looking through what's been turned in", "on it, checking what's been turned in rn"],
  nothingYet: [
    [COPY.nothingYet, COPY.willText],
    ["nothing yet. still looking", "i'll text u as soon as something turns up"],
    ["nothing's turned up yet, still looking", "the second something does, i'll text u"],
  ],
  which: [COPY.which, "is this something u lost or something u found? if u found it, send me a pic", "lost something or found something? if u found it, send me a pic"],
  needWords: [COPY.needWords, "type it out for me and i'll take it from there", "i need it in words. tell me and i'll take it from there"],

  // the claim: every claimant gets these, whatever the scores say
  mightHave: [COPY.mightHave, "i might have something", "think i might have something", "may have something here"],
  turnedUp: [COPY.turnedUp, "something that looks like what u lost just turned up", "hey, something like what u lost just turned up"],
  quickCheck: [COPY.quickCheck, "quick check first tho", "just a quick check first"],
  describe: [
    COPY.describe,
    "tell me about it in ur own words. anything only the owner would know, like marks, stickers or what's on it",
    "describe it in ur own words for me. marks, stickers, what's on it, anything only the owner would know",
  ],
  describeWords: [COPY.describeWords, "i need it in words. describe it for me", "can u describe it in words?"],
  passed: [COPY.passed, "yep, that checks out. it's urs", "that lines up. it's urs"],
  nameMatched: [COPY.nameMatched, "the name on it matches ur usc account. ur good", "name on it matches ur usc account, so ur all set"],
  // After a miss. Same pools for every miss, and no wording here says what was wrong or how near it was.
  retry: [
    COPY.retry,
    ["that doesn't match what i have", "u get one more try. describe it again with anything specific u remember"],
    ["hmm, that's not lining up with what i have", "one more try. tell me again, anything specific u remember"],
  ],
  cantConfirmDescription: [COPY.cantConfirmDescription, "i couldn't confirm it from ur description", "wasn't able to confirm it from ur description"],
  cantConfirm: [COPY.cantConfirm, "something like it turned up, but i wasn't able to confirm it's urs", "something like it did turn up, but i couldn't confirm it's urs"],
  askProof: [
    COPY.askProof,
    "do u have an old photo of it, or a find my screenshot? send it here, or say no",
    "an old photo of it or a find my screenshot would help. send it here, or say no",
  ],
  proofHow: [COPY.proofHow, "if u have a pic of it, send it here. or say no", "send me a pic of it if u've got one, or say no"],
  proofSame: [COPY.proofSame, "yep, that's the same one. it's urs", "that's the one. it's urs"],
  proofUnsettled: [COPY.proofUnsettled, "that pic wasn't enough to settle it", "couldn't settle it from that pic"],
  proofCantCheck: [COPY.proofCantCheck, "i can't check photos rn", "photos aren't something i can check rn"],
  dpsInPerson: [COPY.dpsInPerson, "i can't confirm this one over text. dps can help u in person", "this one i can't confirm by text, but dps can help u in person"],
  askingHolder: [COPY.askingHolder, "i'll check with the person holding it and text u back either way", "let me ask the person holding it. i'll text u back either way"],
  stillWaiting: [
    COPY.stillWaiting,
    "haven't heard back from the person holding it yet. i'll text u either way",
    "no word yet from the person holding it. i'll text u either way",
  ],
  checkingHolder: [
    COPY.checkingHolder,
    ["ok, checking that with the person who found it", "either way, i'll text u back"],
    ["got it. running that by the person who found it", "i'll text u back whichever way it goes"],
  ],
  finderYes: [COPY.finderYes, "good news. the person who found it says that sounds like urs", "good news, the person who found it thinks it sounds like urs"],
  cantConnect: [COPY.cantConnect, "i couldn't confirm this one's urs, so i can't connect u", "wasn't able to confirm this one's urs, so i can't connect u"],
  reportStaysOpen: [COPY.reportStaysOpen, "ur report's staying open in case another one turns up", "i'm keeping ur report open in case another one turns up"],
  okToMeet: [COPY.okToMeet, "the person holding it is good to meet u", "the person holding it said ok to meeting u"],
  timedOut: [
    COPY.timedOut,
    ["that check ran out of time, so i let it go for now", "text me still looking and i'll pick it back up"],
    ["that check timed out, so i set it aside for now", "just text me still looking and i'll pick it right back up"],
  ],
  holderQuiet: [
    COPY.holderQuiet,
    ["i never heard back from the person holding it, so i couldn't confirm it", "ur report is still open and i'll keep looking"],
    ["the person holding it didn't get back to me, so i couldn't confirm it", "ur report stays open and i'll keep looking"],
  ],
  lostTouch: [
    COPY.lostTouch,
    ["sorry, i lost touch with the person on the other end of that one", "ur report is still open and i'll text u if it turns up again"],
    ["i lost touch with the person on the other end of that one, sorry", "ur report stays open and i'll text u if it turns up again"],
  ],
  stoppedOpen: [
    COPY.stoppedOpen,
    "ok, i stopped. ur report's still open and i'll text u if something turns up",
    "ok, stopping there. ur report's still open and i'll text u if something turns up",
  ],
  stillTextIfYes: [
    COPY.stillTextIfYes,
    "ok. if the person holding it says it's urs, i'll still text u",
    "ok, no problem. i'll still text u if the person holding it says it's urs",
  ],

  // finder: the check and the call
  finderClaims: (summary, theirs) => [T.finderClaims(summary, theirs), `someone's saying the ${summary} u found ${theirs}`, `someone thinks the ${summary} u found ${theirs}`],
  tryingToClaim: (summary) => [T.tryingToClaim(summary), `someone wants to claim the ${summary} u found`, `someone's asking to claim the ${summary} u found`],
  howDescribed: [COPY.howDescribed, "this is how they described it:", "their description:"],
  finderCheck: [COPY.finderCheck, "does that sound like what u found? yes or no", "that sound like the one u found? yes or no"],
  finderNo: [COPY.finderNo, "ok, not a match then. i'll keep looking for the owner", "got it, not a match. i'll keep looking for the owner"],
  finderCall: [
    COPY.finderCall,
    "i couldn't confirm this person, so it's ur call: 1) meet them anyway, 2) drop it at dps, 3) keep holding it in case someone else claims it",
    "wasn't able to confirm this person. up to u: 1) meet them anyway, 2) drop it at dps, 3) keep holding it in case someone else claims it",
  ],
  reply123: [COPY.reply123, "just reply 1, 2 or 3", "need a 1, 2 or 3 from u"],
  claimDropped: [
    COPY.claimDropped,
    "the person who was asking about that one dropped it. i'll text u if someone else asks",
    "whoever was asking about that one dropped it. i'll text u if someone else asks",
  ],
  skipping: [COPY.skipping, "ok, i'll skip that one", "got it, skipping that one"],
  keepHolding: [COPY.keepHolding, "ok, keep it with u. i'll text u if someone else claims it", "ok, hold onto it. if someone else claims it i'll text u"],

  // handoff
  ownerCheckedOut: (summary) => [T.ownerCheckedOut(summary), `the owner of the ${summary} u found checks out`, `found the owner of the ${summary} u found, and they check out`],
  nudge: (things) => [T.nudge(things), `dps is the safest way for ${things}, but it's ur call`, `for ${things} dps is safest. ur call tho`],
  handoffAsk: [
    COPY.handoffAsk,
    "how do u want to get it back to them? 1) hold it and meet them, 2) drop it at dps",
    "how should we do the handoff? 1) hold it and meet them, 2) drop it at dps",
  ],
  reply12: [COPY.reply12, "just reply 1 to meet them or 2 to drop it at dps", "it's 1 to meet them or 2 to drop it at dps"],
  checkingHandoff: [
    COPY.checkingHandoff,
    "asking the finder how they want to hand it off. i'll text u right back",
    "seeing how the finder wants to hand it off. i'll text u right back",
  ],
  meetBusy: [COPY.meetBusy, "pick somewhere busy to meet, in the daytime if u can", "meet up somewhere busy, and in the daytime if u can"],
  finderDown: [COPY.finderDown, "the finder's good to meet up and hand it back", "the finder is down to meet and hand it back"],
  noGroup: [COPY.noGroup, "ok, no group chat", "no group chat, got it"],
  groupFailed: [COPY.groupFailed, "the group chat wouldn't start", "i couldn't get the group chat started"],
  waitingThem: [COPY.waitingThem, "cool, just waiting on them to ok it too", "got it. waiting on them to ok it too"],
  waitingConsent: [COPY.waitingConsent, "they haven't ok'd it yet. i'll text u when they do", "waiting on them to ok it still. i'll text u when they do"],
  inGroupFinder: [COPY.inGroupFinder, "u two are in a group chat now. thanks for looking out", "ur both in a group chat now. appreciate u looking out"],
  inGroupOwner: [COPY.inGroupOwner, "u two are in a group chat now", "ok, ur both in a group chat now"],
  ownerWaitingDps: [COPY.ownerWaitingDps, "ok. the owner is waiting on it tho, so it goes to dps", "ok, but the owner's waiting on it, so dps it is"],
  noHandoffAnswer: [COPY.noHandoffAnswer, "never heard back on the handoff, so dps it is", "didn't hear back about the handoff, so it goes to dps"],

  // dps and pickup codes (the code itself is put in by code, never reworded)
  ownerCheckedOutDps: (summary) => [T.ownerCheckedOutDps(summary), `the owner of the ${summary} u turned in checks out`, `found the owner of the ${summary} u turned in, and they check out`],
  theirCode: (code) => [T.theirCode(code), `the pickup code they'll use is ${code}`, `they'll pick it up with code ${code}`],
  dropAtDps: [COPY.dropAtDps, "take it to dps lost and found when u can", "when u get a chance, drop it at dps lost and found"],
  dropAtDpsOk: [COPY.dropAtDpsOk, "ok, take it to dps lost and found when u can", "ok. when u get a chance, drop it at dps lost and found"],
  tellCode: (code) => [T.tellCode(code), `let them know it's for pickup code ${code}`, `say it's for pickup code ${code} when u drop it`],
  takeFromThere: [COPY.takeFromThere, "they take it from there", "they'll handle it from there"],
  atDps: [COPY.atDps, "it's over at dps lost and found", "dps lost and found has it"],
  finderDropping: [COPY.finderDropping, "the finder is taking it to dps lost and found", "the finder's bringing it to dps lost and found"],
  holderDropping: [COPY.holderDropping, "the person holding it is taking it there", "the person holding it is bringing it there"],
  urCode: (code) => [T.urCode(code), `here's ur pickup code: ${code}`, `ur code for pickup is ${code}`],
  noCode: [COPY.noCode, "there's no code on this one. u two are sorting the handoff directly", "no pickup code here, u two are sorting the handoff directly"],
  gotItHint: [COPY.gotItHint, "text me got it when it's back with u", "once it's back with u, text me got it"],
  gotItWhenever: [COPY.gotItWhenever, "ok. whenever u have it, text me got it back", "ok, just text me got it back once u have it"],
  noRush: [COPY.noRush, "no rush at all. text me got it when u do", "take ur time. text me got it when u do"],
  didYouGet: [COPY.didYouGet, "did it make it back to u? text me got it when it does", "is it back with u yet? text me got it when it is"],
  soundsGood: [COPY.soundsGood, "sounds good to me", "ok, sounds good"],

  // closing the loop
  loveThat: [COPY.loveThat, "love to hear it", "so glad"],
  askThanks: [
    COPY.askThanks,
    "wanna send the finder a quick thank-you? text it here and i'll pass it along. or say skip",
    "if u want to thank the finder, text it here and i'll pass it on. or say skip",
  ],
  thanksFrom: (summary) => [T.thanksFrom(summary), `the owner of the ${summary} asked me to pass this on:`, `this is from the owner of the ${summary}:`],
  gladBack: [COPY.gladBack, "so glad u got it back", "glad it's back with u"],
  closedReport: [COPY.closedReport, "i closed out ur report", "ur report's closed out"],
  sorted: [COPY.sorted, "that one's already taken care of. text me if u need anything", "that one's sorted already. text me if u need anything"],
  dropped: [COPY.dropped, "ok, i dropped it. text me if u need me", "ok, it's dropped. text me if u need me"],
};

export const LF_VOICE: Voice = makeVoice("lost_found", LF_POOLS);

/** Proof photos only count when the same-item check is at least this sure. */
export const PROOF_MIN_CONFIDENCE = 70;

// ---------- small helpers ----------

type Data = Record<string, unknown>;
type Row = Record<string, unknown>;
type Step =
  | "found_what"
  | "found_place"
  | "found_marks"
  | "finder_check"
  | "finder_decide"
  | "handoff_choice"
  | "gc_consent"
  | "lost_category"
  | "lost_place"
  | "lost_time"
  | "verify_describe"
  | "proof"
  | "await_finder"
  | "await_pickup"
  | "thanks_note";

/** Steps where a thumbs up / heart means yes and a thumbs down means no. */
const TAP_STEPS = new Set<string>(["finder_check", "gc_consent", "await_pickup"]);
/** Open questions about a match. Another flow can't clear these, and a new question for the same person waits behind them. */
const ASK_STEPS = new Set<string>(["finder_check", "finder_decide", "handoff_choice", "gc_consent", "verify_describe", "proof"]);
/** Intake questions and the thank-you ask go stale: an answer hours later is a new message, not an answer. */
const INTAKE_STEPS = new Set<string>(["found_what", "found_place", "found_marks", "lost_category", "lost_place", "lost_time"]);
export const INTAKE_TTL_MS = 60 * 60 * 1000;
export const THANKS_TTL_MS = 30 * 60 * 1000;
/** A claim the claimant isn't moving is let go after this long once someone else is waiting on the item. */
export const CLAIM_TTL_MS = 60 * 60 * 1000;
/** With nobody else waiting, and for questions that sit with the finder, a full day. */
export const HOLD_TTL_MS = 24 * 60 * 60 * 1000;
/** IDs and cards are checked by the name printed on them. Anything else with a name on it is described like any other item. */
const NAME_CHECKED = new Set<Category>(["id_card", "wallet"]);
/** Steps where a photo can't be an answer, so it starts a new found report. */
const PHOTO_IS_NEW = new Set<string>(["found_what", "found_place", "found_marks", "finder_check", "finder_decide", "handoff_choice", "gc_consent", "await_finder", "await_pickup", "thanks_note"]);
const CHOICE_STEPS = new Set<string>(["finder_check", "finder_decide", "handoff_choice", "gc_consent", "await_finder", "await_pickup"]);

function word(text: string): string {
  return text.toLowerCase().replace(/[‘’'`]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

const CANCEL = /^(?:nvm|never ?mind|cancel|forget it|forget about it|scrap that|stop this)\b/;
const IDK = /^(?:idk|i dont know|dont know|not sure|no idea|dunno|no clue|unsure|i forget|i forgot|cant remember|i dont remember|dont remember|no)$|^(?:idk|not sure|no idea|dunno)\b/;
const SKIP = /^(?:skip|no|nah|nope|no thanks|im good|pass|none)\b/;
const NO = /^(?:n|no|nah|nope|not really|not it|dont think so|i dont think so|doesnt|pass|rather not|id rather not)\b/;
const YES = /^(?:y|yes|yea|yeah|yep|yup|ya|sure|ok|okay|k|kk|bet|fine|sounds good|go ahead|do it|for sure|definitely|i think so|thats it|thats the one|thats fine|works|down|im down)\b/;
const GOT_IT = /\b(?:got it|got them|have it|have them|picked it up|picked them up|got (?:it|them|my [a-z ]+) back|its back|received it)\b/;

const STILL_LOOKING = /\bstill (?:looking|lost|missing|gone|havent found|cant find|need (?:it|them))\b/;
const GREETING = /^(?:hey|hi|hello|yo|sup|troy|u up|you up|wyd)\b/;
const THANKS_WORDS = /\b(?:thank|thanks|thx|ty|tysm|appreciate|grateful|legend|lifesaver|life saver|saved|goat|bless)\b/;

function yesNo(w: string): boolean | null {
  if (NO.test(w)) return false;
  if (YES.test(w)) return true;
  return null;
}

function kindOf(category: string | null | undefined): string {
  const c = normalizeCategory(category);
  return c === "other" ? "item" : c.replace(/_/g, " ");
}

const PLURAL = new Set<Category>(["earbuds", "keys", "glasses"]);

// ---------- io: one way to talk to "me" and to the other person ----------

export interface LostFoundIo {
  db: DatabaseSync;
  /** The user whose message is being handled, or null when called from outside a conversation (dashboard). */
  me: number | null;
  say(userId: number, ...bubbles: (string | Bubble | null | undefined | false)[]): Promise<(string | null)[]>;
  setState(userId: number, step: Step | null, data?: Data): void;
  adapter: MessagingAdapter | null;
}

function ioFrom(ctx: FlowContext): LostFoundIo {
  return {
    db: ctx.db,
    me: ctx.user.id,
    adapter: ctx.adapter,
    async say(userId, ...bubbles) {
      const real = LF_VOICE.bubbles(ctx.db, userId, bubbles.filter((b): b is string | Bubble => !!b));
      if (!real.length) return [];
      // The other person in a claim is owed these: they are answers on their own report or the item they found,
      // so quiet hours don't hold them back (a dropped question would leave a step open on words nobody saw).
      return userId === ctx.user.id ? ctx.say(...real) : ctx.sayToOwed(userId, ...real);
    },
    setState(userId, step, data = {}) {
      ctx.setStateFor(userId, step ? { flow: "lost_found", step, data } : null);
    },
  };
}

// ---------- db helpers ----------

interface MatchRow {
  id: number;
  foundListingId: number;
  lostListingId: number;
  confidence: number;
  status: string;
  /** 1 when the claimant backed out or timed out. Not offered again until they report again. */
  parked: number;
}

function getMatch(db: DatabaseSync, id: number): MatchRow | null {
  const r = db.prepare("SELECT id, foundListingId, lostListingId, confidence, status, COALESCE(parked, 0) AS parked FROM matches WHERE id = ?").get(id) as MatchRow | undefined;
  return r ?? null;
}

function setMatch(db: DatabaseSync, id: number, status: string): void {
  db.prepare("UPDATE matches SET status = ?, touchedAt = ? WHERE id = ?").run(status, Date.now(), id);
}

function touch(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE matches SET touchedAt = ? WHERE id = ?").run(Date.now(), id);
}

function setListing(db: DatabaseSync, id: number, status: string): void {
  db.prepare("UPDATE listings SET status = ? WHERE id = ?").run(status, id);
}

function rawListing(db: DatabaseSync, id: number): { id: number; userId: number; status: string; heldBy: string | null; isDangerous: number; photoUrl: string | null; category: string | null } | null {
  const r = db.prepare("SELECT id, userId, status, heldBy, isDangerous, photoUrl, category FROM listings WHERE id = ?").get(id) as Row | undefined;
  if (!r) return null;
  return {
    id: r.id as number,
    userId: r.userId as number,
    status: r.status as string,
    heldBy: (r.heldBy as string) ?? null,
    isDangerous: Number(r.isDangerous) || 0,
    photoUrl: (r.photoUrl as string) ?? null,
    category: (r.category as string) ?? null,
  };
}

interface Pair {
  match: MatchRow;
  profile: ItemProfile;
  report: LostReport;
  finderId: number;
  ownerId: number;
  /** The only words about the found item anyone but the finder may see. */
  summary: string;
}

function loadPair(db: DatabaseSync, matchId: number): Pair | null {
  const match = getMatch(db, matchId);
  if (!match) return null;
  const found = loadListing(db, match.foundListingId);
  const lost = loadListing(db, match.lostListingId);
  if (!found || !lost || found.type !== "found" || lost.type !== "lost") return null;
  const profile = found.details as ItemProfile;
  return { match, profile, report: lost.details as LostReport, finderId: found.userId, ownerId: lost.userId, summary: profile.publicSummary || kindOf(profile.category) };
}

function addVerification(db: DatabaseSync, matchId: number, method: string, ownerAnswer: string | null, score: number | null, result: "pass" | "fail", attempts = 1): void {
  db.prepare("INSERT INTO verifications (matchId, method, ownerAnswer, score, result, attempts, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(matchId, method, ownerAnswer, score, result, attempts, Date.now());
}

/**
 * Blind descriptions this person has used up on this found item, across all of their lost reports: every miss,
 * and a description that is with the finder right now. Backing out or reporting again never lowers it.
 */
function usedTries(db: DatabaseSync, foundListingId: number, userId: number): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM verifications v
         JOIN matches m ON m.id = v.matchId
         JOIN listings l ON l.id = m.lostListingId
        WHERE m.foundListingId = ? AND l.userId = ? AND v.method = 'blind_description'
          AND (v.result = 'fail' OR (v.result IS NULL AND m.status = 'finder_check'))`,
    )
    .get(foundListingId, userId) as { n: number };
  return r.n;
}

/**
 * True when this person may not try this found item (again): they used up their tries, a check on them is
 * still with the finder, or they were rejected after a failed check. A new lost report never resets this.
 */
export function claimantBlocked(db: DatabaseSync, foundListingId: number, userId: number): boolean {
  if (usedTries(db, foundListingId, userId) >= THRESHOLDS.maxAttempts) return true;
  const r = db
    .prepare(
      `SELECT 1 FROM matches m
         JOIN listings l ON l.id = m.lostListingId
        WHERE m.foundListingId = ? AND l.userId = ?
          AND (m.status IN ('proof_requested','finder_deciding')
               OR (m.status = 'rejected' AND EXISTS (SELECT 1 FROM verifications v WHERE v.matchId = m.id AND v.result = 'fail')))
        LIMIT 1`,
    )
    .get(foundListingId, userId);
  return !!r;
}

/**
 * Put both listings back in the pool and mark the match. Used when a claim ends without a handoff.
 * `park` keeps this pair from being offered again until the claimant reports again. Callers follow up with
 * rematch() so the next owner waiting on the found item is picked up.
 */
function release(db: DatabaseSync, m: MatchRow, status: "proposed" | "rejected" | "proof_requested" | "finder_deciding", park = false): void {
  setMatch(db, m.id, status);
  if (park) db.prepare("UPDATE matches SET parked = 1 WHERE id = ?").run(m.id);
  db.prepare("UPDATE listings SET status = 'open' WHERE id IN (?, ?) AND status IN ('matched','verifying','verified')").run(m.foundListingId, m.lostListingId);
}

// ---------- one open step per person ----------

type Say = string | Bubble | null | undefined | false;

/**
 * Put a question (or a waiting step) in front of someone: the bubbles and the step together.
 * The person handling this message, and anyone already on this same match, gets it now. Anyone else who is
 * in the middle of another question gets it when they are free, so their next "yes" can't land on the wrong one.
 * "failed" means the bubbles could not be sent (they texted STOP): no step is opened on a question nobody saw.
 */
async function ask(io: LostFoundIo, userId: number, step: Step, data: Data, ...bubbles: Say[]): Promise<"sent" | "parked" | "failed"> {
  // Worded here, once, so a question that has to wait is parked in the same words it will be asked in.
  // (As bubble objects, they go through io.say untouched.)
  const real = LF_VOICE.bubbles(io.db, userId, bubbles.filter((b): b is string | Bubble => !!b)).map((b): Bubble => (typeof b === "string" ? { text: b } : b));
  const cur = getFlowState(io.db, userId);
  const sameMatch = cur?.flow === "lost_found" && Number(cur.data.matchId) === Number(data.matchId);
  if (userId !== io.me && cur && !sameMatch) {
    if (isBusy(io.db, userId)) {
      parkAsk(io.db, userId, { flow: "lost_found", step, data }, real);
      return "parked";
    }
    // A waiting step that isn't a question (await_pickup) steps aside and comes back afterwards.
    if (isProtected(io.db, cur)) parkAsk(io.db, userId, { flow: cur.flow, step: cur.step, data: cur.data });
  }
  const ids = await io.say(userId, ...real);
  if (real.length && !ids.some((id) => id !== null)) return "failed";
  io.setState(userId, step, { ...data, qid: ids.length ? (ids[ids.length - 1] ?? null) : null });
  return "sent";
}

/** Clear someone's step, and anything parked for them, only when it belongs to this match. */
function clearFor(io: LostFoundIo, userId: number, matchId: number): void {
  const cur = getFlowState(io.db, userId);
  if (cur?.flow === "lost_found" && Number(cur.data.matchId) === matchId) io.setState(userId, null);
  dropPending(io.db, userId, (s) => s.flow === "lost_found" && Number(s.data.matchId) === matchId);
}

// ---------- dps details (from the directory table, never invented) ----------

interface DpsInfo {
  address: string | null;
  hours: string | null;
  contact: string | null;
}

export function dpsInfo(db: DatabaseSync): DpsInfo | null {
  const r = (db.prepare("SELECT contactMethod, details FROM directory WHERE name = 'DPS Lost & Found' LIMIT 1").get() ??
    db.prepare("SELECT contactMethod, details FROM directory WHERE kind = 'office' AND name LIKE '%DPS%' AND name LIKE '%Lost%' ORDER BY id LIMIT 1").get()) as
    | { contactMethod: string | null; details: string | null }
    | undefined;
  if (!r) return null;
  const sentences = (r.details ?? "").split(/(?<=\.)\s+(?=[A-Z0-9])/).map((s) => s.trim().replace(/\.$/, "")).filter(Boolean);
  const addressLine = sentences.find((s) => /\d{2,6}\s+[A-Za-z].*\b(?:ave|avenue|st|street|blvd|boulevard|way|pkwy|parkway|dr|drive|pl|place)\b/i.test(s)) ?? null;
  const hoursLine = sentences.find((s) => s !== addressLine && (/\bhours\b|\bopen\b|\b\d{1,2}(?::\d\d)?\s?(?:am|pm)\b|\ba\.m\.|\bp\.m\./i.test(s))) ?? null;
  return {
    address: addressLine ? addressLine.slice(addressLine.search(/\d/)).toLowerCase() : null,
    hours: hoursLine ? hoursLine.toLowerCase() : null,
    contact: r.contactMethod ? r.contactMethod.trim().toLowerCase() : null,
  };
}

function dpsWhere(db: DatabaseSync): string[] {
  const d = dpsInfo(db);
  if (!d) return [];
  return [d.address ? `dps lost and found is at ${d.address}` : "", d.hours ?? ""].filter(Boolean);
}

function dpsReach(db: DatabaseSync): string[] {
  const d = dpsInfo(db);
  return [...dpsWhere(db), d?.contact ? `u can reach them at ${d.contact}` : ""].filter(Boolean);
}

// ---------- places and times ----------

interface Spot {
  text: string;
  lat: number | null;
  lng: number | null;
}

function spotFrom(db: DatabaseSync, text: string, hint?: unknown): Spot | null {
  const p = findPlace(db, text);
  if (p) return { text: p.name, lat: p.lat, lng: p.lng };
  if (typeof hint === "string" && hint.trim()) {
    const h = findPlace(db, hint);
    return h ? { text: h.name, lat: h.lat, lng: h.lng } : { text: hint.trim().slice(0, 80), lat: null, lng: null };
  }
  return null;
}

const HOUR = 60 * 60 * 1000;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** A rough time from words like "yesterday", "2 hours ago", "this morning", "on tuesday". Null when it says nothing usable. */
export function parseWhen(text: string, now = Date.now()): number | null {
  const t = word(text);
  if (!t) return null;
  const n = (s: string | undefined) => (!s || /^(?:a|an|one)$/.test(s) ? 1 : s === "couple" || s === "few" ? 2 : Number(s));
  let m = t.match(/\b(\d+|a|an|one|couple|few)(?: of)? ?(min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\b(?: or so)? ago\b/) ?? t.match(/\b(\d+) ?(min|mins|minute|minutes|hr|hrs|hour|hours|day|days) ago\b/);
  if (m) {
    const unit = m[2]!.startsWith("min") ? 60 * 1000 : m[2]!.startsWith("d") ? 24 * HOUR : HOUR;
    return now - n(m[1]) * unit;
  }
  const at = (daysBack: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysBack);
    d.setHours(hour, 0, 0, 0);
    return Math.min(d.getTime(), now);
  };
  if (/\blast night\b/.test(t)) return at(1, 21);
  if (/\byesterday\b/.test(t)) return /\bmorning\b/.test(t) ? at(1, 9) : /\b(?:night|evening)\b/.test(t) ? at(1, 20) : at(1, 14);
  if (/\b(?:just now|rn|right now|a sec ago|a minute ago)\b/.test(t)) return now;
  if (/\bthis morning\b/.test(t)) return at(0, 9);
  if (/\b(?:today|tonight|earlier|this afternoon|this evening|an hour ago)\b/.test(t)) return now - 3 * HOUR;
  m = t.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (m) {
    const today = new Date(now).getDay();
    const back = (today - DAYS.indexOf(m[1]!) + 7) % 7 || 7;
    return at(back, 12);
  }
  return null;
}

// ---------- finder: reporting a found item ----------

interface FoundDraft {
  photo: IncomingImage | null;
  profile: ItemProfile | null;
  spot: Spot | null;
  /** True once the finder was asked where and didn't know. The listing is saved without a place. */
  placeAsked?: boolean;
  /** True when the profile was built from the finder's words (no photo could be read). */
  fromText?: boolean;
  marksAsked?: boolean;
}

/** Both the plain word and its comparison form, so "this" (compared as "thi") and "someones" are caught too. */
const wordSet = (list: string): Set<string> => new Set(list.split(" ").flatMap((w) => [w, ...canonTokens(w)]));

/** Words in a found report that say nothing about the item itself. */
const REPORT_WORDS = wordSet(
  "this these those thi find found pick picked grab grabbed see saw someone someones somebody somebodys their his her hers left leave forgot dropped sitting floor table desk ground outside inside front back next room hall library class classroom lecture bathroom restroom today now earlier ago morning afternoon night yesterday turn turned took take pic photo picture here heres",
);
/** Names for the kind of thing. Saying "airpods" tells the owner check nothing a stranger wouldn't know. */
const KIND_WORDS = wordSet(
  "airpods airpod earbuds headphones beats iphone phone android pixel macbook laptop ipad tablet chromebook wallet cardholder keys key keychain water bottle flask hydroflask tumbler backpack bag tote purse pouch jacket hoodie sweater sweatshirt coat hat cap beanie scarf shirt umbrella glasses sunglasses charger cable watch ring necklace bracelet calculator notebook textbook book planner skateboard scooter bike card id usc student pro max mini air case pair set",
);

/** True when the finder's words give the verifier nothing only the owner would know (just the kind of item and where). */
function thinDescription(db: DatabaseSync, text: string, profile: ItemProfile, spot: Spot | null): boolean {
  const category = normalizeCategory(profile.category);
  const place = new Set(canonTokens(`${spot?.text ?? ""} ${String(pullDetails(text).place ?? "")}`));
  const brand = new Set(canonTokens(profile.brand ?? ""));
  const specific = canonTokens(text).filter((w) => !isGenericWord(w, category) && !isColorWord(w) && !REPORT_WORDS.has(w) && !KIND_WORDS.has(w) && !place.has(w) && !brand.has(w) && !/^\d+$/.test(w) && !findPlace(db, w));
  return specific.length === 0;
}

/** A basic profile from the finder's own words. Their text stays hidden (it goes in distinguishing). */
function profileFromText(text: string, force: boolean): ItemProfile | null {
  const t = text.trim().slice(0, 300);
  if (!t) return null;
  const d = pullDetails(t);
  const named = typeof d.category === "string";
  const category = named ? normalizeCategory(d.category) : normalizeCategory(word(t).replace(/\s+/g, "_"));
  const profile = sanitizeProfile({ category, title: "", brand: d.brand ?? null, color: d.color ?? null, publicSummary: "", distinguishing: [t], nameOnItem: null });
  if (!profile) return null;
  if (!force && !named && !profile.isDangerous) return null;
  return profile;
}

function saveFound(db: DatabaseSync, userId: number, draft: FoundDraft & { profile: ItemProfile }): number {
  const p = draft.profile;
  const dangerous = p.isDangerous;
  const res = db
    .prepare(
      `INSERT INTO listings (userId, type, category, title, details, photoUrl, locationText, lat, lng, happenedAt, status, isValuable, isDangerous, heldBy, createdAt)
       VALUES (?, 'found', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      normalizeCategory(p.category),
      p.title,
      JSON.stringify(p),
      draft.photo?.path ?? null,
      draft.spot?.text ?? null,
      draft.spot?.lat ?? null,
      draft.spot?.lng ?? null,
      Date.now(),
      // A dangerous item is never offered to another student, so it never enters matching.
      dangerous ? "handed_off" : "open",
      p.isValuable ? 1 : 0,
      dangerous ? 1 : 0,
      dangerous ? "dps" : "finder",
      Date.now(),
    );
  return Number(res.lastInsertRowid);
}

async function continueFound(ctx: FlowContext, io: LostFoundIo, draft: FoundDraft & { profile: ItemProfile }): Promise<void> {
  const me = ctx.user.id;
  if (draft.profile.isDangerous) {
    saveFound(io.db, me, draft);
    io.setState(me, null);
    await io.say(me, COPY.dangerous, ...dpsWhere(io.db));
    return;
  }
  if (!draft.spot && !draft.placeAsked) {
    io.setState(me, "found_place", { photo: draft.photo, profile: draft.profile, fromText: draft.fromText === true, marksAsked: draft.marksAsked === true });
    await io.say(me, COPY.askFoundPlace);
    return;
  }
  // No photo could be read and the finder only said what it is: ask once for the details the owner check runs on.
  if (draft.fromText && !draft.marksAsked && thinDescription(io.db, draft.profile.distinguishing.join(" "), draft.profile, draft.spot)) {
    io.setState(me, "found_marks", { photo: draft.photo, profile: { ...draft.profile, distinguishing: [] }, spot: draft.spot });
    await io.say(me, COPY.askMarks);
    return;
  }
  const id = saveFound(io.db, me, draft);
  io.setState(me, null);
  await io.say(me, T.logged(draft.profile.publicSummary || kindOf(draft.profile.category)), COPY.holdOnto);
  await afterNewListing(io, id, "found");
}

async function reportFound(ctx: FlowContext, io: LostFoundIo): Promise<void> {
  const text = (ctx.event.text ?? "").trim();
  const photo = ctx.event.images[0] ?? null;
  const seen = photo ? await profileItem(photo, text) : null;
  const profile = seen ?? profileFromText(text, false);
  const spot = spotFrom(io.db, text, ctx.intent.details.place ?? pullDetails(text).place);
  if (!profile) {
    io.setState(ctx.user.id, "found_what", { photo, spot });
    await io.say(ctx.user.id, COPY.askWhat);
    return;
  }
  await continueFound(ctx, io, { photo, profile, spot, fromText: !seen });
}

// ---------- owner: reporting a loss ----------

interface LostDraft {
  text: string;
  category: Category | null;
  color: string | null;
  brand: string | null;
  spot: Spot | null;
  happenedAt: number | null;
  asked: { category?: boolean; place?: boolean; time?: boolean };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function saveLost(db: DatabaseSync, userId: number, d: LostDraft): number {
  const report: LostReport = { category: d.category, description: d.text, color: d.color, brand: d.brand, locationText: d.spot?.text ?? null, happenedAt: d.happenedAt };
  const res = db
    .prepare(
      `INSERT INTO listings (userId, type, category, title, details, locationText, lat, lng, happenedAt, status, createdAt)
       VALUES (?, 'lost', ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(userId, d.category ?? "other", kindOf(d.category), JSON.stringify(report), d.spot?.text ?? null, d.spot?.lat ?? null, d.spot?.lng ?? null, d.happenedAt, Date.now());
  return Number(res.lastInsertRowid);
}

/**
 * A second report for the same kind of thing while the first is still open is the same loss told again:
 * the open report is updated instead of a new one being made. Its matches keep their history (tries used,
 * rejections), and any that were set aside when the person backed out are offered again.
 */
function mergeIntoOpenReport(db: DatabaseSync, userId: number, d: LostDraft): number | null {
  if (!d.category || d.category === "other") return null;
  const row = db.prepare("SELECT id, details FROM listings WHERE userId = ? AND type = 'lost' AND status = 'open' AND category = ? AND isExample = 0 ORDER BY id DESC LIMIT 1").get(userId, d.category) as { id: number; details: string } | undefined;
  if (!row) return null;
  let old: Partial<LostReport> = {};
  try {
    old = JSON.parse(row.details) as Partial<LostReport>;
  } catch {
    // Unreadable details are replaced by the new report.
  }
  const said = (old.description ?? "").trim();
  // Told again in fuller words, the fuller version is the report. Otherwise both are kept.
  const was = said.toLowerCase();
  const now = d.text.trim().toLowerCase();
  const description = !said || now.includes(was) ? d.text : was.includes(now) ? said : `${said}. ${d.text}`.slice(0, 900);
  const report: LostReport = {
    category: d.category,
    description,
    color: d.color ?? old.color ?? null,
    brand: d.brand ?? old.brand ?? null,
    locationText: d.spot?.text ?? old.locationText ?? null,
    happenedAt: d.happenedAt ?? old.happenedAt ?? null,
  };
  db.prepare("UPDATE listings SET details = ?, locationText = COALESCE(?, locationText), lat = COALESCE(?, lat), lng = COALESCE(?, lng), happenedAt = COALESCE(?, happenedAt) WHERE id = ?").run(
    JSON.stringify(report),
    d.spot?.text ?? null,
    d.spot?.lat ?? null,
    d.spot?.lng ?? null,
    d.happenedAt,
    row.id,
  );
  db.prepare("UPDATE matches SET parked = 0 WHERE lostListingId = ? AND status = 'proposed'").run(row.id);
  return row.id;
}

async function nextLost(ctx: FlowContext, io: LostFoundIo, d: LostDraft): Promise<void> {
  const me = ctx.user.id;
  const ask = async (step: Step, key: "category" | "place" | "time", line: string) => {
    io.setState(me, step, { draft: { ...d, asked: { ...d.asked, [key]: true } } });
    await io.say(me, line);
  };
  if (!d.category && !d.asked.category) return ask("lost_category", "category", COPY.askLostWhat);
  if (!d.spot && !d.asked.place) return ask("lost_place", "place", COPY.askLostPlace);
  if (d.happenedAt === null && !d.asked.time) return ask("lost_time", "time", COPY.askLostTime);
  const id = mergeIntoOpenReport(io.db, me, d) ?? saveLost(io.db, me, d);
  io.setState(me, null);
  await io.say(me, COPY.checking);
  await afterNewListing(io, id, "lost");
}

async function reportLost(ctx: FlowContext, io: LostFoundIo): Promise<void> {
  const text = (ctx.event.text ?? "").trim().slice(0, 600);
  const d = { ...pullDetails(text), ...ctx.intent.details };
  await nextLost(ctx, io, {
    text,
    category: str(d.category) ? normalizeCategory(d.category) : null,
    color: str(d.color),
    brand: str(d.brand),
    spot: spotFrom(io.db, text, d.place),
    happenedAt: parseWhen(text) ?? (str(d.time) ? parseWhen(str(d.time)!) : null),
    asked: {},
  });
}

async function answerLost(ctx: FlowContext, io: LostFoundIo, step: Step, data: Data, text: string): Promise<void> {
  const d = data.draft as LostDraft | undefined;
  if (!d) {
    io.setState(ctx.user.id, null);
    await reportLost(ctx, io);
    return;
  }
  if (!text) {
    await io.say(ctx.user.id, COPY.needWords);
    return;
  }
  const w = word(text);
  const elsewhere = ctx.intent.flow !== "lost_found";
  const pulled = pullDetails(text);
  const unsure = IDK.test(w);

  if (step === "lost_category") {
    if (!unsure) {
      if (elsewhere && !pulled.category) return;
      d.category = normalizeCategory(pulled.category ?? w.replace(/^(?:my|a|an|the)\s+/, "").replace(/\s+/g, "_"));
      d.text = `${d.text}. ${text}`.slice(0, 900);
      d.color ??= str(pulled.color);
      d.brand ??= str(pulled.brand);
      d.spot ??= spotFrom(io.db, text, pulled.place);
      d.happenedAt ??= parseWhen(text);
    }
  } else if (step === "lost_place") {
    if (!unsure) {
      const spot = spotFrom(io.db, text, pulled.place);
      if (elsewhere && !spot) return;
      d.spot = spot ?? { text: text.slice(0, 80), lat: null, lng: null };
      d.happenedAt ??= parseWhen(text);
    }
  } else {
    if (!unsure) {
      const when = parseWhen(text);
      if (elsewhere && when === null) return;
      d.happenedAt = when;
    }
  }
  await nextLost(ctx, io, d);
}

// ---------- matching ----------

const NOTHING_YET = [COPY.nothingYet, COPY.willText];

/**
 * The best match worth acting on: an untouched pair, a found item that is still free, a claimant who may still
 * try, both people reachable. Candidates come best first by the full score (hidden details included), but
 * whether a pair is acted on at all is decided by publicScore alone, so the answer a claimant gets never
 * depends on the finder's hidden details.
 */
function pickBest(db: DatabaseSync, results: MatchResult[]): MatchResult | null {
  for (const r of results) {
    const m = getMatch(db, r.matchId);
    const found = rawListing(db, r.foundListingId);
    const lost = rawListing(db, r.lostListingId);
    if (!m || !found || !lost || m.status !== "proposed" || m.parked) continue;
    if (found.isDangerous || found.status !== "open" || lost.status !== "open") continue;
    if (claimantBlocked(db, found.id, lost.userId)) continue;
    // Someone who texted STOP can't be asked anything, so their listing is never the one a claim waits on.
    const owner = getUserById(db, lost.userId);
    const finder = getUserById(db, found.userId);
    if (!owner || owner.stopped) continue;
    if (found.heldBy !== "dps" && (!finder || finder.stopped)) continue;
    const f = loadListing(db, found.id);
    const l = loadListing(db, lost.id);
    if (!f || !l || publicScore(f, l) < THRESHOLDS.clarify) continue;
    return r;
  }
  return null;
}

/** Run two-sided matching for a listing that was just saved and act on the best result. */
async function afterNewListing(io: LostFoundIo, listingId: number, side: "found" | "lost"): Promise<void> {
  const best = pickBest(io.db, await matchListing(io.db, listingId));
  const listing = rawListing(io.db, listingId);
  if (!listing) return;
  if (!best) {
    if (side === "lost") await io.say(listing.userId, ...NOTHING_YET);
    return;
  }
  const pair = loadPair(io.db, best.matchId);
  if (!pair) return;
  if (side === "found") await io.say(pair.finderId, COPY.finderHeadsUp);
  await startClaim(io, pair, side === "found" ? "found_later" : "just_reported");
}

/**
 * A found item just went back in the pool (a claim ended without a handoff): look for the next owner.
 * Owners who reported while it was locked were told "nothing yet", and nothing else would ever pick them up.
 */
async function rematch(io: LostFoundIo, foundListingId: number, depth = 0): Promise<void> {
  if (depth > 5) return;
  const found = rawListing(io.db, foundListingId);
  if (!found || found.status !== "open" || found.isDangerous) return;
  const best = pickBest(io.db, await matchListing(io.db, foundListingId));
  const pair = best ? loadPair(io.db, best.matchId) : null;
  if (pair) await startClaim(io, pair, "found_later", depth + 1);
}

function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim().slice(0, 280)}"`;
}

// ---------- verification ----------

const hasFullName = (name: string): boolean => name.split(/[^A-Za-z]+/).filter((w) => w.length >= 2).length >= 2;

/**
 * A claim starts the same way for everyone: the same opener and the same blind question, whatever the
 * finder's hidden details say. The only exception is an ID or card with a full name on it, which is checked
 * against the claimant's own USC account without asking anything.
 */
async function startClaim(io: LostFoundIo, pair: Pair, why: "found_later" | "just_reported", depth = 0): Promise<void> {
  const { db } = io;
  const owner = getUserById(db, pair.ownerId);
  if (!owner) return;
  setMatch(db, pair.match.id, "verifying");
  setListing(db, pair.match.foundListingId, "verifying");
  setListing(db, pair.match.lostListingId, "matched");
  const opener = why === "found_later" ? COPY.turnedUp : COPY.mightHave;

  const name = pair.profile.nameOnItem;
  if (name && NAME_CHECKED.has(normalizeCategory(pair.profile.category)) && hasFullName(name)) {
    const ok = nameMatches(name, owner.uscEmail, owner.name);
    addVerification(db, pair.match.id, "name_match", null, null, ok ? "pass" : "fail");
    if (ok) {
      await io.say(owner.id, opener, COPY.nameMatched);
      await markVerified(io, pair);
    } else {
      // Same neutral line as any other miss: it says nothing about what is on the item or how it was checked.
      await afterMisses(io, pair, COPY.cantConfirm);
    }
    return;
  }

  const res = await ask(io, owner.id, "verify_describe", { matchId: pair.match.id }, opener, COPY.quickCheck, COPY.describe);
  if (res === "failed") {
    // The owner can't be reached. The item goes back in the pool instead of waiting on them.
    release(db, pair.match, "proposed", true);
    await rematch(io, pair.match.foundListingId, depth + 1);
  }
}

const DESCRIBES = /\b(?:stickers?|scratch\w*|crack\w*|dent\w*|logo|engrav\w*|initials?|keychain|key ring|charm|strap|lanyard|label|tag|cover|sleeve|case|written|writing|drawn|drawing|says|stain\w*|chip(?:ped)?|missing|zipper|pocket|pattern|strip(?:e|es|ed)|plain|inside|front|back|bottom|lid|corner|side)\b/;
const ASKS = /\?\s*$|^(?:(?:wait|hold on|um+|uh+|so|but|ok|okay|lol|bro|yo|hey)[ ,]+)*(?:do|does|did|is|are|am|can|could|will|would|should|how|what|whats|why|who|where|when|which)\b/;
const STALLS = /\b(?:idk|i (?:don'?t|dont) know|not sure|one sec|hold on|gimme a (?:sec|min)|give me a (?:sec|min)|lemme|let me|panic\w*|freaking out|can'?t (?:think|remember)|cant (?:think|remember)|brb)\b/;

/**
 * Is this message an attempt at describing the item? A question or a stall is not: it gets an answer, the step
 * stays open and no try is counted. Anything that names a color, a brand or a mark is an attempt whatever its
 * punctuation, so a guess phrased as a question ("is it the one with the sticker?") is never free.
 */
export function isDescriptionAttempt(text: string): boolean {
  const t = text.toLowerCase().replace(/[‘’]/g, "'").trim();
  const d = pullDetails(t);
  if (d.color || d.brand || DESCRIBES.test(t) || t.split(/\s+/).some((w) => isColorWord(w.replace(/[^a-z]/g, "")))) return true;
  return !(ASKS.test(t) || STALLS.test(t));
}

async function handleDescribe(ctx: FlowContext, io: LostFoundIo, pair: Pair, text: string): Promise<void> {
  const me = ctx.user.id;
  const { db } = io;
  if (!text) {
    await io.say(me, COPY.describeWords);
    return;
  }
  if (!isDescriptionAttempt(text)) {
    // He answers what they said (never anything about the item: the step's facts stay locked) and the question
    // stays open. Nothing is scored, stored or shown to the finder.
    let bubbles: string[] = [];
    try {
      const { replyAtStep } = await import("../../brain.ts");
      bubbles = (await replyAtStep(ctx, { flow: "lost_found", waitingFor: "ur description of it, in ur own words", canDo: [] })).bubbles;
    } catch {
      bubbles = [];
    }
    await io.say(me, ...(bubbles.length ? bubbles : [COPY.describeWords]));
    touch(db, pair.match.id);
    return;
  }
  const answer = text.slice(0, 1200);
  // Nothing on file only the owner would know (the finder had no photo read and named no marks): a description
  // can't be scored against nothing, so the finder is shown the claimant's words and decides.
  const checkable = pair.profile.distinguishing.length > 0 || !!pair.profile.nameOnItem;
  if (!checkable) {
    await toFinderCheck(io, pair, answer, null);
    return;
  }
  const res = await scoreDescription(pair.profile, text);
  const attempt = usedTries(db, pair.match.foundListingId, me) + 1;
  const pass = res.score >= THRESHOLDS.descriptionPass;
  if (pass && res.source === "fallback") {
    await toFinderCheck(io, pair, answer, res.score);
    return;
  }
  addVerification(db, pair.match.id, "blind_description", answer, res.score, pass ? "pass" : "fail", attempt);
  touch(db, pair.match.id);
  if (pass) {
    await io.say(me, COPY.passed);
    await markVerified(io, pair);
    return;
  }
  if (attempt < THRESHOLDS.maxAttempts) {
    await io.say(me, ...COPY.retry);
    return;
  }
  await afterMisses(io, pair, COPY.cantConfirmDescription);
}

/**
 * The description can't be settled by a score: it passed only on the rule score (the AI check was down or
 * slow), or there is nothing on file to score it against. That is a hint, never a verdict: the finder is shown
 * the claimant's own words and decides. An item already at DPS can't be checked that way, so the claimant goes
 * to DPS in person. The description is saved with no result and counts as a try while the finder has it; the
 * finder's answer becomes the result.
 */
async function toFinderCheck(io: LostFoundIo, pair: Pair, answer: string, score: number | null): Promise<void> {
  const { db } = io;
  db.prepare("INSERT INTO verifications (matchId, method, ownerAnswer, score, result, attempts, createdAt) VALUES (?, 'blind_description', ?, ?, NULL, ?, ?)").run(
    pair.match.id,
    answer,
    score,
    usedTries(db, pair.match.foundListingId, pair.ownerId) + 1,
    Date.now(),
  );
  const found = rawListing(db, pair.match.foundListingId);
  if (found?.heldBy === "dps") {
    release(db, pair.match, "rejected");
    clearFor(io, pair.ownerId, pair.match.id);
    await io.say(pair.ownerId, COPY.dpsInPerson, ...dpsReach(db));
    await rematch(io, pair.match.foundListingId);
    return;
  }
  setMatch(db, pair.match.id, "finder_check");
  await io.say(pair.ownerId, ...COPY.checkingHolder);
  await ask(io, pair.ownerId, "await_finder", { matchId: pair.match.id });
  const theirs = PLURAL.has(normalizeCategory(pair.profile.category)) ? "are theirs" : "is theirs";
  const res = await ask(io, pair.finderId, "finder_check", { matchId: pair.match.id }, T.finderClaims(pair.summary, theirs), COPY.howDescribed, quote(answer), COPY.finderCheck);
  if (res === "failed") await finderUnreachable(io, pair);
}

/** The finder can't be asked (they texted STOP). The claimant isn't left waiting on an answer that can't come. */
async function finderUnreachable(io: LostFoundIo, pair: Pair): Promise<void> {
  release(io.db, pair.match, "proposed", true);
  clearFor(io, pair.ownerId, pair.match.id);
  await io.say(pair.ownerId, ...COPY.lostTouch);
}

async function handleFinderCheck(ctx: FlowContext, io: LostFoundIo, pair: Pair, w: string): Promise<void> {
  const me = ctx.user.id;
  const yn = yesNo(w);
  if (yn === null) {
    if (ctx.intent.flow !== "lost_found") return;
    await io.say(me, COPY.finderCheck);
    return;
  }
  io.setState(me, null);
  // A description that was waiting on the finder gets its result from the finder's answer.
  io.db.prepare("UPDATE verifications SET result = ? WHERE matchId = ? AND method = 'blind_description' AND result IS NULL").run(yn ? "pass" : "fail", pair.match.id);
  if (!yn) {
    addVerification(io.db, pair.match.id, "finder_confirm", null, null, "fail");
    release(io.db, pair.match, "rejected");
    clearFor(io, pair.ownerId, pair.match.id);
    await io.say(me, COPY.finderNo);
    await io.say(pair.ownerId, ...NOTHING_YET);
    await rematch(io, pair.match.foundListingId);
    return;
  }
  addVerification(io.db, pair.match.id, "finder_confirm", null, null, "pass");
  await io.say(pair.ownerId, COPY.finderYes);
  await markVerified(io, pair);
}

/** Out of tries. The item goes back in the pool; what happens next depends on who is holding it. */
async function afterMisses(io: LostFoundIo, pair: Pair, opener: string): Promise<void> {
  const { db } = io;
  const found = rawListing(db, pair.match.foundListingId);
  if (found?.heldBy === "dps") {
    release(db, pair.match, "rejected");
    clearFor(io, pair.ownerId, pair.match.id);
    await io.say(pair.ownerId, COPY.dpsInPerson, ...dpsReach(db));
    await rematch(io, pair.match.foundListingId);
    return;
  }
  if (!found?.photoUrl) {
    // Nothing to compare a proof photo against, so it goes straight to the finder.
    await io.say(pair.ownerId, opener);
    await toFinderDecide(io, pair, null);
    return;
  }
  release(db, pair.match, "proof_requested");
  await ask(io, pair.ownerId, "proof", { matchId: pair.match.id }, opener, COPY.askProof);
  await rematch(io, pair.match.foundListingId);
}

async function handleProof(ctx: FlowContext, io: LostFoundIo, pair: Pair, w: string): Promise<void> {
  const me = ctx.user.id;
  const { db } = io;
  const proof = ctx.event.reaction ? null : (ctx.event.images[0] ?? null);
  if (proof) {
    const found = rawListing(db, pair.match.foundListingId);
    const res = found?.photoUrl ? await sameItem({ path: found.photoUrl, mime: /\.png$/i.test(found.photoUrl) ? "image/png" : "image/jpeg" }, proof) : null;
    const ok = !!res && res.same && res.confidence >= PROOF_MIN_CONFIDENCE;
    if (res) addVerification(db, pair.match.id, "proof_photo", null, res.confidence, ok ? "pass" : "fail");
    if (ok && found?.status === "open") {
      await io.say(me, COPY.proofSame);
      await markVerified(io, pair);
      return;
    }
    await toFinderDecide(io, pair, res ? COPY.proofUnsettled : COPY.proofCantCheck);
    return;
  }
  if (yesNo(w) === false || /\b(?:dont have|no photo|no pic|none|nothing|cant find)\b/.test(w)) {
    await toFinderDecide(io, pair, null);
    return;
  }
  if (ctx.intent.flow !== "lost_found") return;
  await io.say(me, COPY.proofHow);
}

/** The finder is shown the claimant's own words and makes the call. The claimant is shown nothing. */
async function toFinderDecide(io: LostFoundIo, pair: Pair, lead: string | null): Promise<void> {
  const { db } = io;
  release(db, pair.match, "finder_deciding");
  await io.say(pair.ownerId, lead, COPY.askingHolder);
  await ask(io, pair.ownerId, "await_finder", { matchId: pair.match.id });
  const answers = (db.prepare("SELECT ownerAnswer FROM verifications WHERE matchId = ? AND method = 'blind_description' AND ownerAnswer IS NOT NULL ORDER BY id").all(pair.match.id) as { ownerAnswer: string }[]).map((r) => r.ownerAnswer);
  const quotes = [...new Set([pair.report.description, ...answers].map(quote))].slice(-3);
  const res = await ask(io, pair.finderId, "finder_decide", { matchId: pair.match.id }, T.tryingToClaim(pair.summary), COPY.howDescribed, ...quotes, COPY.finderCall);
  if (res === "failed") {
    await finderUnreachable(io, pair);
    return;
  }
  await rematch(io, pair.match.foundListingId);
}

async function finderDecides(io: LostFoundIo, pair: Pair, choice: 1 | 2 | 3): Promise<void> {
  const { db } = io;
  const found = rawListing(db, pair.match.foundListingId);
  clearFor(io, pair.finderId, pair.match.id);
  clearFor(io, pair.ownerId, pair.match.id);
  if (!found || found.status !== "open") {
    // Someone else was verified for it in the meantime.
    release(db, pair.match, "rejected");
    await io.say(pair.finderId, COPY.sorted);
    await io.say(pair.ownerId, COPY.cantConnect);
    return;
  }
  if (choice === 1) {
    addVerification(db, pair.match.id, "finder_judgment", null, null, "pass");
    setMatch(db, pair.match.id, "verified");
    setListing(db, pair.match.foundListingId, "verified");
    setListing(db, pair.match.lostListingId, "verified");
    await io.say(pair.ownerId, COPY.okToMeet);
    await startMeet(io, pair, true);
    return;
  }
  addVerification(db, pair.match.id, "finder_judgment", null, null, "fail");
  release(db, pair.match, "rejected");
  if (choice === 2) {
    db.prepare("UPDATE listings SET heldBy = 'dps' WHERE id = ?").run(pair.match.foundListingId);
    await io.say(pair.finderId, COPY.dropAtDpsOk, ...dpsWhere(db), COPY.takeFromThere);
    await io.say(pair.ownerId, COPY.dpsInPerson, COPY.holderDropping, ...dpsReach(db));
  } else {
    await io.say(pair.finderId, COPY.keepHolding);
    await io.say(pair.ownerId, COPY.cantConnect, COPY.reportStaysOpen);
  }
  await rematch(io, pair.match.foundListingId);
}

async function markVerified(io: LostFoundIo, pair: Pair): Promise<void> {
  setMatch(io.db, pair.match.id, "verified");
  setListing(io.db, pair.match.foundListingId, "verified");
  setListing(io.db, pair.match.lostListingId, "verified");
  await startHandoff(io, pair);
}

// ---------- handoff ----------

/**
 * Contact rules, checked every time a handoff is about to connect two people. no_contact on either side, a
 * dangerous item, an item already at DPS, or a finder who can no longer be texted all mean the DPS path only.
 */
function dpsOnly(db: DatabaseSync, pair: Pair): { forced: boolean; alreadyThere: boolean } {
  const found = rawListing(db, pair.match.foundListingId);
  const finder = getUserById(db, pair.finderId);
  const owner = getUserById(db, pair.ownerId);
  const alreadyThere = found?.heldBy === "dps";
  const forced = alreadyThere || !!found?.isDangerous || pair.profile.isDangerous || !finder || !owner || finder.stopped || owner.stopped || finder.contactMode === "no_contact" || owner.contactMode === "no_contact";
  return { forced, alreadyThere };
}

/** The finder holds the item, so the finder picks. no_contact people and items already at DPS only get the DPS path. */
async function startHandoff(io: LostFoundIo, pair: Pair): Promise<void> {
  if (dpsOnly(io.db, pair).forced) {
    await dpsPath(io, pair);
    return;
  }
  const category = normalizeCategory(pair.profile.category);
  const nudge = category === "wallet" ? T.nudge("wallets") : category === "phone" ? T.nudge("phones") : null;
  clearFor(io, pair.ownerId, pair.match.id);
  await io.say(pair.ownerId, COPY.checkingHandoff);
  const res = await ask(io, pair.finderId, "handoff_choice", { matchId: pair.match.id }, T.ownerCheckedOut(pair.summary), nudge, COPY.handoffAsk);
  if (res === "failed") await dpsPath(io, pair);
}

function hasHandoff(db: DatabaseSync, matchId: number): boolean {
  return !!db.prepare("SELECT 1 FROM handoffs WHERE matchId = ? LIMIT 1").get(matchId);
}

function addHandoff(db: DatabaseSync, matchId: number, method: "group_chat" | "relay" | "dps_code", pickupCode: string | null): void {
  db.prepare("INSERT INTO handoffs (matchId, chosenBy, method, pickupCode, createdAt) VALUES (?, 'finder', ?, ?, ?)").run(matchId, method, pickupCode, Date.now());
  const m = getMatch(db, matchId);
  if (m) db.prepare("UPDATE listings SET status = 'handed_off' WHERE id IN (?, ?)").run(m.foundListingId, m.lostListingId);
}

async function dpsPath(io: LostFoundIo, pair: Pair): Promise<void> {
  const { db } = io;
  if (hasHandoff(db, pair.match.id)) return;
  const { alreadyThere } = dpsOnly(db, pair);
  // The code comes from crypto in verify.ts. No model ever sees or picks it.
  const code = generatePickupCode();
  addHandoff(db, pair.match.id, "dps_code", code);
  db.prepare("UPDATE listings SET heldBy = 'dps' WHERE id = ?").run(pair.match.foundListingId);
  clearConsent(db, pair.match.id);
  const where = dpsWhere(db);
  clearFor(io, pair.finderId, pair.match.id);
  if (alreadyThere) await io.say(pair.finderId, T.ownerCheckedOutDps(pair.summary), T.theirCode(code));
  else await io.say(pair.finderId, COPY.dropAtDps, ...where, T.tellCode(code));
  await io.say(pair.ownerId, alreadyThere ? COPY.atDps : COPY.finderDropping, ...where, T.urCode(code), COPY.gotItHint);
  await ask(io, pair.ownerId, "await_pickup", { matchId: pair.match.id });
}

const consentKey = (matchId: number) => `lf_consent:${matchId}`;

function clearConsent(db: DatabaseSync, matchId: number): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(consentKey(matchId));
}

/**
 * Hold and meet. A group chat only when both people allow it, the adapter can do it, and both say yes to the
 * contact-info warning. A person is only waiting on that question once the warning has reached them: if it
 * can't be put in front of either of them right now, nobody is asked and the handoff uses relay mode.
 */
async function startMeet(io: LostFoundIo, pair: Pair, busy: boolean): Promise<void> {
  const { db } = io;
  const finder = getUserById(db, pair.finderId);
  const owner = getUserById(db, pair.ownerId);
  if (!finder || !owner) return;
  if (dpsOnly(db, pair).forced) {
    await dpsPath(io, pair);
    return;
  }
  const allowed = (u: User) => u.contactMode === "direct" && u.groupChatsAllowed;
  const canGroup = allowed(finder) && allowed(owner) && !!io.adapter?.capabilities().groupChats;
  if (!canGroup) {
    await relayHandoff(io, pair, busy, null);
    return;
  }
  setSetting(db, consentKey(pair.match.id), "{}");
  touch(db, pair.match.id);
  for (const [u, role] of [[finder, "finder"], [owner, "owner"]] as const) {
    const res = await ask(io, u.id, "gc_consent", { matchId: pair.match.id, role, busy }, role === "owner" ? COPY.finderDown : null, COPY.consent);
    if (res !== "failed") continue;
    // The warning can't reach this person, so there is no question for anyone to say yes to.
    clearFor(io, finder.id, pair.match.id);
    clearFor(io, owner.id, pair.match.id);
    await relayHandoff(io, pair, busy, null);
    return;
  }
}

async function relayHandoff(io: LostFoundIo, pair: Pair, busy: boolean, lead: string | null): Promise<void> {
  const { db } = io;
  // A rule set a minute ago still wins: no_contact never gets a relay either.
  if (dpsOnly(db, pair).forced) {
    await dpsPath(io, pair);
    return;
  }
  if (hasHandoff(db, pair.match.id)) return;
  clearConsent(db, pair.match.id);
  startRelay(db, pair.finderId, pair.ownerId, `lost_found:${pair.match.id}`, { a: "the finder", b: "the owner" });
  addHandoff(db, pair.match.id, "relay", null);
  clearFor(io, pair.finderId, pair.match.id);
  await io.say(pair.finderId, lead, ...RELAY_COPY.start, busy ? COPY.meetBusy : null);
  await io.say(pair.ownerId, lead, ...RELAY_COPY.start, COPY.gotItHint);
  await ask(io, pair.ownerId, "await_pickup", { matchId: pair.match.id });
}

async function handleConsent(ctx: FlowContext, io: LostFoundIo, pair: Pair, data: Data, yn: boolean | null): Promise<void> {
  const me = ctx.user.id;
  const { db } = io;
  const role = data.role === "owner" ? "owner" : "finder";
  const busy = data.busy === true;
  const raw = getSetting(db, consentKey(pair.match.id));
  if (raw === null) {
    // The other person already settled it (they said no, so a relay is running).
    io.setState(me, role === "owner" && hasHandoff(db, pair.match.id) ? "await_pickup" : null, { matchId: pair.match.id });
    if (!ctx.event.reaction) await io.say(me, COPY.sorted);
    return;
  }
  // Checked before anything else: someone who went no_contact since the question was asked is never connected.
  if (dpsOnly(db, pair).forced) {
    await dpsPath(io, pair);
    return;
  }
  if (yn === null) {
    if (ctx.intent.flow !== "lost_found") return;
    await io.say(me, COPY.consentHow);
    return;
  }
  if (!yn) {
    await relayHandoff(io, pair, busy, COPY.noGroup);
    return;
  }
  let consent: { finder?: boolean; owner?: boolean } = {};
  try {
    consent = JSON.parse(raw) as typeof consent;
  } catch {
    // A bad value just means nobody has answered yet.
  }
  consent[role] = true;
  if (!(consent.finder && consent.owner)) {
    setSetting(db, consentKey(pair.match.id), JSON.stringify(consent));
    touch(db, pair.match.id);
    // Still the consent step, marked answered: nothing is handed off yet, so "ok" here can't close anything.
    io.setState(me, "gc_consent", { ...data, answered: true });
    await io.say(me, COPY.waitingThem);
    return;
  }
  clearConsent(db, pair.match.id);
  const finder = getUserById(db, pair.finderId);
  const owner = getUserById(db, pair.ownerId);
  // Checked again right before the chat is made: a rule set a minute ago still wins.
  const stillAllowed = !!finder && !!owner && [finder, owner].every((u) => u.contactMode === "direct" && u.groupChatsAllowed && !u.stopped);
  const chatId = stillAllowed && io.adapter ? await io.adapter.createGroupChat([finder.handle, owner.handle], COPY.groupFirst).catch(() => null) : null;
  if (!chatId) {
    await relayHandoff(io, pair, busy, COPY.groupFailed);
    return;
  }
  addHandoff(db, pair.match.id, "group_chat", null);
  clearFor(io, pair.finderId, pair.match.id);
  await io.say(pair.finderId, COPY.inGroupFinder, busy ? COPY.meetBusy : null);
  await io.say(pair.ownerId, COPY.inGroupOwner, COPY.gotItHint);
  await ask(io, pair.ownerId, "await_pickup", { matchId: pair.match.id });
}

// ---------- closing the loop ----------

/**
 * The owner has the item back: both listings returned, the handoff completed, and the owner is asked for a
 * thank-you note. Nothing is closed before a handoff exists, and the thank-you step only opens when the
 * question actually reached the owner. Returns false when there was nothing to close.
 */
async function closeLoop(io: LostFoundIo, pair: Pair): Promise<boolean> {
  const { db } = io;
  if (!hasHandoff(db, pair.match.id)) return false;
  const now = Date.now();
  db.prepare("UPDATE listings SET status = 'returned' WHERE id IN (?, ?)").run(pair.match.foundListingId, pair.match.lostListingId);
  db.prepare("UPDATE handoffs SET completedAt = ? WHERE matchId = ? AND completedAt IS NULL").run(now, pair.match.id);
  endRelayByContext(db, `lost_found:${pair.match.id}`);
  clearConsent(db, pair.match.id);
  clearFor(io, pair.ownerId, pair.match.id);
  await ask(io, pair.ownerId, "thanks_note", { matchId: pair.match.id }, COPY.loveThat, COPY.askThanks);
  return true;
}

async function handleThanks(ctx: FlowContext, io: LostFoundIo, pair: Pair, text: string, skip: boolean): Promise<void> {
  io.setState(ctx.user.id, null);
  const note = text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!skip && note) {
    io.db.prepare("UPDATE handoffs SET thankYouNote = ? WHERE id = (SELECT MAX(id) FROM handoffs WHERE matchId = ?)").run(note, pair.match.id);
    await io.say(pair.finderId, T.thanksFrom(pair.summary), quote(note));
  }
  const win: Bubble = { text: COPY.win, effect: "confetti" };
  await io.say(pair.finderId, win);
  await io.say(pair.ownerId, win);
}

/** The owner's unfinished handoff, if any ("got it back" with no open step still closes it). */
function openHandoffFor(db: DatabaseSync, ownerId: number): number | null {
  const r = db
    .prepare(
      `SELECT h.matchId FROM handoffs h
         JOIN matches m ON m.id = h.matchId
         JOIN listings l ON l.id = m.lostListingId
        WHERE l.userId = ? AND h.completedAt IS NULL AND l.status = 'handed_off'
        ORDER BY h.id DESC LIMIT 1`,
    )
    .get(ownerId) as { matchId: number } | undefined;
  return r?.matchId ?? null;
}

/** "found my keys nvm": close a handoff in progress, or else close out their open lost reports. */
async function resolved(ctx: FlowContext, io: LostFoundIo): Promise<void> {
  const me = ctx.user.id;
  const matchId = openHandoffFor(io.db, me);
  const pair = matchId === null ? null : loadPair(io.db, matchId);
  if (pair && (await closeLoop(io, pair))) return;
  const res = io.db.prepare("UPDATE listings SET status = 'returned' WHERE userId = ? AND type = 'lost' AND status IN ('open','matched')").run(me);
  io.setState(me, null);
  await io.say(me, COPY.gladBack, Number(res.changes) > 0 ? COPY.closedReport : null);
}

/** "still looking" after a check timed out: the reports that were set aside are offered again. */
async function stillLooking(ctx: FlowContext, io: LostFoundIo): Promise<void> {
  const me = ctx.user.id;
  const mine = io.db.prepare("SELECT id FROM listings WHERE userId = ? AND type = 'lost' AND status = 'open' AND isExample = 0 ORDER BY id DESC").all(me) as { id: number }[];
  if (!mine.length) {
    await io.say(me, COPY.which);
    return;
  }
  io.db.prepare("UPDATE matches SET parked = 0 WHERE status = 'proposed' AND lostListingId IN (SELECT id FROM listings WHERE userId = ? AND type = 'lost' AND status = 'open')").run(me);
  await io.say(me, COPY.checking);
  for (const l of mine) {
    const best = pickBest(io.db, await matchListing(io.db, l.id));
    const pair = best ? loadPair(io.db, best.matchId) : null;
    if (pair) {
      await startClaim(io, pair, "just_reported");
      return;
    }
  }
  await io.say(me, ...NOTHING_YET);
}

function plainIo(db: DatabaseSync, send: (userId: number, bubbles: (string | Bubble)[]) => Promise<(string | null)[]>, adapter: MessagingAdapter | null): LostFoundIo {
  return {
    db,
    me: null,
    adapter,
    async say(userId, ...bubbles) {
      const real = LF_VOICE.bubbles(db, userId, bubbles.filter((b): b is string | Bubble => !!b));
      return real.length ? send(userId, real) : [];
    },
    setState(userId, step, data = {}) {
      setFlowState(db, userId, step ? { flow: "lost_found", step, data } : null);
    },
  };
}

/**
 * For the dashboard: DPS staff marked a pickup as done. Same close as the owner texting "got it".
 * `notify` sends plain bubbles to a user's 1:1 chat (the server already has one) and says whether they went out.
 * Returns false when there is nothing to close.
 */
export async function completeHandoff(deps: { db: DatabaseSync; notify: (userId: number, bubbles: string[]) => Promise<unknown> }, handoffId: number): Promise<boolean> {
  const { db } = deps;
  const h = db.prepare("SELECT matchId FROM handoffs WHERE id = ?").get(handoffId) as { matchId: number } | undefined;
  const pair = h ? loadPair(db, h.matchId) : null;
  if (!pair) return false;
  const lost = rawListing(db, pair.match.lostListingId);
  if (!lost || lost.status === "returned") return false;
  const io = plainIo(
    db,
    async (userId, bubbles) => {
      const delivered = (await deps.notify(userId, bubbles.map((b) => (typeof b === "string" ? b : b.text)))) !== false;
      return bubbles.map(() => (delivered ? "sent" : null));
    },
    null,
  );
  return closeLoop(io, pair);
}

// When a lost and found relay is closed with "done", ask the owner whether the item made it back.
onRelayEnd("lost_found:", async (ctx, relay) => {
  const pair = loadPair(ctx.db, Number(relay.context.split(":")[1]));
  if (!pair) return;
  const lost = rawListing(ctx.db, pair.match.lostListingId);
  if (!lost || lost.status !== "handed_off") return;
  // `asked` marks that a yes here answers this exact question.
  await ask(ioFrom(ctx), pair.ownerId, "await_pickup", { matchId: pair.match.id, asked: true }, COPY.didYouGet);
});

// ---------- nothing stays locked ----------

/** True when someone else has an open report this found item could be offered to right now. */
function someoneElseWaiting(db: DatabaseSync, foundListingId: number, exceptUserId: number): boolean {
  const found = loadListing(db, foundListingId);
  if (!found) return false;
  // findCandidates only looks at a listing that is open or matched; the lock is what is being questioned here.
  for (const c of findCandidates(db, { ...found, status: "open" })) {
    if (c.userId === exceptUserId || c.status !== "open") continue;
    if (claimantBlocked(db, foundListingId, c.userId) || publicScore(found, c) < THRESHOLDS.clarify) continue;
    const m = db.prepare("SELECT status, COALESCE(parked, 0) AS parked FROM matches WHERE foundListingId = ? AND lostListingId = ?").get(foundListingId, c.id) as { status: string; parked: number } | undefined;
    if (m && (m.status !== "proposed" || m.parked)) continue;
    const u = getUserById(db, c.userId);
    if (u && !u.stopped) return true;
  }
  return false;
}

/**
 * Release claims nobody is moving, so one silent person never keeps an item from its owner.
 * - Waiting on the claimant's description: after CLAIM_TTL_MS when someone else is waiting on the item, else HOLD_TTL_MS.
 * - Waiting on the finder's yes/no or 1/2/3: after HOLD_TTL_MS the claimant is told and keeps their report.
 * - Verified but no handoff chosen or agreed: after HOLD_TTL_MS it goes the DPS way, like a finder's "nvm".
 * Every release looks for the next owner. Safe to call as often as you like.
 */
export async function sweepClaims(io: LostFoundIo, now = Date.now()): Promise<number> {
  const { db } = io;
  const rows = db
    .prepare(
      `SELECT m.id, m.status, COALESCE(m.touchedAt, m.createdAt) AS at FROM matches m
        WHERE m.status IN ('verifying','clarifying','finder_check','finder_deciding')
           OR (m.status = 'verified' AND NOT EXISTS (SELECT 1 FROM handoffs h WHERE h.matchId = m.id))
        ORDER BY m.id`,
    )
    .all() as { id: number; status: string; at: number }[];
  let released = 0;
  for (const row of rows) {
    const idle = now - row.at;
    if (idle < CLAIM_TTL_MS) continue;
    const pair = loadPair(db, row.id);
    if (!pair || pair.match.status !== row.status) continue;
    const id = pair.match.id;
    const foundId = pair.match.foundListingId;

    if (row.status === "verifying" || row.status === "clarifying") {
      if (idle < HOLD_TTL_MS && !someoneElseWaiting(db, foundId, pair.ownerId)) continue;
      release(db, pair.match, "proposed", true);
      clearFor(io, pair.ownerId, id);
      await io.say(pair.ownerId, ...COPY.timedOut);
    } else if (idle < HOLD_TTL_MS) {
      continue;
    } else if (row.status === "finder_check") {
      // The description never got an answer, so it doesn't count against the claimant (it stays with no result).
      release(db, pair.match, "proposed", true);
      clearFor(io, pair.ownerId, id);
      clearFor(io, pair.finderId, id);
      await io.say(pair.ownerId, ...COPY.holderQuiet);
    } else if (row.status === "finder_deciding") {
      addVerification(db, id, "finder_judgment", null, null, "fail");
      release(db, pair.match, "rejected");
      clearFor(io, pair.ownerId, id);
      clearFor(io, pair.finderId, id);
      await io.say(pair.ownerId, COPY.cantConnect, COPY.reportStaysOpen);
    } else {
      // Verified, and the handoff question has sat for a day: the owner isn't left waiting on it.
      await io.say(pair.finderId, COPY.noHandoffAnswer);
      await dpsPath(io, pair);
      released++;
      continue;
    }
    released++;
    await rematch(io, foundId);
  }
  return released;
}

/**
 * Someone texted STOP or deleted their data: whatever they were holding is let go right away.
 * As the claimant, their claim is dropped and the item looks for its next owner. As the finder, the person
 * waiting on them is told instead of waiting on an answer that can't come.
 */
export async function releaseClaimsOf(io: LostFoundIo, userId: number): Promise<void> {
  const { db } = io;
  const rows = db
    .prepare(
      `SELECT m.id, lo.userId AS ownerId, fo.userId AS finderId FROM matches m
         JOIN listings lo ON lo.id = m.lostListingId
         JOIN listings fo ON fo.id = m.foundListingId
        WHERE (lo.userId = ? OR fo.userId = ?)
          AND (m.status IN ('verifying','clarifying','finder_check','finder_deciding','proof_requested')
               OR (m.status = 'verified' AND NOT EXISTS (SELECT 1 FROM handoffs h WHERE h.matchId = m.id)))
        ORDER BY m.id`,
    )
    .all(userId, userId) as { id: number; ownerId: number; finderId: number }[];
  for (const row of rows) {
    const pair = loadPair(db, row.id);
    if (!pair) continue;
    const wasWithFinder = pair.match.status === "finder_check" || pair.match.status === "finder_deciding" || pair.match.status === "verified";
    release(db, pair.match, "proposed", true);
    clearConsent(db, pair.match.id);
    clearFor(io, pair.ownerId, pair.match.id);
    clearFor(io, pair.finderId, pair.match.id);
    if (row.ownerId === userId) {
      if (wasWithFinder) await io.say(pair.finderId, COPY.claimDropped);
      await rematch(io, pair.match.foundListingId);
    } else {
      await io.say(pair.ownerId, ...COPY.lostTouch);
    }
  }
}

const sweepIoToLf = (io: SweepIo): LostFoundIo => plainIo(io.db, (userId, bubbles) => io.sayTo(userId, ...bubbles), io.adapter);

onSweep("lost_found", async (io, now) => {
  await sweepClaims(sweepIoToLf(io), now);
});
onUserGone("lost_found", (io, userId) => releaseClaimsOf(sweepIoToLf(io), userId));

/** The fixed line that puts a question back in front of someone after another conversation pushed it aside. */
function repromptFor(db: DatabaseSync, step: string, data: Data): string[] {
  const pair = loadPair(db, Number(data.matchId));
  if (!pair) return [];
  const back = `back to the ${pair.summary} u found`;
  switch (step) {
    case "finder_check":
      return [back, COPY.finderCheck];
    case "finder_decide":
      return [back, COPY.finderCall];
    case "handoff_choice":
      return [back, COPY.handoffAsk];
    case "gc_consent":
      return data.answered === true ? [] : [COPY.consent];
    case "verify_describe":
      return [`back to the ${kindOf(pair.report.category)} u lost`, COPY.describe];
    case "proof":
      return [COPY.askProof];
    default:
      return [];
  }
}

/** True while the step still matches where its match stands. */
function stepStillValid(db: DatabaseSync, step: string, data: Data): boolean {
  if (!(step in EXPECTS)) return true;
  const m = getMatch(db, Number(data.matchId));
  if (!m || !EXPECTS[step]!.includes(m.status)) return false;
  if (step === "await_pickup") return rawListing(db, m.lostListingId)?.status === "handed_off";
  if (step === "thanks_note") return rawListing(db, m.lostListingId)?.status === "returned";
  return true;
}

const ANSWER_WORDS = /^(?:y|yes|yea|yeah|yep|yup|n|no|nah|nope|1|2|3|one|two|three|nvm|never ?mind|cancel|meet|dps)\b/;

registerPendingHooks("lost_found", {
  // Open questions and the wait for pickup survive other flows. Only the questions make a person "busy".
  protects: (db, s) => (ASK_STEPS.has(s.step) || s.step === "await_pickup") && stepStillValid(db, s.step, s.data),
  blocks: (db, s) => ASK_STEPS.has(s.step) && stepStillValid(db, s.step, s.data),
  valid: (db, s) => stepStillValid(db, s.step, s.data),
  reprompt: (db, s) => repromptFor(db, s.step, s.data),
  // In relay mode an answer to one of these questions is for Troy, not for the other person.
  keepsFromRelay: (db, _user, state, event) => {
    if (!state || state.flow !== "lost_found" || !ASK_STEPS.has(state.step) || !stepStillValid(db, state.step, state.data)) return false;
    if (state.step === "verify_describe" || state.step === "proof") return true;
    return ANSWER_WORDS.test(word(event.text ?? ""));
  },
});

// ---------- cancel ----------

async function cancelStep(ctx: FlowContext, io: LostFoundIo, step: string, pair: Pair | null, data: Data): Promise<void> {
  const me = ctx.user.id;
  const { db } = io;
  if (!pair) {
    io.setState(me, null);
    await io.say(me, COPY.dropped);
    return;
  }
  switch (step) {
    case "verify_describe":
      // Backing out resets nothing: tries already used stay used, and this pair waits until they report again.
      release(db, pair.match, "proposed", true);
      io.setState(me, null);
      await io.say(me, COPY.stoppedOpen);
      await rematch(io, pair.match.foundListingId);
      return;
    case "proof":
      // Giving up here is the same as having no proof. The tries are used either way.
      await toFinderDecide(io, pair, null);
      return;
    case "await_finder":
      // The finder still gets to answer. The owner just isn't held in this step anymore.
      io.setState(me, null);
      await io.say(me, COPY.stillTextIfYes);
      return;
    case "finder_check":
      // The finder passed on answering. The description they were shown still counts as a try.
      db.prepare("UPDATE verifications SET result = 'fail' WHERE matchId = ? AND method = 'blind_description' AND result IS NULL").run(pair.match.id);
      release(db, pair.match, "proposed", true);
      io.setState(me, null);
      clearFor(io, pair.ownerId, pair.match.id);
      await io.say(me, COPY.skipping);
      await io.say(pair.ownerId, ...NOTHING_YET);
      await rematch(io, pair.match.foundListingId);
      return;
    case "finder_decide":
      await finderDecides(io, pair, 3);
      return;
    case "handoff_choice":
      // A verified owner is waiting, so the safe default is DPS.
      await io.say(me, COPY.ownerWaitingDps);
      await dpsPath(io, pair);
      return;
    case "gc_consent":
      await handleConsent(ctx, io, pair, data, false);
      return;
    case "await_pickup":
      io.setState(me, null);
      await io.say(me, COPY.gotItWhenever);
      return;
    case "thanks_note":
      await handleThanks(ctx, io, pair, "", true);
      return;
    default:
      io.setState(me, null);
      await io.say(me, COPY.dropped);
  }
}

// ---------- the handler ----------

/** The match status each step expects. Anything else means the step went stale (someone else moved it on). */
const EXPECTS: Record<string, string[]> = {
  verify_describe: ["verifying"],
  proof: ["proof_requested"],
  finder_check: ["finder_check"],
  await_finder: ["finder_check", "finder_deciding"],
  finder_decide: ["finder_deciding"],
  handoff_choice: ["verified"],
  gc_consent: ["verified"],
  await_pickup: ["verified"],
  thanks_note: ["verified"],
};

/** Hand a message that isn't about lost and found to smalltalk. Loaded at call time: the registry imports this file. */
async function toSmalltalk(ctx: FlowContext): Promise<void> {
  const { getFlow } = await import("../index.ts");
  const chat = getFlow("smalltalk");
  if (chat) await chat.handle({ ...ctx, state: null, intent: { flow: "smalltalk", action: "chat", details: {}, source: ctx.intent.source } });
}

/** After a step went stale: a new report starts fresh, anything else is ordinary chat (or another flow's, via the pipeline). */
async function freshOrChat(ctx: FlowContext, io: LostFoundIo): Promise<void> {
  const w = word(ctx.event.text ?? "");
  const action = ctx.intent.action;
  const ours = ctx.event.images.length > 0 || action === "report_found" || action === "report_lost" || action === "resolved" || action === "still_looking" || /\b(?:lost|missing|misplaced|cant find|found|picked up)\b/.test(w) || STILL_LOOKING.test(w);
  if (ours) return startFresh(ctx, io);
  if (ctx.intent.flow !== "lost_found") return;
  await toSmalltalk(ctx);
}

async function startFresh(ctx: FlowContext, io: LostFoundIo): Promise<void> {
  const action = ctx.intent.action;
  const w = word(ctx.event.text ?? "");
  if (ctx.event.images.length || action === "report_found") return reportFound(ctx, io);
  if (action === "resolved") return resolved(ctx, io);
  if (action === "still_looking" || STILL_LOOKING.test(w)) return stillLooking(ctx, io);
  if (action === "report_lost") return reportLost(ctx, io);
  if (/\b(?:lost|missing|misplaced|cant find)\b/.test(w)) return reportLost(ctx, io);
  if (/\b(?:found|picked up)\b/.test(w)) return reportFound(ctx, io);
  await io.say(ctx.user.id, COPY.which);
}

async function handle(ctx: FlowContext): Promise<void> {
  const io = ioFrom(ctx);
  const me = ctx.user.id;
  const { event } = ctx;
  if (event.pollVote) return;

  const state: FlowState | null = ctx.state?.flow === "lost_found" ? ctx.state : null;
  // An intake question or the thank-you ask that sat too long is over: this message is a new one, not an answer.
  if (state && ((INTAKE_STEPS.has(state.step) && Date.now() - state.updatedAt > INTAKE_TTL_MS) || (state.step === "thanks_note" && Date.now() - state.updatedAt > THANKS_TTL_MS))) {
    io.setState(me, null);
    if (!event.reaction) await freshOrChat(ctx, io);
    return;
  }
  const step = state?.step ?? "";
  const data: Data = state?.data ?? {};
  let text = (event.text ?? "").trim();

  if (event.reaction) {
    // A tapback only answers a yes/no question, and only on the question bubble itself. A like on any other
    // bubble (the pickup code, a status line) means nothing. A switched tapback replaces the old one.
    if (!state || event.reaction.removed || !TAP_STEPS.has(step)) return;
    if (typeof data.qid !== "string" || data.qid !== event.reaction.targetMessageId) return;
    if (step === "await_pickup" && data.asked !== true) return;
    if (event.reaction.type === "like" || event.reaction.type === "love" || event.reaction.type === "emphasize") text = "yes";
    else if (event.reaction.type === "dislike") text = "no";
    else return;
  }
  const w = word(text);
  const hasImage = !event.reaction && event.images.length > 0;

  if (!state) return startFresh(ctx, io);

  const needsMatch = step in EXPECTS;
  const pair = needsMatch ? loadPair(io.db, Number(data.matchId)) : null;
  if (needsMatch && (!pair || !stepStillValid(io.db, step, data))) {
    io.setState(me, null);
    if (hasImage || ctx.intent.action === "report_found" || ctx.intent.action === "report_lost" || ctx.intent.action === "resolved") return startFresh(ctx, io);
    if (STILL_LOOKING.test(w)) return stillLooking(ctx, io);
    if (!event.reaction) await io.say(me, COPY.sorted);
    return;
  }

  if (!hasImage && CANCEL.test(w)) return cancelStep(ctx, io, step, pair, data);

  // "found it nvm" from an owner who is still mid-claim: let go of the match, then close their report.
  if (ctx.intent.action === "resolved" && !hasImage) {
    if (step === "lost_category" || step === "lost_place" || step === "lost_time") {
      io.setState(me, null);
      await io.say(me, COPY.gladBack);
      return;
    }
    if (pair && (step === "verify_describe" || step === "proof" || step === "await_finder")) {
      const foundId = pair.match.foundListingId;
      if (step === "await_finder") clearFor(io, pair.finderId, pair.match.id);
      release(io.db, pair.match, "proposed", true);
      await resolved(ctx, io);
      await rematch(io, foundId);
      return;
    }
    if (pair && step === "await_pickup" && (await closeLoop(io, pair))) return;
  }

  // A photo where no photo can be an answer is a new found item. So is a clear new report at a choice step.
  // The question that was open is set aside, not lost: it is asked again once the new report is done.
  const setAside = () => {
    if (isProtected(io.db, state)) parkAsk(io.db, me, { flow: "lost_found", step, data });
    io.setState(me, null);
  };
  if (hasImage && PHOTO_IS_NEW.has(step)) {
    setAside();
    return reportFound(ctx, io);
  }
  if (ctx.intent.source === "ai" && CHOICE_STEPS.has(step) && (ctx.intent.action === "report_lost" || ctx.intent.action === "report_found")) {
    setAside();
    return startFresh(ctx, io);
  }

  const elsewhere = ctx.intent.flow !== "lost_found";

  switch (step as Step) {
    case "found_what": {
      if (!text) {
        await io.say(me, COPY.askWhat);
        return;
      }
      const profile = profileFromText(text, true);
      if (!profile) {
        await io.say(me, COPY.askWhat);
        return;
      }
      const spot = (data.spot as Spot | null) ?? spotFrom(io.db, text, pullDetails(text).place);
      return continueFound(ctx, io, { photo: (data.photo as IncomingImage | null) ?? null, profile, spot, fromText: true });
    }
    case "found_place": {
      const profile = sanitizeProfile(data.profile);
      if (!profile) {
        io.setState(me, null);
        await io.say(me, COPY.which);
        return;
      }
      const pulled = spotFrom(io.db, text, pullDetails(text).place);
      if (!text || (elsewhere && !pulled)) {
        if (!text) await io.say(me, COPY.askFoundPlace);
        return;
      }
      // "idk" still saves the listing. A place just makes matching better.
      const spot = IDK.test(w) ? null : (pulled ?? { text: text.slice(0, 80), lat: null, lng: null });
      return continueFound(ctx, io, { photo: (data.photo as IncomingImage | null) ?? null, profile, spot, placeAsked: true, fromText: data.fromText === true, marksAsked: data.marksAsked === true });
    }
    case "found_marks": {
      const base = sanitizeProfile(data.profile);
      if (!base) {
        io.setState(me, null);
        await io.say(me, COPY.which);
        return;
      }
      if (!text) {
        await io.say(me, COPY.askMarks);
        return;
      }
      // "idk" or "nothing" still saves the listing. It just leaves the owner check to the finder later.
      const nothing = IDK.test(w) || /^(?:nothing|none|nope|nah|not really|no marks|plain|its plain|skip)\b/.test(w);
      const marks = nothing ? [] : text.split(/[,;\n]|\band\b/i).map((p) => p.trim()).filter((p) => p.length >= 3).slice(0, 8);
      // The brand may join the public line. A color said here stays hidden: it is often the case or the lanyard, not the item.
      const profile = sanitizeProfile({ ...base, brand: base.brand ?? pullDetails(text).brand ?? null, title: "", publicSummary: "", distinguishing: marks }) ?? base;
      return continueFound(ctx, io, { photo: (data.photo as IncomingImage | null) ?? null, profile, spot: (data.spot as Spot | null) ?? null, placeAsked: true, fromText: true, marksAsked: true });
    }
    case "lost_category":
    case "lost_place":
    case "lost_time":
      return answerLost(ctx, io, step as Step, data, hasImage && !text ? "" : text);
    case "verify_describe":
      return handleDescribe(ctx, io, pair!, text);
    case "proof":
      return handleProof(ctx, io, pair!, w);
    case "finder_check":
      return handleFinderCheck(ctx, io, pair!, w);
    case "finder_decide": {
      const choice = /^(?:1|one)\b|\bmeet\b/.test(w) ? 1 : /^(?:2|two)\b|\bdps\b|\bdrop\b/.test(w) ? 2 : /^(?:3|three)\b|\bkeep\b|\bhold/.test(w) ? 3 : null;
      if (choice === null) {
        if (!elsewhere || /^\d+$/.test(w)) await io.say(me, COPY.reply123);
        return;
      }
      return finderDecides(io, pair!, choice);
    }
    case "handoff_choice": {
      const meet = /^(?:1|one)\b|\bmeet\b|\bhold\b|in person/.test(w);
      const dps = /^(?:2|two)\b|\bdps\b|\bdrop\b|lost and found/.test(w);
      if (meet === dps) {
        if (!elsewhere || /^\d+$/.test(w)) await io.say(me, COPY.reply12);
        return;
      }
      io.setState(me, null);
      if (dps) return dpsPath(io, pair!);
      return startMeet(io, pair!, false);
    }
    case "gc_consent": {
      // A question is never consent to sharing contact info ("ok so any update?" is not a yes).
      const yn = /\?/.test(text) ? null : yesNo(w);
      // Already said yes and waiting on the other person. Only a change of mind (no) does anything here.
      if (data.answered === true && yn !== false) {
        if (elsewhere || event.reaction) return;
        await io.say(me, COPY.waitingConsent);
        return;
      }
      return handleConsent(ctx, io, pair!, data, yn);
    }
    case "await_finder":
      if (elsewhere) return;
      // Waiting on one item never blocks reporting another. (A second go at the same item is refused in matching.)
      if (ctx.intent.action === "report_lost" || ctx.intent.action === "report_found" || /\b(?:lost|missing|misplaced|cant find|found|picked up)\b/.test(w)) {
        io.setState(me, null);
        return startFresh(ctx, io);
      }
      await io.say(me, COPY.stillWaiting);
      return;
    case "await_pickup": {
      // Only "got it" closes the handoff. A plain "ok" or "bet" is an acknowledgement, not a pickup: it counts
      // as yes only as the answer to "did u get it back?" (asked when a relay is closed).
      const yn = yesNo(w);
      if (GOT_IT.test(w) || (data.asked === true && yn === true)) {
        if (await closeLoop(io, pair!)) return;
      }
      if (/\bcode\b/.test(w)) {
        const h = io.db.prepare("SELECT pickupCode FROM handoffs WHERE matchId = ? ORDER BY id DESC LIMIT 1").get(pair!.match.id) as { pickupCode: string | null } | undefined;
        if (h?.pickupCode) await io.say(me, T.urCode(h.pickupCode), ...dpsWhere(io.db));
        else await io.say(me, COPY.noCode);
        return;
      }
      if (yn === false || /\bnot yet\b/.test(w)) {
        await io.say(me, COPY.noRush);
        return;
      }
      if (elsewhere) return;
      await io.say(me, yn === true ? COPY.soundsGood : null, COPY.gotItHint);
      return;
    }
    case "thanks_note": {
      const skip = !text || SKIP.test(w);
      // A greeting, a question or a request for something else is not a thank-you. It is never passed to the finder.
      const notANote = !skip && ((elsewhere && ctx.intent.flow !== "smalltalk") || /\?/.test(text) || (GREETING.test(w) && !THANKS_WORDS.test(w)));
      if (notANote) {
        io.setState(me, null);
        await freshOrChat(ctx, io);
        return;
      }
      return handleThanks(ctx, io, pair!, text, skip);
    }
    default:
      io.setState(me, null);
      return startFresh(ctx, io);
  }
}

export const lostFound: FlowHandler = { name: "lost_found", handle };
