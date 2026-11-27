const RATE = 24_000;

const fromDbfs = (dbfs: number) => 10 ** (dbfs / 20);

const toPcm = (signal: Float64Array, rmsDbfs: number): Int16Array => {
  let energy = 0;
  for (const value of signal) energy += value * value;
  const rms = Math.sqrt(energy / Math.max(1, signal.length)) || 1;
  const gain = fromDbfs(rmsDbfs) / rms;
  return Int16Array.from(signal, (value) =>
    Math.max(-32_768, Math.min(32_767, Math.round(value * gain * 32_768))),
  );
};

export const voicedPcm = (rmsDbfs = -26, ms = 200, pitch = 140): Int16Array => {
  const signal = new Float64Array((RATE * ms) / 1_000);
  for (let index = 0; index < signal.length; index += 1) {
    const t = index / RATE;
    let value = 0;
    for (let harmonic = 1; pitch * harmonic < 3_400; harmonic += 1) {
      value += Math.sin(2 * Math.PI * pitch * harmonic * t) / harmonic;
    }
    signal[index] = value;
  }
  return toPcm(signal, rmsDbfs);
};

const seededNoise = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 1_073_741_824 - 1;
};

export const noisePcm = (rmsDbfs = -60, ms = 200, seed = 7): Int16Array => {
  const next = seededNoise(seed);
  return toPcm(Float64Array.from({ length: (RATE * ms) / 1_000 }, next), rmsDbfs);
};

export const clicksPcm = (peakDbfs = -12, ms = 200, seed = 11): Int16Array => {
  const next = seededNoise(seed);
  const samples = new Int16Array((RATE * ms) / 1_000);
  const peak = fromDbfs(peakDbfs) * 32_767;
  for (let start = 0; start < samples.length; start += RATE / 10) {
    for (let offset = 0; offset < RATE * 0.004 && start + offset < samples.length; offset += 1) {
      samples[start + offset] = Math.round(next() * peak);
    }
  }
  return samples;
};

export const silencePcm = (ms = 200): Int16Array => new Int16Array((RATE * ms) / 1_000);

export const pcmBase64 = (samples: Int16Array): string =>
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
