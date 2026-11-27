import { ROOM_OPEN_DEADLINE_MS } from "../packages/sfu/server/joinDeadlines.ts";
import { JOIN_ROOM_ACK_TIMEOUT_MS } from "../apps/web/src/app/lib/join-timeouts.ts";

const ROUND_TRIP_ALLOWANCE_MS = 3_000;

if (ROOM_OPEN_DEADLINE_MS + ROUND_TRIP_ALLOWANCE_MS > JOIN_ROOM_ACK_TIMEOUT_MS) {
  console.error(
    `The SFU answers a join whose room is still opening after ${ROOM_OPEN_DEADLINE_MS} ms, ` +
      `but a web tab gives up on a join after ${JOIN_ROOM_ACK_TIMEOUT_MS} ms. ` +
      `Keep the SFU's deadline at least ${ROUND_TRIP_ALLOWANCE_MS} ms below the tab's, so the tab hears its answer.`,
  );
  process.exit(1);
}

console.log(
  `Join deadlines line up: the SFU answers by ${ROOM_OPEN_DEADLINE_MS} ms, web tabs wait ${JOIN_ROOM_ACK_TIMEOUT_MS} ms.`,
);
