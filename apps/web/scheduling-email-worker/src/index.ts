interface Env {
  EMAIL: SendEmail;
  SCHEDULING_EMAIL_WORKER_SECRET?: string;
  SCHEDULING_EMAIL_FROM_EMAIL?: string;
  SCHEDULING_EMAIL_FROM_NAME?: string;
}

type AttachmentInput = {
  filename?: unknown;
  type?: unknown;
  content?: unknown;
};

type MessageInput = {
  to?: unknown;
  replyTo?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  headers?: unknown;
  attachments?: unknown;
};

type EmailAddressValue = {
  email: string;
  name: string;
};

type EmailAttachmentValue = {
  filename: string;
  type: string;
  content: string;
  disposition: "attachment";
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 4;
const MAX_SUBJECT_LENGTH = 180;
const MAX_TEXT_LENGTH = 12000;
const MAX_HTML_LENGTH = 30000;
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 32 * 1024;
const DEFAULT_FROM_EMAIL = "scheduling@conclave.acmvit.in";
const DEFAULT_FROM_NAME = "Conclave Meeting";

const json = (
  body: unknown,
  init: ResponseInit = {},
): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const cleanText = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
};

const cleanEmail = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > 320 ||
    /[\s<>()"';,]/.test(normalized) ||
    !/^[^@]+@[^@]+\.[^@]+$/.test(normalized)
  ) {
    return "";
  }
  return normalized;
};

const parseAddress = (value: unknown): EmailAddressValue | null => {
  if (typeof value === "string") {
    const email = cleanEmail(value);
    return email ? { email, name: email } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { email?: unknown; name?: unknown };
  const email = cleanEmail(record.email);
  if (!email) return null;
  const name = cleanText(record.name, 120);
  return { email, name: name || email };
};

const fromAddress = (env: Env): EmailAddressValue => {
  const email = cleanEmail(env.SCHEDULING_EMAIL_FROM_EMAIL) || DEFAULT_FROM_EMAIL;
  const name = cleanText(env.SCHEDULING_EMAIL_FROM_NAME, 120) || DEFAULT_FROM_NAME;
  return { email, name };
};

const timingSafeEqual = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
};

const bearerToken = (request: Request): string => {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || request.headers.get("x-conclave-email-secret") || "";
};

const isAuthorized = (request: Request, env: Env): boolean => {
  const expected = env.SCHEDULING_EMAIL_WORKER_SECRET?.trim() || "";
  const provided = bearerToken(request).trim();
  return Boolean(expected && provided && timingSafeEqual(provided, expected));
};

const parseHeaders = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) continue;
    const headerValue = cleanText(rawValue, 256);
    if (headerValue) headers[key] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
};

const parseAttachments = (value: unknown): EmailAttachmentValue[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const attachments: EmailAttachmentValue[] = [];
  for (const entry of value.slice(0, MAX_ATTACHMENTS)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as AttachmentInput;
    const filename = cleanText(record.filename, 160).replace(/[\\/]/g, "-");
    const type = cleanText(record.type, 120) || "application/octet-stream";
    const content =
      typeof record.content === "string" ? record.content : "";
    if (!filename || !content || byteLength(content) > MAX_ATTACHMENT_BYTES) {
      continue;
    }
    attachments.push({
      filename,
      type,
      content,
      disposition: "attachment",
    });
  }
  return attachments.length > 0 ? attachments : undefined;
};

const parseMessage = (value: unknown): {
  to: EmailAddressValue;
  replyTo?: EmailAddressValue;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: EmailAttachmentValue[];
} | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as MessageInput;
  const to = parseAddress(record.to);
  const subject = cleanText(record.subject, MAX_SUBJECT_LENGTH);
  const text = typeof record.text === "string" ? record.text.slice(0, MAX_TEXT_LENGTH) : "";
  const html = typeof record.html === "string" ? record.html.slice(0, MAX_HTML_LENGTH) : "";
  if (!to || !subject || (!text && !html)) return null;
  const replyTo = parseAddress(record.replyTo);
  return {
    to,
    ...(replyTo ? { replyTo } : {}),
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
    headers: parseHeaders(record.headers),
    attachments: parseAttachments(record.attachments),
  };
};

const readJsonBody = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (byteLength(text) > MAX_BODY_BYTES) {
    throw new Error("Request body is too large.");
  }
  return JSON.parse(text) as unknown;
};

const sendBookingEmails = async (
  request: Request,
  env: Env,
): Promise<Response> => {
  if (!isAuthorized(request, env)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.EMAIL) {
    return json({ error: "Cloudflare email binding is not configured." }, { status: 503 });
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    return json({ error: (error as Error).message || "Invalid JSON body." }, { status: 400 });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ error: "Invalid email payload." }, { status: 400 });
  }
  const rawMessages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return json({ error: "At least one email message is required." }, { status: 400 });
  }
  if (rawMessages.length > MAX_MESSAGES) {
    return json({ error: "Too many email messages." }, { status: 400 });
  }

  const parsedMessages = rawMessages.map(parseMessage);
  if (parsedMessages.some((message) => !message)) {
    return json({ error: "One or more email messages are invalid." }, { status: 400 });
  }
  const messages = parsedMessages.filter(
    (message): message is NonNullable<ReturnType<typeof parseMessage>> =>
      Boolean(message),
  );

  const from = fromAddress(env);
  const results = [];
  for (const message of messages) {
    const result = await env.EMAIL.send({
      from,
      to: message.to,
      subject: message.subject,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.text ? { text: message.text } : {}),
      ...(message.html ? { html: message.html } : {}),
      ...(message.headers ? { headers: message.headers } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
    });
    results.push({
      to: message.to.email,
      messageId: result.messageId,
    });
  }

  return json({ ok: true, results });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "conclave-scheduling-email" });
    }
    if (url.pathname !== "/send-booking") {
      return json({ error: "Not found" }, { status: 404 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
        },
      });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, { status: 405 });
    }
    return sendBookingEmails(request, env);
  },
} satisfies ExportedHandler<Env>;
