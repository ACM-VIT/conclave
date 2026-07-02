/**
 * In-memory audit trail of operator commands. Entries are recorded by the
 * HTTP admin routes (the only write path) and streamed to dashboards by the
 * admin gateway. Per-process and bounded on purpose: this is an operations
 * feed, not a compliance store.
 */

export type AdminAuditEntry = {
  at: number;
  operator: string;
  method: string;
  path: string;
  ok: boolean;
};

const MAX_ENTRIES = 200;

const entries: AdminAuditEntry[] = [];
const listeners = new Set<(entry: AdminAuditEntry) => void>();

export const recordAdminAudit = (entry: AdminAuditEntry): void => {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // A misbehaving listener must not break command handling.
    }
  }
};

export const getAdminAuditEntries = (): AdminAuditEntry[] => [...entries];

export const subscribeAdminAudit = (
  listener: (entry: AdminAuditEntry) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
