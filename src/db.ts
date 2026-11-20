import { MongoClient, type Collection } from "mongodb";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// A signed-in player's saved progress (client src/store.js snapshot(), bounded by sanitize.ts).
export interface PlayerDoc {
  _id: string; // Bloxity user id, verified with Bloxity (identity.ts). Guests are never saved.
  username?: string; // display name as of the last save
  coins?: number;
  suitcases?: string[]; // owned suitcase ids (client SUITCASES)
  suitcase?: string; // the one in hand (an owned one)
  hats?: string[]; // job hats owned for good (security / pilot)
  hat?: string; // the worn hat, "" = none (may be a timed free shift)
  passes?: string[]; // SHOP.passes ids owned for good
  visited?: string[]; // DESTINATIONS codes visited
  dest?: number; // the booked flight (DESTINATIONS index)
  flights?: number; // flights taken (landed at a destination), only ever goes up
  timed?: Record<string, number>; // timed rewards { id: epoch ms it ends }
  playtime?: number; // s connected, counted by the server
  lastSeen?: number; // epoch ms of the last activity
  // Daily Reward (daily.ts): written by the server only, never by saveProgress.
  dailyDay?: number;
  dailyLast?: number;
  dailyClaimed?: number[];
  // Rewarded ads: epoch ms of the last verified reward (written by the server only).
  adAt?: number;
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
