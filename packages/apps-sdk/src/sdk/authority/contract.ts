import { SchemaError, s, type Infer, type Schema } from "#authority/schema";

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

/** The most characters an app id may have. */
export const APP_ID_MAX_LENGTH = 48;

/**
 * What an app may be called: lowercase letters, digits and dashes, starting
 * with a letter. The id is a folder name, a package subpath and a name on
 * the wire, so this is the one statement of the rule. `defineContract`,
 * `new:app` and `check:apps` all read it, and none keeps a copy.
 */
export const appIdSchema: Schema<string> = s.string({
  max: APP_ID_MAX_LENGTH,
  pattern: /^[a-z][a-z0-9-]*$/,
});

/** What a schema has against a value, or null when it takes it. */
const problemOf = (schema: Schema<unknown>, value: unknown): string | null => {
  try {
    schema.parse(value, "strict", "it");
    return null;
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    return error.message.replace(/^it: /, "");
  }
};

/** Why a value cannot be an app id, in words for whoever chose it, or null. */
export const appIdProblem = (id: unknown): string | null => {
  const reason = problemOf(appIdSchema, id);
  return reason === null
    ? null
    : `${reason}. An app id is at most ${APP_ID_MAX_LENGTH} lowercase letters, digits and dashes, starting with a letter`;
};

/**
 * What an action, a query or a view may be called. A contract is held to it
 * when it is defined, and the SFU reads a request's action and query names
 * with it, so a name a contract may have is a name the wire carries.
 */
export const authorityNameSchema: Schema<string> = s.string({
  max: 48,
  pattern: /^[a-zA-Z][a-zA-Z0-9]*$/,
});

export const isAuthorityName = (value: unknown): value is string =>
  problemOf(authorityNameSchema, value) === null;

const assertNames = (appId: string, kind: string, names: string[]): void => {
  for (const name of names) {
    if (!isAuthorityName(name)) {
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
  const problem = appIdProblem(contract.id);
  if (problem) {
    throw new Error(`Invalid authority app id "${contract.id}": ${problem}`);
  }
  if (!Number.isInteger(contract.major) || contract.major < 1) {
    throw new Error(`App ${contract.id}: major must be a positive integer`);
  }
  assertNames(contract.id, "action", Object.keys(contract.actions));
  assertNames(contract.id, "query", Object.keys(contract.queries));
  assertNames(contract.id, "view", Object.keys(contract.views));
  return contract;
};
