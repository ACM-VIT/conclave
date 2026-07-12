import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { auth } from "@/lib/auth";
import { resolveSfuSecret } from "@/lib/sfu-admin-auth";
import { resolveSfuUrls } from "@/lib/sfu-url";

export const runtime = "nodejs";

const MAX_MOM_BYTES = 512 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 4;

const rateLimit = new Map<string, { count: number; resetAt: number }>();

type RoomAuthPayload = {
  jti?: string;
  purpose?: string;
  clientId?: string;
  userId?: string;
  email?: string;
  roomId?: string;
};

const sanitizePathSegment = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const takeRateLimit = (key: string): boolean => {
  const now = Date.now();
  const current = rateLimit.get(key);
  if (!current || current.resetAt <= now) {
    rateLimit.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (current.count >= RATE_LIMIT_MAX) {
    return false;
  }
  current.count += 1;
  return true;
};

const githubFailureStatus = (status: number): number => {
  if (status === 409) return 409;
  if (status === 422) return 400;
  if (status === 429) return 429;
  if (status >= 500) return 503;
  return 424;
};

const consumeSfuMomAuthorization = async (options: {
  roomId: string;
  clientId: string;
  authorizationId: string;
  email: string;
  sfuSecret: string;
}): Promise<boolean> => {
  for (const sfuUrl of resolveSfuUrls()) {
    const targetUrl = new URL(
      `/admin/rooms/${encodeURIComponent(options.roomId)}/mom/finalize-authority`,
      sfuUrl,
    );
    targetUrl.searchParams.set("clientId", options.clientId);
    try {
      const response = await fetch(targetUrl.toString(), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-sfu-secret": options.sfuSecret,
          "x-sfu-client": options.clientId,
        },
        cache: "no-store",
        body: JSON.stringify({
          authorizationId: options.authorizationId,
          email: options.email,
        }),
      });
      if (response.ok) return true;
    } catch {
      continue;
    }
  }
  return false;
};

export async function POST(request: Request) {
  const token = process.env.MOM_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  const repository = process.env.MOM_GITHUB_REPOSITORY;
  const branch = process.env.MOM_GITHUB_BRANCH || "main";
  const basePath = process.env.MOM_GITHUB_BASE_PATH || "meeting-minutes";
  const sfuSecret = resolveSfuSecret();

  if (!token || !repository) {
    return NextResponse.json(
      {
        error:
          "MoM versioning is not configured. Set MOM_GITHUB_TOKEN and MOM_GITHUB_REPOSITORY.",
      },
      { status: 501 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    roomId?: unknown;
    finalizeToken?: unknown;
    markdown?: unknown;
    title?: unknown;
  } | null;

  const roomId = typeof body?.roomId === "string" ? body.roomId.trim() : "";
  const finalizeToken =
    typeof body?.finalizeToken === "string" ? body.finalizeToken.trim() : "";
  const markdown =
    typeof body?.markdown === "string" ? body.markdown.trim() : "";
  if (!roomId || !finalizeToken || !markdown) {
    return NextResponse.json(
      { error: "roomId, finalizeToken, and markdown are required." },
      { status: 400 },
    );
  }

  const session = await auth.api
    .getSession({ headers: request.headers })
    .catch(() => null);
  const sessionEmail = session?.user?.email?.trim().toLowerCase() || "";
  if (!session?.user?.id || !sessionEmail) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  let roomAuth: RoomAuthPayload;
  try {
    roomAuth = jwt.verify(finalizeToken, sfuSecret) as RoomAuthPayload;
  } catch {
    return NextResponse.json(
      { error: "Invalid room authorization." },
      { status: 403 },
    );
  }

  if (
    roomAuth.roomId !== roomId ||
    roomAuth.purpose !== "mom:finalize" ||
    !roomAuth.jti ||
    !roomAuth.clientId ||
    roomAuth.email?.toLowerCase() !== sessionEmail
  ) {
    return NextResponse.json(
      { error: "Only the room host can finalize MoM." },
      { status: 403 },
    );
  }

  const rateKey = `${session.user.id}:${roomId}`;
  if (!takeRateLimit(rateKey)) {
    return NextResponse.json(
      { error: "MoM finalization is rate limited. Try again shortly." },
      { status: 429 },
    );
  }

  if (Buffer.byteLength(markdown, "utf8") > MAX_MOM_BYTES) {
    return NextResponse.json(
      { error: "MoM is too large to version." },
      { status: 413 },
    );
  }

  const hasLiveRoomAuthority = await consumeSfuMomAuthorization({
    roomId,
    clientId: roomAuth.clientId,
    authorizationId: roomAuth.jti,
    email: sessionEmail,
    sfuSecret,
  });
  if (!hasLiveRoomAuthority) {
    return NextResponse.json(
      { error: "Only the current room host can finalize MoM." },
      { status: 403 },
    );
  }

  const safeRoomId = sanitizePathSegment(roomId) || "meeting";
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `${date}-${safeRoomId}.md`;
  const path = `${basePath.replace(/^\/+|\/+$/g, "")}/${fileName}`;
  const apiBase = `https://api.github.com/repos/${repository}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;

  const lookup = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  const existing = lookup.ok
    ? ((await lookup.json()) as { sha?: string; html_url?: string })
    : null;

  const response = await fetch(apiBase, {
    method: "PUT",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      message: `docs(mom): finalize minutes for ${safeRoomId}`,
      content: Buffer.from(markdown, "utf8").toString("base64"),
      branch,
      ...(existing?.sha ? { sha: existing.sha } : {}),
    }),
  });

  if (!response.ok) {
    return NextResponse.json(
      { error: "Failed to version MoM." },
      { status: githubFailureStatus(response.status) },
    );
  }

  const result = (await response.json()) as {
    content?: { html_url?: string; path?: string };
    commit?: { html_url?: string; sha?: string };
  };

  return NextResponse.json({
    success: true,
    path: result.content?.path ?? path,
    url: result.content?.html_url ?? existing?.html_url ?? null,
    commitUrl: result.commit?.html_url ?? null,
    commitSha: result.commit?.sha ?? null,
  });
}
