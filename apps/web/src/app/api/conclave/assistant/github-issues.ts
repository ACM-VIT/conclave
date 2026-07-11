const DEFAULT_GITHUB_REPOSITORY = "ACM-VIT/conclave";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_ISSUE_TITLE_LENGTH = 180;
const MAX_ISSUE_BODY_LENGTH = 60_000;
const EXPLICIT_ISSUE_ACTION_PATTERN =
  /\b(?:open|create|file|submit|raise|publish|post|make|log)\b[\s\S]{0,80}\b(?:github\s+)?(?:issue|bug\s+report|feature\s+request)\b/i;
const TURN_INTO_ISSUE_PATTERN =
  /\bturn\b[\s\S]{0,80}\binto\b[\s\S]{0,30}\b(?:github\s+)?issue\b/i;
const REPORT_ON_GITHUB_PATTERN =
  /\breport\b[\s\S]{0,50}\b(?:bug|issue)\b[\s\S]{0,50}\b(?:on|to)\s+github\b/i;
const NEGATED_ISSUE_ACTION_PATTERN =
  /\b(?:do\s+not|don't|dont|never)\b[\s\S]{0,24}\b(?:open|create|file|submit|raise|publish|post|make|log)\b/i;
const ISSUE_INSTRUCTIONS_PATTERN =
  /\b(?:how|where|when)\s+(?:(?:do|can|should)\s+(?:i|we|you)\s+|to\s+)(?:open|create|file|submit|raise|post|make|log)\b/i;

export type GithubIssueType =
  | "bug_report"
  | "feature_request"
  | "documentation"
  | "other";

export interface GithubIssueDraft {
  issueType: GithubIssueType;
  title: string;
  overview: string;
  details: string;
  reproductionSteps: string[] | null;
  expectedBehavior: string | null;
  actualBehavior: string | null;
  acceptanceCriteria: string[] | null;
  additionalContext: string | null;
}

export interface GithubIssueResult {
  number: number;
  title: string;
  url: string;
  repository: string;
}

interface GithubIssuesConfig {
  token: string;
  repository: string;
}

interface GithubIssueApiResponse {
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  message?: unknown;
}

const ISSUE_TYPE_META: Record<
  GithubIssueType,
  { label: string | null; displayName: string }
> = {
  bug_report: { label: "bug", displayName: "Bug report" },
  feature_request: { label: "enhancement", displayName: "Feature request" },
  documentation: { label: "documentation", displayName: "Documentation" },
  other: { label: null, displayName: "General" },
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeOptionalString = (value: unknown): string | null =>
  isNonEmptyString(value) ? value.trim() : null;

const normalizeStringList = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter(isNonEmptyString)
    .map((item) => item.trim())
    .slice(0, 20);
  return items.length > 0 ? items : null;
};

// Tool descriptions guide the model, while this check is the server-side
// backstop that prevents chat history or a mistaken tool call from causing a
// write. The current participant's request must contain an explicit action.
export const isExplicitGithubIssueRequest = (question: string): boolean =>
  !NEGATED_ISSUE_ACTION_PATTERN.test(question) &&
  !ISSUE_INSTRUCTIONS_PATTERN.test(question) &&
  (EXPLICIT_ISSUE_ACTION_PATTERN.test(question) ||
    TURN_INTO_ISSUE_PATTERN.test(question) ||
    REPORT_ON_GITHUB_PATTERN.test(question));

export const parseGithubIssueDraft = (argumentsJson: string): GithubIssueDraft => {
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson);
  } catch {
    throw new Error("The GitHub issue details were not valid JSON.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The GitHub issue details were not an object.");
  }

  const input = value as Record<string, unknown>;
  const issueType = input.issue_type;
  if (
    issueType !== "bug_report" &&
    issueType !== "feature_request" &&
    issueType !== "documentation" &&
    issueType !== "other"
  ) {
    throw new Error("Choose a valid GitHub issue type.");
  }
  if (!isNonEmptyString(input.title)) {
    throw new Error("A GitHub issue title is required.");
  }
  if (!isNonEmptyString(input.overview)) {
    throw new Error("A GitHub issue overview is required.");
  }
  if (!isNonEmptyString(input.details)) {
    throw new Error("Detailed GitHub issue context is required.");
  }

  return {
    issueType,
    title: input.title.trim().slice(0, MAX_ISSUE_TITLE_LENGTH),
    overview: input.overview.trim(),
    details: input.details.trim(),
    reproductionSteps: normalizeStringList(input.reproduction_steps),
    expectedBehavior: normalizeOptionalString(input.expected_behavior),
    actualBehavior: normalizeOptionalString(input.actual_behavior),
    acceptanceCriteria: normalizeStringList(input.acceptance_criteria),
    additionalContext: normalizeOptionalString(input.additional_context),
  };
};

