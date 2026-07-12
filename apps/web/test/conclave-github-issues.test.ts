import { describe, expect, it } from "vitest";
import {
  appendGithubIssueRequesterAttribution,
  createGithubIssue,
  parseGithubIssueDraft,
  resolveGithubIssuesConfig,
  type GithubIssueDraft,
} from "../src/app/api/conclave/assistant/github-issues";
import {
  createGithubIssueApproval,
  verifyGithubIssueApproval,
  type GithubIssueApprovalIdentity,
} from "../src/app/api/conclave/assistant/route";

const issueDraft: GithubIssueDraft = {
  title: "Add per-message copy action",
  body: [
    "## Overview",
    "",
    "Add a copy action to each chat message, positioned alongside Reply.",
    "",
    "## Expected behavior",
    "",
    "Selecting Copy places that message's text on the clipboard.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] Copy is available for every text message.",
    "- [ ] The action provides visible success feedback.",
  ].join("\n"),
};

const approvalIdentity: GithubIssueApprovalIdentity = {
  answerId: "answer-1",
  questionMessageId: "question-1",
  userId: "user-1",
  roomId: "room-1",
  clientId: "client-1",
  channelId: "room:room-1",
};

describe("Conclave GitHub issues", () => {
  it("accepts a complete model-authored title and Markdown body", () => {
    const draft = parseGithubIssueDraft(
      JSON.stringify({
        title: "  Add meeting templates  ",
        body: "  ## Overview\n\nLet hosts reuse meeting settings.  ",
      }),
    );

    expect(draft).toEqual({
      title: "Add meeting templates",
      body: "## Overview\n\nLet hosts reuse meeting settings.",
    });
  });

  it("rejects malformed or incomplete tool output", () => {
    expect(() => parseGithubIssueDraft("not json")).toThrow("valid JSON");
    expect(() =>
      parseGithubIssueDraft(JSON.stringify({ title: "Missing body" })),
    ).toThrow("body is required");
  });

  it("creates exactly the issue authored by the model", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ input: String(input), init });
      return Response.json({
        number: 42,
        title: issueDraft.title,
        html_url: "https://github.com/ACM-VIT/conclave/issues/42",
      });
    }) as typeof fetch;

    const result = await createGithubIssue(issueDraft, {
      env: { GITHUB_ISSUES_TOKEN: "secret-token" },
      fetcher,
    });

    expect(result).toEqual({
      number: 42,
      title: issueDraft.title,
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
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(issueDraft);
  });

  it("binds approval to the exact issue draft and requester", () => {
    const approval = createGithubIssueApproval(issueDraft, approvalIdentity);

    expect(verifyGithubIssueApproval(approval, approvalIdentity)?.draft).toEqual(
      issueDraft,
    );
    expect(
      verifyGithubIssueApproval(
        { ...approval, title: "A tampered title" },
        approvalIdentity,
      ),
    ).toBeNull();
    expect(
      verifyGithubIssueApproval(approval, {
        ...approvalIdentity,
        userId: "different-user",
      }),
    ).toBeNull();
  });

  it("appends who requested the issue, sanitized to a single line", () => {
    const attributed = appendGithubIssueRequesterAttribution(
      issueDraft,
      "Prakhar Joshi",
    );
    expect(attributed.title).toBe(issueDraft.title);
    expect(attributed.body).toBe(
      `${issueDraft.body}\n\n---\nRequested by **Prakhar Joshi** during a Conclave meeting.`,
    );

    const withInjectedLines = appendGithubIssueRequesterAttribution(
      issueDraft,
      "Sneaky\n\n## Injected heading",
    );
    expect(withInjectedLines.body).toContain(
      "Requested by **Sneaky ## Injected heading** during a Conclave meeting.",
    );

    const withMissingName = appendGithubIssueRequesterAttribution(
      issueDraft,
      "   ",
    );
    expect(withMissingName.body).toContain(
      "Requested by **a meeting participant** during a Conclave meeting.",
    );
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
