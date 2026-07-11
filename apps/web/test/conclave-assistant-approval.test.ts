import { afterEach, describe, expect, it, vi } from "vitest";
import {
  streamConclaveAssistant,
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

  it("pauses completion when the server requests inline approval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
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
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        `data: ${JSON.stringify({ type: "done" })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
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
