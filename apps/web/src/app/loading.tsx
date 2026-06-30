import RouteLoadingState from "./components/RouteLoadingState";

export default function Loading() {
  return (
    <RouteLoadingState
      eyebrow="Lobby"
      title="Opening Conclave"
      detail="Preparing meeting controls and account state."
    />
  );
}
