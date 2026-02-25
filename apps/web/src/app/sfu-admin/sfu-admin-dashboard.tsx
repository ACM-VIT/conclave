"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type TabId = "overview" | "moderation" | "access" | "lifecycle" | "advanced";

type AdminUser = {
  id: string;
  email: string | null;
  name: string | null;
};

type ParticipantRole = "host" | "admin" | "participant" | "ghost" | "attendee";

type ParticipantProducer = {
  producerId: string;
  kind: "audio" | "video";
  type: "webcam" | "screen";
  paused: boolean;
};

type ParticipantSnapshot = {
  userId: string;
  userKey: string | null;
  displayName: string;
  role: ParticipantRole;
  mode: string;
  muted: boolean;
  cameraOff: boolean;
  producerTransportConnected: boolean;
  consumerTransportConnected: boolean;
  pendingDisconnect: boolean;
  producers: ParticipantProducer[];
  consumerCount: number;
};

type PendingUserSnapshot = {
  userId: string;
  participantUserId: string;
  userKey: string;
  displayName: string;
  socketId: string | null;
};

type RoomPolicies = {
  locked: boolean;
  chatLocked: boolean;
  noGuests: boolean;
  ttsDisabled: boolean;
  dmEnabled: boolean;
  requiresMeetingInviteCode: boolean;
};

type RoomSnapshot = {
  id: string;
  channelId: string;
  clientId: string;
  hostUserId: string | null;
  adminUserIds: string[];
  screenShareProducerId: string | null;
  quality: "low" | "standard";
  policies: RoomPolicies;
  access: {
    allowedUserKeys: string[];
    lockedAllowedUserKeys: string[];
    blockedUserKeys: string[];
  };
  counts: {
    participants: number;
    activeParticipants: number;
    admins: number;
    guests: number;
    ghosts: number;
    webinarAttendees: number;
    pendingUsers: number;
    blockedUsers: number;
    producers: number;
    consumers: number;
  };
  participants: ParticipantSnapshot[];
  pendingUsers: PendingUserSnapshot[];
};

type ClusterOverview = {
  instanceId: string;
  version: string;
  uptime: number;
  timestamp: string;
  draining: boolean;
  workers: {
    total: number;
    closed: number;
    healthy: number;
  };
  counts: {
    rooms: number;
    participants: number;
    pendingUsers: number;
    admins: number;
    webinarAttendees: number;
    producers: number;
    consumers: number;
  };
  roomsByClientId: Record<string, number>;
  topRooms: Array<{
    channelId: string;
    roomId: string;
    clientId: string;
    participantCount: number;
    pendingUserCount: number;
    adminCount: number;
  }>;
};

type WorkerSnapshot = {
  index: number;
  pid: number | null;
  closed: boolean;
  usage: Record<string, number> | null;
  error?: string;
};

type PolicyDraft = {
  locked: boolean;
  chatLocked: boolean;
  noGuests: boolean;
  ttsDisabled: boolean;
  dmEnabled: boolean;
};

const tabs: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "moderation", label: "Moderation" },
  { id: "access", label: "Access" },
  { id: "lifecycle", label: "Lifecycle" },
  { id: "advanced", label: "Advanced" },
];

const defaultPolicyDraft: PolicyDraft = {
  locked: false,
  chatLocked: false,
  noGuests: false,
  ttsDisabled: false,
  dmEnabled: true,
};

const shellClass =
  "rounded-2xl border border-[#E9E4C8]/12 bg-[#11130f] shadow-[0_12px_24px_rgba(0,0,0,0.18)]";
const panelClass = "rounded-xl border border-[#E9E4C8]/12 bg-[#0B0D0A]";
const inputClass =
  "w-full rounded-lg border border-[#E9E4C8]/18 bg-[#090A08] px-3 py-2 text-sm text-[#E9E4C8] outline-none transition focus:border-[#F95F4A]";
const buttonClass =
  "rounded-full border border-[#E9E4C8]/24 bg-[#121510] px-3 py-1.5 text-sm text-[#E9E4C8] transition hover:border-[#F95F4A] disabled:cursor-not-allowed disabled:opacity-45";
const softButtonClass =
  "rounded-full border border-[#E9E4C8]/12 px-3 py-1.5 text-sm text-[#E9E4C8]/72 transition hover:border-[#E9E4C8]/35 hover:text-[#E9E4C8]";

const parseUserKeysInput = (value: string): string[] =>
  Array.from(
    new Set(
      value
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );

const parseIntOrZero = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
};

