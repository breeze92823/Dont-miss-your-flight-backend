import { CALL_DEPTH, HOLD_PATTERN, LINE_KINDS, LINE_SPOTS, SPOT_GRACE_MS, SPOT_KEYS_MAX } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Server-ordered lines (client queue.js / security.js / boarding.js). Every client draws the same
// order from the roster (`line` + `ticket`), and the spots at the end of a line (check-in desks,
// security lanes, the boarding scanner) and the search mats are handed out here one at a time, so two
// passengers are never sent to the same one and nobody waits on another client's decision.
//
// - joinLine: a ticket at the back (join order). skipLine: ahead of everyone in that line.
// - callMe: one of the first CALL_DEPTH waiting passengers (away / idle ones passed over) gets the
//   first free spot among the keys their client offers, if there are enough free for their place
//   (2 free desks = the first two are called). They leave the line and hold the spot.
// - claimSpot: a free spot outside a line (security search mats).
// A spot is taken while someone present (not away, not idle) holds it, or was handed it within
// SPOT_GRACE_MS (their `trip` hasn't reported it yet).

type Kind = (typeof LINE_KINDS)[number];
interface Roster {
  get(sid: string): PlayerState | undefined;
  forEach(cb: (p: PlayerState, sid: string) => void): void;
}

export const isLineKind = (v: unknown): v is Kind => typeof v === "string" && (LINE_KINDS as readonly string[]).includes(v);
const passedOver = (p: PlayerState) => p.away || p.idle;

export class Lines {
  private seq = 0;
  private grants = new Map<string, { sid: string; at: number }>(); // spot key -> who was just handed it

  constructor(private players: Roster) {}

  join(sid: string, kind: unknown): void {
    const p = this.players.get(sid);
    if (!p || !isLineKind(kind) || p.line === kind) return;
    p.line = kind;
    p.ticket = ++this.seq;
  }

  leave(sid: string): void {
    const p = this.players.get(sid);
    if (!p || !p.line) return;
    p.line = "";
    p.ticket = 0;
  }

  skip(sid: string, kind: unknown): void {
    const p = this.players.get(sid);
    if (!p || !isLineKind(kind) || p.line !== kind) return;
    let front = Infinity;
    this.players.forEach((o, osid) => {
      if (osid !== sid && o.line === kind) front = Math.min(front, o.ticket);
    });
    if (front <= p.ticket) p.ticket = front - 1;
  }

  // Who is waiting in `kind`, front first (passengers passed over left out).
  order(kind: Kind): string[] {
    const rows: [number, string][] = [];
    this.players.forEach((p, sid) => {
      if (p.line === kind && !passedOver(p)) rows.push([p.ticket, sid]);
    });
    return rows.sort((a, b) => a[0] - b[0]).map((r) => r[1]);
  }

  // The offered keys that are well-formed (`pattern`) and free for `sid`, in the order offered.
  private free(sid: string, keys: unknown, pattern: RegExp, now: number): string[] {
    if (!Array.isArray(keys) || keys.length > SPOT_KEYS_MAX) return [];
    const out: string[] = [];
    for (const k of keys) {
      if (typeof k !== "string" || !HOLD_PATTERN.test(k) || !pattern.test(k) || out.includes(k)) continue;
      if (!this.taken(k, sid, now)) out.push(k);
    }
    return out;
  }

  private taken(key: string, by: string, now: number): boolean {
    let held = false;
    this.players.forEach((o, sid) => {
      if (!held && sid !== by && o.hold === key && !passedOver(o)) held = true;
    });
    if (held) return true;
    const g = this.grants.get(key);
    if (!g) return false;
    const owner = this.players.get(g.sid);
    if (g.sid === by || !owner || passedOver(owner) || now - g.at >= SPOT_GRACE_MS) {
      if (g.sid !== by) this.grants.delete(key);
      return false;
    }
    return true;
  }

  private grant(sid: string, p: PlayerState, key: string, now: number): string {
    for (const [k, g] of this.grants) if (g.sid === sid) this.grants.delete(k);
    p.hold = key;
    this.grants.set(key, { sid, at: now });
    return key;
  }

  // The spot `sid` is sent to from the `kind` line, or "" (not their turn / nothing free).
  call(sid: string, kind: unknown, keys: unknown, now = Date.now()): string {
    const p = this.players.get(sid);
    if (!p || !isLineKind(kind) || p.line !== kind || passedOver(p)) return "";
    const at = this.order(kind).indexOf(sid);
    const free = this.free(sid, keys, LINE_SPOTS[kind], now);
    if (at < 0 || at >= Math.min(free.length, CALL_DEPTH)) return "";
    p.line = "";
    p.ticket = 0;
    return this.grant(sid, p, free[0], now);
  }

  // A free spot outside a line (the first free one offered), or "".
  claim(sid: string, keys: unknown, now = Date.now()): string {
    const p = this.players.get(sid);
    if (!p || passedOver(p)) return "";
    const free = this.free(sid, keys, /^mat:\d{1,2}$/, now);
    return free.length ? this.grant(sid, p, free[0], now) : "";
  }

  forget(sid: string): void {
    for (const [k, g] of this.grants) if (g.sid === sid) this.grants.delete(k);
  }
}
