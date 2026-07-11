import { Suspense } from "react";
import RouteLoadingState from "./components/RouteLoadingState";
import MeetsClientShell from "./meets-client-shell";

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <RouteLoadingState
          title="Opening Conclave"
        />
      }
    >
      <MeetsClientShell />
    </Suspense>
  );
}
