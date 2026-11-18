export type DecisionProvider = "cloudflare" | "typesafe";

export type DecisionModel = {
  id: string;
  provider: DecisionProvider;
  label: string;
  apiModel: string;
};

export const DECISION_MODELS = [
  { id: "clef-flash", provider: "cloudflare", label: "Clef Flash", apiModel: "clef-flash" },
  { id: "clef", provider: "cloudflare", label: "Clef", apiModel: "clef" },
  { id: "jev", provider: "typesafe", label: "Jev", apiModel: "jev-latest" },
] as const satisfies readonly DecisionModel[];

export type DecisionModelId = (typeof DECISION_MODELS)[number]["id"];

export const DEFAULT_DECISION_MODEL: DecisionModelId = "clef-flash";

export const decisionModel = (id: string | null | undefined): DecisionModel | null =>
  DECISION_MODELS.find((model) => model.id === id) ?? null;

export type NoulQuestion = {
  type: "noul";
  instructions: unknown;
  criteria?: { true?: unknown; false?: unknown };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: unknown;
  criteria: Record<string, unknown>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: unknown;
  criteria: unknown[];
};

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
};

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type DecisionResult = {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
};

export type CloudflareDecisionCredential = { accountId: string; token: string };

export type DecisionCredentials = {
  cloudflare?: CloudflareDecisionCredential | null;
  typesafe?: { apiKey: string } | null;
};

export class DecisionError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null = null, retryable = false) {
    super(message);
    this.name = "DecisionError";
    this.status = status;
    this.retryable = retryable;
  }
}

export const MAX_DECISION_QUESTIONS = 64;
const SCORE_EPSILON = 1e-6;
const QUESTION_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const CLOUDFLARE_ACCOUNT = /^[A-Za-z0-9]{8,64}$/;
const DEFAULT_TIMEOUT_MS = 4_000;
const RETRY_BASE_MS = 200;

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4/accounts";
const TYPESAFE_API = "https://api.typesafe.ai/v1/systemone";
const CLOUDFLARE_KEY_ENV = "CLOUDFLARE_AI_API_KEY";
const TYPESAFE_KEY_ENV = "TYPESAFE_API_KEY";

export const parseCloudflareCredential = (
  value: string | null | undefined,
): CloudflareDecisionCredential | null => {
  const text = value?.trim();
  if (!text) return null;
  const split = text.indexOf(":");
  if (split <= 0) return null;
  const accountId = text.slice(0, split).trim();
  const token = text.slice(split + 1).trim();
  if (!CLOUDFLARE_ACCOUNT.test(accountId) || !token) return null;
  return { accountId, token };
};

export const formatCloudflareCredential = (credential: CloudflareDecisionCredential): string =>
  `${credential.accountId.trim()}:${credential.token.trim()}`;

export const readDecisionCredentials = (
  env: Partial<Record<string, string | undefined>>,
): DecisionCredentials => {
  const typesafe = env[TYPESAFE_KEY_ENV]?.trim();
  return {
    cloudflare: parseCloudflareCredential(env[CLOUDFLARE_KEY_ENV]),
    typesafe: typesafe ? { apiKey: typesafe } : null,
  };
};

export const hasDecisionCredential = (
  credentials: DecisionCredentials,
  provider: DecisionProvider,
): boolean => Boolean(provider === "cloudflare" ? credentials.cloudflare : credentials.typesafe);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const probability = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

const probabilityMap = (value: unknown): Record<string, number> | null => {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const p = probability(entry);
    if (p === null) return null;
    out[key] = p;
  }
  return Object.keys(out).length > 0 ? out : null;
};

const parseAnswer = (value: unknown, question: DecisionQuestion): DecisionAnswer | null => {
  if (!isRecord(value) || value.type !== question.type) return null;
  if (question.type === "noul") {
    const noul = probability(value.noul);
    return noul === null ? null : { type: "noul", noul };
  }
  const probabilities = probabilityMap(value.probabilities);
  const confidence = probability(value.confidence);
  if (!probabilities || confidence === null) return null;
  if (question.type === "choice") {
    const options = new Set(Object.keys(question.criteria));
    if (typeof value.choice !== "string" || !options.has(value.choice)) return null;
    if (!Object.keys(probabilities).every((option) => options.has(option))) return null;
    return { type: "choice", choice: value.choice, probabilities, confidence };
  }
  const top = question.criteria.length - 1;
  if (typeof value.score !== "number" || !Number.isFinite(value.score)) return null;
  if (value.score < -SCORE_EPSILON || value.score > top + SCORE_EPSILON) return null;
  const levelsInRange = Object.keys(probabilities).every((level) => {
    const index = Number(level);
    return /^\d+$/.test(level) && index >= 0 && index <= top;
  });
  if (!levelsInRange) return null;
  return { type: "score", score: Math.min(top, Math.max(0, value.score)), probabilities, confidence };
};

