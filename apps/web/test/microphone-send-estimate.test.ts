import { describe, expect, it } from "vitest";
import {
  INITIAL_MICROPHONE_SEND_ESTIMATE_STATE,
  stepMicrophoneSendEstimate,
  type MicrophoneSendEstimateState,
} from "../src/app/lib/microphone-send-estimate";

const run = (samples: Array<[number, number | null]>) =>
  samples.reduce<MicrophoneSendEstimateState>(
    (state, [at, estimate]) => stepMicrophoneSendEstimate(state, estimate, at),
    INITIAL_MICROPHONE_SEND_ESTIMATE_STATE,
  ).profile;

const every = (fromMs: number, toMs: number, estimate: number | null) =>
  Array.from({ length: (toMs - fromMs) / 1000 + 1 }, (_, i): [number, number | null] => [
    fromMs + i * 1000,
    estimate,
  ]);

describe("microphone send estimate", () => {
  it("steps down only after the uplink stays low for three seconds", () => {
    expect(run(every(0, 2_000, 120_000))).toBe("good");
    expect(run(every(0, 3_000, 120_000))).toBe("poor");
    expect(run(every(0, 3_000, 150_000))).toBe("fair");
    expect(run(every(0, 3_000, 60_000))).toBe("emergency");
  });

  it("keeps the full mic bitrate on a healthy or unknown uplink", () => {
    expect(run(every(0, 30_000, 300_000))).toBe("good");
    expect(run(every(0, 30_000, null))).toBe("good");
  });

  it("climbs back only with headroom held for eight seconds", () => {
    const low = every(0, 3_000, 120_000);
    expect(run([...low, ...every(4_000, 30_000, 210_000)])).toBe("fair");
    expect(run([...low, ...every(4_000, 11_000, 260_000)])).toBe("poor");
    expect(run([...low, ...every(4_000, 12_000, 260_000)])).toBe("good");
  });

  it("ignores a brief dip", () => {
    expect(run([...every(0, 2_000, 80_000), ...every(3_000, 20_000, 400_000)])).toBe("good");
  });
});
