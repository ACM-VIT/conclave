import RecorderBotClient from "./RecorderBotClient";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ sessionId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const first = (
  value: string | string[] | undefined,
): string | undefined => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const num = (
  value: string | string[] | undefined,
  fallback: number,
): number => {
  const raw = first(value);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export default async function RecorderBotPage({ params, searchParams }: Props) {
  const { sessionId } = await params;
  const resolved = (await (searchParams ?? Promise.resolve({}))) as Record<
    string,
    string | string[] | undefined
  >;
  const roomId = first(resolved.roomId) ?? "";
  const token = first(resolved.token) ?? "";
  const captureSourceTag = first(resolved.title) ?? `conclave-rec-${sessionId.slice(0, 8)}`;
  const captureMode =
    first(resolved.capture) === "x11grab" ? "x11grab" : "mediarecorder";

  return (
    <RecorderBotClient
      sessionId={sessionId}
      roomId={roomId}
      token={token}
      captureSourceTag={captureSourceTag}
      captureMode={captureMode}
      width={num(resolved.w, 1920)}
      height={num(resolved.h, 1080)}
      fps={num(resolved.fps, 30)}
      videoBitrateKbps={num(resolved.vb, 5_000)}
      audioBitrateKbps={num(resolved.ab, 128)}
    />
  );
}
