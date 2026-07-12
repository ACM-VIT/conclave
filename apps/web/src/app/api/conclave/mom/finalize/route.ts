import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_MOM_BYTES = 512 * 1024;

const sanitizePathSegment = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

export async function POST(request: Request) {
  const token = process.env.MOM_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  const repository = process.env.MOM_GITHUB_REPOSITORY;
  const branch = process.env.MOM_GITHUB_BRANCH || "main";
  const basePath = process.env.MOM_GITHUB_BASE_PATH || "meeting-minutes";

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
    markdown?: unknown;
    title?: unknown;
  } | null;

  const roomId = typeof body?.roomId === "string" ? body.roomId.trim() : "";
  const markdown =
    typeof body?.markdown === "string" ? body.markdown.trim() : "";
  if (!roomId || !markdown) {
    return NextResponse.json(
      { error: "roomId and markdown are required." },
      { status: 400 },
    );
  }

  if (Buffer.byteLength(markdown, "utf8") > MAX_MOM_BYTES) {
    return NextResponse.json(
      { error: "MoM is too large to version." },
      { status: 413 },
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
      message: `docs(mom): finalize minutes for ${roomId}`,
      content: Buffer.from(markdown, "utf8").toString("base64"),
      branch,
      ...(existing?.sha ? { sha: existing.sha } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json(
      { error: "Failed to version MoM.", detail: text.slice(0, 500) },
      { status: response.status },
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
