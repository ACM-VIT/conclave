import { createWhiteboardDoc } from "../core/doc/index";
import { defineApp } from "../../../sdk/registry/index";
import { WhiteboardNativeApp } from "./components/WhiteboardNativeApp";

export const whiteboardApp = defineApp({
  id: "whiteboard",
  name: "Whiteboard",
  description: "Collaborative whiteboard",
  createDoc: createWhiteboardDoc,
  native: WhiteboardNativeApp,
});

export { WhiteboardNativeApp };
