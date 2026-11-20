import { matchMaker } from "colyseus";

// Bloxity "Open Rooms" (docs.bloxity.io, Show live rooms): every 2 s this pod tells the matchmaker
// which rooms it hosts, so the game page lists them and its Join button / friend invites land in the
// right pod. Needs MATCHMAKER_REPORT_URL, BLOXITY_REPORT_TOKEN and BLOXITY_GAME_ID (Bloxity hosting
// injects them); without them (local dev) it does nothing. Private rooms are never listed.
export function installRoomReporter(): void {
  const base = (process.env.MATCHMAKER_REPORT_URL || "").replace(/\/$/, "");
  const token = process.env.BLOXITY_REPORT_TOKEN;
  const gameId = process.env.BLOXITY_GAME_ID;
  if (!base || !token || !gameId) return;
  const podName = process.env.POD_NAME || process.env.HOSTNAME || "";
  const url = `${base}/${gameId}/rooms`;

  const tick = async () => {
    try {
      const listings = await matchMaker.query({});
      const rooms = listings
        .filter((r: any) => !r.private)
        .map((r: any) => ({
          colyseusRoomId: r.roomId,
          name: r.name ?? undefined,
          clients: r.clients ?? 0,
          maxClients: r.maxClients ?? 0,
          locked: !!r.locked,
          private: !!r.private,
          started: !!r.metadata?.started,
          metadata: r.metadata ?? undefined,
        }));
      const players = rooms.reduce((n: number, r: { clients: number }) => n + r.clients, 0);
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ podName, players, rooms }),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      // The next tick tries again.
    }
  };
  void tick();
  setInterval(tick, 2000).unref();
}
