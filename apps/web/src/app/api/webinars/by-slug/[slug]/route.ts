import { NextResponse } from "next/server";
import {
  resolveSfuClientId,
  resolveSfuSecret,
  resolveSfuUrl,
} from "@/lib/sfu-admin-auth";
import type { ScheduledWebinar } from "@/lib/scheduled-webinars";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

const buildPublicProjection = (webinar: ScheduledWebinar) => ({
  id: webinar.id,
  linkSlug: webinar.linkSlug,
  title: webinar.title,
  description: webinar.description,
  hostName: webinar.hostName,
  scheduledStartAt: webinar.scheduledStartAt,
  scheduledEndAt: webinar.scheduledEndAt,
  status: webinar.status,
  publicAccess: webinar.publicAccess,
  requiresInviteCode: webinar.requiresInviteCode,
  waitingRoomEnabled: webinar.waitingRoomEnabled,
  earlyEntryMinutes: webinar.earlyEntryMinutes,
  qaEnabled: webinar.qaEnabled,
  webinarLink: webinar.webinarLink,
  roomId: webinar.roomId,
  clientId: webinar.clientId,
  totalJoinCount: webinar.totalJoinCount,
  peakAttendeeCount: webinar.peakAttendeeCount,
});

export async function GET(request: Request, context: RouteContext) {
  const { slug } = await context.params;
  const sfuUrl = resolveSfuUrl();
  const clientId = resolveSfuClientId(request, { fallback: "default" });
  const url = `${sfuUrl}/scheduled-webinars/by-slug/${encodeURIComponent(slug)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-sfu-secret": resolveSfuSecret(),
        "x-sfu-client": clientId,
        accept: "application/json",
      },
      cache: "no-store",
    });
    if (response.status === 404) {
      return NextResponse.json({ scheduledWebinar: null }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (!response.ok) {
      return NextResponse.json(
        { error: "Lookup failed" },
        { status: response.status },
      );
    }
    const data = (await response.json()) as {
      scheduledWebinar?: ScheduledWebinar;
    };
    const webinar = data?.scheduledWebinar;
    if (!webinar) {
      return NextResponse.json({ scheduledWebinar: null }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (webinar.clientId !== clientId) {
      return NextResponse.json({ scheduledWebinar: null }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    return NextResponse.json(
      { scheduledWebinar: buildPublicProjection(webinar) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to reach scheduled-webinar service" },
      { status: 502 },
    );
  }
}
