const RTP_FIXED_HEADER_BYTES = 12;

export const extractRtpPayload = (packet: Buffer): Buffer | null => {
  if (packet.length < RTP_FIXED_HEADER_BYTES) return null;
  const firstByte = packet[0] ?? 0;
  const version = firstByte >> 6;
  if (version !== 2) return null;

  const hasPadding = (firstByte & 0x20) !== 0;
  const hasExtension = (firstByte & 0x10) !== 0;
  const csrcCount = firstByte & 0x0f;
  let offset = RTP_FIXED_HEADER_BYTES + csrcCount * 4;
  if (packet.length < offset) return null;

  if (hasExtension) {
    if (packet.length < offset + 4) return null;
    const extensionLengthWords = packet.readUInt16BE(offset + 2);
    offset += 4 + extensionLengthWords * 4;
    if (packet.length < offset) return null;
  }

  let end = packet.length;
  if (hasPadding) {
    const paddingBytes = packet[packet.length - 1] ?? 0;
    if (paddingBytes === 0 || paddingBytes > packet.length - offset) return null;
    end -= paddingBytes;
  }

  if (end <= offset) return null;
  return packet.subarray(offset, end);
};