const formatUptime = (seconds: number): string => {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${remaining}s`;
  if (minutes > 0) return `${minutes}m ${remaining}s`;
  return `${remaining}s`;
};

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

const readError = async (response: Response): Promise<string> => {
  const data = await response.json().catch(() => null);
  if (data && typeof data === "object" && "error" in data) {
    return String((data as { error?: string }).error || "Request failed");
  }
  return response.statusText || `Request failed (${response.status})`;
};

const buildAdminApiPath = (path: string, clientId: string): string => {
  const normalizedPath = path.replace(/^\/+/, "");
  const query = new URLSearchParams();
  if (clientId.trim()) {
    query.set("clientId", clientId.trim());
  }
  return query.toString()
    ? `/api/sfu/admin/${normalizedPath}?${query.toString()}`
    : `/api/sfu/admin/${normalizedPath}`;
};

const fetchAdminJson = async <T,>(
  path: string,
  options: {
    clientId: string;
    method?: RequestMethod;
    body?: unknown;
  },
): Promise<T> => {
  const response = await fetch(buildAdminApiPath(path, options.clientId), {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as T;
};

const fetchAdminAuth = async (): Promise<AdminUser> => {
  const response = await fetch("/api/sfu/admin/auth", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const data = (await response.json()) as { user: AdminUser };
  return data.user;
};

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-[#E9E4C8]/10 bg-black/20 px-3 py-2">
      <p className="text-sm text-[#E9E4C8]/65">{label}</p>
      <p className="mt-1 text-lg text-[#E9E4C8]">{value}</p>
    </div>
  );
}

export default function SfuAdminDashboard() {
  const initialClientId = process.env.NEXT_PUBLIC_SFU_CLIENT_ID || "default";

  const [clientId, setClientId] = useState(initialClientId);
  const [clientIdDraft, setClientIdDraft] = useState(initialClientId);
  const [roomQuery, setRoomQuery] = useState("");

  const [adminUser, setAdminUser] = useState<AdminUser | null>(null);
  const [overview, setOverview] = useState<ClusterOverview | null>(null);
  const [workers, setWorkers] = useState<WorkerSnapshot[]>([]);
  const [rooms, setRooms] = useState<RoomSnapshot[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [selectedRoomClientId, setSelectedRoomClientId] = useState("");
  const [roomSnapshot, setRoomSnapshot] = useState<RoomSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overview");

  const [policyDraft, setPolicyDraft] = useState<PolicyDraft>(defaultPolicyDraft);
  const [noticeMessage, setNoticeMessage] = useState("");
  const [noticeLevel, setNoticeLevel] = useState<"info" | "warning" | "error">("info");

  const [accessUserKeysInput, setAccessUserKeysInput] = useState("");
  const [accessReason, setAccessReason] = useState("Policy enforcement");
  const [allowWhenLocked, setAllowWhenLocked] = useState(true);
  const [revokeLocked, setRevokeLocked] = useState(true);
  const [kickPresent, setKickPresent] = useState(true);

  const [removeReason, setRemoveReason] = useState("Stage reset by operator");
  const [includeGhosts, setIncludeGhosts] = useState(false);
  const [includeAttendees, setIncludeAttendees] = useState(false);
  const [moderationReason, setModerationReason] = useState("Removed by operator");

  const [endRoomMessage, setEndRoomMessage] = useState(
    "This meeting has been ended by the host.",
  );
  const [endRoomDelayMs, setEndRoomDelayMs] = useState("0");

  const [drainEnabled, setDrainEnabled] = useState(false);
  const [drainForce, setDrainForce] = useState(false);
  const [drainNotice, setDrainNotice] = useState(
    "Meeting server is restarting. You will be reconnected automatically.",
  );
  const [drainNoticeMs, setDrainNoticeMs] = useState("4000");

  const [advancedMethod, setAdvancedMethod] = useState<RequestMethod>("GET");
  const [advancedPath, setAdvancedPath] = useState("overview");
  const [advancedBody, setAdvancedBody] = useState("");
  const [advancedResult, setAdvancedResult] = useState("");

  const [isLoadingOverview, setIsLoadingOverview] = useState(false);
  const [isLoadingRoom, setIsLoadingRoom] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const selectedRoomPath = useMemo(
    () => encodeURIComponent(selectedRoomId.trim()),
    [selectedRoomId],
  );

  const selectedRoomScopeClientId = useMemo(() => {
    if (selectedRoomClientId) return selectedRoomClientId;
    if (roomSnapshot?.clientId) return roomSnapshot.clientId;
    return clientId;
  }, [clientId, roomSnapshot?.clientId, selectedRoomClientId]);

  const filteredRooms = useMemo(() => {
    const query = roomQuery.trim().toLowerCase();
    if (!query) return rooms;
    return rooms.filter((room) => {
      return (
        room.id.toLowerCase().includes(query) ||
        room.clientId.toLowerCase().includes(query) ||
        room.channelId.toLowerCase().includes(query)
      );
    });
  }, [roomQuery, rooms]);

  const isBusy = Boolean(activeAction);

  const refreshOverview = useCallback(async () => {
    setIsLoadingOverview(true);
    setErrorMessage(null);

    try {
      const [user, overviewData, workersData, roomsData] = await Promise.all([
        fetchAdminAuth(),
        fetchAdminJson<ClusterOverview>("overview", { clientId }),
        fetchAdminJson<{ workers: WorkerSnapshot[] }>("workers", { clientId }),
        fetchAdminJson<{ rooms: RoomSnapshot[] }>("rooms", { clientId }),
      ]);

      setAdminUser(user);
      setOverview(overviewData);
      setWorkers(Array.isArray(workersData.workers) ? workersData.workers : []);
      setRooms(Array.isArray(roomsData.rooms) ? roomsData.rooms : []);
      setDrainEnabled(Boolean(overviewData.draining));
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setIsLoadingOverview(false);
    }
  }, [clientId]);

  const refreshRoom = useCallback(
    async (roomId: string, roomClientId: string) => {
      const normalized = roomId.trim();
      if (!normalized) {
        setRoomSnapshot(null);
        return;
      }

      setIsLoadingRoom(true);
      setErrorMessage(null);

      try {
        const response = await fetchAdminJson<{ room: RoomSnapshot }>(
          `rooms/${encodeURIComponent(normalized)}`,
          {
            clientId: roomClientId,
          },
        );
        setRoomSnapshot(response.room);
      } catch (error) {
        setRoomSnapshot(null);
        setErrorMessage((error as Error).message);
      } finally {
        setIsLoadingRoom(false);
      }
    },
    [],
  );

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  useEffect(() => {
    if (rooms.length === 0) {
      setSelectedRoomId("");
      setSelectedRoomClientId("");
      setRoomSnapshot(null);
      return;
    }

    const existing = rooms.find(
      (room) => room.id === selectedRoomId && room.clientId === selectedRoomClientId,
    );

    if (existing) {
      return;
    }

    const fallback = rooms[0];
    setSelectedRoomId(fallback.id);
    setSelectedRoomClientId(fallback.clientId);
  }, [rooms, selectedRoomClientId, selectedRoomId]);

  useEffect(() => {
    if (!selectedRoomId || !selectedRoomClientId) {
      setRoomSnapshot(null);
      return;
    }
    void refreshRoom(selectedRoomId, selectedRoomClientId);
  }, [refreshRoom, selectedRoomClientId, selectedRoomId]);

  useEffect(() => {
    if (!roomSnapshot) {
      setPolicyDraft(defaultPolicyDraft);
      return;
    }

    setPolicyDraft({
      locked: roomSnapshot.policies.locked,
      chatLocked: roomSnapshot.policies.chatLocked,
      noGuests: roomSnapshot.policies.noGuests,
      ttsDisabled: roomSnapshot.policies.ttsDisabled,
      dmEnabled: roomSnapshot.policies.dmEnabled,
    });
  }, [roomSnapshot]);

  const runAction = useCallback(
    async (options: {
      label: string;
      path: string;
      method?: RequestMethod;
      body?: unknown;
      clientIdOverride?: string;
      refreshOverviewAfter?: boolean;
      refreshRoomAfter?: boolean;
    }) => {
      setActiveAction(options.label);
      setErrorMessage(null);
      setStatusMessage(null);

      try {
        await fetchAdminJson(options.path, {
          clientId: options.clientIdOverride ?? clientId,
          method: options.method || "POST",
          body: options.body,
        });

        setStatusMessage(`${options.label} succeeded.`);

        if (options.refreshOverviewAfter !== false) {
          await refreshOverview();
        }

        if (
          options.refreshRoomAfter !== false &&
          selectedRoomId &&
          selectedRoomScopeClientId
        ) {
          await refreshRoom(selectedRoomId, selectedRoomScopeClientId);
        }
      } catch (error) {
        setErrorMessage((error as Error).message);
      } finally {
        setActiveAction(null);
      }
    },
    [
      clientId,
      refreshOverview,
      refreshRoom,
      selectedRoomId,
      selectedRoomScopeClientId,
    ],
  );

  const requireSelectedRoom = useCallback(() => {
    if (!selectedRoomPath || !selectedRoomScopeClientId) {
      setErrorMessage("Select a room first.");
      return null;
    }

    return {
      roomPath: selectedRoomPath,
      roomClientId: selectedRoomScopeClientId,
    };
  }, [selectedRoomPath, selectedRoomScopeClientId]);

  const applyClientScope = useCallback(() => {
    const next = clientIdDraft.trim();
    setClientId(next);
    setSelectedRoomId("");
    setSelectedRoomClientId("");
    setRoomSnapshot(null);
    setStatusMessage(null);
    setErrorMessage(null);
  }, [clientIdDraft]);

  const applyPolicies = useCallback(async () => {
    const room = requireSelectedRoom();
    if (!room) return;

    await runAction({
      label: "Updated room policies",
      path: `rooms/${room.roomPath}/policies`,
      body: policyDraft,
      clientIdOverride: room.roomClientId,
    });
  }, [policyDraft, requireSelectedRoom, runAction]);

  const sendNotice = useCallback(async () => {
    const room = requireSelectedRoom();
    if (!room) return;

    const message = noticeMessage.trim();
    if (!message) {
      setErrorMessage("Notice message is required.");
      return;
    }

    await runAction({
      label: "Sent room notice",
      path: `rooms/${room.roomPath}/notice`,
      body: {
        message,
        level: noticeLevel,
      },
      clientIdOverride: room.roomClientId,
    });
  }, [noticeLevel, noticeMessage, requireSelectedRoom, runAction]);

  const applyAccessAction = useCallback(
    async (action: "allow" | "revoke" | "block" | "unblock") => {
      const room = requireSelectedRoom();
      if (!room) return;

      const userKeys = parseUserKeysInput(accessUserKeysInput);
      if (userKeys.length === 0) {
        setErrorMessage("Add at least one user key.");
        return;
      }

      const body: Record<string, unknown> = { userKeys };
      if (action === "allow") {
        body.allowWhenLocked = allowWhenLocked;
      }
      if (action === "revoke") {
        body.revokeLocked = revokeLocked;
      }
      if (action === "block") {
        body.kickPresent = kickPresent;
        body.reason = accessReason.trim() || "Blocked by operator";
      }

      await runAction({
        label: `${action.toUpperCase()} user keys`,
        path: `rooms/${room.roomPath}/access/${action}`,
        body,
        clientIdOverride: room.roomClientId,
      });
    },
    [
      accessReason,
      accessUserKeysInput,
      allowWhenLocked,
      kickPresent,
      requireSelectedRoom,
      revokeLocked,
      runAction,
    ],
  );

  const runAdvancedRequest = useCallback(async () => {
    const path = advancedPath.trim().replace(/^\/+/, "");
    if (!path) {
      setErrorMessage("Advanced path is required.");
      return;
    }

    setActiveAction(`Advanced ${advancedMethod} ${path}`);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      let parsedBody: unknown = undefined;
      if (advancedMethod !== "GET" && advancedMethod !== "DELETE") {
        const trimmed = advancedBody.trim();
        if (trimmed) {
          parsedBody = JSON.parse(trimmed) as unknown;
        }
      }

      const data = await fetchAdminJson<unknown>(path, {
        clientId,
        method: advancedMethod,
        body: parsedBody,
      });

      setAdvancedResult(pretty(data));
      setStatusMessage(`Advanced request ${advancedMethod} ${path} succeeded.`);

      if (path === "overview" || path.startsWith("rooms/")) {
        await refreshOverview();
        if (selectedRoomId && selectedRoomScopeClientId) {
          await refreshRoom(selectedRoomId, selectedRoomScopeClientId);
        }
      }
    } catch (error) {
      setAdvancedResult(String((error as Error).message));
      setErrorMessage((error as Error).message);
    } finally {
      setActiveAction(null);
    }
  }, [
    advancedBody,
    advancedMethod,
    advancedPath,
    clientId,
    refreshOverview,
    refreshRoom,
    selectedRoomId,
    selectedRoomScopeClientId,
  ]);

  return (
    <div className="min-h-screen bg-[#090A08] text-[#E9E4C8]">
      <div className="mx-auto w-full max-w-[1380px] px-4 py-4 md:px-8 md:py-7">
        {errorMessage ? (
          <div className="rounded-xl border border-red-400/35 bg-red-900/25 px-4 py-3 text-sm text-red-100">
            {errorMessage}
          </div>
        ) : null}

        {statusMessage ? (
          <div className="mt-4 rounded-xl border border-emerald-400/35 bg-emerald-900/25 px-4 py-3 text-sm text-emerald-100">
            {statusMessage}
          </div>
        ) : null}

        <div className="mt-4 grid gap-4 xl:grid-cols-[320px_1fr]">
          <aside className="space-y-4">
            <section className={`${shellClass} p-4`}>
              <h2 className="text-base">Scope</h2>
              <p className="mt-1 text-sm text-[#E9E4C8]/65">
                {adminUser?.email || adminUser?.id || "not authenticated"}
              </p>
              <p className="text-sm text-[#E9E4C8]/65">
                {clientId || "all clients"}
              </p>

              <div className="mt-3 space-y-2">
                <input
                  className={inputClass}
                  value={clientIdDraft}
                  onChange={(event) => setClientIdDraft(event.target.value)}
                  placeholder="default"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={applyClientScope}
                    disabled={isBusy}
                  >
                    Apply Scope
                  </button>
                  <button
                    type="button"
                    className={softButtonClass}
                    onClick={() => setClientIdDraft("")}
                  >
                    All Clients
                  </button>
                  <button
                    type="button"
                    className={softButtonClass}
                    onClick={() => void refreshOverview()}
                    disabled={isBusy || isLoadingOverview}
                  >
                    {isLoadingOverview ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <Metric label="Rooms" value={overview?.counts.rooms ?? 0} />
                <Metric
                  label="Participants"
                  value={overview?.counts.participants ?? 0}
                />
                <Metric label="Pending" value={overview?.counts.pendingUsers ?? 0} />
                <Metric label="Workers" value={`${overview?.workers.healthy ?? 0}/${overview?.workers.total ?? 0}`} />
              </div>

              <div className="mt-4 space-y-2 rounded-lg border border-[#E9E4C8]/10 bg-black/20 p-3">
                <label className="flex items-center justify-between text-xs text-[#E9E4C8]/72">
                  <span>Enable draining</span>
                  <input
                    type="checkbox"
                    checked={drainEnabled}
                    onChange={(event) => setDrainEnabled(event.target.checked)}
                  />
                </label>
                <label className="flex items-center justify-between text-xs text-[#E9E4C8]/72">
                  <span>Force disconnect</span>
                  <input
                    type="checkbox"
                    checked={drainForce}
                    onChange={(event) => setDrainForce(event.target.checked)}
                  />
                </label>
                <input
                  className={inputClass}
                  value={drainNotice}
                  onChange={(event) => setDrainNotice(event.target.value)}
                  placeholder="Restart notice"
                />
                <input
                  className={inputClass}
                  value={drainNoticeMs}
                  onChange={(event) => setDrainNoticeMs(event.target.value)}
                  placeholder="Notice delay ms"
                />
                <button
                  type="button"
                  className={buttonClass}
                  disabled={isBusy}
                  onClick={() =>
                    void runAction({
                      label: "Updated drain state",
                      path: "drain",
                      body: {
                        draining: drainEnabled,
                        force: drainForce,
                        notice: drainNotice.trim() || undefined,
                        noticeMs: parseIntOrZero(drainNoticeMs),
                      },
                      refreshRoomAfter: false,
                    })
                  }
                >
                  Apply Drain
                </button>
              </div>
            </section>

            <section className={`${shellClass} p-4`}>
              <h2 className="text-base">Rooms</h2>

              <input
                className={`${inputClass} mt-3`}
                value={roomQuery}
                onChange={(event) => setRoomQuery(event.target.value)}
                placeholder="Filter rooms"
              />

              <div className="mt-3 max-h-[420px] space-y-2 overflow-auto pr-1">
                {filteredRooms.map((room) => {
                  const selected =
                    selectedRoomId === room.id && selectedRoomClientId === room.clientId;
                  return (
                    <button
                      key={`${room.channelId}`}
                      type="button"
                      onClick={() => {
                        setSelectedRoomId(room.id);
                        setSelectedRoomClientId(room.clientId);
                        setActiveTab("overview");
                      }}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                        selected
                          ? "border-[#F95F4A] bg-[#181B15]"
                          : "border-[#E9E4C8]/12 bg-black/20 hover:border-[#E9E4C8]/32"
                      }`}
                    >
                      <p className="text-sm text-[#E9E4C8]">{room.id}</p>
                      <p className="text-[11px] text-[#E9E4C8]/56">
                        {room.clientId} • {room.counts.participants} ppl • {room.counts.pendingUsers} pending
                      </p>
                    </button>
                  );
                })}

                {filteredRooms.length === 0 ? (
                  <p className="py-4 text-sm text-[#E9E4C8]/46">No matching rooms.</p>
                ) : null}
              </div>
            </section>
          </aside>

          <main className={`${shellClass} p-4 md:p-5`}>

            {!roomSnapshot ? (
              <div className="rounded-lg border border-[#E9E4C8]/12 bg-black/20 px-4 py-8 text-center text-sm text-[#E9E4C8]/55">
                Select a room from the left panel.
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-xl text-[#E9E4C8]">{roomSnapshot.id}</h2>
                    <p className="text-sm text-[#E9E4C8]/65">
                      {roomSnapshot.clientId} • {roomSnapshot.channelId} • {formatUptime(overview?.uptime ?? 0)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={softButtonClass}
                    onClick={() =>
                      void refreshRoom(roomSnapshot.id, roomSnapshot.clientId)
                    }
                    disabled={isLoadingRoom}
                  >
                    {isLoadingRoom ? "Refreshing..." : "Refresh Room"}
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-5">
                  <Metric label="Participants" value={roomSnapshot.counts.participants} />
                  <Metric label="Pending" value={roomSnapshot.counts.pendingUsers} />
                  <Metric label="Admins" value={roomSnapshot.counts.admins} />
                  <Metric label="Blocked" value={roomSnapshot.access.blockedUserKeys.length} />
                  <Metric
                    label="Screen"
                    value={roomSnapshot.screenShareProducerId ? "on" : "off"}
                  />
                </div>

                <div className="mt-4 flex flex-wrap gap-2 border-b border-[#E9E4C8]/10 pb-3">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={
                        activeTab === tab.id
                          ? `${buttonClass} border-[#F95F4A]`
                          : softButtonClass
                      }
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {activeTab === "overview" ? (
                  <div className="mt-4 grid gap-4 xl:grid-cols-2">
                    <section className="space-y-2 rounded-lg border border-[#E9E4C8]/10 bg-black/20 p-3">
                      <h3 className="text-base">Waiting room</h3>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className={buttonClass}
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void runAction({
                              label: "Admitted all pending users",
                              path: `rooms/${selectedRoomPath}/pending/admit-all`,
                              clientIdOverride: selectedRoomScopeClientId,
                            })
                          }
                        >
                          Admit All
                        </button>
                        <button
                          className={buttonClass}
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void runAction({
                              label: "Rejected all pending users",
                              path: `rooms/${selectedRoomPath}/pending/reject-all`,
                              clientIdOverride: selectedRoomScopeClientId,
                            })
                          }
                        >
                          Reject All
                        </button>
                        <button
                          className={buttonClass}
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void runAction({
                              label: "Cleared raised hands",
                              path: `rooms/${selectedRoomPath}/hands/clear`,
                              clientIdOverride: selectedRoomScopeClientId,
                            })
                          }
                        >
                          Clear Hands
                        </button>
                      </div>

                      <div className="max-h-[260px] space-y-2 overflow-auto pr-1">
                        {roomSnapshot.pendingUsers.map((pending) => (
                          <div
                            key={`${pending.userKey}-${pending.participantUserId}`}
                            className="rounded-md border border-[#E9E4C8]/10 bg-black/20 px-3 py-2"
                          >
                            <p className="text-sm">{pending.displayName}</p>
                            <p className="text-[11px] text-[#E9E4C8]/55">{pending.userKey}</p>
                            <div className="mt-2 flex gap-2">
                              <button
                                type="button"
                                className={softButtonClass}
                                disabled={isBusy}
                                onClick={() =>
                                  void runAction({
                                    label: `Admitted ${pending.userKey}`,
                                    path: `rooms/${selectedRoomPath}/pending/${encodeURIComponent(
                                      pending.userKey,
                                    )}/admit`,
                                    clientIdOverride: selectedRoomScopeClientId,
                                  })
                                }
                              >
                                Admit
                              </button>
                              <button
                                type="button"
                                className={softButtonClass}
                                disabled={isBusy}
                                onClick={() =>
                                  void runAction({
                                    label: `Rejected ${pending.userKey}`,
                                    path: `rooms/${selectedRoomPath}/pending/${encodeURIComponent(
                                      pending.userKey,
                                    )}/reject`,
                                    clientIdOverride: selectedRoomScopeClientId,
                                  })
                                }
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        ))}
                        {roomSnapshot.pendingUsers.length === 0 ? (
                          <p className="py-3 text-sm text-[#E9E4C8]/45">No pending users.</p>
                        ) : null}
                      </div>
                    </section>

                    <section className="space-y-2 rounded-lg border border-[#E9E4C8]/10 bg-black/20 p-3">
                      <h3 className="text-base">Participants</h3>
                      <div className="max-h-[360px] space-y-2 overflow-auto pr-1">
                        {roomSnapshot.participants.map((participant) => (
                          <div
                            key={participant.userId}
                            className="rounded-md border border-[#E9E4C8]/10 bg-black/20 px-3 py-2"
                          >
                            <p className="text-sm">{participant.displayName}</p>
                            <p className="text-[11px] text-[#E9E4C8]/55">
                              {participant.role} • {participant.userKey || "no-user-key"}
                            </p>
                            <p className="text-[11px] text-[#E9E4C8]/45">
                              producers {participant.producers.length} • consumers {participant.consumerCount}
                            </p>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                ) : null}

                {activeTab === "moderation" ? (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-lg border border-[#E9E4C8]/10 bg-black/20 p-3">
                      <h3 className="text-base">Moderation reason</h3>
                      <input
                        className={`${inputClass} mt-2`}
                        value={moderationReason}
                        onChange={(event) => setModerationReason(event.target.value)}
                        placeholder="Reason for kick/block"
                      />
                    </div>

                    <div className="max-h-[560px] overflow-auto rounded-lg border border-[#E9E4C8]/10">
                      <table className="w-full min-w-[860px] border-collapse text-left text-xs">
                        <thead className="sticky top-0 bg-[#0F110D]">
                          <tr className="border-b border-[#E9E4C8]/10 text-[#E9E4C8]/55">
                            <th className="px-3 py-2 font-medium">User</th>
                            <th className="px-3 py-2 font-medium">Role</th>
                            <th className="px-3 py-2 font-medium">Producers</th>
                            <th className="px-3 py-2 font-medium">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {roomSnapshot.participants.map((participant) => (
                            <tr key={participant.userId} className="border-b border-[#E9E4C8]/8">
                              <td className="px-3 py-2 align-top">
                                <p className="text-[#E9E4C8]">{participant.displayName}</p>
                                <p className="text-[10px] text-[#E9E4C8]/50">{participant.userId}</p>
                                <p className="text-[10px] text-[#E9E4C8]/50">{participant.userKey || "-"}</p>
                              </td>
                              <td className="px-3 py-2 align-top">{participant.role}</td>
                              <td className="px-3 py-2 align-top">
                                <div className="flex flex-wrap gap-1">
                                  {participant.producers.map((producer) => (
                                    <button
                                      key={producer.producerId}
                                      type="button"
                                      className={softButtonClass}
                                      onClick={() =>
                                        void runAction({
                                          label: `Closed producer ${producer.producerId}`,
                                          path: `rooms/${selectedRoomPath}/producers/${encodeURIComponent(
                                            producer.producerId,
                                          )}/close`,
                                          clientIdOverride: selectedRoomScopeClientId,
                                        })
                                      }
                                      disabled={isBusy}
                                    >
                                      {producer.kind}:{producer.type}
                                    </button>
                                  ))}
                                  {participant.producers.length === 0 ? (
                                    <span className="text-[#E9E4C8]/40">no producers</span>
                                  ) : null}
                                </div>
                              </td>
                              <td className="px-3 py-2 align-top">
                                <div className="flex flex-wrap gap-1">
                                  <button
                                    type="button"
                                    className={softButtonClass}
                                    onClick={() =>
                                      void runAction({
                                        label: `Kicked ${participant.userId}`,
                                        path: `rooms/${selectedRoomPath}/users/${encodeURIComponent(
                                          participant.userId,
                                        )}/kick`,
                                        body: { reason: moderationReason.trim() || "Removed by operator" },
                                        clientIdOverride: selectedRoomScopeClientId,
                                      })
                                    }
                                    disabled={isBusy}
                                  >
                                    Kick
                                  </button>
                                  <button
                                    type="button"
                                    className={softButtonClass}
                                    onClick={() =>
                                      void runAction({
                                        label: `Muted ${participant.userId}`,
                                        path: `rooms/${selectedRoomPath}/users/${encodeURIComponent(
                                          participant.userId,
                                        )}/mute`,
                                        clientIdOverride: selectedRoomScopeClientId,
                                      })
                                    }
                                    disabled={isBusy}
                                  >
                                    Mute
                                  </button>
                                  <button
                                    type="button"
                                    className={softButtonClass}
                                    onClick={() =>
                                      void runAction({
                                        label: `Video off for ${participant.userId}`,
                                        path: `rooms/${selectedRoomPath}/users/${encodeURIComponent(
                                          participant.userId,
                                        )}/video-off`,
                                        clientIdOverride: selectedRoomScopeClientId,
                                      })
                                    }
                                    disabled={isBusy}
                                  >
                                    Video Off
                                  </button>
                                  <button
                                    type="button"
                                    className={softButtonClass}
                                    onClick={() =>
                                      void runAction({
                                        label: `Stopped screen for ${participant.userId}`,
                                        path: `rooms/${selectedRoomPath}/users/${encodeURIComponent(
                                          participant.userId,
                                        )}/stop-screen`,
                                        clientIdOverride: selectedRoomScopeClientId,
                                      })
                                    }
                                    disabled={isBusy}
                                  >
                                    Stop Screen
                                  </button>
                                  <button
                                    type="button"
                                    className={softButtonClass}
                                    onClick={() =>
                                      void runAction({
                                        label: `Blocked ${participant.userId}`,
                                        path: `rooms/${selectedRoomPath}/users/${encodeURIComponent(
                                          participant.userId,
                                        )}/block`,
                                        body: {
                                          reason: moderationReason.trim() || "Blocked by operator",
                                        },
                                        clientIdOverride: selectedRoomScopeClientId,
                                      })
                                    }
                                    disabled={isBusy}
                                  >
                                    Block
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                {activeTab === "access" ? (
                  <div className="mt-4 grid gap-4 xl:grid-cols-2">
                    <section className="space-y-2 rounded-lg border border-[#E9E4C8]/10 bg-black/20 p-3">
                      <h3 className="text-base">Access actions</h3>
                      <textarea
                        className={`${inputClass} min-h-24`}
                        value={accessUserKeysInput}
                        onChange={(event) => setAccessUserKeysInput(event.target.value)}
                        placeholder={"alice@example.com\nguest:123"}
                      />
                      <input
                        className={inputClass}
                        value={accessReason}
                        onChange={(event) => setAccessReason(event.target.value)}
                        placeholder="Reason used by block"
                      />

                      <label className="flex items-center justify-between text-xs text-[#E9E4C8]/72">
                        <span>Allow when locked</span>
                        <input
                          type="checkbox"
                          checked={allowWhenLocked}
                          onChange={(event) => setAllowWhenLocked(event.target.checked)}
                        />
                      </label>
                      <label className="flex items-center justify-between text-xs text-[#E9E4C8]/72">
                        <span>Revoke locked entries</span>
                        <input
                          type="checkbox"
                          checked={revokeLocked}
                          onChange={(event) => setRevokeLocked(event.target.checked)}
                        />
                      </label>
                      <label className="flex items-center justify-between text-xs text-[#E9E4C8]/72">
                        <span>Kick connected users on block</span>
                        <input
                          type="checkbox"
                          checked={kickPresent}
                          onChange={(event) => setKickPresent(event.target.checked)}
                        />
                      </label>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={isBusy}
                          onClick={() => void applyAccessAction("allow")}
                        >
                          Allow
                        </button>
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={isBusy}
                          onClick={() => void applyAccessAction("revoke")}
                        >
                          Revoke
                        </button>
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={isBusy}
                          onClick={() => void applyAccessAction("block")}
                        >
                          Block
                        </button>
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={isBusy}
                          onClick={() => void applyAccessAction("unblock")}
                        >
                          Unblock
                        </button>
                      </div>
                    </section>

                    <section className="space-y-3 rounded-lg border border-[#E9E4C8]/10 bg-black/20 p-3 text-xs">
                      <div className="rounded-md border border-[#E9E4C8]/10 bg-black/20 p-2">
                        <p className="text-sm text-[#E9E4C8]/70">Allowed</p>
                        <p className="mt-1 text-[#E9E4C8]/76">
                          {roomSnapshot.access.allowedUserKeys.join(", ") || "none"}
                        </p>
                      </div>
                      <div className="rounded-md border border-[#E9E4C8]/10 bg-black/20 p-2">
                        <p className="text-sm text-[#E9E4C8]/70">Locked allowed</p>
                        <p className="mt-1 text-[#E9E4C8]/76">
                          {roomSnapshot.access.lockedAllowedUserKeys.join(", ") || "none"}
                        </p>
                      </div>
                      <div className="rounded-md border border-[#E9E4C8]/10 bg-black/20 p-2">
                        <p className="text-sm text-[#E9E4C8]/70">Blocked</p>
                        <p className="mt-1 text-[#E9E4C8]/76">
                          {roomSnapshot.access.blockedUserKeys.join(", ") || "none"}
                        </p>
                      </div>
                    </section>
                  </div>
                ) : null}

                {activeTab === "lifecycle" ? (
                  <div className="mt-4 grid gap-4 xl:grid-cols-3">
                    <section className="space-y-2 rounded-lg border border-[#E9E4C8]/10 bg-black/20 p-3">
                      <h3 className="text-base">Policies</h3>
                      <label className="flex items-center justify-between text-xs">
                        <span>Room locked</span>
                        <input
                          type="checkbox"
                          checked={policyDraft.locked}
                          onChange={(event) =>
                            setPolicyDraft((prev) => ({
                              ...prev,
                              locked: event.target.checked,
                            }))
                          }
                        />
                      </label>
                      <label className="flex items-center justify-between text-xs">
                        <span>Chat locked</span>
                        <input
                          type="checkbox"
                          checked={policyDraft.chatLocked}
                          onChange={(event) =>
                            setPolicyDraft((prev) => ({
                              ...prev,
                              chatLocked: event.target.checked,
                            }))
                          }
                        />
                      </label>
                      <label className="flex items-center justify-between text-xs">
                        <span>No guests</span>
                        <input
                          type="checkbox"
                          checked={policyDraft.noGuests}
                          onChange={(event) =>
                            setPolicyDraft((prev) => ({
                              ...prev,
                              noGuests: event.target.checked,
                            }))
                          }
                        />
                      </label>
                      <label className="flex items-center justify-between text-xs">
                        <span>TTS disabled</span>
                        <input
                          type="checkbox"
                          checked={policyDraft.ttsDisabled}
                          onChange={(event) =>
                            setPolicyDraft((prev) => ({
                              ...prev,
                              ttsDisabled: event.target.checked,
                            }))
                          }
                        />
                      </label>
                      <label className="flex items-center justify-between text-xs">
                        <span>DM enabled</span>
                        <input
                          type="checkbox"
                          checked={policyDraft.dmEnabled}
                          onChange={(event) =>
                            setPolicyDraft((prev) => ({
                              ...prev,
                              dmEnabled: event.target.checked,
                            }))
                          }
                        />
                      </label>

                      <button
                        type="button"
                        className={buttonClass}
                        disabled={isBusy}
                        onClick={() => void applyPolicies()}
                      >
                        Apply Policies
                      </button>
                    </section>

                    <section className="space-y-2 rounded-lg border border-[#E9E4C8]/10 bg-black/20 p-3">
                      <h3 className="text-base">Notice</h3>
                      <textarea
                        className={`${inputClass} min-h-24`}
                        value={noticeMessage}
                        onChange={(event) => setNoticeMessage(event.target.value)}
                        placeholder="Message"
                      />
                      <div className="flex flex-wrap gap-2">
                        {(["info", "warning", "error"] as const).map((level) => (
                          <button
                            key={level}
                            type="button"
                            className={
                              noticeLevel === level
                                ? `${buttonClass} border-[#F95F4A]`
                                : softButtonClass
                            }
                            onClick={() => setNoticeLevel(level)}
                          >
                            {level}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={isBusy}
                        onClick={() => void sendNotice()}
                      >
                        Send Notice
                      </button>
                    </section>

                    <section className="space-y-2 rounded-lg border border-[#E9E4C8]/10 bg-black/20 p-3">
                      <h3 className="text-base">Room lifecycle</h3>
                      <input
                        className={inputClass}
                        value={removeReason}
                        onChange={(event) => setRemoveReason(event.target.value)}
                        placeholder="Remove non-admins reason"
                      />
                      <label className="flex items-center justify-between text-xs">
                        <span>Include ghosts</span>
                        <input
                          type="checkbox"
                          checked={includeGhosts}
                          onChange={(event) => setIncludeGhosts(event.target.checked)}
                        />
                      </label>
                      <label className="flex items-center justify-between text-xs">
                        <span>Include attendees</span>
                        <input
                          type="checkbox"
                          checked={includeAttendees}
                          onChange={(event) => setIncludeAttendees(event.target.checked)}
                        />
                      </label>
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={isBusy}
                        onClick={() =>
                          void runAction({
                            label: "Removed non-admins",
                            path: `rooms/${selectedRoomPath}/users/remove-non-admins`,
                            body: {
                              includeGhosts,
                              includeAttendees,
                              reason: removeReason.trim() || undefined,
                            },
                            clientIdOverride: selectedRoomScopeClientId,
                          })
                        }
                      >
                        Remove Non-Admins
                      </button>

                      <textarea
                        className={`${inputClass} min-h-20`}
                        value={endRoomMessage}
                        onChange={(event) => setEndRoomMessage(event.target.value)}
                        placeholder="End-room message"
                      />
                      <input
                        className={inputClass}
                        value={endRoomDelayMs}
                        onChange={(event) => setEndRoomDelayMs(event.target.value)}
                        placeholder="End delay ms"
                      />
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={isBusy}
                        onClick={() =>
                          void runAction({
                            label: "Ended room",
                            path: `rooms/${selectedRoomPath}/end`,
                            body: {
                              message: endRoomMessage.trim() || undefined,
                              delayMs: parseIntOrZero(endRoomDelayMs),
                            },
                            clientIdOverride: selectedRoomScopeClientId,
                          })
                        }
                      >
                        End Room
                      </button>
                    </section>
                  </div>
                ) : null}

                {activeTab === "advanced" ? (
                  <div className="mt-4 space-y-3">
                    <div className="grid gap-2 md:grid-cols-[120px_1fr]">
                      <select
                        className={inputClass}
                        value={advancedMethod}
                        onChange={(event) =>
                          setAdvancedMethod(event.target.value as RequestMethod)
                        }
                      >
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                        <option value="PATCH">PATCH</option>
                        <option value="DELETE">DELETE</option>
                      </select>
                      <input
                        className={inputClass}
                        value={advancedPath}
                        onChange={(event) => setAdvancedPath(event.target.value)}
                        placeholder="rooms/{roomId}/access"
                      />
                    </div>
                    <textarea
                      className={`${inputClass} min-h-24`}
                      value={advancedBody}
                      onChange={(event) => setAdvancedBody(event.target.value)}
                      placeholder='{"userKeys":["alice@example.com"]}'
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={isBusy}
                        onClick={() => void runAdvancedRequest()}
                      >
                        Run
                      </button>
                      <button
                        type="button"
                        className={softButtonClass}
                        onClick={() => {
                          setAdvancedBody("");
                          setAdvancedResult("");
                        }}
                      >
                        Clear
                      </button>
                    </div>
                    <pre className="max-h-[320px] overflow-auto rounded-lg border border-[#E9E4C8]/10 bg-black/30 p-3 text-[11px] text-[#E9E4C8]/78">
                      {advancedResult || "// Response output"}
                    </pre>
                  </div>
                ) : null}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