export const validateDecisionQuestions = (questions: Record<string, DecisionQuestion>): void => {
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new DecisionError("Ask at least one question");
  if (ids.length > MAX_DECISION_QUESTIONS) {
    throw new DecisionError(`Ask at most ${MAX_DECISION_QUESTIONS} questions per request`);
  }
  for (const id of ids) {
    if (!QUESTION_ID.test(id)) throw new DecisionError(`Invalid question id: ${id}`);
    const question = questions[id];
    if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      if (options.length < 2 || options.length > 255) {
        throw new DecisionError(`Question ${id} needs 2 to 255 options`);
      }
    } else if (question.type === "score") {
      if (question.criteria.length < 2 || question.criteria.length > 10) {
        throw new DecisionError(`Question ${id} needs 2 to 10 levels`);
      }
    }
  }
};

const errorMessage = (body: unknown, status: number): string => {
  if (isRecord(body)) {
    const errors = body.errors;
    if (Array.isArray(errors) && errors.length > 0 && isRecord(errors[0]) && typeof errors[0].message === "string") {
      return errors[0].message;
    }
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  }
  if (status === 401 || status === 403) return "The decision model rejected the key";
  if (status === 429) return "The decision model is rate limited";
  return `The decision model failed (${status})`;
};

type RequestPlan = { url: string; headers: Record<string, string>; body: string; envelope: boolean };

const planRequest = (
  model: DecisionModel,
  credentials: DecisionCredentials,
  state: unknown,
  questions: Record<string, DecisionQuestion>,
): RequestPlan => {
  const body = JSON.stringify({ model: model.apiModel, state, questions });
  if (model.provider === "cloudflare") {
    const credential = credentials.cloudflare;
    if (!credential) throw new DecisionError("Add a Cloudflare account ID and token for Clef");
    return {
      url: `${CLOUDFLARE_API}/${encodeURIComponent(credential.accountId)}/ai/run/@cf/cloudflare/${model.apiModel}`,
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body,
      envelope: true,
    };
  }
  const credential = credentials.typesafe;
  if (!credential) throw new DecisionError("Add a TypeSafe API key for Jev");
  return {
    url: TYPESAFE_API,
    headers: { authorization: `Bearer ${credential.apiKey}`, "content-type": "application/json" },
    body,
    envelope: false,
  };
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DecisionError("The decision request was cancelled"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DecisionError("The decision request was cancelled"));
      },
      { once: true },
    );
  });

export type RunDecisionsOptions = {
  model: string;
  credentials: DecisionCredentials;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export const runDecisions = async ({
  model: modelId,
  credentials,
  state,
  questions,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = 3,
  fetchImpl = fetch,
  now = Date.now,
}: RunDecisionsOptions): Promise<DecisionResult> => {
  const model = decisionModel(modelId);
  if (!model) throw new DecisionError(`Unknown decision model: ${modelId}`);
  validateDecisionQuestions(questions);
  const plan = planRequest(model, credentials, state, questions);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const started = now();
  try {
    let lastError: DecisionError | null = null;
    for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt++) {
      if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), controller.signal);
      let response: Response;
      try {
        response = await fetchImpl(plan.url, {
          method: "POST",
          headers: plan.headers,
          body: plan.body,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new DecisionError(signal?.aborted ? "The decision request was cancelled" : "The decision model timed out", null, true);
        }
        lastError = new DecisionError(
          error instanceof Error ? error.message : "Could not reach the decision model",
          null,
          true,
        );
        continue;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
        lastError = new DecisionError(errorMessage(payload, response.status), response.status, retryable);
        if (!retryable) throw lastError;
        continue;
      }
      const result = plan.envelope && isRecord(payload) && "result" in payload ? payload.result : payload;
      if (!isRecord(result) || !isRecord(result.answers)) {
        throw new DecisionError("The decision model returned an unexpected response", response.status);
      }
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, question] of Object.entries(questions)) {
        const answer = parseAnswer(result.answers[id], question);
        if (!answer) throw new DecisionError(`The decision model returned no valid answer for ${id}`, response.status);
        answers[id] = answer;
      }
      const usage = isRecord(result.usage) ? result.usage : {};
      return {
        model: typeof result.model === "string" ? result.model : model.apiModel,
        answers,
        usage: {
          inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        },
        latencyMs: Math.max(0, now() - started),
      };
    }
    throw lastError ?? new DecisionError("The decision model failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
};

export const runDecisionBatches = async (
  options: Omit<RunDecisionsOptions, "questions"> & {
    questions: Record<string, DecisionQuestion>;
    concurrency?: number;
  },
): Promise<Record<string, DecisionAnswer>> => {
  const entries = Object.entries(options.questions);
  const chunks: Record<string, DecisionQuestion>[] = [];
  for (let i = 0; i < entries.length; i += MAX_DECISION_QUESTIONS) {
    chunks.push(Object.fromEntries(entries.slice(i, i + MAX_DECISION_QUESTIONS)));
  }
  const answers: Record<string, DecisionAnswer> = {};
  let cursor = 0;
  const worker = async () => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      const result = await runDecisions({ ...options, questions: chunk });
      Object.assign(answers, result.answers);
    }
  };
  const lanes = Math.max(1, Math.min(options.concurrency ?? 3, chunks.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return answers;
};

export const scoreLevel = (answer: ScoreAnswer): number => {
  let best = 0;
  let bestProbability = -1;
  for (const [level, value] of Object.entries(answer.probabilities)) {
    const index = Number(level);
    if (Number.isInteger(index) && value > bestProbability) {
      best = index;
      bestProbability = value;
    }
  }
  return best;
};
