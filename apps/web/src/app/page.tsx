import { Suspense } from "react";
import RouteLoadingState from "./components/RouteLoadingState";
import MeetsClientShell from "./meets-client-shell";

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
