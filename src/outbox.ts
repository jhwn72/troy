// Texts Troy starts on his own from the dashboard (a report's status changed, a pickup was completed).
// Someone in quiet hours or on pause doesn't get them right then, but they are not thrown away either:
// they wait here and go out, in order, once the person can get alerts again. STOP drops them for good.
//
// `owed` is for a text that answers something the person is in the middle of right now (DPS staff just
// handed their item over the counter): it is not held back by quiet hours or pause. Never sent after STOP.

import type { DatabaseSync } from "node:sqlite";
import type { MessagingAdapter } from "./types.ts";
import { getUserById, saveMessage } from "./db/index.ts";
import { canAlert } from "./quiet.ts";

export type NotifierDeps = {
  db: DatabaseSync;
  /** Null until the adapter is ready. */
  getAdapter: () => MessagingAdapter | null;
  /** The kill switch. Nothing is sent or queued while it is off. */
  enabled: () => boolean;
  now?: () => Date;
};

export type Notify = (userId: number, bubbles: string[], opts?: { owed?: boolean }) => Promise<boolean>;

export function createNotifier(deps: NotifierDeps): { notify: Notify; flush: () => Promise<number> } {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  db.exec("CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL)");

  async function sendNow(userId: number, text: string): Promise<boolean> {
    const adapter = deps.getAdapter();
    const user = getUserById(db, userId);
    if (!adapter || !user || user.stopped) return false;
    const sent = await adapter.sendMessage(user.chatId, text).catch(() => null);
    if (!sent) return false;
    saveMessage(db, { userId: user.id, chatId: user.chatId, direction: "out", providerMessageId: sent.messageId, text, notice: true });
    return true;
  }

  /** Send what is waiting for one person, oldest first. Stops at the first text that doesn't go out. */
  async function flushUser(userId: number): Promise<number> {
    const user = getUserById(db, userId);
    if (!user || user.stopped) {
      db.prepare("DELETE FROM outbox WHERE userId = ?").run(userId);
      return 0;
    }
    if (!canAlert(user, now())) return 0;
    let sent = 0;
    for (const row of db.prepare("SELECT id, text FROM outbox WHERE userId = ? ORDER BY id").all(userId) as { id: number; text: string }[]) {
      if (!(await sendNow(userId, row.text))) break;
      db.prepare("DELETE FROM outbox WHERE id = ?").run(row.id);
      sent++;
    }
    return sent;
  }

  /** True when the text went out or is waiting to. False when it never will (STOP, no such user, Troy is off). */
  const notify: Notify = async (userId, bubbles, opts) => {
    if (!deps.getAdapter() || !deps.enabled()) return false;
    const user = getUserById(db, userId);
    if (!user || user.stopped) return false;
    if (!opts?.owed && !canAlert(user, now())) {
      const add = db.prepare("INSERT INTO outbox (userId, text, createdAt) VALUES (?, ?, ?)");
      for (const text of bubbles) add.run(userId, text, Date.now());
      return bubbles.length > 0;
    }
    // Anything older goes first so texts never arrive out of order.
    if (!opts?.owed) await flushUser(userId);
    let delivered = false;
    for (const text of bubbles) delivered = (await sendNow(userId, text)) || delivered;
    return delivered;
  };

  async function flush(): Promise<number> {
    if (!deps.getAdapter() || !deps.enabled()) return 0;
    let sent = 0;
    for (const r of db.prepare("SELECT DISTINCT userId FROM outbox ORDER BY userId").all() as { userId: number }[]) sent += await flushUser(r.userId);
    return sent;
  }

  return { notify, flush };
}
