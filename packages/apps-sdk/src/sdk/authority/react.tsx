import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AuthorityClient,
  type AuthoritySession,
  type AuthoritySessionState,
  type AuthoritySocket,
  type CapabilityState,
} from "#authority/client";
import type {
  ActionInput,
  ActionName,
  ActionReceipt,
  AuthorityContract,
  QueryInput,
  QueryName,
  QueryOutput,
} from "#authority/contract";
import type { AuthorityResult } from "#authority/wire";

const AuthorityContext = createContext<AuthorityClient | null>(null);

export type AuthorityProviderProps = {
  socket: AuthoritySocket | null;
  /**
   * Whether this socket is in its room. Capabilities are asked while it is,
   * and every view is forgotten when it no longer is.
   */
  joined: boolean;
  children: React.ReactNode;
};

/**
 * Hosts the authority transport for one meeting socket. Sits beside
 * `AppsProvider`; the two do not share state.
 */
export function AuthorityProvider({ socket, joined, children }: AuthorityProviderProps) {
  const [client, setClient] = useState<AuthorityClient | null>(null);

  useEffect(() => {
    if (!socket) {
      setClient(null);
      return;
    }
    const next = new AuthorityClient({ socket });
    setClient(next);
    return () => next.dispose();
  }, [socket]);

  useEffect(() => {
    if (joined) client?.joined();
    else client?.left();
  }, [client, joined]);

  return (
    <AuthorityContext.Provider value={client}>{children}</AuthorityContext.Provider>
  );
}

export type AuthorityAppClient<C extends AuthorityContract> = {
  state: AuthoritySessionState<C>;
  act: <K extends ActionName<C>>(
    action: K,
    input: ActionInput<C, K>,
  ) => Promise<AuthorityResult<ActionReceipt<C, K>>>;
  query: <K extends QueryName<C>>(
    query: K,
    input: QueryInput<C, K>,
  ) => Promise<AuthorityResult<QueryOutput<C, K>>>;
};

const UNSUPPORTED = { kind: "unsupported" } as const;
const UNKNOWN: CapabilityState = { kind: "unknown" };
const noSubscription = () => () => {};

/**
 * The live view of one authority app and the calls its contract allows.
 * `state.kind` is `ready` once the server has sent the view. Every other
 * kind renders as unavailable. Several components may use the same contract;
 * they share one subscription.
 */
export function useAuthority<C extends AuthorityContract>(contract: C): AuthorityAppClient<C> {
  const client = useContext(AuthorityContext);
  const [session, setSession] = useState<AuthoritySession<C> | null>(null);

  useEffect(() => {
    if (!client) {
      setSession(null);
      return;
    }
    const opened = client.open(contract);
    setSession(opened);
    return () => {
      opened.release();
    };
  }, [client, contract]);

  const state = useSyncExternalStore<AuthoritySessionState<C>>(
    session ? session.subscribe : noSubscription,
    session ? session.getState : () => UNSUPPORTED,
    () => UNSUPPORTED,
  );

  const act = useCallback<AuthorityAppClient<C>["act"]>(
    (action, input) =>
      session
        ? session.act(action, input)
        : Promise.resolve({ ok: false, code: "unsupported" }),
    [session],
  );
  const query = useCallback<AuthorityAppClient<C>["query"]>(
    (name, input) =>
      session
        ? session.query(name, input)
        : Promise.resolve({ ok: false, code: "unsupported" }),
    [session],
  );

  return useMemo(() => ({ state, act, query }), [state, act, query]);
}

/**
 * Whether the server runs authority apps at all. "unknown" until it has
 * answered or the wait for an answer ran out, and "unsupported" for an older
 * server or one with the runtime turned off. A host uses it to say why an
 * app is missing, where `useAuthorityAvailable` only says that it is.
 */
export function useAuthorityRuntime(): CapabilityState["kind"] {
  const client = useContext(AuthorityContext);
  return useSyncExternalStore(
    client ? client.subscribe : noSubscription,
    client ? () => client.capabilities.kind : () => UNKNOWN.kind,
    () => UNKNOWN.kind,
  );
}

/**
 * Whether the server offers this app to this connection. False on a server
 * without the runtime, so hosts hide the app's entry points instead of
 * showing something that cannot work.
 */
export function useAuthorityAvailable(contract: AuthorityContract): boolean {
  const client = useContext(AuthorityContext);
  const capabilities = useSyncExternalStore<CapabilityState>(
    client ? client.subscribe : noSubscription,
    client ? () => client.capabilities : () => UNKNOWN,
    () => UNKNOWN,
  );
  return (
    capabilities.kind === "ready" &&
    capabilities.capability.apps.some(
      (entry) => entry.app === contract.id && entry.major === contract.major,
    )
  );
}
