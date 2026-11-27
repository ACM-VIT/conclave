import { defineAuthorityApp } from "../../../sdk/authority/app";
import { pollsContract } from "../core/index";

/**
 * Polls as a meeting host lists it. The host renders the panel itself from
 * `usePolls`, in its own design system.
 */
export const pollsApp = defineAuthorityApp({
  contract: pollsContract,
  name: "Polls",
  description: "Ask a question and see the answers come in",
});

export * from "../core/index";
export * from "./usePolls";
