import { Suspense } from "react";
import type { Viewport } from "next";
import RouteLoadingState from "./components/RouteLoadingState";
import MeetsClientShell from "./meets-client-shell";

export const instant = true;
export const prefetch = "allow-runtime";
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#131316",
  colorScheme: "dark",
};

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
