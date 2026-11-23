import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("cabin messages (stowaway reports, flight-attendant service)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  async function three() {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    fake.release();
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", username: "Ann" });
    const b = await colyseus.connectTo(room, { userId: "guest-b", username: "Bob" });
    const c = await colyseus.connectTo(room, { userId: "guest-c", username: "Cy" });
    const got: Record<string, any[]> = { a: [], b: [], c: [] };
    for (const [k, cl] of [["a", a], ["b", b], ["c", c]] as const) {
      for (const m of ["noProgress", "spins", "daily", "leaderboard"]) cl.onMessage(m, () => {});
      cl.onMessage("cabin", (m: any) => got[k].push(m));
    }
    await sleep(100);
    return { room, a, b, c, got };
  }

  it("bounds the trip's class and crew flag", async () => {
    const { room, a } = await three();
    a.send("trip", { zone: "cabin", cls: 2, crew: true });
    await sleep(100);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.cls, 2);
    assert.strictEqual(p.crew, true);
    a.send("trip", { cls: 9, crew: "yes" });
    await sleep(100);
    assert.strictEqual(p.cls, 2, "out of range: ignored");
    assert.strictEqual(p.crew, true);
    a.send("trip", { cls: -1, crew: false });
    await sleep(100);
    assert.strictEqual(p.cls, -1);
    assert.strictEqual(p.crew, false);
  });

  it("passes a report to that one passenger, both on board, rate-limited per pair", async () => {
    const { a, b, c, got } = await three();
    a.send("trip", { zone: "cabin", cls: 3 });
    b.send("trip", { zone: "cabin", cls: 3 });
    await sleep(100);
    c.send("cabin", { to: b.sessionId, kind: "report" }); // c is not on board: dropped
    a.send("cabin", { to: b.sessionId, kind: "report" });
    await sleep(150);
    assert.strictEqual(got.c.length, 0);
    assert.strictEqual(got.a.length, 0, "the sender gets nothing back");
    assert.strictEqual(got.b.length, 1);
    assert.deepStrictEqual(got.b[0], { from: a.sessionId, name: "Ann", kind: "report", item: "" });
    await sleep(450);
    a.send("cabin", { to: b.sessionId, kind: "report" }); // same pair again too soon: dropped
    await sleep(150);
    assert.strictEqual(got.b.length, 1);
    b.send("cabin", { to: a.sessionId, kind: "reportOk" });
    await sleep(150);
    assert.deepStrictEqual(got.a.map((m) => m.kind), ["reportOk"]);
    b.send("cabin", { to: b.sessionId, kind: "report" }); // to yourself: dropped
    b.send("cabin", { to: a.sessionId, kind: "hack" }); // unknown kind: dropped
    await sleep(150);
    assert.strictEqual(got.a.length, 1);
    assert.strictEqual(got.b.length, 1);
  });

  it("only crew serve, and crew are never reported", async () => {
    const { a, b, got } = await three();
    a.send("trip", { zone: "cabin", cls: 3 });
    b.send("trip", { zone: "cabin", cls: 3 });
    await sleep(100);
    a.send("cabin", { to: b.sessionId, kind: "serve", item: "cookie" }); // not crew: dropped
    await sleep(500);
    assert.strictEqual(got.b.length, 0);
    a.send("trip", { crew: true });
    await sleep(100);
    a.send("cabin", { to: b.sessionId, kind: "serve", item: "cookie" });
    await sleep(150);
    assert.deepStrictEqual(got.b.map((m) => [m.kind, m.item]), [["serve", "cookie"]]);
    b.send("cabin", { to: a.sessionId, kind: "report" }); // a is crew: dropped
    await sleep(500);
    b.send("cabin", { to: a.sessionId, kind: "tip", item: "bad id!" }); // bad item: dropped
    await sleep(500);
    b.send("cabin", { to: a.sessionId, kind: "tip" });
    await sleep(150);
    assert.deepStrictEqual(got.a.map((m) => m.kind), ["tip"]);
  });
});
