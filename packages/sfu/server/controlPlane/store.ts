import type { Backend, StoreMode } from "./backends/backend.js";
import type { CommitResult } from "./model.js";
import type { Command, Query } from "./tx.js";

export type ControlPlaneStore = {
  readonly mode: StoreMode;
  commit<T>(command: Command<T>): Promise<CommitResult<T>>;
  read<T>(query: Query<T>): Promise<T>;
  close(): Promise<void>;
};

export const controlPlaneStore = (
  backend: Backend,
  clock: () => number = () => Date.now(),
): ControlPlaneStore => ({
  mode: backend.mode,
  commit: (command) => backend.commit(command, clock()),
  read: (query) => backend.read(query, clock()),
  close: () => backend.close(),
});
