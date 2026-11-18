import { createRoot } from "react-dom/client";
import { createWhiteboardDoc } from "../../apps/whiteboard/core/doc/index";
import { createNativeTransport } from "../bridge";
import { parseScope } from "../protocol";
import { NativeEmbedSession } from "../session";
import { NativeWhiteboardEmbed } from "./NativeWhiteboardEmbed";

const boot = (): void => {
  const scope = parseScope(window.location.hash);
  if (!scope || scope.appId !== "whiteboard") return;
  const transport = createNativeTransport(window);
  if (transport.platform === "none") return;
  const container = document.getElementById("root");
  if (!container) return;
  const session = new NativeEmbedSession(transport, scope, createWhiteboardDoc());
  createRoot(container).render(<NativeWhiteboardEmbed session={session} />);
  session.start();
};

boot();
