const DEFAULT_GITHUB_REPOSITORY = "ACM-VIT/conclave";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_ISSUE_TITLE_LENGTH = 180;
const MAX_ISSUE_BODY_LENGTH = 60_000;

export interface GithubIssueDraft {
  title: string;
  body: string;
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

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const MAX_REQUESTER_NAME_LENGTH = 120;

export const appendGithubIssueRequesterAttribution = (
  draft: GithubIssueDraft,
  requesterDisplayName: string,
): GithubIssueDraft => {
  const name =
    requesterDisplayName.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_REQUESTER_NAME_LENGTH) ||
    "a meeting participant";
  const attribution = `\n\n---\nRequested by **${name}** during a Conclave meeting.`;
  return {
    title: draft.title,
    body: `${draft.body}${attribution}`.slice(0, MAX_ISSUE_BODY_LENGTH),
  };
};

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
  if (!isNonEmptyString(input.title)) {
    throw new Error("A GitHub issue title is required.");
  }
  if (!isNonEmptyString(input.body)) {
    throw new Error("A detailed GitHub issue body is required.");
  }

  return {
    title: input.title.trim().slice(0, MAX_ISSUE_TITLE_LENGTH),
    body: input.body.trim().slice(0, MAX_ISSUE_BODY_LENGTH),
  };
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
  const response = await fetcher(
    `https://api.github.com/repos/${repository}/issues`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "conclave-assistant",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify(draft),
    },
  );

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
