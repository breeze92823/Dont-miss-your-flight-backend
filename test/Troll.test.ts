import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { TIMED_MAX_MS, TROLL_TEXT_MAX } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("flight save fields", () => {
  it("bounds coins, owned lists, the worn hat and timed rewards", () => {
    const now = Date.now();
    const out = sanitizeProgress({
      coins: 12.9,
      suitcases: ["purple", "gold", "Bad Id!"],
      suitcase: "red", // not owned
      hats: ["security"],
      hat: "pilot", // may be a timed shift: shape only
      passes: ["vip", "vip", "gravityGun"],
      visited: ["CDG", "LHR"],
      dest: 4.5,
      timed: { grapple: now + 60_000, old: now - 1, forever: now * 2, "bad id": now + 5 },
    })!;
    assert.strictEqual(out.coins, 12);
    assert.deepStrictEqual(out.suitcases, ["purple", "gold"]);
    assert.strictEqual(out.suitcase, undefined);
    assert.strictEqual(out.hat, "pilot");
    assert.deepStrictEqual(out.passes, ["vip", "gravityGun"]);
    assert.deepStrictEqual(out.visited, ["CDG", "LHR"]);
    assert.strictEqual(out.dest, 4);
    assert.deepStrictEqual(Object.keys(out.timed!).sort(), ["forever", "grapple"]);
    assert.ok(out.timed!.forever <= Date.now() + TIMED_MAX_MS);
    assert.strictEqual(sanitizeProgress({ coins: -3 })!.coins, 0);
  });
});

describe("troll relay", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("relays a troll to everyone else, bounded and rate-limited", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    fake.release();
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", username: "Ann" });
    const b = await colyseus.connectTo(room, { userId: "guest-b", username: "Bob" });
    const gotA: any[] = [];
    const gotB: any[] = [];
    for (const c of [a, b]) {
      c.onMessage("noProgress", () => {});
      c.onMessage("spins", () => {});
      c.onMessage("daily", () => {});
      c.onMessage("leaderboard", () => {});
    }
    a.onMessage("trolled", (m: any) => gotA.push(m));
    b.onMessage("trolled", (m: any) => gotB.push(m));
    await sleep(100);

    a.send("troll", { id: "announce", text: `hi\u0007${"x".repeat(200)}` });
    a.send("troll", { id: "killAll" }); // inside the cooldown: dropped
    b.send("troll", { id: "not an id!" }); // bad id: dropped
    await sleep(150);
    assert.strictEqual(gotA.length, 0, "the sender does not get its own troll back");
    assert.strictEqual(gotB.length, 1);
    assert.strictEqual(gotB[0].id, "announce");
    assert.strictEqual(gotB[0].from, "Ann");
    assert.strictEqual(gotB[0].text.length, TROLL_TEXT_MAX);
    assert.ok(gotB[0].text.startsWith("hi x"));

    b.send("troll", { id: "luggageRain" });
    await sleep(150);
    assert.deepStrictEqual(gotA.map((m) => m.id), ["luggageRain"]);
    assert.strictEqual(gotA[0].text, "");
  });
});
