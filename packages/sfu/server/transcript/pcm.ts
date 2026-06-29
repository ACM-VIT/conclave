const PCM16_BYTES_PER_SAMPLE = 2;
const INPUT_SAMPLE_RATE = 48000;
const OUTPUT_SAMPLE_RATE = 24000;

const clampInt16 = (value: number): number =>
  Math.max(-32768, Math.min(32767, Math.round(value)));

export const pcm16LeToBase64 = (buffer: Buffer): string =>
  buffer.toString("base64");

export const downsamplePcm16LeTo24kMono = (
  pcm: Buffer,
  channels: number,
): Buffer => {
  const normalizedChannels = Math.max(1, Math.floor(channels));
  const inputFrames = Math.floor(
    pcm.length / (PCM16_BYTES_PER_SAMPLE * normalizedChannels),
  );
  if (inputFrames === 0) return Buffer.alloc(0);

  const sampleRatio = INPUT_SAMPLE_RATE / OUTPUT_SAMPLE_RATE;
  const outputFrames = Math.floor(inputFrames / sampleRatio);
  const output = Buffer.alloc(outputFrames * PCM16_BYTES_PER_SAMPLE);

  for (let outputFrame = 0; outputFrame < outputFrames; outputFrame += 1) {
    const startFrame = Math.floor(outputFrame * sampleRatio);
    const endFrame = Math.min(
      inputFrames,
      Math.max(startFrame + 1, Math.floor((outputFrame + 1) * sampleRatio)),
    );
    let sum = 0;
    let count = 0;

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      for (let channel = 0; channel < normalizedChannels; channel += 1) {
        const sampleOffset =
          (frame * normalizedChannels + channel) * PCM16_BYTES_PER_SAMPLE;
        sum += pcm.readInt16LE(sampleOffset);
        count += 1;
      }
    }

    output.writeInt16LE(
      clampInt16(count === 0 ? 0 : sum / count),
      outputFrame * PCM16_BYTES_PER_SAMPLE,
    );
  }

  return output;
};
