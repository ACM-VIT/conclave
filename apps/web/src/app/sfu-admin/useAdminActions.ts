"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminRequest } from "./adminApi";
import type { AdminActionInput } from "./types";

const BUSY_TOAST_DELAY_MS = 400;
const STATUS_TOAST_MS = 4000;

/**
 * Command runner with calm feedback: commands are re-entry guarded, the busy
 * toast only appears for actions that actually take a while (quick ones never
 * flash it), successes self-dismiss, and errors stay until dismissed. `isBusy`
 * is meant for destructive confirm buttons only; everyday controls stay
 * enabled and rely on the re-entry guard, so acting never dims the page.
 */
export function useAdminActions() {
  const [isBusy, setIsBusy] = useState(false);
  const [busyToast, setBusyToast] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const busyRef = useRef(false);
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(null), STATUS_TOAST_MS);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  const begin = useCallback((label: string): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setIsBusy(true);
    setErrorMessage(null);
    busyTimerRef.current = setTimeout(() => setBusyToast(label), BUSY_TOAST_DELAY_MS);
    return true;
  }, []);

  const finish = useCallback((outcome: { status?: string; error?: string }) => {
    if (busyTimerRef.current) {
      clearTimeout(busyTimerRef.current);
      busyTimerRef.current = null;
    }
    busyRef.current = false;
    setIsBusy(false);
    setBusyToast(null);
    if (outcome.error) {
      setErrorMessage(outcome.error);
    } else if (outcome.status) {
      setStatusMessage(outcome.status);
    }
  }, []);

  const runAction = useCallback(
    async (input: AdminActionInput): Promise<boolean> => {
      if (!begin(input.label)) return false;
      try {
        await adminRequest(input.path, {
          clientId: input.clientId,
          instanceUrl: input.instanceUrl,
          method: input.method || "POST",
          body: input.body,
        });
        finish({ status: input.label });
        return true;
      } catch (error) {
        finish({ error: (error as Error).message });
        return false;
      }
    },
    [begin, finish],
  );

  /** Several commands under one label and one toast, e.g. mute all. */
  const runBatch = useCallback(
    async (
      label: string,
      inputs: Array<Omit<AdminActionInput, "label">>,
    ): Promise<boolean> => {
      if (!begin(label)) return false;
      try {
        for (const input of inputs) {
          await adminRequest(input.path, {
            clientId: input.clientId,
            instanceUrl: input.instanceUrl,
            method: input.method || "POST",
            body: input.body,
          });
        }
        finish({ status: label });
        return true;
      } catch (error) {
        finish({ error: (error as Error).message });
        return false;
      }
    },
    [begin, finish],
  );

  return {
    runAction,
    runBatch,
    isBusy,
    busyToast,
    errorMessage,
    statusMessage,
    setErrorMessage,
  };
}
