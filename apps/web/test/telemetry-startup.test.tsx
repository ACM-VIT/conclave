// @vitest-environment happy-dom
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  unregister_for_session: vi.fn(),
  capture: vi.fn(),
  captureException: vi.fn(),
  // properties() is what posthog-js attaches to every event from each store.
  persistence: { properties: vi.fn((): Record<string, unknown> => ({})) },
  sessionPersistence: { properties: vi.fn((): Record<string, unknown> => ({})) },
}));
vi.mock("posthog-js", () => ({ default: posthog }));
vi.mock("posthog-js/dist/exception-autocapture", () => ({}));
vi.mock("../src/app/components/ErrorStateView", () => ({ default: () => null }));

type BoundaryProps = { error: Error & { digest?: string }; reset: () => void };

const originalConsoleError = console.error;
let root: Root | null = null;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  console.error = () => {};
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test_project");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_DEV", "1");
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  console.error = originalConsoleError;
  vi.unstubAllEnvs();
});

const renderOnFirstLoad = async (boundary: ComponentType<BoundaryProps>) => {
  const error = Object.assign(new Error("page failed on first render"), {
    digest: "digest-1",
  });
  root = createRoot(document.createElement("div"));
  await act(async () => {
    const Boundary = boundary;
    root?.render(<Boundary error={error} reset={() => {}} />);
  });
  return error;
};

describe("error boundaries on the first page load", () => {
  it("reports a route error caught before telemetry has loaded", async () => {
    const { default: RouteError } = await import("../src/app/error");
    const error = await renderOnFirstLoad(RouteError);

    await vi.waitFor(() =>
      expect(posthog.captureException).toHaveBeenCalledWith(error, {
        source: "react_error_boundary",
        boundary: "route",
        digest: "digest-1",
      }),
    );
    expect(posthog.init).toHaveBeenCalledTimes(1);
  });

  it("reports a root layout failure with no telemetry provider mounted", async () => {
    const { default: GlobalError } = await import("../src/app/global-error");
    const error = await renderOnFirstLoad(GlobalError);

    await vi.waitFor(() =>
      expect(posthog.captureException).toHaveBeenCalledWith(error, {
        source: "react_error_boundary",
        boundary: "root",
        digest: "digest-1",
      }),
    );
  });

  it("drops every stored super property that is not on the exact allowlist", async () => {
    posthog.persistence.properties.mockReturnValue({
      $initialization_time: "2026-11-22T00:00:00Z",
      client_version: "0b2d3b48",
      meeting_note: "Meet Mira in sample-room",
      $meeting_note: "Meet Mira in sample-room",
      __meeting_note: "Meet Mira in sample-room",
    });
    posthog.sessionPersistence.properties.mockReturnValue({
      $session_entry_url: "https://conclave.acmvit.in/",
      visit_note: "Meet Mira in sample-room",
    });
    const { default: RouteError } = await import("../src/app/error");
    await renderOnFirstLoad(RouteError);

    await vi.waitFor(() => expect(posthog.captureException).toHaveBeenCalled());
    expect(posthog.unregister.mock.calls.map(([key]) => key).sort()).toEqual([
      "$meeting_note",
      "__meeting_note",
      "meeting_note",
    ]);
    expect(posthog.unregister_for_session.mock.calls.map(([key]) => key)).toEqual(["visit_note"]);
  });

  it("loads nothing and sends nothing without a project key", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    const { default: RouteError } = await import("../src/app/error");
    await renderOnFirstLoad(RouteError);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.captureException).not.toHaveBeenCalled();
  });
});
