import type React from "react";
import type { AuthorityContract } from "#authority/contract";

/**
 * An authority app as a meeting host lists and mounts it. The host owns the
 * panel's frame and decides when it is open; opening one is local to the
 * viewer and never touches the stage.
 */
export type AuthorityApp<C extends AuthorityContract = AuthorityContract> = {
  id: string;
  name: string;
  description?: string;
  icon?: React.ReactNode;
  contract: C;
  /** The panel's content. It reads the app through `useAuthority(contract)`. */
  panel: React.ComponentType;
};

export const defineAuthorityApp = <C extends AuthorityContract>(
  app: Omit<AuthorityApp<C>, "id">,
): AuthorityApp<C> => {
  if (!app.name || app.name.trim().length === 0) {
    throw new Error(`App ${app.contract.id}: name is required`);
  }
  if (app.contract.surface !== "panel") {
    throw new Error(
      `App ${app.contract.id}: only panel apps can be mounted by a host yet`,
    );
  }
  return { id: app.contract.id, ...app };
};
