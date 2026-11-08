import { transcriptRoomObjectName, verifyTranscriptRoomToken } from "./auth";
import { TranscriptRoom } from "./room";
import { getTranscriptServiceVersion } from "./service-version";
import type { Env } from "./types";
import { json, normalizeRoomIdFromPath } from "./utils";

export { TranscriptRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/version") {
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
      };
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders,
            "cache-control": "no-store",
          },
        });
      }
      if (request.method !== "GET") {
        return json(
          { error: "Method not allowed" },
          { status: 405, headers: corsHeaders },
        );
      }
      return json(
        { serviceVersion: getTranscriptServiceVersion(env) },
        {
          headers: {
            ...corsHeaders,
            "cache-control": "public, max-age=60, stale-while-revalidate=300",
          },
        },
      );
    }

    const roomId = normalizeRoomIdFromPath(url.pathname);
    if (!roomId) {
      return json({ error: "Not found" }, { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, { status: 426 });
    }

    // Route by the verified token's tenant, not the path alone: the same room
    // code can exist under different client ids.
    const payload = await verifyTranscriptRoomToken(
      url.searchParams.get("token") || "",
      env.TRANSCRIPT_TOKEN_SECRET,
      roomId,
    );
    const objectName = payload ? transcriptRoomObjectName(payload) : null;
    if (!objectName) {
      return json({ error: "Unauthorized" }, { status: 401 });
    }
    const objectId = env.TRANSCRIPT_ROOM.idFromName(objectName);
    const stub = env.TRANSCRIPT_ROOM.get(objectId);
    return stub.fetch(request);
  },
};
