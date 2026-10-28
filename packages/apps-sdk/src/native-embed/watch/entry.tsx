// Boots the Watch Together native embed (ACT-8): reads the scope native put in the fragment, finds the platform
// channel, owns one Y.Doc for the app session and renders the synced YouTube player. Outside the app (no channel) or
// with a bad scope it renders nothing and says nothing, so native's ready timeout shows "Couldn't Open Watch Together".

import { createRoot } from "react-dom/client";
import { createWatchDoc } from "../../apps/watch/core/doc/index";
import { createNativeTransport } from "../bridge";
import { parseScope } from "../protocol";
import { NativeEmbedSession } from "../session";
import { NativeWatchEmbed } from "./NativeWatchEmbed";

const boot = (): void => {
  const scope = parseScope(window.location.hash);
  if (!scope || scope.appId !== "watch") return;
  const transport = createNativeTransport(window);
  if (transport.platform === "none") return;
  const container = document.getElementById("root");
  if (!container) return;
  const session = new NativeEmbedSession(transport, scope, createWatchDoc());
  createRoot(container).render(<NativeWatchEmbed session={session} />);
  session.start();
};

boot();
