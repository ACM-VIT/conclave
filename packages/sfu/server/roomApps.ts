import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";

export type AppAwarenessRemoval = {
  appId: string;
  awarenessUpdate: Uint8Array;
};

const getAwarenessStateUserId = (state: unknown): string | null => {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const record = state as { user?: unknown };
  if (
    !record.user ||
    typeof record.user !== "object" ||
    Array.isArray(record.user)
  ) {
    return null;
  }
  const user = record.user as { id?: unknown };
  return typeof user.id === "string" ? user.id : null;
};

export class RoomApps {
  public state: { activeAppId: string | null; locked: boolean } = {
    activeAppId: null,
    locked: false,
  };
  private docs: Map<string, Y.Doc> = new Map();
  private awareness: Map<string, Awareness> = new Map();
  private awarenessClientIdsByUser: Map<string, Map<string, Set<number>>> =
    new Map();

  private getOrCreateAwarenessUserMap(appId: string): Map<string, Set<number>> {
    const existing = this.awarenessClientIdsByUser.get(appId);
    if (existing) return existing;
    const map = new Map<string, Set<number>>();
    this.awarenessClientIdsByUser.set(appId, map);
    return map;
  }

  private trackAwarenessClientForUser(
    appId: string,
    userId: string,
    clientId: number,
  ): void {
    const users = this.getOrCreateAwarenessUserMap(appId);
    const existing = users.get(userId);
    if (existing) {
      existing.add(clientId);
      return;
    }
    users.set(userId, new Set([clientId]));
  }

  private untrackAwarenessClientForUser(
    appId: string,
    userId: string,
    clientId: number,
  ): void {
    const users = this.awarenessClientIdsByUser.get(appId);
    if (!users) return;
    const clientIds = users.get(userId);
    if (!clientIds) return;
    clientIds.delete(clientId);
    if (clientIds.size === 0) {
      users.delete(userId);
    }
    if (users.size === 0) {
      this.awarenessClientIdsByUser.delete(appId);
    }
  }

  getOrCreateDoc(appId: string): Y.Doc {
    const existing = this.docs.get(appId);
    if (existing) return existing;
    const doc = new Y.Doc();
    this.docs.set(appId, doc);
    return doc;
  }

  getOrCreateAwareness(appId: string): Awareness {
    const existing = this.awareness.get(appId);
    if (existing) return existing;
    const awareness = new Awareness(this.getOrCreateDoc(appId));
    this.awareness.set(appId, awareness);
    return awareness;
  }

  applyAwarenessUpdate(
    appId: string,
    awarenessUpdate: Uint8Array,
    userId?: string,
    clientId?: number,
  ): void {
    const awareness = this.getOrCreateAwareness(appId);
    applyAwarenessUpdate(awareness, awarenessUpdate, userId ?? "socket");
    if (!userId || typeof clientId !== "number" || !Number.isFinite(clientId)) {
      return;
    }
    if (awareness.getStates().has(clientId)) {
      this.trackAwarenessClientForUser(appId, userId, clientId);
      return;
    }
    this.untrackAwarenessClientForUser(appId, userId, clientId);
  }

  encodeAwarenessSnapshot(appId: string): Uint8Array | null {
    const awareness = this.awareness.get(appId);
    if (!awareness) return null;
    const clientIds = Array.from(awareness.getStates().keys());
    if (clientIds.length === 0) return null;
    return encodeAwarenessUpdate(awareness, clientIds);
  }

  clearAwareness(appId: string): Uint8Array | null {
    const awareness = this.awareness.get(appId);
    this.awarenessClientIdsByUser.delete(appId);
    if (!awareness) return null;

    const clientIds = Array.from(awareness.getStates().keys());
    let removalUpdate: Uint8Array | null = null;
    if (clientIds.length > 0) {
      removeAwarenessStates(awareness, clientIds, "app-close");
      removalUpdate = encodeAwarenessUpdate(awareness, clientIds);
    }

    try {
      awareness.destroy();
    } catch {}
    this.awareness.delete(appId);
    return removalUpdate;
  }

  clearAppState(appId: string): Uint8Array | null {
    const awarenessUpdate = this.clearAwareness(appId);
    const doc = this.docs.get(appId);
    if (doc) {
      try {
        doc.destroy();
      } catch {}
      this.docs.delete(appId);
    }
    if (this.state.activeAppId === appId) {
      this.state.activeAppId = null;
      this.state.locked = false;
    }
    return awarenessUpdate;
  }

  clearUserAwareness(userId: string): AppAwarenessRemoval[] {
    const removals: AppAwarenessRemoval[] = [];

    const appIds = new Set<string>([
      ...this.awareness.keys(),
      ...this.awarenessClientIdsByUser.keys(),
    ]);

    for (const appId of appIds) {
      const awareness = this.awareness.get(appId);
      if (!awareness) {
        continue;
      }

      const users = this.awarenessClientIdsByUser.get(appId);
      const trackedClientIds = users?.get(userId);
      if (users) {
        users.delete(userId);
        if (users.size === 0) {
          this.awarenessClientIdsByUser.delete(appId);
        }
      }

      const clientIds = new Set<number>(trackedClientIds ?? []);
      if (clientIds.size === 0) {
        for (const [clientId, state] of awareness.getStates().entries()) {
          if (getAwarenessStateUserId(state) === userId) {
            clientIds.add(clientId);
          }
        }
      }

      const removableClientIds = Array.from(clientIds).filter((id) =>
        awareness.meta.has(id),
      );
      if (removableClientIds.length === 0) {
        continue;
      }

      removeAwarenessStates(awareness, removableClientIds, userId);
      removals.push({
        appId,
        awarenessUpdate: encodeAwarenessUpdate(awareness, removableClientIds),
      });
    }

    return removals;
  }

  clear(): void {
    for (const awareness of this.awareness.values()) {
      try {
        awareness.destroy();
      } catch {}
    }
    this.awareness.clear();
    this.awarenessClientIdsByUser.clear();

    for (const doc of this.docs.values()) {
      try {
        doc.destroy();
      } catch {}
    }
    this.docs.clear();
    this.state.activeAppId = null;
    this.state.locked = false;
  }
}
