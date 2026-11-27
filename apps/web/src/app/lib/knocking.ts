import type { ConnectionState } from "./types";

// States a tab passes through on its way to an answer. They do not say where
// it stands: in the call, knocking, or out.
const IN_TRANSIT: ReadonlySet<ConnectionState> = new Set([
  "connecting",
  "connected",
  "joining",
  "reconnecting",
]);

export const settledConnectionState = (
  settled: ConnectionState,
  next: ConnectionState,
): ConnectionState => (IN_TRANSIT.has(next) ? settled : next);

// A tab that was knocking is still knocking while it reconnects, such as
// after a server restart: it shows the waiting room until it is let in,
// gives up or leaves.
export const isKnocking = (
  current: ConnectionState,
  settled: ConnectionState,
): boolean =>
  current === "waiting" || (settled === "waiting" && IN_TRANSIT.has(current));
