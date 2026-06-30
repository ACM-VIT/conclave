import RouteLoadingState from "../components/RouteLoadingState";

export default function Loading() {
  return (
    <RouteLoadingState
      eyebrow="Meeting"
      title="Joining room"
      detail="Checking room details before the call opens."
    />
  );
}
