import { Suspense } from "react";
import RouteLoadingState from "../../../components/RouteLoadingState";
import BookingClient from "./booking-client";

// Cloudflare workerd currently throws a Cache Components viewport bailout
// when resuming this route's partial-prerender payload.
export const instant = false;

type BookingPageProps = {
  params: Promise<{ username: string; eventSlug: string }>;
};

export default function BookingPage({ params }: BookingPageProps) {
  return (
    <Suspense
      fallback={
        <RouteLoadingState
          eyebrow="Booking"
          title="Loading scheduler"
          detail="Preparing the public booking page."
        />
      }
    >
      <BookingContent params={params} />
    </Suspense>
  );
}

async function BookingContent({ params }: BookingPageProps) {
  const { username, eventSlug } = await params;
  return (
    <BookingClient
      username={decodeURIComponent(username)}
      eventSlug={decodeURIComponent(eventSlug)}
    />
  );
}
