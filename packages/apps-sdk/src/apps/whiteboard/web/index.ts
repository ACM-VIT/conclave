import { createElement } from "react";
import { createWhiteboardDoc } from "../core/doc/index";
import { defineApp } from "../../../sdk/registry/index";
import { WhiteboardWebApp } from "./components/WhiteboardWebApp";
import { WhiteboardAppIcon } from "./icon";

export const whiteboardApp = defineApp({
  id: "whiteboard",
  name: "Whiteboard",
  description: "Collaborative whiteboard",
  icon: createElement(WhiteboardAppIcon),
  createDoc: createWhiteboardDoc,
  web: WhiteboardWebApp,
});

export { WhiteboardWebApp };
