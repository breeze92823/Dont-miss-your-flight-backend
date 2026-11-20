import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import {
  AD_REWARD_COINS, AD_REWARD_COOLDOWN_MS, DEV_ID_PREFIX, GUEST_ID_PREFIX, ID_PATTERN, NAME_MAX, PFP_MAX_LEN,
  PLAY_SECONDS_MAX, RECONNECT_SECONDS, REPORT_EVERY_MS, ROOM_MAX_CLIENTS, TOKEN_MAX_LEN, TROLL_COOLDOWN_MS, TROLL_TEXT_MAX,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { progressView, sanitizeProgress } from "../sanitize.js";
import { claimDaily, dailyFields, dailyView, readDaily, rollDaily, type DailyState } from "../daily.js";
import { applyAvatar, applyEmote, applyPose, applyTrip } from "../presence.js";
import { reportScores, reportStats, trustClientIds, verifyReward, verifyToken, type PlayerNumbers } from "../bloxity.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

// What the client sends to say who it is (join options and `identify`).
interface IdentityMsg {
  token?: unknown; // Legion.SDK.auth.getToken(): the only proof of a Bloxity account
  userId?: unknown; // its own id: only trusted for local dev (trustClientIds), else ignored
  username?: unknown; // a guest's display name
  pfp?: unknown;
}

// What one signed-in session last reported, for the Bloxity leaderboards / stats (bloxity.ts).
interface Numbers {
  flights: number;
  destinations: number;
  coins: number;
  playtime: number; // s saved before this session
  since: number; // epoch ms this session's play clock started
  sent: string; // the last reported values (only changes go up)
}

/**
 * Room every client joins via `joinOrCreate("world", { token, username, pfp, pose, trip, avatar })`.
 * Everyone in the room is a passenger the others see (roster = WorldState.players, presence.ts);
 * the airport staff are each client's own bots. Loads and saves each signed-in player's progress
 * (MongoDB, db.ts) under the Bloxity id the token verifies to (bloxity.ts) -- never an id the client
 * picked. The game is client-authoritative: saves are only bounded (sanitize.ts). Full rooms spill
 * into a fresh one (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> verified Bloxity id. Guests have no entry.
  userIds = new Map<string, string>();
  // sessionIds whose identity has been settled once (the first answer must always go out).
  private identified = new Set<string>();
  // sessionId -> a counter bumped per identity change, so a slow verify/load can't land late.
  private idGen = new Map<string, number>();
  // sessionIds whose current identity's save has been read: only these may write.
  private loaded = new Set<string>();
  private dailies = new Map<string, DailyState>();
  private trollAt = new Map<string, number>();
  private adAt = new Map<string, number>();
  private numbers = new Map<string, Numbers>();

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;
      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      this.track(client.sessionId, patch);
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // Flights taken only ever go up ($max), so a stale or replayed save can't lower them.
      const { flights, ...rest } = patch;
      try {
        await players.updateOne(
          { _id: userId },
          {
            $set: { ...rest, username: p.username || "Player", updatedAt: new Date() },
            ...(flights !== undefined && { $max: { flights } }),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Daily Reward day `msg.day` (0-based); the client grants it only on ok (daily.ts).
    claimDaily: async (client: Client, msg: { day?: unknown }) => {
      const s = this.dailies.get(client.sessionId);
      const day = msg?.day;
      if (!s || !this.loaded.has(client.sessionId)) return client.send("dailyResult", { ok: false, day, reason: "loading" });
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s);
      if (!claimDaily(s, day)) return client.send("dailyResult", { ok: false, day, reason: "locked", ...dailyView(s) });
      if (!(await this.saveDaily(client.sessionId, s))) {
        s.claimed = s.claimed.filter((i) => i !== day);
        return client.send("dailyResult", { ok: false, day, reason: "save", ...dailyView(s) });
      }
      client.send("dailyResult", { ok: true, day, ...dailyView(s) });
    },
    dailyRefresh: (client: Client) => {
      const s = this.dailies.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return;
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s);
      client.send("daily", dailyView(s));
    },
    // A rewarded ad finished on the client: Bloxity verifies the reward token (one use, this game,
    // 5 min, daily cap) and only then the client grants `coins`. Answers `adRewardResult`
    // { ok, coins?, reason? }.
    adReward: async (client: Client, msg: { rewardToken?: unknown }) => {
      const token = msg?.rewardToken;
      if (typeof token !== "string" || !token || token.length > TOKEN_MAX_LEN) return client.send("adRewardResult", { ok: false, reason: "token" });
      const now = Date.now();
      if (now - (this.adAt.get(client.sessionId) ?? 0) < AD_REWARD_COOLDOWN_MS) return client.send("adRewardResult", { ok: false, reason: "cooldown" });
      this.adAt.set(client.sessionId, now);
      const check = await verifyReward(token);
      const userId = this.userIds.get(client.sessionId);
      // A token minted for another account is not this player's reward.
      if (!check.valid || (check.userId && userId && check.userId.replace(/^legion_/, "") !== userId)) {
        this.adAt.delete(client.sessionId);
        return client.send("adRewardResult", { ok: false, reason: check.reason || "invalid" });
      }
      client.send("adRewardResult", { ok: true, coins: AD_REWARD_COINS, test: !!check.test });
      const players = getPlayers();
      if (userId && players) {
        try {
          await players.updateOne({ _id: userId }, { $set: { adAt: now, updatedAt: new Date() }, $setOnInsert: { version: 1 } }, { upsert: true });
        } catch (err) {
          console.warn("[WorldRoom] adAt save failed", err);
        }
      }
    },
    // A troll the sender bought (or a job's broadcast), relayed to everyone ELSE in the room as
    // `trolled` { id, from, text }. Bounded: a slug id, short text, one per TROLL_COOLDOWN_MS.
    troll: (client: Client, msg: { id?: unknown; text?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      const id = msg?.id;
      if (!p || typeof id !== "string" || !ID_PATTERN.test(id)) return;
      const now = Date.now();
      if (now - (this.trollAt.get(client.sessionId) ?? 0) < TROLL_COOLDOWN_MS) return;
      this.trollAt.set(client.sessionId, now);
      const text = typeof msg?.text === "string" ? msg.text.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, TROLL_TEXT_MAX) : "";
      this.broadcast("trolled", { id, from: p.username || "Someone", text }, { except: client });
    },
    // Presence (presence.ts): what the others draw.
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    trip: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyTrip(p, msg);
    },
    emote: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyEmote(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    // A sign-in / sign-out after joining: { token } (or a guest's { username, pfp }). Answers with
    // progress / noProgress for the new identity.
    identify: (client: Client, msg: IdentityMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (p) void this.identifyAs(client, p, msg ?? {});
    },
  };

  // Leaderboards + game stats for the room's signed-in players.
  onCreate() {
    this.clock.setInterval((): void => void this.report(), REPORT_EVERY_MS);
  }

  onJoin(client: Client, options?: IdentityMsg & { pose?: unknown; trip?: unknown; avatar?: string }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username) || "Passenger";
    p.pfp = sanitizePfp(options?.pfp);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyTrip(p, options?.trip);
    applyAvatar(p, options);
    this.state.players.set(client.sessionId, p);
    void this.identifyAs(client, p, options ?? {});
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number): Promise<void> {
    // A deliberate leave, or this pod shutting down (onBeforeShutdown): gone at once, no reconnection hold.
    if (code === CloseCode.CONSENTED || code === CloseCode.SERVER_SHUTDOWN) return void this.gone(client.sessionId);
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      await this.gone(client.sessionId);
    }
  }

  // SIGTERM (a deploy or scale-down; Legion waits up to 10 min): Colyseus shuts the rooms down.
  // Everyone's last-seen + play time is stored first, then they're disconnected for good (no
  // reconnection hold); each client re-resolves through the matchmaker and lands on the new pod.
  async onBeforeShutdown(): Promise<void> {
    this.lock();
    await Promise.all([...this.userIds.keys()].map((sid) => this.stampLeave(sid)));
    this.userIds.clear(); // already stamped: the leaves that follow write nothing twice
    this.disconnect(CloseCode.SERVER_SHUTDOWN);
  }

  private async gone(sessionId: string): Promise<void> {
    await this.stampLeave(sessionId);
    this.forgetSession(sessionId);
  }

  // Server-clock "last seen" + this session's play time for a player who has really gone.
  private async stampLeave(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    const n = this.numbers.get(sessionId);
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now(), ...(n && { playtime: this.playtime(n) }) } });
    } catch (err) {
      console.warn("[WorldRoom] stampLeave failed", err);
    }
  }

  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.idGen.delete(sessionId);
    this.loaded.delete(sessionId);
    this.dailies.delete(sessionId);
    this.trollAt.delete(sessionId);
    this.adAt.delete(sessionId);
    this.numbers.delete(sessionId);
  }

  // Stores a session's Daily Reward state. True when stored, or when there is nowhere to store it.
  private async saveDaily(sessionId: string, s: DailyState): Promise<boolean> {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return true;
    try {
      await players.updateOne({ _id: userId }, { $set: { ...dailyFields(s), updatedAt: new Date() }, $setOnInsert: { version: 1 } }, { upsert: true });
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveDaily failed", err);
      return false;
    }
  }

  // Works out who the session is: a verified Bloxity account (token), a trusted local-dev id, or a
  // guest. Then (re)loads that identity's save. A second live session on the same account is evicted.
  private async identifyAs(client: Client, p: PlayerState, msg: IdentityMsg) {
    const gen = (this.idGen.get(client.sessionId) ?? 0) + 1;
    this.idGen.set(client.sessionId, gen);
    let userId = "";
    let name = sanitizeName(msg.username);
    let pfp = sanitizePfp(msg.pfp);
    const token = typeof msg.token === "string" && msg.token.length <= TOKEN_MAX_LEN ? msg.token : "";
    if (token) {
      const user = await verifyToken(token);
      if (this.idGen.get(client.sessionId) !== gen || this.state.players.get(client.sessionId) !== p) return; // superseded / gone
      if (user) {
        userId = user.id;
        name = sanitizeName(user.username) || name;
        pfp = sanitizePfp(user.pfp) || pfp;
      }
    } else if (trustClientIds() && typeof msg.userId === "string" && !msg.userId.startsWith(GUEST_ID_PREFIX)) {
      userId = msg.userId.slice(0, 128);
    }
    if (name) p.username = name;
    if (msg.pfp !== undefined || pfp) p.pfp = pfp;

    const prev = this.userIds.get(client.sessionId) || "";
    if (userId === prev && this.identified.has(client.sessionId)) return; // same account: nothing to reload
    this.identified.add(client.sessionId);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    this.numbers.delete(client.sessionId);
    p.signedIn = !!userId && !userId.startsWith(DEV_ID_PREFIX);
    p.uid = userId && !userId.startsWith(DEV_ID_PREFIX) ? userId : "";

    if (userId) {
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        try {
          stale?.leave(CloseCode.CONSENTED);
        } catch {
          // Already gone.
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else this.userIds.delete(client.sessionId);

    await this.loadProgress(client, userId, p);
  }

  // Sends the saved doc to just this client ("progress"), or "noProgress" when there is nothing to
  // load (new account, guest, or Mongo unset). A failed read sends "serverError" and keeps saving
  // off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    // `you` tells the client who the server says it is (a verified account or a guest).
    const you = { signedIn: p.signedIn, username: p.username, uid: p.uid };
    if (!doc) client.send("noProgress", { serverTime: now, you });
    else client.send("progress", { ...progressView(doc), serverTime: now, you });
    if (userId) {
      this.numbers.set(client.sessionId, { flights: 0, destinations: 0, coins: 0, playtime: Math.min(PLAY_SECONDS_MAX, doc?.playtime ?? 0), since: now, sent: "" });
      if (doc) this.track(client.sessionId, doc);
    }

    const daily = readDaily(doc);
    this.dailies.set(client.sessionId, daily);
    if (rollDaily(daily)) await this.saveDaily(client.sessionId, daily);
    if (this.dailies.get(client.sessionId) === daily) client.send("daily", dailyView(daily));
  }

  // --- Bloxity leaderboards + stats -------------------------------------------------------------
  private track(sessionId: string, save: Partial<PlayerDoc>) {
    const n = this.numbers.get(sessionId);
    if (!n) return;
    if (save.flights !== undefined) n.flights = Math.max(n.flights, save.flights);
    if (save.visited !== undefined) n.destinations = save.visited.length;
    if (save.coins !== undefined) n.coins = save.coins;
  }
  private playtime(n: Numbers) {
    return Math.min(PLAY_SECONDS_MAX, n.playtime + Math.floor((Date.now() - n.since) / 1000));
  }
  private async report() {
    const rows: PlayerNumbers[] = [];
    const changed: PlayerNumbers[] = [];
    for (const [sid, n] of this.numbers) {
      const userId = this.userIds.get(sid);
      if (!userId || userId.startsWith(DEV_ID_PREFIX)) continue;
      const row = { userId, flights: n.flights, destinations: n.destinations, coins: n.coins, playtime: this.playtime(n) };
      rows.push(row);
      const key = `${row.flights}|${row.destinations}|${row.coins}`;
      if (key !== n.sent) {
        n.sent = key;
        changed.push(row);
      }
    }
    await Promise.all([reportScores(changed), reportStats(rows)]);
  }
}
