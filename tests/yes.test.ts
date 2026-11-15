import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingEvent, TapbackType } from "../src/types.ts";
import { openDb, getOrCreateUser, setFlowState, getFlowState } from "../src/db/index.ts";
import { noteOpenQuestion, openQuestionId, readYesNo } from "../src/yes.ts";

const event = (over: Partial<IncomingEvent>): IncomingEvent => ({ provider: "webchat", userHandle: "+12135550100", chatId: "c", isGroup: false, messageId: "m", text: "", images: [], receivedAt: 0, ...over });
const typed = (text: string) => readYesNo({ event: event({ text }), questionMessageId: null });
const tapped = (type: TapbackType, target: string, question: string | null, opts: { removed?: boolean; allowTapback?: boolean } = {}) =>
  readYesNo({ event: event({ reaction: { targetMessageId: target, type, removed: !!opts.removed } }), questionMessageId: question, allowTapback: opts.allowTapback });

test("typed yes, in every usual shape", () => {
  for (const t of ["yes", "Yes!", "yep", "yup", "yeah", "ya", "sure", "ok", "okay", "bet", "do it", "please do", "y", "yes please", "yeah sure", "ok bet", "sure thing", "go ahead", "sounds good", "yes 🙏", "YES.", "ok!!", "👍", "yeah do it", "for sure", "k"]) {
    assert.equal(typed(t), "yes", t);
  }
});

test("typed no, in every usual shape", () => {
  for (const t of ["no", "No.", "nah", "nope", "n", "no thanks", "nah im good", "not now", "no thank u", "nope 😅", "👎", "nvm", "no way"]) {
    assert.equal(typed(t), "no", t);
  }
});

test("a question is never a yes, and neither is a yes with strings attached", () => {
  for (const t of ["ok but why?", "yes?", "sure, what for?", "ok but why", "yes if it's free", "ok so i lost my wallet", "i am not sure", "yeah no", "ok no", "maybe", "", "   ", "lost my airpods", "what", "sure i guess but can u explain first"]) {
    assert.equal(typed(t), null, JSON.stringify(t));
  }
});

test("a tapback is a yes or a no only on the open question itself", () => {
  assert.equal(tapped("like", "q1", "q1"), "yes");
  assert.equal(tapped("love", "q1", "q1"), "yes");
  assert.equal(tapped("dislike", "q1", "q1"), "no");
  // Any other bubble: an acknowledgement, nothing more.
  assert.equal(tapped("like", "other", "q1"), null);
  assert.equal(tapped("dislike", "other", "q1"), null);
  // Nothing open (expired or already answered).
  assert.equal(tapped("like", "q1", null), null);
  // Other tapbacks and removed ones say nothing.
  for (const type of ["laugh", "emphasize", "question"] as const) assert.equal(tapped(type, "q1", "q1"), null, type);
  assert.equal(tapped("like", "q1", "q1", { removed: true }), null);
});

test("where a tapback can't answer (deleting data, a verification step), it never does", () => {
  assert.equal(tapped("like", "q1", "q1", { allowTapback: false }), null);
  assert.equal(tapped("love", "q1", "q1", { allowTapback: false }), null);
  assert.equal(tapped("dislike", "q1", "q1", { allowTapback: false }), null);
  // Typed answers still count there.
  assert.equal(readYesNo({ event: event({ text: "yes" }), questionMessageId: "q1", allowTapback: false }), "yes");
});

test("a poll vote is not a yes or a no", () => {
  assert.equal(readYesNo({ event: event({ pollVote: { pollMessageId: "p", optionIndex: 0 } }), questionMessageId: "p" }), null);
});

test("the open question: a flow's own qid wins, a recorded bubble counts only while its step is still open", () => {
  const db = openDb(":memory:");
  const u = getOrCreateUser(db, "+12135550100", "c");
  assert.equal(openQuestionId(db, u.id), null, "nothing open");

  setFlowState(db, u.id, { flow: "repair", step: "where", data: {} });
  noteOpenQuestion(db, u.id, getFlowState(db, u.id), "out-7");
  assert.equal(openQuestionId(db, u.id), "out-7");

  // The step moved on: the old bubble is not the open question anymore.
  setFlowState(db, u.id, { flow: "repair", step: "confirm", data: {} });
  assert.equal(openQuestionId(db, u.id), null);

  // A flow that tracks its own question.
  setFlowState(db, u.id, { flow: "lost_found", step: "gc_consent", data: { qid: "out-9" } });
  assert.equal(openQuestionId(db, u.id), "out-9");

  // Answered: no state, nothing open.
  setFlowState(db, u.id, null);
  assert.equal(openQuestionId(db, u.id), null);
});
