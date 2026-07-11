import type { ConclaveApp } from "../types/index";

const validateApp = (app: ConclaveApp): void => {
  if (!app?.id || app.id.trim().length === 0) {
    throw new Error("App id is required");
  }
  if (!app.name || app.name.trim().length === 0) {
    throw new Error(`App ${app.id}: name is required`);
  }
  if (!app.web) {
    throw new Error(`App ${app.id}: web renderer is required`);
  }
};

export const defineApp = <T extends ConclaveApp>(app: T): T => {
  validateApp(app);
  return app;
};
