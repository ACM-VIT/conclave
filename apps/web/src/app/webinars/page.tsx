import { headers as nextHeaders } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import WebinarsDashboardClient from "./WebinarsDashboardClient";

export const dynamic = "force-dynamic";

export default async function WebinarsDashboardPage() {
  const session = await auth.api
    .getSession({ headers: await nextHeaders() })
    .catch(() => null);

  if (!session?.user?.email) {
    redirect("/");
  }

  const user = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name || null,
  };

  return <WebinarsDashboardClient user={user} />;
}
