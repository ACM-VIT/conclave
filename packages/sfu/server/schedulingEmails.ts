import type {
  ScheduledMeeting,
  ScheduledMeetingEmailNotificationStatus,
  SchedulingEventType,
  SchedulingProfile,
} from "../types.js";
import { Logger } from "../utilities/loggers.js";
import {
  renderSchedulingEmail,
  type SchedulingEmailRow,
} from "./email/schedulingTemplates.js";
import { buildSchedulingMeetingLink } from "./schedulingLinks.js";

type SchedulingEmailAddress = {
  email: string;
  name?: string;
};

type SchedulingEmailAttachment = {
  filename: string;
  type: string;
  content: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
};

type SchedulingEmailMessage = {
  to: SchedulingEmailAddress;
  replyTo?: SchedulingEmailAddress;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
  attachments?: SchedulingEmailAttachment[];
};

type SchedulingEmailConfig = {
  workerUrl: string;
  secret: string;
};

export type SchedulingEmailDeliveryResult = {
  status: ScheduledMeetingEmailNotificationStatus;
  error: string | null;
  sentAt: number | null;
};

const MAX_EMAIL_WORKER_BODY_BYTES = 64 * 1024;
const DEFAULT_EMAIL_TIMEOUT_MS = 8000;

const cleanText = (value: string | null | undefined): string =>
  (value || "").trim().replace(/\s+/g, " ");

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? value.slice(0, maxLength) : value;

const emailAddress = (
  email: string | null | undefined,
  name?: string | null,
): SchedulingEmailAddress | null => {
  const normalized = cleanText(email).toLowerCase();
  if (!normalized || !normalized.includes("@") || normalized.length > 320) {
    return null;
  }
  const displayName = truncate(cleanText(name), 120);
  return displayName
    ? { email: normalized, name: displayName }
    : { email: normalized };
};

const formatEmailTime = (timestamp: number, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(timestamp);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(timestamp);
  }
};

type SchedulingDateParts = {
  weekday: string;
  day: string;
  month: string;
  time: string;
  timeZone: string;
};

const formatEmailDateParts = (
  timestamp: number,
  timeZone: string,
): SchedulingDateParts => {
  const build = (zone: string): SchedulingDateParts => {
    const part = (options: Intl.DateTimeFormatOptions): string =>
      new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options }).format(
        timestamp,
      );
    const tzParts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      timeZoneName: "short",
    }).formatToParts(timestamp);
    return {
      weekday: part({ weekday: "long" }),
      day: part({ day: "numeric" }),
      month: part({ month: "short" }).toUpperCase(),
      time: part({ hour: "numeric", minute: "2-digit" }),
      timeZone:
        tzParts.find((entry) => entry.type === "timeZoneName")?.value || "",
    };
  };
  try {
    return build(timeZone);
  } catch {
    return build("UTC");
  }
};

const formatDuration = (meeting: ScheduledMeeting): string => {
  const minutes = Math.max(
    1,
    Math.round((meeting.scheduledEndAt - meeting.scheduledStartAt) / 60000),
  );
  return `${minutes} min`;
};

const calendarSyncLabel = (meeting: ScheduledMeeting): string => {
  switch (meeting.calendarSyncStatus) {
    case "synced":
      return "Synced to Google Calendar";
    case "pending":
      return "Google Calendar sync pending";
    case "failed":
      return `Google Calendar sync failed${
        meeting.calendarSyncError ? `: ${meeting.calendarSyncError}` : ""
      }`;
    case "not_required":
    case undefined:
      return "Google Calendar sync not required";
  }
};

const formatIcsDate = (timestamp: number): string =>
  new Date(timestamp)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

const escapeIcsText = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");

const escapeIcsParam = (value: string): string =>
  `"${cleanText(value).replace(/"/g, "'")}"`;

const foldIcsLine = (line: string): string => {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 75) {
    parts.push(rest.slice(0, 75));
    rest = ` ${rest.slice(75)}`;
  }
  parts.push(rest);
  return parts.join("\r\n");
};

