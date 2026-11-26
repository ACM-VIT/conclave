import { NextResponse } from "next/server";
import { requireSfuSessionUser } from "@/lib/sfu-user-auth";
import {
  createInstantVoiceClone,
  createVoiceToken,
  deleteInstantVoiceClone,
  MAX_VOICE_SAMPLE_SECONDS,
  MIN_VOICE_SAMPLE_SECONDS,
} from "@/lib/tts-voice";
import { readVoiceUpload } from "@/lib/voice-upload";

const errorResponse = (error: unknown, status = 500): NextResponse =>
  NextResponse.json(
    { error: error instanceof Error ? error.message : "Voice cloning failed." },
    { status },
  );

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireSfuSessionUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const upload = await readVoiceUpload(request);
  if (!upload.ok) {
    return errorResponse(new Error(upload.error), upload.status);
  }
  const { form: formData, audio } = upload;

  if (formData.get("consent") !== "true") {
    return errorResponse(
      new Error("You must confirm that this is your voice and consent to cloning it."),
      400,
    );
  }
  const durationSeconds = Number(formData.get("durationSeconds"));
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < MIN_VOICE_SAMPLE_SECONDS ||
    durationSeconds > MAX_VOICE_SAMPLE_SECONDS
  ) {
    return errorResponse(
      new Error("The voice sample must be about 1 to 2 minutes long."),
      400,
    );
  }

  const requestedName = String(formData.get("name") || "").trim();
  const ownerName = auth.user.name?.trim() || auth.user.email || "Conclave user";
  const voiceName = `${(requestedName || ownerName).slice(0, 70)} · Conclave`;

  try {
    const clone = await createInstantVoiceClone({ audio, name: voiceName });
    if (clone.requiresVerification) {
      await deleteInstantVoiceClone(clone.voiceId).catch(() => {});
      return errorResponse(
        new Error("The voice provider requires additional owner verification."),
        409,
      );
    }
    const token = await createVoiceToken({
      voiceId: clone.voiceId,
      voiceName,
      ownerId: auth.user.id,
    });
    return NextResponse.json({ token, name: voiceName });
  } catch (error) {
    return errorResponse(error);
  }
}
