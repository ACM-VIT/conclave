import RouteLoadingState from "../components/RouteLoadingState";

export default function Loading() {
  return (
    <RouteLoadingState
      eyebrow="Authentication"
      title="Preparing sign-in"
      detail="Loading the available identity providers."
    />
  );
}
