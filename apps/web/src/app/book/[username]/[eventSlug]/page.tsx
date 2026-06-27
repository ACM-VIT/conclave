import BookingClient from "./booking-client";

export const runtime = "nodejs";

type BookingPageProps = {
  params: Promise<{ username: string; eventSlug: string }>;
};

export default async function BookingPage({ params }: BookingPageProps) {
  const { username, eventSlug } = await params;
  return (
    <BookingClient
      username={decodeURIComponent(username)}
      eventSlug={decodeURIComponent(eventSlug)}
    />
  );
}

