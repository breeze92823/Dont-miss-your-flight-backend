// Keep in step with the client's src/config.js by hand (Don't Miss Your Flight).
// Players per room (WorldRoom's maxClients). The deploy sends no room size: Bloxity's seatCap
// defaults to 50, so the room holds the same 50 (2-100 for party play). Every player in a room is a
// passenger the others see.
export const ROOM_MAX_CLIENTS = 50;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// A Bloxity game token (JWT) from the client's join options / `identify`.
export const TOKEN_MAX_LEN = 4096;

// Presence (presence.ts): the Bloxity look JSON relayed for the others to draw, and the world
// bounds a pose is clamped to (|x|, |z| up to `xz` m, y between -`yDown` and `yUp`: the cabin is
// built at y 300, the arrival city far out on x).
export const AVATAR_MAX_LEN = 3000;
export const POSE_BOUNDS = { xz: 5000, yDown: 200, yUp: 1000, speed: 60 };
// Where a player is: the shared airport, the flight cabin (shared by every flight in the air) or the
// arrival city (per destination, clients only draw players who landed in the same city).
export const ZONES = ["airport", "cabin", "city"] as const;
// The shared lines a player can stand in (client queue.js / security.js / boarding.js).
export const LINES = ["", "checkin", "security", "boarding"] as const;
export const LINE_KINDS = ["checkin", "security", "boarding"] as const;
// Lines are server-ordered (lines.ts): `joinLine` hands out a ticket (join order), `skipLine` moves
// it to the front, `callMe` { kind, keys } sends one of the first CALL_DEPTH waiting passengers to
// a free spot of that line (the spots the client offers, one each), `claimSpot` { keys } hands out
// a spot outside a line (security search mats). Away / idle passengers keep their ticket but are
// passed over, and the spots they hold count as free.
export const CALL_DEPTH = 3;
export const LINE_SPOTS: Record<(typeof LINE_KINDS)[number], RegExp> = {
  checkin: /^desk:\d{1,2}$/,
  security: /^lane:\d{1,2}$/,
  boarding: /^scan$/,
};
// Most spot keys one call may offer.
export const SPOT_KEYS_MAX = 16;
// A spot just handed out stays that player's this long even before their `trip` reports it.
export const SPOT_GRACE_MS = 4000;
// No `active` message (the player touched the keyboard / mouse / screen) for this long = idle: passed
// over in lines and their held spot counts as free. Only clients that have sent `active` once time out.
export const IDLE_AFTER_MS = 60_000;
// Animation overlays the others play on a passenger (client remote.js).
export const ANIMS = ["", "sit", "tpose", "ko"] as const;
// A spot a passenger holds so no one else is sent to it: "desk:2", "lane:0", "mat:3", "scan".
export const HOLD_PATTERN = /^(desk|lane|mat):\d{1,2}$|^scan$/;

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 64 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// A player whose game has stopped (hidden / minimized tab, ad break, frozen, or a dropped connection
// waiting to reconnect) is marked `away`: the others take them out of their lines and held spots so
// nobody is stuck behind them. The client sends `alive` from its game loop every ~1 s; no beat for
// AWAY_AFTER_MS (checked every AWAY_CHECK_MS) = away.
export const AWAY_AFTER_MS = 5000;
export const AWAY_CHECK_MS = 1000;

// Saved progress bounds (client src/store.js snapshot()): coins, owned suitcases / passes / job
// hats, visited destination codes, the booked flight, flights taken and timed rewards
// { id: epoch ms it ends }. A timed reward may end at most TIMED_MAX_MS from now (the longest the
// client grants is 15 min).
export const COINS_MAX = 1e12;
export const FLIGHTS_MAX = 1e7;
export const OWNED_MAX = 128;
export const TIMED_MAX_MS = 24 * 60 * 60 * 1000;
export const TIMED_KINDS_MAX = 16;
export const DEST_MAX = 64;
export const PLAY_SECONDS_MAX = 31_536_000; // ~1 year

// Trolls (client SHOP.trolls + the jobs' broadcasts): one relayed troll per session every
// TROLL_COOLDOWN_MS; an announcement's text is cut to TROLL_TEXT_MAX characters.
export const TROLL_COOLDOWN_MS = 1500;
export const TROLL_TEXT_MAX = 80;
// On board (`cabin` -> `cabin`, WorldRoom): one passenger-to-passenger message per sender every
// CABIN_COOLDOWN_MS; reporting the same passenger again waits REPORT_COOLDOWN_MS.
export const CABIN_KINDS = ["report", "reportOk", "serve", "tip"] as const;
export const CABIN_COOLDOWN_MS = 400;
export const REPORT_COOLDOWN_MS = 15_000;
export const CLASS_MAX = 3; // cabin classes 0 (First) .. 3 (Economy)
// Emotes (Bloxity catalogue ids, 24 hex chars) relayed to the others.
export const EMOTE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

// Daily Reward (client DAILY.days): days in one calendar cycle.
export const DAILY_DAYS = 7;

// Rewarded ads (client ADS.reward): coins one verified ad grants, and the least time between two.
export const AD_REWARD_COINS = 150;
export const AD_REWARD_COOLDOWN_MS = 60 * 1000;

// Bloxity reporting (bloxity.ts): leaderboards and game stats go up every REPORT_EVERY_MS for the
// room's signed-in players (only what changed).
export const REPORT_EVERY_MS = 30 * 1000;
// Leaderboards (client LEADERBOARDS in config.js declares the same ids).
export const BOARDS = [
  { id: "flights", label: "Flights Taken", order: "desc", mode: "best", format: "number", reset: "none" },
  { id: "destinations", label: "Places Visited", order: "desc", mode: "best", format: "number", reset: "none" },
  { id: "coins", label: "Richest Travellers", order: "desc", mode: "latest", format: "compact", reset: "none" },
] as const;
// Game stats shown on the Bloxity game page.
export const STATS = [
  { key: "flights_taken", label: "Flights taken", type: "number", sortOrder: 1 },
  { key: "destinations", label: "Destinations visited", type: "number", sortOrder: 2 },
  { key: "coins", label: "Coins", type: "currency", sortOrder: 3 },
  { key: "time_played", label: "Time played", type: "seconds", sortOrder: 4 },
] as const;

// Ids from the client's catalogs (suitcases, passes, job hats, timed rewards, destination codes).
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The client's per-browser id for players who are not signed in to Bloxity. Guests are never saved.
export const GUEST_ID_PREFIX = "guest-";
// Local dev without the Bloxity SDK plays as `dev-...` (trusted only outside production, identity.ts).
export const DEV_ID_PREFIX = "dev-";
