import { ANIMS, AVATAR_MAX_LEN, CLASS_MAX, DEST_MAX, EMOTE_PATTERN, HOLD_PATTERN, ID_PATTERN, POSE_BOUNDS, ZONES } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player as a fellow passenger (client remote.js).
// Relayed through the roster as sent, only bounded here -- like the rest of the game it is
// client-authoritative and purely cosmetic.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);

// `pose` { x, y, z, yaw, speed, grounded, anim }: feet position (m), heading (rad), ground speed
// (m/s), on the ground or not, and the pose overlay ("" | sit | tpose | ko). ~10 a second.
export function applyPose(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  const b = POSE_BOUNDS;
  if (finite(m.x)) p.x = clamp(m.x, -b.xz, b.xz);
  if (finite(m.y)) p.y = clamp(m.y, -b.yDown, b.yUp);
  if (finite(m.z)) p.z = clamp(m.z, -b.xz, b.xz);
  if (finite(m.yaw)) p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
  if (typeof m.grounded === "boolean") p.grounded = m.grounded;
  if (oneOf(ANIMS, m.anim)) p.anim = m.anim;
}

// `trip` { zone, dest, line, hold, suitcase, hat, vip, pack, bag }: where the passenger is in their
// trip and what they carry. zone airport | cabin | city (the cabin is shared by every flight, the city is per destination `dest`),
// line (ignored: the server sets it, lines.ts), hold = the desk / lane / mat / scanner they use, suitcase
// (SUITCASES id), hat (job id, "" = none), vip, pack (backpack worn), bag (suitcase in hand), cls (on board:
// the ticket's class 0..3, -1 = not flying; others report them as stowaways forward of it), crew (on a
// flight-attendant shift).
export function applyTrip(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  if (oneOf(ZONES, m.zone)) p.zone = m.zone;
  if (Number.isInteger(m.dest)) p.dest = clamp(m.dest as number, 0, DEST_MAX - 1);
  // `line` is server-owned (joinLine / leaveLine, lines.ts): a trip's `line` is ignored.
  if (m.hold === "" || (typeof m.hold === "string" && HOLD_PATTERN.test(m.hold))) p.hold = m.hold as string;
  if (isId(m.suitcase)) p.suitcase = m.suitcase;
  if (m.hat === "" || isId(m.hat)) p.hat = m.hat as string;
  if (typeof m.vip === "boolean") p.vip = m.vip;
  if (typeof m.pack === "boolean") p.pack = m.pack;
  if (typeof m.bag === "boolean") p.bag = m.bag;
  if (Number.isInteger(m.cls) && (m.cls as number) >= -1 && (m.cls as number) <= CLASS_MAX) p.cls = m.cls as number;
  if (typeof m.crew === "boolean") p.crew = m.crew;
}

// `emote` { id }: a Bloxity emote the passenger plays ("" = stopped).
export function applyEmote(p: PlayerState, msg: unknown): void {
  const id = (msg as { id?: unknown })?.id;
  if (id === "" || (typeof id === "string" && EMOTE_PATTERN.test(id))) p.emote = id as string;
}

// `setAvatar` { avatar }: the Bloxity look as an opaque JSON string ("" = default), length-capped.
export function applyAvatar(p: PlayerState, msg: unknown): void {
  const a = (msg as { avatar?: unknown })?.avatar;
  if (typeof a === "string" && a.length <= AVATAR_MAX_LEN) p.avatar = a;
}
