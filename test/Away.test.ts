import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { AWAY_AFTER_MS, AWAY_CHECK_MS } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

// A player whose game stopped (hidden tab, frozen, dropped) is marked `away`, so the other clients
// drop them from their lines instead of waiting behind them forever.
describe("away passengers", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("is set by `away`, cleared by an `alive` beat", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.away, false);
    a.send("away", { on: true });
    await sleep(80);
    assert.strictEqual(p.away, true);
    a.send("alive", {});
    await sleep(80);
    assert.strictEqual(p.away, false);
    a.send("away", { on: "yes" });
    await sleep(80);
    assert.strictEqual(p.away, false, "a malformed away is ignored");
  });

  it("marks a client that stops beating as away", async function () {
    this.timeout(AWAY_AFTER_MS + AWAY_CHECK_MS * 4 + 5000);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    a.send("alive", {});
    b.send("alive", {});
    // b keeps beating, a goes quiet.
    const beat = setInterval(() => b.send("alive", {}), 500);
    try {
      await sleep(AWAY_AFTER_MS + AWAY_CHECK_MS * 2);
      assert.strictEqual(room.state.players.get(a.sessionId)!.away, true);
      assert.strictEqual(room.state.players.get(b.sessionId)!.away, false);
    } finally {
      clearInterval(beat);
    }
  });

  it("never times out a client that has not sent a beat", async function () {
    this.timeout(AWAY_AFTER_MS + AWAY_CHECK_MS * 4 + 5000);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    await sleep(AWAY_AFTER_MS + AWAY_CHECK_MS * 2);
    assert.strictEqual(room.state.players.get(a.sessionId)!.away, false);
  });
});
