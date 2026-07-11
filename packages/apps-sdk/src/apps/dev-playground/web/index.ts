import { createElement } from "react";
import { defineApp } from "../../../sdk/registry/index";
import { createDevPlaygroundDoc } from "../core/doc/index";
import { DevPlaygroundWebApp } from "./components/DevPlaygroundWebApp";
import { DevPlaygroundAppIcon } from "./icon";

export const devPlaygroundApp = defineApp({
  id: "dev-playground",
  name: "Dev Playground",
  description: "Development-only example app for SDK contributors",
  icon: createElement(DevPlaygroundAppIcon),
  createDoc: createDevPlaygroundDoc,
  web: DevPlaygroundWebApp,
});

export { DevPlaygroundWebApp };
