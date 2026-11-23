import type { NextFunction, Request, Response } from "express";
import { ChangedElsewhereError, PersistenceUnavailableError } from "../persistThenApply.js";

export { ChangedElsewhereError, PersistenceUnavailableError };

export class AccessRevokedError extends Error {
  constructor(what: string) {
    super(`Not authorized for this ${what}`);
    this.name = "AccessRevokedError";
  }
}

export const PERSISTENCE_UNAVAILABLE = "persistence_unavailable";

export const CHANGED_ELSEWHERE = "changed_elsewhere";

export const sendPersistenceUnavailable = (res: Response): void => {
  res.status(503).json({ error: PERSISTENCE_UNAVAILABLE, message: "Couldn't save, try again." });
};

export const answerStoreFailure = (res: Response, error: unknown): boolean => {
  if (error instanceof PersistenceUnavailableError) {
    sendPersistenceUnavailable(res);
    return true;
  }
  if (error instanceof ChangedElsewhereError) {
    res.status(409).json({ error: CHANGED_ELSEWHERE, message: "This changed somewhere else. Reload and try again." });
    return true;
  }
  if (error instanceof AccessRevokedError) {
    res.status(403).json({ error: error.message });
    return true;
  }
  return false;
};

export const persistenceUnavailableHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (answerStoreFailure(res, error)) return;
  next(error);
};
