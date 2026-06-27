import { headers as nextHeaders } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import ScheduleClient from "./schedule-client";

export const runtime = "nodejs";

export default async function SchedulePage() {
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

