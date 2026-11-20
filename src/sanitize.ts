import { COINS_MAX, DEST_MAX, FLIGHTS_MAX, ID_PATTERN, OWNED_MAX, TIMED_KINDS_MAX, TIMED_MAX_MS } from "./constants.js";
import type { PlayerDoc } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
export const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// Catalog ids: slug strings, no duplicates, bounded count.
export function sanitizeIds(raw: unknown, max = OWNED_MAX): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isId))].slice(0, max);
}

// Timed rewards { id: epoch ms it ends }: slug ids, whole times no further ahead than TIMED_MAX_MS
// (a forged "forever" is cut to that), already-ended ones dropped.
function sanitizeTimed(raw: unknown, now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  for (const [id, at] of Object.entries(raw)) {
    if (Object.keys(out).length >= TIMED_KINDS_MAX) break;
    if (isId(id) && finite(at) && at > now) out[id] = Math.floor(Math.min(at, now + TIMED_MAX_MS));
  }
  return out;
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};
  if (finite(raw.coins)) out.coins = clampInt(raw.coins, COINS_MAX);
  if (raw.suitcases !== undefined) out.suitcases = sanitizeIds(raw.suitcases);
  if (isId(raw.suitcase) && (!out.suitcases || out.suitcases.includes(raw.suitcase))) out.suitcase = raw.suitcase;
  if (raw.hats !== undefined) out.hats = sanitizeIds(raw.hats);
  // The worn hat may be owned or a running timed reward (a free shift), so only its shape is checked.
  if (raw.hat === "") out.hat = "";
  else if (isId(raw.hat)) out.hat = raw.hat;
  if (raw.passes !== undefined) out.passes = sanitizeIds(raw.passes);
  if (raw.visited !== undefined) out.visited = sanitizeIds(raw.visited, DEST_MAX);
  if (finite(raw.dest)) out.dest = clampInt(raw.dest, DEST_MAX - 1);
  if (finite(raw.flights)) out.flights = clampInt(raw.flights, FLIGHTS_MAX);
  if (raw.timed !== undefined) out.timed = sanitizeTimed(raw.timed);
  return out;
}

// What a stored doc sends back to its client (the save shape only, no server bookkeeping).
export function progressView(doc: PlayerDoc): Partial<PlayerDoc> {
  return sanitizeProgress(doc) ?? {};
}
