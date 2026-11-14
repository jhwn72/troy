# Receiving tapbacks (tested 2026-11-14)

Test chat only (`any;-;test-phone@example.com`), BlueBubbles 1.9.12 with the patched helper, macOS 27.0.1. The test phone reacted to a message the Mac sent through the API (guid `0E620BAE-BDA0-40CC-B0C8-E34C7B734942`).

## Answers

1. **Event:** every tapback arrives as a normal `new-message` webhook event, a separate message with its own `guid`.
   - `associatedMessageType` is a **string**: `"love"`, `"like"` (the others are `"dislike"`, `"laugh"`, `"emphasize"`, `"question"`, plus emoji tapbacks).
   - `associatedMessageGuid` is the reacted-to message's guid **with a `p:<partIndex>/` prefix**: `p:0/0E620BAE-BDA0-40CC-B0C8-E34C7B734942`. Strip `p:N/` to match the original guid. (`bp:` was not seen here; BlueBubbles uses it for some balloon messages, so strip it too.)
   - `text` is Apple's fallback, e.g. `Loved “…”`, `Liked “…”`. Don't treat it as user text.
2. **Removal:** sends a `new-message` with type `"-like"` (minus prefix), same `p:0/` guid, text `Removed a like from “…”`.
   - **Replacing** one tapback with another (Love, then Like) sent only the new `"like"` event. There was **no `"-love"` event**, so treat a new tapback from the same handle on the same message as replacing the previous one.
3. **Sender:** `isFromMe` is `false`, and `handle.address` is the phone's handle (`test-phone@example.com`). `chats[0].guid` is the test chat.

Also seen: the reacted-to message itself fired two `new-message` events with `isFromMe: true` (send, then a delivery update). Dedupe by `guid`. Typing-indicator events fire around reactions too.

## Polls and votes (for reference)

- A poll arrives as `new-message` with `balloonBundleId` = `com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.messages.Polls`, `text` = `\ufffc`, no associated type.
- A vote arrives as `new-message` with `associatedMessageType` = `"4000"`, `associatedMessageGuid` = the poll's guid **without** a `p:` prefix, the same Polls `balloonBundleId`, empty text.

## Sample event (Love), trimmed to the useful fields

```json
{
  "type": "new-message",
  "data": {
    "guid": "8E36CFB6-283A-4901-B1AB-69212A3DE593",
    "text": "Loved “Troy tapback test: please Love this, then Like it, then remove both”",
    "isFromMe": false,
    "handle": {
      "address": "test-phone@example.com",
      "service": "iMessage"
    },
    "associatedMessageGuid": "p:0/0E620BAE-BDA0-40CC-B0C8-E34C7B734942",
    "associatedMessageType": "love",
    "balloonBundleId": null,
    "itemType": 0,
    "dateCreated": 1794688935329,
    "chats": [
      {
        "guid": "any;-;test-phone@example.com",
        "chatIdentifier": "test-phone@example.com",
        "style": 45
      }
    ],
    "threadOriginatorGuid": null,
    "partCount": 1,
    "attachments": []
  }
}
```
