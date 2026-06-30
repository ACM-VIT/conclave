import ConclaveBrandScreen from "./components/ConclaveBrandScreen";
import { BRAND_BTN_PRIMARY } from "./components/brandScreenStyles";

export default function NotFound() {
  return (
    <ConclaveBrandScreen
      eyebrow="404 · Not found"
      title="Page not found"
      detail="The room or page you're looking for doesn't exist. Head back to the lobby and start fresh."
      actions={
        <a href="/" className={BRAND_BTN_PRIMARY}>
          Back to lobby
        </a>
      }
    />
  );
}
