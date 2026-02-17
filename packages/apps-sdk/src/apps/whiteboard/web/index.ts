import { createWhiteboardDoc } from "../core/doc/index";
import { defineApp } from "../../../sdk/registry/index";
import { WhiteboardWebApp } from "./components/WhiteboardWebApp";

export const whiteboardApp = defineApp({
  id: "whiteboard",
  name: "Whiteboard",
  description: "Collaborative whiteboard",
  createDoc: createWhiteboardDoc,
  web: WhiteboardWebApp,
});

export { WhiteboardWebApp };
