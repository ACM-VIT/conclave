import type { RtpCodecParameters, RtpParameters } from "mediasoup/types";

export type SdpKind = "audio" | "video";

export type SdpBuildOptions = {
  kind: SdpKind;
  rtpParameters: RtpParameters;
  listenIp: string;
  port: number;
  rtcpPort?: number;
  ssrc?: number;
  cname?: string;
};

const formatFmtp = (params: Record<string, unknown> | undefined): string => {
  if (!params) return "";
  const tokens: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    tokens.push(`${key}=${value}`);
  }
  return tokens.join(";");
};

const pickPrimaryCodec = (
  codecs: RtpCodecParameters[],
): RtpCodecParameters | null => {
  for (const codec of codecs) {
    if (codec.mimeType.toLowerCase().endsWith("/rtx")) continue;
    return codec;
  }
  return codecs[0] ?? null;
};

export const buildSdpFromConsumer = (options: SdpBuildOptions): string => {
  const { kind, rtpParameters, listenIp, port } = options;
  const codec = pickPrimaryCodec(rtpParameters.codecs);
  if (!codec) {
    throw new Error("Recording: consumer has no codec parameters");
  }
  const codecName = codec.mimeType.split("/")[1];
  if (!codecName) {
    throw new Error(`Recording: invalid mime type ${codec.mimeType}`);
  }
  const channels = codec.channels ?? (kind === "audio" ? 1 : undefined);
  const rtpmapParams =
    kind === "audio" && channels
      ? `${codecName}/${codec.clockRate}/${channels}`
      : `${codecName}/${codec.clockRate}`;

  const ssrc =
    options.ssrc ?? rtpParameters.encodings?.[0]?.ssrc ?? 0;
  const cname =
    options.cname ?? rtpParameters.rtcp?.cname ?? "mediasoup-recording";

  const fmtpString = formatFmtp(codec.parameters);

  const lines: string[] = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=conclave-recording",
    `c=IN IP4 ${listenIp}`,
    "t=0 0",
    `m=${kind} ${port} RTP/AVP ${codec.payloadType}`,
    `a=rtpmap:${codec.payloadType} ${rtpmapParams}`,
  ];

  if (fmtpString) {
    lines.push(`a=fmtp:${codec.payloadType} ${fmtpString}`);
  }

  lines.push("a=sendonly");
  lines.push("a=rtcp-mux");
  if (ssrc > 0) {
    lines.push(`a=ssrc:${ssrc} cname:${cname}`);
  }

  return lines.join("\n") + "\n";
};

export const codecToOutputFormat = (
  kind: SdpKind,
  rtpParameters: RtpParameters,
): { codec: string; container: "webm" | "mp4" | "m4a"; extension: string } => {
  const codec = pickPrimaryCodec(rtpParameters.codecs);
  const mime = codec?.mimeType.toLowerCase() ?? "";
  if (kind === "audio") {
    if (mime.includes("opus")) {
      return { codec: "opus", container: "webm", extension: "webm" };
    }
    return { codec: codec?.mimeType.split("/")[1] ?? "audio", container: "webm", extension: "webm" };
  }
  if (mime.includes("h264")) {
    return { codec: "h264", container: "mp4", extension: "mp4" };
  }
  if (mime.includes("vp9")) {
    return { codec: "vp9", container: "webm", extension: "webm" };
  }
  if (mime.includes("vp8")) {
    return { codec: "vp8", container: "webm", extension: "webm" };
  }
  return { codec: codec?.mimeType.split("/")[1] ?? "video", container: "webm", extension: "webm" };
};
