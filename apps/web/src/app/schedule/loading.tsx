import RouteLoadingState from "../components/RouteLoadingState";

export default function Loading() {
  return (
    <RouteLoadingState
      eyebrow="Schedule"
      title="Loading scheduler"
      detail="Checking your account and calendar workspace."
    />
  );
}
