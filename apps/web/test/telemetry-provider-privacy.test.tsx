// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CaptureResult } from "posthog-js";
import { afterEach, expect, it, vi } from "vitest";
import TelemetryProvider from "../src/app/components/TelemetryProvider";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { init, capture: vi.fn() } }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("sends call ratings without the room name, the invite query or a room id", async () => {
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test_project_key");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<TelemetryProvider>{null}</TelemetryProvider>));
  await vi.waitFor(() => expect(init).toHaveBeenCalled());
  const beforeSend = init.mock.calls[0][1].before_send as
    | ((event: CaptureResult) => CaptureResult | null)
    | undefined;

  const rated: CaptureResult = {
    uuid: "0196-uuid",
    event: "meet_call_rated",
    properties: {
      token: "phc_test_project_key",
      distinct_id: "0196f0a1-0000-7000-8000-000000000000",
      $current_url: "https://conclave.test/alice-smith?invitee=alice%40example.test",
      $pathname: "/alice-smith",
      $title: "alice-smith · Conclave",
      $referrer: "https://conclave.test/alice-smith?invitee=alice%40example.test",
      $session_entry_url: "https://conclave.test/alice-smith?invitee=alice%40example.test",
      roomId: "alice-smith",
      rating: 4,
      outcome: "left",
      durationSeconds: 61,
    },
    $set_once: {
      $initial_current_url: "https://conclave.test/alice-smith?invitee=alice%40example.test",
    },
  };
  const sent = beforeSend?.(rated) ?? rated;
  await act(async () => root.unmount());

  const payload = JSON.stringify(sent);
  expect(payload).not.toContain("alice-smith");
  expect(payload).not.toContain("invitee");
  expect(sent.properties).not.toHaveProperty("roomId");
  expect(sent.properties).toMatchObject({
    $current_url: "https://conclave.test/[code]",
    rating: 4,
    outcome: "left",
    durationSeconds: 61,
  });
});
