import { defineAuthorityApp } from "../../../sdk/authority/app";
import { qaContract } from "../core/index";

/**
 * Q&A as a meeting host lists it. The host renders the panel itself from
 * `useQa`, in its own design system.
 */
export const qaApp = defineAuthorityApp({
  contract: qaContract,
  name: "Q&A",
  description: "Ask questions and upvote the ones you want answered",
});

export * from "../core/index";
export * from "./useQa";
