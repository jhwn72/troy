-- Troy schema. Times are unix milliseconds. JSON columns hold JSON text.
-- Only allowed chats are ever stored.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys: go_live_at (ms), troy_enabled ("true" | "false")

CREATE TABLE IF NOT EXISTS allow_list (
  id INTEGER PRIMARY KEY,
  handle TEXT,            -- normalized handle, or null for a group chat entry
  chatId TEXT,            -- provider chat id, or null for a handle-only entry
  reason TEXT NOT NULL CHECK (reason IN ('opt_in_phrase','manual','troy_group')),
  addedAt INTEGER NOT NULL,
  UNIQUE (handle, chatId)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  chatId TEXT NOT NULL,
  name TEXT,
  uscEmail TEXT,
  verifiedAt INTEGER,
  verifiedVia TEXT CHECK (verifiedVia IN ('usc_email','judge_skip')),
  contactMode TEXT NOT NULL DEFAULT 'direct' CHECK (contactMode IN ('direct','relay_only','no_contact')),
  groupChatsAllowed INTEGER NOT NULL DEFAULT 1,
  subscriptions TEXT NOT NULL DEFAULT '[]',
  usualSpots TEXT NOT NULL DEFAULT '[]',
  alertMinutes INTEGER NOT NULL DEFAULT 15,
  quietHours TEXT,
  bannedFromPosting INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  stopped INTEGER NOT NULL DEFAULT 0,
  isExample INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  -- Last known location (src/location.ts is the only reader and writer). Never shown to another student or on a dashboard.
  lastLat REAL,
  lastLng REAL,
  lastLocationAt INTEGER,
  lastLocationSource TEXT CHECK (lastLocationSource IN ('find_my','pin','asked'))
);

CREATE TABLE IF NOT EXISTS flow_state (
  userId INTEGER PRIMARY KEY REFERENCES users(id),
  flow TEXT NOT NULL,
  step TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY,
  userId INTEGER NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_notes (
  id INTEGER PRIMARY KEY,
  userId INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('rule','preference')),
  text TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  userId INTEGER REFERENCES users(id),
  chatId TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  providerMessageId TEXT,
  text TEXT,
  media TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_provider ON messages(providerMessageId);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chatId, createdAt);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  userId INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('found','lost','ride')),
  category TEXT,
  title TEXT,
  details TEXT NOT NULL DEFAULT '{}',   -- found: vision profile incl. hidden distinguishing details; ride: destination, window
  photoUrl TEXT,
  locationText TEXT,
  lat REAL,
  lng REAL,
  happenedAt INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','verifying','verified','handed_off','returned','expired')),
  isValuable INTEGER NOT NULL DEFAULT 0,
  isDangerous INTEGER NOT NULL DEFAULT 0,
  heldBy TEXT CHECK (heldBy IN ('finder','dps')),
  isExample INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  foundListingId INTEGER NOT NULL REFERENCES listings(id),
  lostListingId INTEGER NOT NULL REFERENCES listings(id),
  confidence INTEGER NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai','fallback')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','clarifying','finder_check','verifying','proof_requested','finder_deciding','verified','rejected')),
  createdAt INTEGER NOT NULL,
  touchedAt INTEGER,              -- last time the claim moved; stale claims are released (see lostfound/handler.ts)
  parked INTEGER NOT NULL DEFAULT 0, -- 1 = the claimant backed out or timed out; not offered again until they report again
  UNIQUE (foundListingId, lostListingId)
);

CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY,
  matchId INTEGER NOT NULL REFERENCES matches(id),
  method TEXT NOT NULL CHECK (method IN ('blind_description','name_match','finder_confirm','proof_photo','finder_judgment')),
  ownerAnswer TEXT,
  score INTEGER,
  result TEXT CHECK (result IN ('pass','fail')),
  attempts INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY,
  matchId INTEGER NOT NULL REFERENCES matches(id),
  chosenBy TEXT NOT NULL DEFAULT 'finder',
  method TEXT NOT NULL CHECK (method IN ('group_chat','relay','dps_code')),
  pickupCode TEXT,
  completedAt INTEGER,
  thankYouNote TEXT,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS food_drops (
  id INTEGER PRIMARY KEY,
  posterUserId INTEGER NOT NULL REFERENCES users(id),
  clubName TEXT,
  description TEXT,
  photoUrl TEXT,
  locationText TEXT,
  lat REAL,
  lng REAL,
  servingsTotal INTEGER NOT NULL,
  servingsLeft INTEGER NOT NULL,
  holdMinutes INTEGER NOT NULL DEFAULT 15,
  alertMessageIds TEXT NOT NULL DEFAULT '{}',  -- { [userId]: providerMessageId }
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','ended','removed')),
  reports INTEGER NOT NULL DEFAULT 0,
  isExample INTEGER NOT NULL DEFAULT 0,
  expiresAt INTEGER,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  foodDropId INTEGER NOT NULL REFERENCES food_drops(id),
  userId INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','picked_up','released')),
  heldUntil INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  userId INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('repair','usg_concern')),
  anonymous INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  description TEXT,
  photoUrl TEXT,
  locationText TEXT,
  routedTo TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_progress','on_agenda','fixed','acted_on','closed')),
  duplicateOf INTEGER REFERENCES reports(id),
  followers TEXT NOT NULL DEFAULT '[]',   -- userIds
  isExample INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS directory (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('office','usg_committee','usg_program')),
  name TEXT NOT NULL UNIQUE,
  topics TEXT NOT NULL DEFAULT '[]',
  contactMethod TEXT,
  url TEXT,
  details TEXT,
  isExample INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS campus_places (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  nicknames TEXT NOT NULL DEFAULT '[]',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  kind TEXT    -- 'campus' (FMS) | 'dorm' (Housing) | 'other'
);

-- Relay mode: Troy passes messages between two users without sharing contact info. See src/relay.ts.
CREATE TABLE IF NOT EXISTS relays (
  id INTEGER PRIMARY KEY,
  userA INTEGER NOT NULL REFERENCES users(id),
  userB INTEGER NOT NULL REFERENCES users(id),
  context TEXT NOT NULL,          -- what it is for, e.g. 'lost_found:12' (the match id)
  labelA TEXT,                    -- how A is introduced to B ("the finder"). A role, never a name or number.
  labelB TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  createdAt INTEGER NOT NULL,     -- relays expire 24 hours after this
  endedAt INTEGER
);
CREATE INDEX IF NOT EXISTS relays_active ON relays(status, userA, userB);

-- Flow 2: every bubble of a food alert, so a tapback on any of them claims and the count bubble can be edited.
-- Same definition as the one src/flows/food.ts creates on first use.
CREATE TABLE IF NOT EXISTS food_alert_bubbles (
  messageId TEXT PRIMARY KEY,
  foodDropId INTEGER NOT NULL,
  userId INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('count','walk','claim','report'))
);
CREATE INDEX IF NOT EXISTS food_alert_bubbles_drop ON food_alert_bubbles(foodDropId, userId);

-- Notes flow: how to undo the setting a note changed ("forget that"). Same definition as src/flows/notes.ts.
CREATE TABLE IF NOT EXISTS note_effects (
  noteId INTEGER PRIMARY KEY,
  userId INTEGER NOT NULL,
  undo TEXT NOT NULL
);

-- Questions waiting for a person who is busy with another step (see src/pending.ts).
CREATE TABLE IF NOT EXISTS pending_asks (
  id INTEGER PRIMARY KEY,
  userId INTEGER NOT NULL,
  flow TEXT NOT NULL,
  step TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  bubbles TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_asks_user ON pending_asks(userId, id);

-- "last one" / "all gone" texts already sent for a drop, so each person gets each at most once.
CREATE TABLE IF NOT EXISTS food_milestones (
  foodDropId INTEGER NOT NULL,
  userId INTEGER NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (foodDropId, userId, kind)
);

-- Dashboard texts held back by quiet hours or pause, sent when the person can get alerts again (see src/outbox.ts).
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  userId INTEGER NOT NULL,
  text TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
