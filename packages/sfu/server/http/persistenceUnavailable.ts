import type { NextFunction, Request, Response } from "express";
import { PersistenceUnavailableError } from "../persistThenApply.js";

export { PersistenceUnavailableError };

export const PERSISTENCE_UNAVAILABLE = "persistence_unavailable";

export const sendPersistenceUnavailable = (res: Response): void => {
  res.status(503).json({ error: PERSISTENCE_UNAVAILABLE, message: "Couldn't save, try again." });
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
