import ConclaveBrandScreen from "./ConclaveBrandScreen";

type RouteLoadingStateProps = {
  eyebrow?: string;
  title: string;
  detail?: string;
};

// Route-level loading fallback: the brand Lottie with a single low caption.
// (eyebrow/detail are accepted for call-site compatibility but intentionally
// not shown — the animation is the focus.)
export default function RouteLoadingState({ title }: RouteLoadingStateProps) {
  return <ConclaveBrandScreen caption={title} />;
}
