import { defineApp } from "../../../sdk/registry/index";
import { createDevPlaygroundDoc } from "../core/doc/index";
import { DevPlaygroundWebApp } from "./components/DevPlaygroundWebApp";

export const devPlaygroundApp = defineApp({
  id: "dev-playground",
  name: "Dev Playground",
  description: "Development-only example app for SDK contributors",
  createDoc: createDevPlaygroundDoc,
  web: DevPlaygroundWebApp,
});

export { DevPlaygroundWebApp };
