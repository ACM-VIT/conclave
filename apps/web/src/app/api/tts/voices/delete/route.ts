import { NextResponse } from "next/server";
import { requireSfuSessionUser } from "@/lib/sfu-user-auth";
import {
  deleteInstantVoiceClone,
  verifyVoiceToken,
} from "@/lib/tts-voice";

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireSfuSessionUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body = (await request.json()) as { token?: string };
    const token = body.token?.trim();
    if (!token) {
      return NextResponse.json({ error: "Missing cloned voice token." }, { status: 400 });
    }
    const voice = await verifyVoiceToken(token, { allowExpired: true });
    if (voice.ownerId !== auth.user.id) {
      return NextResponse.json(
        { error: "Only the voice owner can delete this clone." },
        { status: 403 },
      );
    }
    await deleteInstantVoiceClone(voice.voiceId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Voice deletion failed." },
      { status: 400 },
    );
  }
}
