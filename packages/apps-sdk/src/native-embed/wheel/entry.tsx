// Boots the Spin the Wheel native embed (ACT-8): reads the scope native put in the fragment, finds the platform channel,
// owns one Y.Doc for the app session and renders the SDK wheel. Outside the app (no channel) or with a bad scope it
// renders nothing and says nothing, so native's ready timeout shows "Couldn't Open Spin the Wheel".

import { createRoot } from "react-dom/client";
import { createWheelDoc } from "../../apps/wheel/core/doc/index";
import { createNativeTransport } from "../bridge";
import { parseScope } from "../protocol";
import { NativeEmbedSession } from "../session";
import { NativeWheelEmbed } from "./NativeWheelEmbed";

const boot = (): void => {
  const scope = parseScope(window.location.hash);
  if (!scope || scope.appId !== "wheel") return;
  const transport = createNativeTransport(window);
  if (transport.platform === "none") return;
  const container = document.getElementById("root");
  if (!container) return;
  const session = new NativeEmbedSession(transport, scope, createWheelDoc());
  createRoot(container).render(<NativeWheelEmbed session={session} />);
  session.start();
};

boot();
