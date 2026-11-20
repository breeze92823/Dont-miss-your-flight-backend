// Every call this server makes to Bloxity (docs.bloxity.io, "HTML5 / JavaScript" + Reference):
//   - identity: the client's game token -> the verified Bloxity account (POST /v1/auth/game-token/verify)
//   - rewarded ads: a reward token -> valid or not (POST /v1/ads/reward/verify)
//   - hosted leaderboards: scores of signed-in players (POST /v1/leaderboards/hosted/{game}/report)
//   - game stats: the game page's player stats (POST /v1/games/{game}/stats)
// Bloxity hosting injects BLOXITY_API_URL / BLOXITY_GAME_ID / BLOXITY_REPORT_TOKEN (and BLOXITY_ENV);
// the prod API is the fallback. None of these may throw into a room: failures are logged and
// answer "not verified" / skip the report.
import { BOARDS, STATS } from "./constants.js";

export const apiUrl = () => (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");
// The game id is the client's GAME_SLUG (src/config.js), also the Legion game id.
export const gameId = () => process.env.BLOXITY_GAME_ID || process.env.LEGION_GAME_ID || "dont-miss-your-flight";
const reportToken = () => process.env.BLOXITY_REPORT_TOKEN || "";

const TIMEOUT_MS = 5000;

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // Empty / non-JSON body.
  }
  return { status: res.status, json };
}

// --- Identity -----------------------------------------------------------------------------------
export interface VerifiedUser {
  id: string; // Bloxity user._id: the ONLY account id this server trusts
  username: string;
  pfp: string;
}
type Verifier = (token: string) => Promise<VerifiedUser | null>;

// The client's Legion.SDK.auth.getToken() -> the account it belongs to, or null (guest, expired or
// forged token, Bloxity unreachable). Never decodes the JWT itself.
const verifyWithBloxity: Verifier = async (token) => {
  try {
    const { status, json } = await post(`${apiUrl()}/v1/auth/game-token/verify`, { gameSlug: gameId() }, { authorization: `Bearer ${token}` });
    const u = json?.user;
    if (status !== 200 || json?.valid !== true || !u || typeof u._id !== "string" || !u._id) return null;
    return { id: u._id, username: String(u.displayName || u.username || "Player"), pfp: typeof u.pfp === "string" ? u.pfp : "" };
  } catch (err) {
    console.warn("[bloxity] token verify failed", (err as Error)?.message ?? err);
    return null;
  }
};
let verifier: Verifier = verifyWithBloxity;
export const verifyToken = (token: string) => verifier(token);
// Test-only seam.
export function __setVerifierForTest(fn: Verifier | null): void {
  verifier = fn ?? verifyWithBloxity;
}

// Outside production (local `npm start`, tests) a client-sent `dev-`/plain id is trusted so local
// play keeps a save without Bloxity; hosted servers (BLOXITY_ENV set or NODE_ENV=production) only
// ever trust a verified token.
export const trustClientIds = () => process.env.NODE_ENV !== "production" && !process.env.BLOXITY_ENV;

// --- Rewarded ads ------------------------------------------------------------------------------------
export interface RewardCheck {
  valid: boolean;
  userId?: string;
  placement?: string;
  test?: boolean;
  reason?: string;
}
type RewardVerifier = (rewardToken: string) => Promise<RewardCheck>;
const verifyRewardWithBloxity: RewardVerifier = async (rewardToken) => {
  try {
    const { json } = await post(`${apiUrl()}/v1/ads/reward/verify`, { gameSlug: gameId(), rewardToken });
    return { valid: json?.valid === true, userId: json?.userId, placement: json?.placement, test: json?.test === true, reason: json?.reason };
  } catch (err) {
    console.warn("[bloxity] reward verify failed", (err as Error)?.message ?? err);
    return { valid: false, reason: "unreachable" };
  }
};
let rewardVerifier: RewardVerifier = verifyRewardWithBloxity;
export const verifyReward = (rewardToken: string) => rewardVerifier(rewardToken);
export function __setRewardVerifierForTest(fn: RewardVerifier | null): void {
  rewardVerifier = fn ?? verifyRewardWithBloxity;
}

// --- Leaderboards + stats ---------------------------------------------------------------------------
// Bloxity's user ids in reports are "legion_<id>" (any "#m..." suffix stripped).
const reportUserId = (id: string) => `legion_${id.replace(/#m.*$/, "")}`;
export const canReport = () => !!reportToken() && !!process.env.BLOXITY_GAME_ID;

export interface PlayerNumbers {
  userId: string; // verified Bloxity id
  flights: number;
  destinations: number;
  coins: number;
  playtime: number; // s
}

let boardsDeclared = false;
// Leaderboard scores (BOARDS ids). Max 200 per call; rooms hold far fewer.
export async function reportScores(rows: PlayerNumbers[]): Promise<void> {
  if (!canReport() || !rows.length) return;
  const scores = rows.flatMap((r) => [
    { board: "flights", userId: reportUserId(r.userId), score: r.flights },
    { board: "destinations", userId: reportUserId(r.userId), score: r.destinations },
    { board: "coins", userId: reportUserId(r.userId), score: r.coins },
  ]);
  try {
    const { status, json } = await post(
      `${apiUrl()}/v1/leaderboards/hosted/${encodeURIComponent(gameId())}/report`,
      { ...(!boardsDeclared && { boards: BOARDS }), scores: scores.slice(0, 200) },
      { authorization: `Bearer ${reportToken()}` },
    );
    if (status === 200) boardsDeclared = true;
    const dropped = json?.dropped;
    if (status !== 200 || (dropped && Object.values(dropped).some((n) => Number(n) > 0))) console.warn("[bloxity] leaderboard report", status, dropped ?? json);
  } catch (err) {
    console.warn("[bloxity] leaderboard report failed", (err as Error)?.message ?? err);
  }
}

// Ceilings Bloxity rejects above (not clamps), so values are clamped here first.
const CEILING: Record<string, number> = { number: 1e9, seconds: 31_536_000_000, currency: 1e12, percent: 100 };
export async function reportStats(rows: PlayerNumbers[]): Promise<void> {
  if (!canReport() || !rows.length) return;
  const cap = (key: string, v: number) => Math.max(0, Math.min(CEILING[STATS.find((s) => s.key === key)!.type], Math.floor(v)));
  const players = rows.slice(0, 200).map((r) => ({
    userId: reportUserId(r.userId),
    values: {
      flights_taken: cap("flights_taken", r.flights),
      destinations: cap("destinations", r.destinations),
      coins: cap("coins", r.coins),
      time_played: cap("time_played", r.playtime),
    },
  }));
  try {
    const { status, json } = await post(`${apiUrl()}/v1/games/${encodeURIComponent(gameId())}/stats`, { definitions: STATS, players }, { authorization: `Bearer ${reportToken()}` });
    if (status !== 200) console.warn("[bloxity] stats report", status, json);
  } catch (err) {
    console.warn("[bloxity] stats report failed", (err as Error)?.message ?? err);
  }
}
