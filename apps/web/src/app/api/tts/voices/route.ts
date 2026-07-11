import { NextResponse } from "next/server";
import { requireSfuSessionUser } from "@/lib/sfu-user-auth";
import {
  createInstantVoiceClone,
  createVoiceToken,
  deleteInstantVoiceClone,
  MAX_VOICE_SAMPLE_BYTES,
  MAX_VOICE_SAMPLE_SECONDS,
  MIN_VOICE_SAMPLE_SECONDS,
} from "@/lib/tts-voice";

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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(new Error("Invalid voice sample upload."), 400);
  }

  if (formData.get("consent") !== "true") {
    return errorResponse(
      new Error("You must confirm that this is your voice and consent to cloning it."),
      400,
    );
  }
  const audio = formData.get("audio");
  if (!(audio instanceof File) || !audio.type.startsWith("audio/")) {
    return errorResponse(new Error("An audio recording is required."), 400);
  }
  if (audio.size <= 0 || audio.size > MAX_VOICE_SAMPLE_BYTES) {
    return errorResponse(new Error("The voice recording is too large."), 413);
  }
  const durationSeconds = Number(formData.get("durationSeconds"));
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < MIN_VOICE_SAMPLE_SECONDS ||
    durationSeconds > MAX_VOICE_SAMPLE_SECONDS
  ) {
    return errorResponse(
      new Error(
        `Record between ${MIN_VOICE_SAMPLE_SECONDS} and ${MAX_VOICE_SAMPLE_SECONDS} seconds.`,
      ),
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
