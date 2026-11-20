import assert from "assert";

import { COINS_MAX, FLIGHTS_MAX } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({ coins: 1e40, flights: 2.7, dest: -2, hack: "x", trophies: 5 })!;
    assert.strictEqual(out.coins, COINS_MAX);
    assert.strictEqual(out.flights, 2);
    assert.strictEqual(out.dest, 0);
    assert.ok(!("hack" in out));
    assert.ok(!("trophies" in out), "fields of other games are dropped");
    assert.strictEqual(sanitizeProgress({ flights: 1e20 })!.flights, FLIGHTS_MAX);
  });
});
