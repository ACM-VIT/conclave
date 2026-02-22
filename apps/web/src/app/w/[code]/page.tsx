import { use } from "react";
import MeetsClientShell from "../../meets-client-shell";
import { sanitizeWebinarLinkCode } from "../../lib/utils";

type WebinarRoomPageProps = {
  params: Promise<{ code: string }>;
};

export default function WebinarRoomPage({ params }: WebinarRoomPageProps) {
  const { code } = use(params);

  const rawCode = typeof code === "string" ? code : "";
  const decodedCode = decodeURIComponent(rawCode);
  const resolvedCode =
    decodedCode === "undefined" || decodedCode === "null" ? "" : decodedCode;
  const webinarLinkCode = sanitizeWebinarLinkCode(resolvedCode);

  return (
    <MeetsClientShell
      initialRoomId={webinarLinkCode}
      forceJoinOnly={true}
      bypassMediaPermissions={true}
      joinMode="webinar_attendee"
      autoJoinOnMount={true}
      hideJoinUI={true}
    />
  );
}
