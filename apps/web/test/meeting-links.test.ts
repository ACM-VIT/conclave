import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMeetingPath } from "../src/lib/meeting-links";
import {
  canonicalizeSfuClientId,
  resolveBrowserSfuClientId,
} from "../src/lib/sfu-client-id";

afterEach(() => vi.unstubAllEnvs());

const ROOM = "abc-defg-hij";

const tenantOpenedBy = (path: string) =>
  canonicalizeSfuClientId(
    new URL(path, "https://web.test").searchParams.get("clientId"),
  ) || resolveBrowserSfuClientId();

describe("meeting links", () => {
  it.each([
    ["conclave", "acme"],
    ["acme", "conclave"],
    ["acme", "default"],
    ["acme", "acme"],
    ["conclave", "conclave"],
  ])(
    "on a %s deployment, a link to a %s room opens that same room",
    (deploymentDefault, roomClientId) => {
      vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", deploymentDefault);

      const path = buildMeetingPath({ roomCode: ROOM, clientId: roomClientId });

      expect(tenantOpenedBy(path)).toBe(canonicalizeSfuClientId(roomClientId));
    },
  );

  it("leaves the client ID out when it is the deployment's own", () => {
    vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", "acme");

    expect(buildMeetingPath({ roomCode: ROOM, clientId: "acme" })).toBe(`/${ROOM}`);
  });
});
