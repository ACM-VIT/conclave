import { TranscriptRoom } from "./room";
import type { Env } from "./types";
import { json, normalizeRoomIdFromPath } from "./utils";

export { TranscriptRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const roomId = normalizeRoomIdFromPath(url.pathname);
    if (!roomId) {
      return json({ error: "Not found" }, { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, { status: 426 });
    }

    const objectId = env.TRANSCRIPT_ROOM.idFromName(roomId);
    const stub = env.TRANSCRIPT_ROOM.get(objectId);
    return stub.fetch(request);
  },
};
