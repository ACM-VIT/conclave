// Boots the Whiteboard native embed: reads the scope native put in the fragment, finds the platform channel, owns one
// Y.Doc for the app session and renders the SDK canvas. Outside the app (no channel) or with a bad scope it renders
// nothing and says nothing, so native's ready timeout shows "Couldn't Open Whiteboard".

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
