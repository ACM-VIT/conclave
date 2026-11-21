export interface CspViolation {
  disposition: string;
  directive: string;
  blocked: string;
  document: string;
  source: string;
  line: number | null;
  column: number | null;
  sample: string;
}

type ReportFields = Record<string, unknown>;

const MAX_FIELD_LENGTH = 200;
const MAX_SAMPLE_LENGTH = 40;

const asRecord = (value: unknown): ReportFields | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ReportFields)
    : null;

const text = (value: unknown, maxLength = MAX_FIELD_LENGTH): string =>
  typeof value === "string" ? value.slice(0, maxLength) : "";

const position = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/** Keep the origin and path only: query strings can carry tokens and room secrets. */
const withoutQuery = (value: unknown): string => {
  const raw = text(value, 2048);
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, MAX_FIELD_LENGTH);
  } catch {
    return raw.slice(0, MAX_FIELD_LENGTH);
  }
};

const fromReport = (report: ReportFields): CspViolation => ({
  disposition: text(report.disposition),
  directive: text(report["effective-directive"]) || text(report["violated-directive"]),
  blocked: withoutQuery(report["blocked-uri"]),
  document: withoutQuery(report["document-uri"]),
  source: withoutQuery(report["source-file"]),
  line: position(report["line-number"]),
  column: position(report["column-number"]),
  sample: text(report["script-sample"], MAX_SAMPLE_LENGTH),
});

/** Parses the `{"csp-report": {...}}` body a `report-uri` directive posts. */
export const parseCspReport = (payload: unknown): CspViolation | null => {
  const report = asRecord(asRecord(payload)?.["csp-report"]);
  return report ? fromReport(report) : null;
};
