import { roomAiAccess } from "@/lib/room-ai-access";
import { AI_ENDPOINTS, getProviderApiKey } from "@conclave/ai/models";

export async function POST(request: Request): Promise<Response> {
  try {
    const token =
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const { env, settings } = await roomAiAccess(token, "voice");
    const apiKey = getProviderApiKey(env, "openai");
    if (!apiKey)
      return Response.json(
        { error: "Add an OpenAI key in Room AI settings." },
        { status: 400 },
      );
    const body = (await request.json()) as {
      session?: Record<string, unknown>;
    };
    const endpoint = `${(env.CLOUDFLARE_AI_GATEWAY_OPENAI_URL || env.OPENAI_BASE_URL || AI_ENDPOINTS.openai.apiBase).replace(/\/+$/, "")}/realtime/client_secrets`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session: {
          ...body.session,
          type: "realtime",
          model: settings.model,
          ...(settings.instructions
            ? {
                instructions: `${typeof body.session?.instructions === "string" ? body.session.instructions : ""}\n\n${settings.instructions}`,
              }
            : {}),
        },
      }),
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(settings.timeoutMs),
      ]),
      redirect: "manual",
    });
    if (!response.ok)
      return Response.json(
        {
          error:
            "OpenAI could not start the voice assistant. Check the room model and key.",
        },
        {
          status:
            response.status >= 400 && response.status <= 599
              ? response.status
              : 502,
        },
      );
    const result: unknown = await response.json();
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json(
      {
        error:
          "Voice access expired or is unavailable. Reconnect and try again.",
      },
      { status: 403 },
    );
  }
}
