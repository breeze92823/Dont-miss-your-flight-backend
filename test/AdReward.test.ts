import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setRewardVerifierForTest } from "../src/bloxity.js";
import { AD_REWARD_COINS } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("rewarded ads", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setRewardVerifierForTest(null));

  it("grants coins only for a token Bloxity verifies, one per cooldown", async () => {
    __setRewardVerifierForTest(async (t) => (t === "ok" ? { valid: true, placement: "free-coins" } : { valid: false, reason: "unknown" }));
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-a" });
    const got: any[] = [];
    c.onMessage("adRewardResult", (m: any) => got.push(m));
    c.onMessage("noProgress", () => {});
    c.onMessage("daily", () => {});
    c.send("adReward", { rewardToken: "forged" });
    await sleep(80);
    c.send("adReward", { rewardToken: "ok" });
    await sleep(80);
    c.send("adReward", { rewardToken: "ok" });
    await sleep(80);
    assert.deepStrictEqual(got.map((m) => [m.ok, m.coins ?? m.reason]), [[false, "unknown"], [true, AD_REWARD_COINS], [false, "cooldown"]]);
  });
});
