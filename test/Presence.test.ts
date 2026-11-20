import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { AVATAR_MAX_LEN, POSE_BOUNDS } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("presence (fellow passengers)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("takes the pose, trip and look from the join options", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {
      userId: "guest-a",
      pose: { x: 3, y: 0.5, z: -12, yaw: Math.PI, speed: 4, grounded: false, anim: "sit" },
      trip: { zone: "cabin", dest: 3, line: "security", hold: "lane:1", suitcase: "gold", hat: "pilot", vip: true, pack: false, bag: false },
      avatar: '{"equipped":{}}',
    });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual([p.x, p.y, p.z, p.speed, p.grounded, p.anim], [3, 0.5, -12, 4, false, "sit"]);
    assert.ok(Math.abs(Math.abs(p.yaw) - Math.PI) < 1e-5);
    assert.deepStrictEqual([p.zone, p.dest, p.line, p.hold, p.suitcase, p.hat, p.vip, p.pack, p.bag], ["cabin", 3, "security", "lane:1", "gold", "pilot", true, false, false]);
    assert.strictEqual(p.avatar, '{"equipped":{}}');
  });

  it("bounds poses and trips and relays them to the others", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    a.send("pose", { x: 1e9, y: "high", z: -1e12, yaw: 7, speed: -3, anim: "dance" });
    a.send("trip", { zone: "moon", dest: 999, line: "taxi", hold: "desk:999", suitcase: "Bad Id!", hat: "security", vip: "yes" });
    a.send("emote", { id: "65f0c0ffee0000000000abcd" });
    a.send("setAvatar", { avatar: "x".repeat(AVATAR_MAX_LEN + 1) });
    await sleep(100);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.x, POSE_BOUNDS.xz);
    assert.strictEqual(p.y, 0, "a non-number is ignored");
    assert.strictEqual(p.z, -POSE_BOUNDS.xz);
    assert.ok(Math.abs(p.yaw - Math.atan2(Math.sin(7), Math.cos(7))) < 1e-5, "yaw wrapped to -PI..PI");
    assert.strictEqual(p.speed, 0);
    assert.strictEqual(p.anim, "", "an unknown overlay is ignored");
    assert.deepStrictEqual([p.zone, p.line, p.hold, p.suitcase, p.vip], ["airport", "", "", "purple", false], "malformed trip fields are ignored");
    assert.strictEqual(p.dest, 63, "dest clamped");
    assert.strictEqual(p.hat, "security");
    assert.strictEqual(p.emote, "65f0c0ffee0000000000abcd");
    assert.strictEqual(p.avatar, "", "an oversized look is ignored");

    // b's synced copy of the roster sees a's presence (after the next state patch).
    await sleep(150);
    const seen = (b.state as any).players.get(a.sessionId);
    assert.strictEqual(seen.hat, "security");
    assert.strictEqual(seen.x, POSE_BOUNDS.xz);
  });
});
