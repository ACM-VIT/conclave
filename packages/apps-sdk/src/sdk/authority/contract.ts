import type { Infer, Schema } from "#authority/schema";

export type ActionSpec = {
  input: Schema<unknown>;
  /** What a successful call returns to the caller, and to nobody else. */
  receipt: Schema<unknown>;
};

export type QuerySpec = {
  input: Schema<unknown>;
  output: Schema<unknown>;
};

export type AuthoritySurface = "panel" | "stage";

/**
 * Everything a renderer and the server agree on for one app: the names and
 * shapes of its actions, queries and view buckets. This is the only part of
 * an authority app the browser bundles.
 */
export type AuthorityContract<
  Actions extends Record<string, ActionSpec> = Record<string, ActionSpec>,
  Queries extends Record<string, QuerySpec> = Record<string, QuerySpec>,
  Views extends Record<string, Schema<unknown>> = Record<
    string,
    Schema<unknown>
  >,
> = {
  id: string;
  /** Bumped on a breaking change to any shape below. Pinned per room. */
  major: number;
  surface: AuthoritySurface;
  actions: Actions;
  queries: Queries;
  views: Views;
};

export type ActionName<C extends AuthorityContract> = keyof C["actions"] &
  string;
export type QueryName<C extends AuthorityContract> = keyof C["queries"] &
  string;
export type ViewName<C extends AuthorityContract> = keyof C["views"] & string;

export type ActionInput<
  C extends AuthorityContract,
  K extends ActionName<C>,
> = Infer<C["actions"][K]["input"]>;
export type ActionReceipt<
  C extends AuthorityContract,
  K extends ActionName<C>,
> = Infer<C["actions"][K]["receipt"]>;
export type QueryInput<
  C extends AuthorityContract,
  K extends QueryName<C>,
> = Infer<C["queries"][K]["input"]>;
export type QueryOutput<
  C extends AuthorityContract,
  K extends QueryName<C>,
> = Infer<C["queries"][K]["output"]>;
export type ViewRow<
  C extends AuthorityContract,
  K extends ViewName<C>,
> = Infer<C["views"][K]>;

const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,47}$/;

const assertNames = (appId: string, kind: string, names: string[]): void => {
  for (const name of names) {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`App ${appId}: invalid ${kind} name "${name}"`);
    }
  }
};

export const defineContract = <
  const Actions extends Record<string, ActionSpec>,
  const Queries extends Record<string, QuerySpec>,
  const Views extends Record<string, Schema<unknown>>,
>(
  contract: AuthorityContract<Actions, Queries, Views>,
): AuthorityContract<Actions, Queries, Views> => {
  if (!APP_ID_PATTERN.test(contract.id)) {
    throw new Error(`Invalid authority app id "${contract.id}"`);
  }
  if (!Number.isInteger(contract.major) || contract.major < 1) {
    throw new Error(`App ${contract.id}: major must be a positive integer`);
  }
  assertNames(contract.id, "action", Object.keys(contract.actions));
  assertNames(contract.id, "query", Object.keys(contract.queries));
  assertNames(contract.id, "view", Object.keys(contract.views));
  return contract;
};
