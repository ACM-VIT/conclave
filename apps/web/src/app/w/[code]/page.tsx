import { Suspense } from "react";
import { headers as nextHeaders } from "next/headers";
import RouteLoadingState from "../../components/RouteLoadingState";
import { webinarSlugFromPath } from "@/lib/meeting-links";
import { canonicalizeSfuClientId } from "@/lib/sfu-client-id";
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
  searchParams?: Promise<{ clientId?: string | string[] }>;
};

const lookupScheduledWebinar = async (
  slug: string,
  clientId: string,
): Promise<PublicScheduledWebinar | null> => {
  if (!slug) return null;
  const sfuUrl = resolveSfuUrl();

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

export default function WebinarRoomPage({ params, searchParams }: WebinarRoomPageProps) {
  return (
    <Suspense
      fallback={
        <RouteLoadingState
          title="Opening webinar"
        />
      }
    >
      <WebinarRoomContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function WebinarRoomContent({ params, searchParams }: WebinarRoomPageProps) {
  const { code } = await params;

  const rawCode = typeof code === "string" ? code : "";
  const webinarLinkCode = webinarSlugFromPath(decodeURIComponent(rawCode));
  const requested = (await searchParams)?.clientId;
  const clientId =
    canonicalizeSfuClientId(Array.isArray(requested) ? requested[0] : requested) ??
    resolveSfuClientId(new Request("http://internal/lookup", { headers: await nextHeaders() }));
  const webinar = await lookupScheduledWebinar(webinarLinkCode, clientId);

  return (
    <WebinarLandingClient
      webinarLinkCode={webinarLinkCode}
      clientId={clientId}
      initialWebinar={webinar}
    />
  );
}
