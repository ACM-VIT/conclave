import ConclaveBrandScreen from "./ConclaveBrandScreen";

type RouteLoadingStateProps = {
  title: string;
};

export default function RouteLoadingState({ title }: RouteLoadingStateProps) {
  return <ConclaveBrandScreen caption={title} />;
}
