import { createElement } from "react";
import { createWatchDoc } from "../core/doc/index";
import { defineApp } from "../../../sdk/registry/index";
import { WatchWebApp } from "./components/WatchWebApp";
import { WatchAppIcon } from "./icon";

export const watchApp = defineApp({
  id: "watch",
  name: "Watch together",
  description: "Synced YouTube playback",
  icon: createElement(WatchAppIcon),
  createDoc: createWatchDoc,
  web: WatchWebApp,
});

export { WatchWebApp };
