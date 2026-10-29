import { afterEach, describe, expect, it, vi } from "vitest";
import {
  streamConclaveAssistant,
  ConclaveAssistantApiKeyRequiredError,
  type AssistantToolApproval,
} from "../src/app/lib/conclave-assistant";

const approval: AssistantToolApproval = {
  id: "approval-1",
  tool: "create_github_issue",
  title: "Fix audio recovery",
  body: "## Problem\n\nSome attendees lose audio.",
  token: "signed-approval-token",
};

describe("Conclave assistant tool approval streaming", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends an explicit model selection when using a shared key", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('data: {"type":"done"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    await streamConclaveAssistant({
      answerId: "answer",
      question: "Hello",
      relayToken: "token",
      history: [],
      transcript: "",
      transcriptActive: false,
      model: "claude-haiku-5-5",
      onDelta: vi.fn(),
      onReasoning: vi.fn(),
      onTask: vi.fn(),
      onRelay: vi.fn(),
    });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body)) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body).not.toHaveProperty("apiKey");
  });

  it("preserves a missing-key response's resolved model and provider message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { model: "claude-haiku-5-5", error: "Add an Anthropic key." },
          { status: 428 },
        ),
      ),
    );
    await expect(
      streamConclaveAssistant({
        answerId: "answer",
        question: "Hello",
        relayToken: "token",
        history: [],
        transcript: "",
        transcriptActive: false,
        onDelta: vi.fn(),
        onReasoning: vi.fn(),
        onTask: vi.fn(),
        onRelay: vi.fn(),
      }),
    ).rejects.toMatchObject({
      model: "claude-haiku-5-5",
      message: "Add an Anthropic key.",
    });
  });

  it("reopens personal key setup after a provider authentication rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"type":"error","code":"personal_api_key_rejected","model":"claude-haiku-5-5","error":"Anthropic rejected your key. Replace it to retry."}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    )));
    const request = streamConclaveAssistant({
      answerId: "answer", question: "Hello", relayToken: "token",
      apiKey: "sk-ant-rejected-fixture", model: "claude-haiku-5-5",
      history: [], transcript: "", transcriptActive: false,
      onDelta: vi.fn(), onReasoning: vi.fn(), onTask: vi.fn(), onRelay: vi.fn(),
    });
    await expect(request).rejects.toBeInstanceOf(ConclaveAssistantApiKeyRequiredError);
    await expect(request).rejects.toMatchObject({ model: "claude-haiku-5-5" });
  });

  it("pauses completion when the server requests inline approval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({ type: "approval", approval })}\n\n`,
            {
              headers: { "Content-Type": "text/event-stream" },
            },
          ),
      ),
    );
    const onApproval = vi.fn();
    const onDone = vi.fn();

    const result = await streamConclaveAssistant({
      answerId: "answer-1",
      question: "Create the issue",
      relayToken: "relay-token",
      history: [],
      transcript: "",
      transcriptActive: false,
      onDelta: vi.fn(),
      onReasoning: vi.fn(),
      onTask: vi.fn(),
      onApproval,
      onRelay: vi.fn(),
      onDone,
    });

    expect(result).toEqual({ status: "approval_required", approval });
    expect(onApproval).toHaveBeenCalledWith(approval);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("sends the exact signed approval decision on continuation", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(`data: ${JSON.stringify({ type: "done" })}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    await streamConclaveAssistant({
      answerId: "answer-1",
      question: "Create the issue",
      relayToken: "relay-token",
      history: [],
      transcript: "",
      transcriptActive: false,
      githubIssueApproval: { decision: "approve", approval },
      onDelta: vi.fn(),
      onReasoning: vi.fn(),
      onTask: vi.fn(),
      onRelay: vi.fn(),
    });

    const requestBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(requestBody.supportsToolApproval).toBe(true);
    expect(requestBody.githubIssueApproval).toEqual({
      decision: "approve",
      approval,
    });
  });
});
