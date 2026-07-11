import { Suspense } from "react";
import { headers as nextHeaders } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import RouteLoadingState from "../components/RouteLoadingState";
import ScheduleClient from "./schedule-client";

export default function SchedulePage() {
  return (
    <Suspense
      fallback={
        <RouteLoadingState
          title="Loading scheduler"
        />
      }
    >
      <ScheduleContent />
    </Suspense>
  );
}

async function ScheduleContent() {
  const headers = await nextHeaders();
  const session = await auth.api.getSession({ headers }).catch(() => null);
  if (!session?.user?.id) {
    redirect("/sign-in?next=/schedule");
  }

  return (
    <ScheduleClient
      user={{
        name: session.user.name || "",
        email: session.user.email || "",
      }}
    />
  );
}
