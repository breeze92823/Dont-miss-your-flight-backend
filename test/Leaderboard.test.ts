import assert from "assert";
import http from "http";
import type { AddressInfo } from "net";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setVerifierForTest } from "../src/bloxity.js";
import { BOARDS } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

// A stand-in for api.bloxity.io that records what the game server reports.
function fakeBloxity() {
  const calls: { url: string; auth: string; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? ""), body: JSON.parse(raw || "null") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, accepted: 1, dropped: {} }));
    });
  });
  return new Promise<{ calls: typeof calls; url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })),
  );
}

describe("Bloxity leaderboards + stats", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  let api: Awaited<ReturnType<typeof fakeBloxity>>;
  const env = { ...process.env };
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    api = await fakeBloxity();
    Object.assign(process.env, { BLOXITY_API_URL: api.url, BLOXITY_GAME_ID: "dont-miss-your-flight", BLOXITY_REPORT_TOKEN: "report-token" });
    __setVerifierForTest(async (t) => (t.startsWith("tok-") ? { id: t.slice(4), username: t.slice(4), pfp: "" } : null));
  });
  afterEach(() => {
    api.close();
    for (const k of ["BLOXITY_API_URL", "BLOXITY_GAME_ID", "BLOXITY_REPORT_TOKEN"]) if (env[k] === undefined) delete process.env[k];
    __setVerifierForTest(null);
  });

  it("reports a signed-in player's flights, destinations and coins, then only changes", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { token: "tok-acc1" });
    const guest = await colyseus.connectTo(room, { username: "Guest" });
    for (const x of [c, guest]) for (const t of ["noProgress", "daily"]) x.onMessage(t, () => {});
    await sleep(100);
    c.send("saveProgress", { coins: 500, flights: 3, visited: ["CDG", "LHR"] });
    guest.send("saveProgress", { coins: 999, flights: 9 });
    await sleep(100);
    await (room as any).report();

    const boards = api.calls.filter((r) => r.url === "/v1/leaderboards/hosted/dont-miss-your-flight/report");
    const stats = api.calls.filter((r) => r.url === "/v1/games/dont-miss-your-flight/stats");
    assert.strictEqual(boards.length, 1);
    assert.strictEqual(boards[0].auth, "Bearer report-token");
    assert.deepStrictEqual(boards[0].body.boards.map((b: any) => b.id), BOARDS.map((b) => b.id), "boards declared on the first report");
    assert.deepStrictEqual(boards[0].body.scores, [
      { board: "flights", userId: "legion_acc1", score: 3 },
      { board: "destinations", userId: "legion_acc1", score: 2 },
      { board: "coins", userId: "legion_acc1", score: 500 },
    ], "guests are never reported");
    assert.strictEqual(stats.length, 1);
    assert.deepStrictEqual(stats[0].body.players.map((p: any) => p.userId), ["legion_acc1"]);
    assert.deepStrictEqual({ ...stats[0].body.players[0].values, time_played: 0 }, { flights_taken: 3, destinations: 2, coins: 500, time_played: 0 });
    assert.deepStrictEqual(stats[0].body.definitions.map((d: any) => d.key), ["flights_taken", "destinations", "coins", "time_played"]);

    // Nothing changed: no leaderboard call (stats still refresh). Flights never go down.
    api.calls.length = 0;
    c.send("saveProgress", { coins: 500, flights: 1, visited: ["CDG", "LHR"] });
    await sleep(100);
    await (room as any).report();
    assert.strictEqual(api.calls.filter((r) => r.url.includes("/leaderboards/")).length, 0);
  });

  it("sends a leaving player's last scores at once", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { token: "tok-acc2" });
    for (const t of ["noProgress", "daily"]) c.onMessage(t, () => {});
    await sleep(100);
    c.send("saveProgress", { coins: 40, flights: 1, visited: ["JFK"] });
    await sleep(100);
    await c.leave(true);
    await sleep(200);
    const boards = api.calls.filter((r) => r.url.includes("/leaderboards/"));
    assert.strictEqual(boards.length, 1, "reported on leave, not 30 s later");
    assert.deepStrictEqual(boards[0].body.scores.find((s: any) => s.board === "flights"), { board: "flights", userId: "legion_acc2", score: 1 });
  });
});
