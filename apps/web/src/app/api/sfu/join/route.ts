import jwt from "jsonwebtoken";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type JoinRequestBody = {
  roomId?: string;
  sessionId?: string;
  user?: {
    id?: string | null;
    email?: string | null;
    name?: string | null;
  };
  isAdmin?: boolean;
};

const parseAdminEmails = (value?: string) =>
  (value ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

const resolveSfuUrl = () =>
  process.env.SFU_URL || process.env.NEXT_PUBLIC_SFU_URL || "http://localhost:3031";

export async function POST(request: Request) {
  let body: JoinRequestBody;
  try {
    body = (await request.json()) as JoinRequestBody;
  } catch (_error) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const roomId = body?.roomId?.trim();
  const sessionId = body?.sessionId?.trim();

  if (!roomId) {
    return NextResponse.json({ error: "Missing room ID" }, { status: 400 });
  }

  if (!sessionId) {
    return NextResponse.json({ error: "Missing session ID" }, { status: 400 });
  }

  const email = body?.user?.email?.trim() || undefined;
  const name = body?.user?.name?.trim() || undefined;
  const providedId = body?.user?.id?.trim() || undefined;
  const baseUserId = email || providedId || `guest-${sessionId}`;
  const adminEmails = parseAdminEmails(process.env.SFU_ADMIN_EMAILS);
  const resolvedAdmin =
    adminEmails.length > 0
      ? Boolean(email && adminEmails.includes(email.toLowerCase()))
      : Boolean(body?.isAdmin);

  const token = jwt.sign(
    {
      userId: baseUserId,
      email,
      name,
      isAdmin: resolvedAdmin,
      sessionId,
    },
    process.env.SFU_SECRET || "development-secret",
    { expiresIn: "1h" }
  );

  return NextResponse.json({ token, sfuUrl: resolveSfuUrl() });
}
