import type { NextFunction, Request, Response } from "express";
import { Logger } from "../../utilities/loggers.js";

export const PERSISTENCE_UNAVAILABLE = "persistence_unavailable";

/** A store write failed, so the request's change was not saved. */
export class PersistenceUnavailableError extends Error {
  constructor(what: string, cause: unknown) {
    super(`Could not save ${what}`, { cause });
    this.name = "PersistenceUnavailableError";
  }
}

export const sendPersistenceUnavailable = (res: Response): void => {
  res.status(503).json({ error: PERSISTENCE_UNAVAILABLE, message: "Couldn't save, try again." });
};

export const persistOrFail = async (what: string, write: () => unknown): Promise<void> => {
  try {
    await write();
  } catch (error) {
    Logger.error(`Failed to save ${what}`, error);
    throw new PersistenceUnavailableError(what, error);
  }
};

export const persistOrFailSync = (what: string, write: () => void): void => {
  try {
    write();
  } catch (error) {
    Logger.error(`Failed to save ${what}`, error);
    throw new PersistenceUnavailableError(what, error);
  }
};

/** Answers a failed save from any route with the same 503 and error code. */
export const persistenceUnavailableHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (error instanceof PersistenceUnavailableError) {
    sendPersistenceUnavailable(res);
    return;
  }
  next(error);
};
