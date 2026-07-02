import { headers as nextHeaders } from "next/headers";
import { auth } from "@/lib/auth";
import MeetsClientPage from "./meets-client-page";
import type { JoinMode } from "./lib/types";

type MeetsClientShellProps = {
  initialRoomId?: string;
  forceJoinOnly?: boolean;
  bypassMediaPermissions?: boolean;
  sfuClientId?: string;
  joinMode?: JoinMode;
  autoJoinOnMount?: boolean;
  hideJoinUI?: boolean;
  user?: {
    id?: string;
    email?: string | null;
    name?: string | null;
  };
  isAdmin?: boolean;
};

const resolveSessionUser = async (): Promise<
  MeetsClientShellProps["user"] | undefined
> => {
  try {
    const headers = await nextHeaders();
    const session = await auth.api.getSession({ headers }).catch(() => null);
    const user = session?.user;
    if (!user?.id) return undefined;
    return {
      id: user.id,
      email: user.email || null,
      name: user.name || null,
    };
  } catch {
    return undefined;
  }
};

export default async function MeetsClientShell({
  initialRoomId,
  forceJoinOnly,
  bypassMediaPermissions,
  sfuClientId,
  joinMode,
  autoJoinOnMount,
  hideJoinUI,
  user,
  isAdmin,
}: MeetsClientShellProps) {
  const resolvedUser = user ?? (await resolveSessionUser());

  return (
    <MeetsClientPage
      initialRoomId={initialRoomId}
      forceJoinOnly={forceJoinOnly}
      bypassMediaPermissions={bypassMediaPermissions}
      sfuClientId={sfuClientId}
      joinMode={joinMode}
      autoJoinOnMount={autoJoinOnMount}
      hideJoinUI={hideJoinUI}
      user={resolvedUser}
      isAdmin={isAdmin}
    />
  );
}
