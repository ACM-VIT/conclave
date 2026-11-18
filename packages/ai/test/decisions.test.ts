import { describe, expect, it, vi } from "vitest";
import {
  DecisionError,
  formatCloudflareCredential,
  parseCloudflareCredential,
  readDecisionCredentials,
  runDecisionBatches,
  runDecisions,
  scoreLevel,
  type DecisionQuestion,
} from "@conclave/ai/decisions";
import { isProviderApiKey, readAiEnvironment } from "@conclave/ai/models";
import { resolveAiFeatureSettings, validateFeaturePatch, featureProvider } from "@conclave/ai/room-settings";

const cloudflare = { cloudflare: { accountId: "abc123def456", token: "cf-token" } };
const typesafe = { typesafe: { apiKey: "ts-key" } };

const questions: Record<string, DecisionQuestion> = {
  urgent: { type: "noul", instructions: "Is this urgent?" },
  team: {
    type: "choice",
    instructions: "Which team?",
    criteria: { billing: "Payments", technical: "Outages" },
  },
  severity: { type: "score", instructions: "How severe?", criteria: ["None", "Minor", "Major"] },
};

const answers = {
  urgent: { type: "noul", noul: 0.91 },
  team: { type: "choice", choice: "technical", probabilities: { billing: 0.1, technical: 0.9 }, confidence: 0.8 },
  severity: {
    type: "score",
    score: 1.7,
    legend: { "0": "None", "1": "Minor", "2": "Major" },
    probabilities: { "0": 0.05, "1": 0.2, "2": 0.75 },
    confidence: 0.6,
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("decision credentials", () => {
  it("parses a packed Cloudflare account and token", () => {
    expect(parseCloudflareCredential(" abc123def456 : tok:en ")).toEqual({ accountId: "abc123def456", token: "tok:en" });
    expect(parseCloudflareCredential("short:token")).toBeNull();
    expect(parseCloudflareCredential("abc123def456:")).toBeNull();
    expect(parseCloudflareCredential("no-separator")).toBeNull();
    expect(formatCloudflareCredential({ accountId: "abc123def456", token: "t" })).toBe("abc123def456:t");
  });

  it("reads deployment credentials and validates provider keys", () => {
    const env = readAiEnvironment({ CLOUDFLARE_AI_API_KEY: "abc123def456:tok", TYPESAFE_API_KEY: "ts" });
    expect(readDecisionCredentials(env)).toEqual({
      cloudflare: { accountId: "abc123def456", token: "tok" },
      typesafe: { apiKey: "ts" },
    });
    expect(readDecisionCredentials({})).toEqual({ cloudflare: null, typesafe: null });
    expect(isProviderApiKey("cloudflare", "abc123def456:tok")).toBe(true);
    expect(isProviderApiKey("cloudflare", "tok")).toBe(false);
    expect(isProviderApiKey("typesafe", "anything")).toBe(true);
  });
});

describe("runDecisions", () => {
  it("calls Workers AI for Clef and unwraps the result envelope", async () => {
    const fetchImpl = vi.fn(async () => json({ success: true, result: { model: "clef-flash", answers, usage: { input_tokens: 40, output_tokens: 0 } } }));
    const result = await runDecisions({ model: "clef-flash", credentials: cloudflare, state: "Checkout is down", questions, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/abc123def456/ai/run/@cf/cloudflare/clef-flash");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer cf-token");
    expect(JSON.parse(String(init.body))).toEqual({ model: "clef-flash", state: "Checkout is down", questions });
    expect(result.answers.urgent).toEqual({ type: "noul", noul: 0.91 });
    expect(result.answers.team).toMatchObject({ choice: "technical", confidence: 0.8 });
    expect(result.answers.severity).toMatchObject({ score: 1.7 });
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 0 });
  });

  it("calls the TypeSafe System One endpoint for Jev", async () => {
    const fetchImpl = vi.fn(async () => json({ model: "jev-1.14.0", answers, usage: { input_tokens: 10, output_tokens: 0 } }));
    const result = await runDecisions({ model: "jev", credentials: typesafe, state: { a: 1 }, questions, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((JSON.parse(String(init.body)) as { model: string }).model).toBe("jev-latest");
    expect(result.model).toBe("jev-1.14.0");
  });

  it("needs a credential for the chosen provider", async () => {
    await expect(runDecisions({ model: "clef", credentials: typesafe, state: "x", questions })).rejects.toThrow(/Cloudflare/);
    await expect(runDecisions({ model: "jev", credentials: cloudflare, state: "x", questions })).rejects.toThrow(/TypeSafe/);
    await expect(runDecisions({ model: "gpt", credentials: cloudflare, state: "x", questions })).rejects.toThrow(/Unknown decision model/);
  });

  it("rejects malformed questions before calling out", async () => {
    const fetchImpl = vi.fn();
    const bad = async (q: Record<string, DecisionQuestion>) =>
      runDecisions({ model: "clef", credentials: cloudflare, state: "x", questions: q, fetchImpl });
    await expect(bad({})).rejects.toThrow(/at least one/);
    await expect(bad({ "bad id!": { type: "noul", instructions: "x" } })).rejects.toThrow(/Invalid question id/);
    await expect(bad({ c: { type: "choice", instructions: "x", criteria: { only: "one" } } })).rejects.toThrow(/2 to 255/);
    await expect(bad({ s: { type: "score", instructions: "x", criteria: ["one"] } })).rejects.toThrow(/2 to 10/);
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, { type: "noul" as const, instructions: "x" }]));
    await expect(bad(many)).rejects.toThrow(/at most 64/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses answers that do not match the question schema", async () => {
    const run = (body: unknown) =>
      runDecisions({ model: "jev", credentials: typesafe, state: "x", questions, fetchImpl: vi.fn(async () => json(body)) });
    await expect(run({ answers: { ...answers, urgent: { type: "noul", noul: 1.5 } } })).rejects.toThrow(/urgent/);
    await expect(run({ answers: { ...answers, team: { ...answers.team, choice: "sales" } } })).rejects.toThrow(/team/);
    await expect(run({ answers: { ...answers, severity: { type: "noul", noul: 0.5 } } })).rejects.toThrow(/severity/);
    await expect(run({ nope: true })).rejects.toThrow(/unexpected response/);
    await expect(run({ answers: { ...answers, severity: { ...answers.severity, score: 99 } } })).rejects.toThrow(/severity/);
    await expect(run({ answers: { ...answers, severity: { ...answers.severity, probabilities: { "99": 1 } } } })).rejects.toThrow(/severity/);
    await expect(run({ answers: { ...answers, severity: { ...answers.severity, probabilities: { "1.5": 1 } } } })).rejects.toThrow(/severity/);
    await expect(run({ answers: { ...answers, team: { ...answers.team, probabilities: { billing: 0.1, sales: 0.9 } } } })).rejects.toThrow(/team/);
  });

  it("retries rate limits and overloads, but not auth failures", async () => {
    const retried = vi
      .fn()
      .mockResolvedValueOnce(json({ detail: "slow down" }, 429))
      .mockResolvedValueOnce(json({ detail: "overloaded" }, 529))
      .mockResolvedValueOnce(json({ answers }));
    await expect(
      runDecisions({ model: "jev", credentials: typesafe, state: "x", questions, fetchImpl: retried }),
    ).resolves.toMatchObject({ answers: { urgent: { noul: 0.91 } } });
    expect(retried).toHaveBeenCalledTimes(3);

    const denied = vi.fn(async () => json({ success: false, errors: [{ message: "Authentication error" }] }, 401));
    const error = await runDecisions({ model: "clef", credentials: cloudflare, state: "x", questions, fetchImpl: denied }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecisionError);
    expect(error).toMatchObject({ status: 401, retryable: false, message: "Authentication error" });
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("gives up when the time budget runs out", async () => {
    const hang = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    await expect(
      runDecisions({ model: "jev", credentials: typesafe, state: "x", questions, fetchImpl: hang as unknown as typeof fetch, timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);
  });

  it("splits more than 64 questions into concurrent batches", async () => {
    const many = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`q${i}`, { type: "noul" as const, instructions: `#${i}` }]));
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      return json({ answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.5 }])) });
    });
    const result = await runDecisionBatches({ model: "jev", credentials: typesafe, state: "x", questions: many, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(Object.keys(result)).toHaveLength(130);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reads the most likely level from a score answer", () => {
    expect(scoreLevel({ type: "score", score: 1.7, probabilities: { "0": 0.05, "1": 0.2, "2": 0.75 }, confidence: 0.6 })).toBe(2);
  });
});

describe("answer judging feature", () => {
  it("defaults to Clef Flash with a short timeout and accepts only decision models", () => {
    const settings = resolveAiFeatureSettings({}, "answers", {});
    expect(settings).toMatchObject({ enabled: true, model: "clef-flash", timeoutMs: 2_500, searchEnabled: false });
    expect(featureProvider("answers", "clef")).toBe("cloudflare");
    expect(featureProvider("answers", "jev")).toBe("typesafe");
    expect(validateFeaturePatch("answers", { model: "jev", enabled: false })).toEqual({ model: "jev", enabled: false });
    expect(() => validateFeaturePatch("answers", { model: "gpt-6.1-sol" })).toThrow(/supported model/);
  });
});
