import type { CommitResult } from "../model.js";
import type { Command, Query } from "../tx.js";

export type StoreMode = "memory" | "json" | "sqlite" | "redis";

export interface Backend {
  readonly mode: StoreMode;
  commit<T>(command: Command<T>, now: number): Promise<CommitResult<T>>;
  read<T>(query: Query<T>, now: number): Promise<T>;
  close(): Promise<void>;
}
