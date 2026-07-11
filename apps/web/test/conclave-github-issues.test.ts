import { describe, expect, it } from "vitest";
import {
  createGithubIssue,
  formatGithubIssueBody,
  isExplicitGithubIssueRequest,
  parseGithubIssueDraft,
  resolveGithubIssuesConfig,
  type GithubIssueDraft,
} from "../src/app/api/conclave/assistant/github-issues";

const bugDraft: GithubIssueDraft = {
  issueType: "bug_report",
  title: "Chat freezes after reconnecting to a meeting",
  overview: "The meeting chat stops accepting input after a reconnect.",
  details:
    "This affects participants whose network briefly disconnects while the chat dock is open.",
  reproductionSteps: [
    "Join a meeting and open chat.",
    "Disconnect and reconnect the network.",
    "Try to send a chat message.",
  ],
  expectedBehavior: "The message is sent after the meeting reconnects.",
  actualBehavior: "The composer remains disabled.",
  acceptanceCriteria: [
    "The composer is enabled after reconnecting.",
    "Queued messages are not duplicated.",
  ],
  additionalContext: "Seen in the web client.",
};

describe("Conclave GitHub issues", () => {
  it("requires an explicit issue-creation action in the current request", () => {
    expect(
      isExplicitGithubIssueRequest(
        "Open a GitHub issue for the reconnect bug we discussed.",
      ),
    ).toBe(true);
    expect(
      isExplicitGithubIssueRequest(
        "File a detailed feature request for templates.",
      ),
    ).toBe(true);
    expect(
      isExplicitGithubIssueRequest("Turn this into an issue on GitHub."),
    ).toBe(true);
    expect(
      isExplicitGithubIssueRequest("This sounds like a bug we should fix."),
    ).toBe(false);
    expect(
      isExplicitGithubIssueRequest("Draft a GitHub issue, but do not create it."),
    ).toBe(false);
    expect(
      isExplicitGithubIssueRequest(
        "Do not open a GitHub issue; just summarize it.",
      ),
    ).toBe(false);
    expect(isExplicitGithubIssueRequest("How do I open a GitHub issue?")).toBe(
      false,
    );
  });

  it("parses structured tool arguments and normalizes empty optional fields", () => {
    const draft = parseGithubIssueDraft(
      JSON.stringify({
        issue_type: "feature_request",
        title: "  Add meeting templates  ",
        overview: "Let hosts start from reusable settings.",
        details: "Templates should capture room settings, not participant data.",
        reproduction_steps: null,
        expected_behavior: "",
        actual_behavior: null,
        acceptance_criteria: [
          "Hosts can save a template",
          "  Templates can be renamed  ",
        ],
        additional_context: null,
      }),
    );

    expect(draft).toEqual({
      issueType: "feature_request",
      title: "Add meeting templates",
      overview: "Let hosts start from reusable settings.",
      details: "Templates should capture room settings, not participant data.",
      reproductionSteps: null,
      expectedBehavior: null,
      actualBehavior: null,
      acceptanceCriteria: [
        "Hosts can save a template",
        "Templates can be renamed",
      ],
      additionalContext: null,
    });
  });

  it("formats a detailed bug report with ordered steps and checkboxes", () => {
    const body = formatGithubIssueBody(bugDraft);

    expect(body).toContain("## Overview\n\nThe meeting chat stops");
    expect(body).toContain("## Issue type\n\nBug report");
    expect(body).toContain("1. Join a meeting and open chat.");
    expect(body).toContain("## Expected behavior");
    expect(body).toContain("## Actual behavior");
    expect(body).toContain("- [ ] The composer is enabled after reconnecting.");
    expect(body).toContain("_Created by the Conclave in-meeting assistant._");
  });

  it("creates the issue with server credentials and the default bug label", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ input: String(input), init });
      return Response.json({
        number: 42,
        title: bugDraft.title,
        html_url: "https://github.com/ACM-VIT/conclave/issues/42",
      });
    }) as typeof fetch;

    const result = await createGithubIssue(bugDraft, {
      env: { GITHUB_ISSUES_TOKEN: "secret-token" },
      fetcher,
    });

    expect(result).toEqual({
      number: 42,
      title: bugDraft.title,
      url: "https://github.com/ACM-VIT/conclave/issues/42",
      repository: "ACM-VIT/conclave",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe(
      "https://api.github.com/repos/ACM-VIT/conclave/issues",
    );
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer secret-token",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      title: bugDraft.title,
      labels: ["bug"],
    });
  });

  it("retries without a default label when a repository rejects it", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      if (requestBodies.length === 1) {
        return Response.json({ message: "Validation Failed" }, { status: 422 });
      }
      return Response.json({
        number: 7,
        title: bugDraft.title,
        html_url: "https://github.com/example/project/issues/7",
      });
    }) as typeof fetch;

    await createGithubIssue(bugDraft, {
      env: {
        GITHUB_ISSUES_TOKEN: "secret-token",
        GITHUB_ISSUES_REPOSITORY: "example/project",
      },
      fetcher,
    });

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.labels).toEqual(["bug"]);
    expect(requestBodies[1]?.labels).toBeUndefined();
  });

  it("requires server-side GitHub configuration", () => {
    expect(() => resolveGithubIssuesConfig({})).toThrow(
      "Set GITHUB_ISSUES_TOKEN",
    );
    expect(() =>
      resolveGithubIssuesConfig({
        GITHUB_ISSUES_TOKEN: "token",
        GITHUB_ISSUES_REPOSITORY: "not-a-repository",
      }),
    ).toThrow("owner/repository");
  });
});
