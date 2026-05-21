import { headers as nextHeaders } from "next/headers";
import { notFound, redirect } from "next/navigation";
import MeetsClientShell from "../../../meets-client-shell";
import type { ScheduledWebinar } from "@/lib/scheduled-webinars";
import {
  buildScheduledWebinarHeaders,
  requireSfuSessionUser,
  resolveScheduledWebinarsBase,
} from "@/lib/sfu-user-auth";

type WebinarHostPageProps = {
  params: Promise<{ id: string }>;
};

export const dynamic = "force-dynamic";

const loadWebinarForHost = async (
  id: string,
): Promise<{
  webinar: ScheduledWebinar;
  user: {
    id: string;
    email: string | null;
    name: string | null;
  };
} | null> => {
  const headers = await nextHeaders();
  const request = new Request("http://internal/webinars/host", { headers });
  const authResult = await requireSfuSessionUser(request);

  if (!authResult.ok) {
    if (authResult.status === 401) {
      redirect("/");
    }
    return null;
  }

  const response = await fetch(
    `${resolveScheduledWebinarsBase()}/${encodeURIComponent(id)}`,
    {
      method: "GET",
      headers: buildScheduledWebinarHeaders(authResult.user, request),
      cache: "no-store",
    },
  );

  if (response.status === 404) {
    notFound();
  }
  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    scheduledWebinar?: ScheduledWebinar;
  };
  if (!data?.scheduledWebinar) {
    return null;
  }

  return {
    webinar: data.scheduledWebinar,
    user: {
      id: authResult.user.id,
      email: authResult.user.email,
      name: authResult.user.name,
    },
  };
};

export default async function WebinarHostPage({ params }: WebinarHostPageProps) {
  const { id } = await params;
  const webinarId = typeof id === "string" ? id.trim() : "";
  if (!webinarId) {
    notFound();
  }

  const result = await loadWebinarForHost(webinarId);
  if (!result) {
    redirect("/webinars");
  }

  return (
    <MeetsClientShell
      initialRoomId={result.webinar.roomId}
      forceJoinOnly={true}
      sfuClientId={result.webinar.clientId}
      autoJoinOnMount={true}
      user={result.user}
      isAdmin={true}
    />
  );
}