const numberList = (items: string[]): string =>
  items.map((item, index) => `${index + 1}. ${item}`).join("\n");

const checklist = (items: string[]): string =>
  items.map((item) => `- [ ] ${item}`).join("\n");

export const formatGithubIssueBody = (draft: GithubIssueDraft): string => {
  const sections = [
    `## Overview\n\n${draft.overview}`,
    `## Issue type\n\n${ISSUE_TYPE_META[draft.issueType].displayName}`,
    `## Details\n\n${draft.details}`,
  ];

  if (draft.reproductionSteps) {
    sections.push(
      `## Steps to reproduce\n\n${numberList(draft.reproductionSteps)}`,
    );
  }
  if (draft.expectedBehavior) {
    sections.push(`## Expected behavior\n\n${draft.expectedBehavior}`);
  }
  if (draft.actualBehavior) {
    sections.push(`## Actual behavior\n\n${draft.actualBehavior}`);
  }
  if (draft.acceptanceCriteria) {
    sections.push(
      `## Acceptance criteria\n\n${checklist(draft.acceptanceCriteria)}`,
    );
  }
  if (draft.additionalContext) {
    sections.push(`## Additional context\n\n${draft.additionalContext}`);
  }

  sections.push("_Created by the Conclave in-meeting assistant._");
  return sections.join("\n\n").slice(0, MAX_ISSUE_BODY_LENGTH);
};

export const resolveGithubIssuesConfig = (
  env: NodeJS.ProcessEnv = process.env,
): GithubIssuesConfig => {
  const token = env.GITHUB_ISSUES_TOKEN?.trim() || "";
  const repository =
    env.GITHUB_ISSUES_REPOSITORY?.trim() || DEFAULT_GITHUB_REPOSITORY;

  if (!token) {
    throw new Error(
      "GitHub issue creation is not configured. Set GITHUB_ISSUES_TOKEN on the web server.",
    );
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(
      "GITHUB_ISSUES_REPOSITORY must use the owner/repository format.",
    );
  }

  return { token, repository };
};

const githubErrorMessage = async (response: Response): Promise<string> => {
  try {
    const data = (await response.json()) as GithubIssueApiResponse;
    return isNonEmptyString(data.message)
      ? data.message
      : `GitHub returned ${response.status}.`;
  } catch {
    return `GitHub returned ${response.status}.`;
  }
};

export const createGithubIssue = async (
  draft: GithubIssueDraft,
  options: {
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
  } = {},
): Promise<GithubIssueResult> => {
  const { token, repository } = resolveGithubIssuesConfig(options.env);
  const fetcher = options.fetcher ?? fetch;
  const endpoint = `https://api.github.com/repos/${repository}/issues`;
  const label = ISSUE_TYPE_META[draft.issueType].label;
  const basePayload = {
    title: draft.title,
    body: formatGithubIssueBody(draft),
  };

  const request = (withLabel: boolean): Promise<Response> =>
    fetcher(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "conclave-assistant",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({
        ...basePayload,
        ...(withLabel && label ? { labels: [label] } : {}),
      }),
    });

  let response = await request(Boolean(label));
  // Custom repositories do not always have GitHub's default labels. A 422 is
  // safe to retry because GitHub did not create an issue for that response.
  if (response.status === 422 && label) {
    response = await request(false);
  }
  if (!response.ok) {
    throw new Error(
      `GitHub issue creation failed: ${await githubErrorMessage(response)}`,
    );
  }

  const data = (await response.json()) as GithubIssueApiResponse;
  if (
    typeof data.number !== "number" ||
    !isNonEmptyString(data.title) ||
    !isNonEmptyString(data.html_url)
  ) {
    throw new Error("GitHub created the issue but returned an invalid response.");
  }

  return {
    number: data.number,
    title: data.title,
    url: data.html_url,
    repository,
  };
};
