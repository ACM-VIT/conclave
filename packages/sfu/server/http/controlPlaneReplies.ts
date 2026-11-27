import type { Request, RequestHandler, Response } from "express";
import { Logger } from "../../utilities/loggers.js";
import type { CommitFailure, FailureReason } from "../controlPlane/model.js";

const STATUS: Record<FailureReason, number> = {
  conflict: 409,
  not_found: 404,
  duplicate: 409,
  forbidden: 403,
  invalid: 400,
};

const DEFAULT_MESSAGE: Record<FailureReason, string> = {
  conflict: "This changed somewhere else. Reload and try again.",
  not_found: "Not found",
  duplicate: "That is already taken.",
  forbidden: "Not authorized",
  invalid: "Invalid request",
};

export const STORE_UNAVAILABLE_MESSAGE = "Couldn't save, try again.";

export const sendFailure = (res: Response, failure: CommitFailure): void => {
  res.status(STATUS[failure.reason]).json({ error: failure.message ?? DEFAULT_MESSAGE[failure.reason] });
};

export const controlPlaneRoute =
  (label: string, handler: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
  async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      Logger.error(`[ControlPlane] ${label} failed`, error);
      if (res.headersSent) return;
      res.status(503).json({ error: STORE_UNAVAILABLE_MESSAGE });
    }
  };
