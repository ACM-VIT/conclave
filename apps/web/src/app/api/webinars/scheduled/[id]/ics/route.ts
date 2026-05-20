import { NextResponse } from "next/server";
import {
  buildScheduledWebinarHeaders,
  requireSfuSessionUser,
  resolveScheduledWebinarsBase,
} from "@/lib/sfu-user-auth";
import type { ScheduledWebinar } from "@/lib/scheduled-webinars";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const escapeIcs = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");

const formatIcsDate = (timestamp: number): string => {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}` +
    `${pad(d.getUTCMonth() + 1)}` +
    `${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}` +
    `${pad(d.getUTCMinutes())}` +
    `${pad(d.getUTCSeconds())}Z`
  );
};

const buildIcs = (webinar: ScheduledWebinar): string => {
  const dtStart = formatIcsDate(webinar.scheduledStartAt);
  const dtEnd = formatIcsDate(webinar.scheduledEndAt);
  const dtStamp = formatIcsDate(Date.now());
  const summary = escapeIcs(webinar.title);
  const descriptionLines = [
    webinar.description,
    "",
    `Join here: ${webinar.webinarLink}`,
  ]
    .filter(Boolean)
    .join("\n");
  const description = escapeIcs(descriptionLines);
  const location = escapeIcs(webinar.webinarLink);
  const organizer = escapeIcs(webinar.hostEmail);

  const attendees = [webinar.hostEmail, ...webinar.coHosts.map((c) => c.email)]
    .filter(Boolean)
    .map(
      (email) =>
        `ATTENDEE;CN=${escapeIcs(email)};ROLE=REQ-PARTICIPANT:mailto:${escapeIcs(
          email,
        )}`,
    );

  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Conclave//Webinar//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${webinar.id}@conclave`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    `URL:${webinar.webinarLink}`,
    `ORGANIZER;CN=${escapeIcs(webinar.hostName || webinar.hostEmail)}:mailto:${organizer}`,
    ...attendees,
    `STATUS:${webinar.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Webinar starts soon",
    "TRIGGER:-PT15M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return lines.join("\r\n");
};

export async function GET(request: Request, context: RouteContext) {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }
  const { id } = await context.params;
  try {
    const response = await fetch(
      `${resolveScheduledWebinarsBase()}/${encodeURIComponent(id)}`,
      {
        method: "GET",
        headers: buildScheduledWebinarHeaders(authResult.user, request),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return NextResponse.json(
        { error: "Scheduled webinar not found" },
        { status: response.status },
      );
    }
    const data = (await response.json()) as { scheduledWebinar?: ScheduledWebinar };
    const webinar = data?.scheduledWebinar;
    if (!webinar) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const ics = buildIcs(webinar);
    const safeName =
      webinar.linkSlug.replace(/[^a-z0-9-]/gi, "") || "webinar";
    return new NextResponse(ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeName}.ics"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to build calendar invite" },
      { status: 502 },
    );
  }
}
