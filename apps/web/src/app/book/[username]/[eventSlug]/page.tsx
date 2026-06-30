import { Suspense } from "react";
import type { Viewport } from "next";
import RouteLoadingState from "../../../components/RouteLoadingState";
import BookingClient from "./booking-client";

export const instant = true;
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#131316",
  colorScheme: "dark",
};

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
