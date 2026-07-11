import { createElement } from "react";
import { createWheelDoc } from "../core/doc/index";
import { defineApp } from "../../../sdk/registry/index";
import { WheelWebApp } from "./components/WheelWebApp";
import { WheelAppIcon } from "./icon";

export const wheelApp = defineApp({
  id: "wheel",
  name: "Spin the wheel",
  description: "Random picker for names and choices",
  icon: createElement(WheelAppIcon),
  createDoc: createWheelDoc,
  web: WheelWebApp,
});

export { WheelWebApp };
