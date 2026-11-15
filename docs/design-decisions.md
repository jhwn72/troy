# Troy: the decisions behind the design

One source for Troy's judge notes, the landing page, the Devpost write-up, the slides and the video. Each entry: the choice, the reason in plain words, and the proof in the build. Numbers are from the build on Nov 14, 2026 and should be refreshed before submitting.

## Product and experience

1. **No app, no website, no sign-up form.** Students already check their texts all day and mostly ignore email and new apps. So there is nothing to download and nothing to remember: you text a number. Verification happens inside the chat.
2. **Troy connects, then steps back.** He finds the right person or office, makes the introduction and leaves. The offices (DPS Lost & Found, FMS, USC Housing, USG) stay in charge. He is the front door, not a replacement.
3. **A photo replaces the form.** Sending a picture is easier than describing something. Troy reads the photo, works out what it is, counts it and routes it.
4. **Location decides who hears about it.** Only people close enough to act get a text, so alerts stay useful. Students choose their own alert distance and can erase their location with one message.
5. **The finder chooses the handoff.** The person holding the item picks: meet the owner or drop it at DPS. It is their time, so it is their call.
6. **Troy texts first.** Status changes come to you ("fixed", "update from USG"). Nobody has to chase an office.
7. **He sounds like a person.** Outside a short list of safety lines, nothing he says is scripted. He works from a brief about who he is and what he knows, so he can talk about anything and still do his job.

8. **Short on purpose.** A general chatbot answers with a wall of text. Troy answers in one to three short bubbles, like a friend texting, because the goal is to get you to a person, not to keep you reading.

## Trust and safety

9. **Prove it before you see it.** An owner describes the item before seeing any photo or detail, so a stranger can't read the answer off the screen. In testing on 40 written cases, including look-alikes and fraud attempts, Troy made zero wrong handoffs.
10. **Contact info is shared only after both people say yes.** Group chats share numbers, so Troy warns both sides first. Anyone can choose relay mode, where Troy passes messages and no number is shared.
11. **Dangerous items always go to DPS.** No student-to-student handoff, decided in code.
12. **A privacy gate in front of everything.** Troy runs on a personal phone number for this demo, so every message is checked against an allow-list before it is saved, read by the AI or answered. Everything else is ignored completely.

## Technical

13. **Code owns the facts, the AI owns the wording.** Pickup codes, counts, walking times, verification results, office names and links are inserted by code. The model writes how it is said, never what is true.
14. **Two models, each for what it is good at.** A stronger model reads photos, matches and verifies. A faster one works out what a message is asking for.
15. **It keeps working when the AI is down.** Every step has a rule-based fallback, and when the AI can't score a claim, the finder decides instead of a guess.
16. **One engine, five steps.** Understand, find, check, connect, follow up. Lost items, free food, repairs, concerns and rides all run on the same steps, so a new use is a new connection, not a new product.
17. **Tested like software, not a prompt.** Hundreds of automated tests, a scored evaluation set, and reviewers whose only job was to break it.
