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
