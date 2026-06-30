"use client";

import ConclaveBrandScreen from "./ConclaveBrandScreen";
import { BRAND_BTN_GHOST, BRAND_BTN_PRIMARY } from "./brandScreenStyles";

type ErrorStateViewProps = {
  eyebrow?: string;
  title?: string;
  message?: string;
  retryLabel?: string;
  homeLabel?: string;
  onRetry?: () => void;
};

export default function ErrorStateView({
  eyebrow = "Something went wrong",
  title = "We couldn't load this screen",
  message = "Try again. If the issue continues, return to the lobby and rejoin.",
  retryLabel = "Try again",
  homeLabel = "Go home",
  onRetry,
}: ErrorStateViewProps) {
  return (
    <ConclaveBrandScreen
      eyebrow={eyebrow}
      title={title}
      detail={message}
      actions={
        <>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className={BRAND_BTN_PRIMARY}
            >
              {retryLabel}
            </button>
          ) : null}
          <a href="/" className={onRetry ? BRAND_BTN_GHOST : BRAND_BTN_PRIMARY}>
            {homeLabel}
          </a>
        </>
      }
    />
  );
}
