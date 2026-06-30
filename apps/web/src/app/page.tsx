import { Suspense } from "react";
import RouteLoadingState from "./components/RouteLoadingState";
import MeetsClientShell from "./meets-client-shell";

// Cloudflare workerd currently throws a Cache Components viewport bailout
// when resuming this route's partial-prerender payload.
export const instant = false;
export const prefetch = "allow-runtime";

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <RouteLoadingState
          eyebrow="Lobby"
          title="Opening Conclave"
          detail="Preparing meeting controls and account state."
        />
      }
    >
      <MeetsClientShell />
    </Suspense>
  );
}
