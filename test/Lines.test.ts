import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { CALL_DEPTH, SPOT_GRACE_MS } from "../src/constants.js";
import { Lines } from "../src/lines.js";
import { PlayerState } from "../src/rooms/schema/WorldState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

// A plain roster for the unit tests (WorldRoom hands its MapSchema to Lines).
function roster(...ids: string[]) {
  const m = new Map<string, PlayerState>();
  for (const id of ids) m.set(id, new PlayerState());
  return m;
}

describe("lines (server-ordered queues)", () => {
  it("orders by join time, skipLine goes to the front", () => {
    const r = roster("a", "b", "c");
    const L = new Lines(r);
    L.join("a", "checkin");
    L.join("b", "checkin");
    L.join("c", "checkin");
    L.join("a", "checkin"); // already in it: keeps the place
    assert.deepStrictEqual(L.order("checkin"), ["a", "b", "c"]);
    L.skip("c", "checkin");
    assert.deepStrictEqual(L.order("checkin"), ["c", "a", "b"]);
    L.skip("b", "security"); // not in that line
    assert.deepStrictEqual(L.order("checkin"), ["c", "a", "b"]);
    L.leave("a");
    assert.deepStrictEqual(L.order("checkin"), ["c", "b"]);
    assert.strictEqual(r.get("a")!.ticket, 0);
    L.join("x", "taxi");
    L.join("b", "taxi");
    assert.strictEqual(r.get("b")!.line, "checkin", "unknown lines are ignored");
  });

  it("calls only the front passengers, one free spot each", () => {
    const r = roster("a", "b", "c", "d");
    const L = new Lines(r);
    for (const id of ["a", "b", "c", "d"]) L.join(id, "checkin");
    assert.strictEqual(L.call("b", "checkin", ["desk:0"]), "", "one free desk: only the first");
    assert.strictEqual(L.call("a", "checkin", ["desk:0", "desk:1"]), "desk:0");
    assert.strictEqual(r.get("a")!.line, "");
    assert.strictEqual(r.get("a")!.hold, "desk:0");
    assert.strictEqual(L.call("b", "checkin", ["desk:0"]), "", "desk 0 was just handed to a");
    assert.strictEqual(L.call("c", "checkin", ["desk:1", "desk:2"]), "desk:1", "2nd in line with 2 free desks");
    assert.strictEqual(L.call("b", "checkin", ["lane:2", "scan", 5, "desk:2"]), "desk:2", "only this line's spots count");
    assert.strictEqual(L.call("d", "checkin", ["desk:9"]), "desk:9");
    assert.strictEqual(L.call("d", "checkin", ["desk:8"]), "", "not in the line any more");
  });

  it("never calls further back than CALL_DEPTH", () => {
    const ids = Array.from({ length: CALL_DEPTH + 2 }, (_, i) => `p${i}`);
    const r = roster(...ids);
    const L = new Lines(r);
    for (const id of ids) L.join(id, "security");
    const keys = Array.from({ length: 8 }, (_, i) => `lane:${i}`);
    assert.strictEqual(L.call(ids[CALL_DEPTH], "security", keys), "");
    assert.notStrictEqual(L.call(ids[CALL_DEPTH - 1], "security", keys), "");
  });

  it("passes over away / idle passengers and frees what they hold", () => {
    const r = roster("a", "b", "c");
    const L = new Lines(r);
    L.join("a", "boarding");
    L.join("b", "boarding");
    r.get("a")!.away = true;
    assert.deepStrictEqual(L.order("boarding"), ["b"]);
    assert.strictEqual(L.call("a", "boarding", ["scan"]), "", "away: never called");
    assert.strictEqual(L.call("b", "boarding", ["scan"]), "scan");
    // b goes idle at the scanner (after their grant ran out): c may use it.
    L.join("c", "boarding");
    assert.strictEqual(L.call("c", "boarding", ["scan"]), "", "b holds it");
    r.get("b")!.idle = true;
    assert.strictEqual(L.call("c", "boarding", ["scan"]), "scan");
    // a comes back: still holds the ticket from before.
    r.get("a")!.away = false;
    assert.deepStrictEqual(L.order("boarding"), ["a"]);
  });

  it("keeps a granted spot for the grace time, then follows the roster", () => {
    const r = roster("a", "b");
    const L = new Lines(r);
    assert.strictEqual(L.claim("a", ["mat:1", "mat:2"], 1000), "mat:1");
    r.get("a")!.hold = ""; // a stale trip from a, before it knew
    assert.strictEqual(L.claim("b", ["mat:1"], 1000 + SPOT_GRACE_MS - 1), "");
    assert.strictEqual(L.claim("b", ["mat:1"], 1000 + SPOT_GRACE_MS + 1), "mat:1", "a never reported it: free again");
    assert.strictEqual(L.claim("a", ["desk:1", "lane:0"], 1000), "", "only mats outside a line");
    assert.strictEqual(L.claim("a", "mat:1", 1000), "");
  });
});

describe("lines in the room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("joins, calls and syncs the order to everyone", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    a.send("joinLine", { kind: "checkin" });
    await sleep(20);
    b.send("joinLine", { kind: "checkin" });
    await sleep(80);
    const pa = room.state.players.get(a.sessionId)!;
    const pb = room.state.players.get(b.sessionId)!;
    assert.strictEqual(pa.line, "checkin");
    assert.ok(pa.ticket > 0 && pa.ticket < pb.ticket);
    // a trip can't move anyone out of (or into) a line
    b.send("trip", { line: "" });
    await sleep(50);
    assert.strictEqual(pb.line, "checkin");

    const calledB = new Promise<{ kind: string; key: string }>((res) => b.onMessage("called", res));
    b.send("callMe", { kind: "checkin", keys: ["desk:3"] });
    assert.deepStrictEqual(await calledB, { kind: "checkin", key: "" }, "b is second with one desk");
    const calledA = new Promise<{ kind: string; key: string }>((res) => a.onMessage("called", res));
    a.send("callMe", { kind: "checkin", keys: ["desk:3"] });
    assert.deepStrictEqual(await calledA, { kind: "checkin", key: "desk:3" });
    await sleep(50);
    assert.strictEqual(pa.hold, "desk:3");
    assert.strictEqual(pa.line, "");
    // what b's client sees
    await sleep(50);
    const seen = b.state.players.get(a.sessionId)!;
    assert.strictEqual(seen.hold, "desk:3");
    assert.strictEqual(b.state.players.get(b.sessionId)!.ticket, pb.ticket);
  });

  it("claims a mat once and drops a leaver's grants", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    const spot = (c: typeof a, keys: unknown) =>
      new Promise<{ key: string }>((res) => {
        c.onMessage("spot", res);
        c.send("claimSpot", { keys });
      });
    assert.strictEqual((await spot(a, ["mat:0"])).key, "mat:0");
    assert.strictEqual((await spot(b, ["mat:0"])).key, "");
    await a.leave(true);
    await sleep(80);
    assert.strictEqual((await spot(b, ["mat:0"])).key, "mat:0");
  });

  it("flags idle players only after they sent input once", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    p.idle = true;
    a.send("active", {});
    await sleep(60);
    assert.strictEqual(p.idle, false);
  });
});
