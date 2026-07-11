import { Suspense } from "react";
import { headers as nextHeaders } from "next/headers";
import RouteLoadingState from "../../components/RouteLoadingState";
import { sanitizeWebinarLinkCode } from "../../lib/utils";
import {
  resolveSfuClientId,
  resolveSfuSecret,
  resolveSfuUrl,
} from "@/lib/sfu-admin-auth";
import WebinarLandingClient, {
  type PublicScheduledWebinar,
} from "./WebinarLandingClient";

type WebinarRoomPageProps = {
  params: Promise<{ code: string }>;
};

const lookupScheduledWebinar = async (
  slug: string,
): Promise<PublicScheduledWebinar | null> => {
  if (!slug) return null;
  const sfuUrl = resolveSfuUrl();
  const headers = await nextHeaders();
  const fakeRequest = new Request("http://internal/lookup", { headers });
  const clientId = resolveSfuClientId(fakeRequest);

  try {
    const response = await fetch(
      `${sfuUrl}/scheduled-webinars/by-slug/${encodeURIComponent(slug)}`,
      {
        method: "GET",
        headers: {
          "x-sfu-secret": resolveSfuSecret(),
          "x-sfu-client": clientId,
          accept: "application/json",
        },
        cache: "no-store",
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      scheduledWebinar?: PublicScheduledWebinar;
    };
    const webinar = data?.scheduledWebinar;
    if (!webinar || webinar.clientId !== clientId) return null;
    return {
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
    };
  } catch (_error) {
    return null;
  }
};

export default function WebinarRoomPage({ params }: WebinarRoomPageProps) {
  return (
    <Suspense
      fallback={
        <RouteLoadingState
          title="Opening webinar"
        />
      }
    >
      <WebinarRoomContent params={params} />
    </Suspense>
  );
}

async function WebinarRoomContent({ params }: WebinarRoomPageProps) {
  const { code } = await params;

  const rawCode = typeof code === "string" ? code : "";
  const decodedCode = decodeURIComponent(rawCode);
  const resolvedCode =
    decodedCode === "undefined" || decodedCode === "null" ? "" : decodedCode;
  const webinarLinkCode = sanitizeWebinarLinkCode(resolvedCode);

  const webinar = webinarLinkCode
    ? await lookupScheduledWebinar(webinarLinkCode)
    : null;

  return (
    <WebinarLandingClient
      webinarLinkCode={webinarLinkCode}
      initialWebinar={webinar}
    />
  );
}
