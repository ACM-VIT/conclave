import CoHostInviteClient from "./CoHostInviteClient";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ token: string }>;
};

export default async function CoHostInvitePage({ params }: Props) {
  const { token } = await params;
  return <CoHostInviteClient token={token} />;
}
