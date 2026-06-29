import { TranscriptRoom } from "./room";
import { getTranscriptServiceVersion } from "./service-version";
import type { Env } from "./types";
import { json, normalizeRoomIdFromPath } from "./utils";

export { TranscriptRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/version") {
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
      };
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, { status: 405, headers });
      }
      return json(
        { serviceVersion: getTranscriptServiceVersion(env) },
        { headers },
      );
    }

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
