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
};

boot();
