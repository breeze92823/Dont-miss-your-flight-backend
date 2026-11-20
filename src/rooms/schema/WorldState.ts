import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: every passenger in the room, as the other clients draw them (client remote.js).
// Durable progress lives in Mongo (src/db.ts). To sync something new about a player, add a field
// here and accept it in a WorldRoom message (presence.ts bounds it).
export const PlayerState = schema(
  {
    username: t.string().default(""), // Bloxity display name (verified for signed-in players)
    signedIn: t.boolean().default(false), // verified Bloxity account: only these are saved
    uid: t.string().default(""), // verified Bloxity user id ("" = guest): matches chat messages to a passenger
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none)
    // `pose`
    x: t.float32().default(0), // feet position, m
    y: t.float32().default(0),
    z: t.float32().default(0),
    yaw: t.float32().default(0), // facing, rad
    speed: t.float32().default(0), // ground speed, m/s (walk cycle)
    grounded: t.boolean().default(true),
    anim: t.string().default(""), // pose overlay: "" | sit | tpose | ko
    // `trip`
    zone: t.string().default("airport"), // airport | cabin | city
    dest: t.uint8().default(0), // DESTINATIONS index (cabin + city are per flight)
    line: t.string().default(""), // shared line: "" | checkin | security | boarding
    hold: t.string().default(""), // "desk:N" | "lane:N" | "mat:N" | "scan" | ""
    suitcase: t.string().default("purple"), // SUITCASES id
    hat: t.string().default(""), // job hat ("" = none)
    vip: t.boolean().default(false),
    pack: t.boolean().default(true), // backpack worn
    bag: t.boolean().default(true), // suitcase in hand
    // `emote` / `setAvatar`
    emote: t.string().default(""), // Bloxity emote id playing ("" = none)
    avatar: t.string().default(""), // Bloxity look JSON { equipped, proportions }, "" = default
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