const buildIcsContent = (input: {
  meeting: ScheduledMeeting;
  meetingLink: string;
  attendeeName: string;
  attendeeEmail: string;
}): string => {
  const hostName = cleanText(input.meeting.hostName) || "Conclave host";
  const description = [
    `Join Conclave: ${input.meetingLink}`,
    input.meeting.attendeeNote ? `Note: ${input.meeting.attendeeNote}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Conclave//Scheduling//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${input.meeting.id}@conclave`,
    `DTSTAMP:${formatIcsDate(Date.now())}`,
    `DTSTART:${formatIcsDate(input.meeting.scheduledStartAt)}`,
    `DTEND:${formatIcsDate(input.meeting.scheduledEndAt)}`,
    `SUMMARY:${escapeIcsText(input.meeting.title)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `LOCATION:${escapeIcsText(input.meetingLink)}`,
    `ORGANIZER;CN=${escapeIcsParam(hostName)}:mailto:${
      input.meeting.hostEmail
    }`,
    `ATTENDEE;CN=${escapeIcsParam(
      input.attendeeName,
    )};ROLE=REQ-PARTICIPANT:mailto:${input.attendeeEmail}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
};

const buildIcsAttachment = (input: {
  meeting: ScheduledMeeting;
  meetingLink: string;
  attendeeName: string;
  attendeeEmail: string;
}): SchedulingEmailAttachment => ({
  filename: "conclave-booking.ics",
  type: "text/calendar; method=PUBLISH; charset=UTF-8",
  disposition: "attachment",
  content: buildIcsContent(input),
});

type SchedulingEmailInput = {
  profile: SchedulingProfile;
  eventType: SchedulingEventType;
  meeting: ScheduledMeeting;
  appOrigin: string;
  calendarError?: string | null;
};

type SchedulingEmailPurpose = "confirmation" | "reminder";

const baseDisclaimer =
  "You're receiving this email because a Conclave meeting was scheduled with this address. If this wasn't you, you can ignore it.";

const buildSchedulingEmailMessages = async (
  input: SchedulingEmailInput,
  purpose: SchedulingEmailPurpose,
): Promise<SchedulingEmailMessage[]> => {
  const host = emailAddress(input.profile.email, input.profile.name);
  const attendee = emailAddress(
    input.meeting.attendeeEmail,
    input.meeting.attendeeName,
  );
  if (!host || !attendee) return [];

  const attendeeName = cleanText(input.meeting.attendeeName) || "Guest";
  const hostName =
    cleanText(input.profile.name) || cleanText(input.meeting.hostName) || "Host";
  const meetingLink = buildSchedulingMeetingLink(input.appOrigin, input.meeting);
  const hostTime = formatEmailTime(
    input.meeting.scheduledStartAt,
    input.profile.timeZone,
  );
  const attendeeTime = formatEmailTime(
    input.meeting.scheduledStartAt,
    input.meeting.attendeeTimeZone || input.profile.timeZone,
  );
  const attendeeWhen = formatEmailDateParts(
    input.meeting.scheduledStartAt,
    input.meeting.attendeeTimeZone || input.profile.timeZone,
  );
  const hostWhen = formatEmailDateParts(
    input.meeting.scheduledStartAt,
    input.profile.timeZone,
  );
  const duration = formatDuration(input.meeting);
  const calendarStatus = input.calendarError
    ? `Google Calendar sync failed: ${input.calendarError}`
    : calendarSyncLabel(input.meeting);
  const note = cleanText(input.meeting.attendeeNote);
  const attendeeRows: SchedulingEmailRow[] = [
    { label: "Host", value: `${hostName} <${host.email}>` },
  ];
  const hostRows: SchedulingEmailRow[] = [
    { label: "Guest", value: `${attendeeName} <${attendee.email}>` },
  ];
  if (purpose === "confirmation") {
    hostRows.push({ label: "Calendar", value: calendarStatus });
  }
  if (note) {
    hostRows.push({ label: "Note", value: note });
  }

  const attendeeCopy =
    purpose === "reminder"
      ? {
          subject: `Reminder: ${input.eventType.title} starts soon`,
          preview: `${input.eventType.title} starts at ${attendeeTime}.`,
          heading: "Your meeting starts soon",
          intro: `Your Conclave meeting with ${hostName} is coming up. Join from the room link when you are ready.`,
        }
      : {
          subject: `You're booked: ${input.eventType.title}`,
          preview: `${input.eventType.title} is booked for ${attendeeTime}.`,
          heading: "You're booked",
          intro: `Your Conclave meeting with ${hostName} is confirmed.`,
        };
  const hostCopy =
    purpose === "reminder"
      ? {
          subject: `Upcoming booking: ${attendeeName} for ${input.eventType.title}`,
          preview: `${attendeeName}'s booking starts at ${hostTime}.`,
          heading: "Upcoming booking",
          intro: `${attendeeName}'s Conclave booking starts soon.`,
        }
      : {
          subject: `New booking: ${attendeeName} for ${input.eventType.title}`,
          preview: `${attendeeName} booked ${input.eventType.title} for ${hostTime}.`,
          heading: "New booking",
          intro: `${attendeeName} booked a Conclave meeting with you.`,
        };

  const [attendeeEmail, hostEmail] = await Promise.all([
    renderSchedulingEmail({
      preview: attendeeCopy.preview,
      heading: attendeeCopy.heading,
      intro: attendeeCopy.intro,
      eventTitle: input.eventType.title,
      when: attendeeWhen,
      durationLabel: duration,
      rows: attendeeRows,
      meetingLink,
      ctaLabel: "Join the room",
      disclaimer: baseDisclaimer,
    }),
    renderSchedulingEmail({
      preview: hostCopy.preview,
      heading: hostCopy.heading,
      intro: hostCopy.intro,
      eventTitle: input.eventType.title,
      when: hostWhen,
      durationLabel: duration,
      rows: hostRows,
      meetingLink,
      ctaLabel: "Join the room",
      disclaimer: baseDisclaimer,
    }),
  ]);

  const icsAttachment =
    purpose === "confirmation"
      ? buildIcsAttachment({
          meeting: input.meeting,
          meetingLink,
          attendeeName,
          attendeeEmail: attendee.email,
        })
      : null;

  const sameRecipient = attendee.email === host.email;
  const attendeeMessage: SchedulingEmailMessage = {
    to: attendee,
    ...(sameRecipient ? {} : { replyTo: host }),
    subject: attendeeCopy.subject,
    text: attendeeEmail.text,
    html: attendeeEmail.html,
    headers: {
      "X-Conclave-Email-Type":
        purpose === "reminder"
          ? "booking-attendee-reminder"
          : "booking-attendee-confirmation",
      "X-Conclave-Meeting-Id": input.meeting.id,
    },
    ...(icsAttachment ? { attachments: [icsAttachment] } : {}),
  };
  if (sameRecipient) return [attendeeMessage];

  return [
    attendeeMessage,
    {
      to: host,
      replyTo: attendee,
      subject: hostCopy.subject,
      text: hostEmail.text,
      html: hostEmail.html,
      headers: {
        "X-Conclave-Email-Type":
          purpose === "reminder"
            ? "booking-host-reminder"
            : "booking-host-notification",
        "X-Conclave-Meeting-Id": input.meeting.id,
      },
      ...(icsAttachment ? { attachments: [icsAttachment] } : {}),
    },
  ];
};

export const buildSchedulingBookingEmailMessages = (
  input: SchedulingEmailInput,
): Promise<SchedulingEmailMessage[]> =>
  buildSchedulingEmailMessages(input, "confirmation");

export const buildSchedulingReminderEmailMessages = (
  input: SchedulingEmailInput,
): Promise<SchedulingEmailMessage[]> =>
  buildSchedulingEmailMessages(input, "reminder");

export const resolveSchedulingEmailConfig = (): SchedulingEmailConfig | null => {
  const enabled = process.env.SCHEDULING_EMAIL_ENABLED?.trim().toLowerCase();
  if (enabled === "0" || enabled === "false" || enabled === "off") {
    return null;
  }
  const workerUrl =
    process.env.SCHEDULING_EMAIL_WORKER_URL?.trim() ||
    process.env.CLOUDFLARE_EMAIL_WORKER_URL?.trim() ||
    "";
  const secret =
    process.env.SCHEDULING_EMAIL_WORKER_SECRET?.trim() ||
    process.env.CLOUDFLARE_EMAIL_WORKER_SECRET?.trim() ||
    "";
  if (!workerUrl || !secret) return null;
  const normalizedWorkerUrl = workerUrl.replace(/\/$/, "");
  return {
    workerUrl: normalizedWorkerUrl.endsWith("/send-booking")
      ? normalizedWorkerUrl
      : `${normalizedWorkerUrl}/send-booking`,
    secret,
  };
};

export const isSchedulingEmailConfigured = (): boolean =>
  Boolean(resolveSchedulingEmailConfig());

const emailTimeoutMs = (): number => {
  const configured = Number(process.env.SCHEDULING_EMAIL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_EMAIL_TIMEOUT_MS;
};

const sendSchedulingEmailMessages = async (
  messages: SchedulingEmailMessage[],
): Promise<SchedulingEmailDeliveryResult> => {
  const config = resolveSchedulingEmailConfig();
  if (!config) {
    return { status: "not_configured", error: null, sentAt: null };
  }

  if (messages.length === 0) {
    return {
      status: "failed",
      error: "Booking email recipients are invalid.",
      sentAt: null,
    };
  }

  const body = JSON.stringify({ messages });
  if (Buffer.byteLength(body, "utf8") > MAX_EMAIL_WORKER_BODY_BYTES) {
    return {
      status: "failed",
      error: "Booking email payload is too large.",
      sentAt: null,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), emailTimeoutMs());
  try {
    const response = await fetch(config.workerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.secret}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        data && typeof data === "object" && "error" in data
          ? String((data as { error?: unknown }).error || response.statusText)
          : response.statusText || "Scheduling email worker request failed.";
      throw new Error(message);
    }
    return { status: "sent", error: null, sentAt: Date.now() };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Scheduling email worker timed out."
        : (error as Error).message || "Scheduling email delivery failed.";
    Logger.warn("Scheduling email delivery failed", error);
    return { status: "failed", error: message, sentAt: null };
  } finally {
    clearTimeout(timeout);
  }
};

export const sendSchedulingBookingEmails = async (
  input: SchedulingEmailInput,
): Promise<SchedulingEmailDeliveryResult> => {
  if (!resolveSchedulingEmailConfig()) {
    return { status: "not_configured", error: null, sentAt: null };
  }
  const messages = await buildSchedulingBookingEmailMessages(input);
  return sendSchedulingEmailMessages(messages);
};

export const sendSchedulingReminderEmails = async (
  input: SchedulingEmailInput,
): Promise<SchedulingEmailDeliveryResult> => {
  if (!resolveSchedulingEmailConfig()) {
    return { status: "not_configured", error: null, sentAt: null };
  }
  const messages = await buildSchedulingReminderEmailMessages(input);
  return sendSchedulingEmailMessages(messages);
};
