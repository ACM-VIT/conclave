/**
 * SFU signaling event registry — THE single source of truth for every
 * socket.io event name in the Conclave realtime protocol.
 *
 * Web (apps/web) imports `SFU_EVENTS` directly. The native Skip app gets a
 * generated Swift mirror (`Core/Networking/SfuEvents.swift`) produced by
 * `packages/meeting-core/scripts/gen-swift-events.mjs` from THIS file — so the
 * two clients can never drift on an event name. The SFU server
 * (packages/sfu/server/socket) is the producer of these strings; keep this list
 * in lockstep with the handler registrations there.
 *
 * Keys are stable camelCase identifiers; values are the exact wire strings.
 */
export const SFU_EVENTS = {
  /** Built-in socket.io lifecycle events the client cares about. */
  system: {
    connect: "connect",
    disconnect: "disconnect",
    connectError: "connect_error",
    reconnect: "reconnect",
  },

  /** Client → server: requests, commands, and acknowledged RPCs. */
  clientToServer: {
    // Session / media plumbing
    joinRoom: "joinRoom",
    getRouterRtpCapabilities: "getRouterRtpCapabilities",
    createProducerTransport: "createProducerTransport",
    createConsumerTransport: "createConsumerTransport",
    connectProducerTransport: "connectProducerTransport",
    connectConsumerTransport: "connectConsumerTransport",
    produce: "produce",
    consume: "consume",
    resumeConsumer: "resumeConsumer",
    setConsumerPreferences: "setConsumerPreferences",
    closeProducer: "closeProducer",
    getProducers: "getProducers",
    restartIce: "restartIce",
    toggleMute: "toggleMute",
    toggleCamera: "toggleCamera",
    closeRemoteProducer: "closeRemoteProducer",
    closeAllVideo: "closeAllVideo",

    // Chat / reactions / hand / identity
    sendChat: "sendChat",
    sendReaction: "sendReaction",
    setHandRaised: "setHandRaised",
    updateDisplayName: "updateDisplayName",

    // Room queries + host controls
    getRooms: "getRooms",
    lockRoom: "lockRoom",
    lockChat: "lockChat",
    setNoGuests: "setNoGuests",
    setDmEnabled: "setDmEnabled",
    setTtsDisabled: "setTtsDisabled",
    getRoomLockStatus: "getRoomLockStatus",
    getChatLockStatus: "getChatLockStatus",
    getDmEnabledStatus: "getDmEnabledStatus",
    getTtsDisabledStatus: "getTtsDisabledStatus",
    admitUser: "admitUser",
    rejectUser: "rejectUser",
    kickUser: "kickUser",
    promoteHost: "promoteHost",
    redirectUser: "redirectUser",
    muteAll: "muteAll",

    // Shared browser (host)
    browserLaunch: "browser:launch",
    browserNavigate: "browser:navigate",
    browserClose: "browser:close",
    browserGetState: "browser:getState",
    browserActivity: "browser:activity",

    // Apps SDK / collaborative docs
    appsOpen: "apps:open",
    appsClose: "apps:close",
    appsLock: "apps:lock",
    appsGetState: "apps:getState",
    appsYjsSync: "apps:yjs:sync",
    appsYjsUpdate: "apps:yjs:update",
    appsAwareness: "apps:awareness",

    // Meeting / webinar configuration (host)
    meetingGetConfig: "meeting:getConfig",
    meetingUpdateConfig: "meeting:updateConfig",
    webinarGetConfig: "webinar:getConfig",
    webinarUpdateConfig: "webinar:updateConfig",
    webinarGenerateLink: "webinar:generateLink",
    webinarRotateLink: "webinar:rotateLink",

    // Admin namespace (elevated)
    adminAdmitAllPending: "admin:admitAllPending",
    adminRejectAllPending: "admin:rejectAllPending",
    adminBroadcastNotice: "admin:broadcastNotice",
    adminClearRaisedHands: "admin:clearRaisedHands",
    adminCloseUserVideo: "admin:closeUserVideo",
    adminCloseUserMedia: "admin:closeUserMedia",
    adminGetAccessLists: "admin:getAccessLists",
    adminGetParticipants: "admin:getParticipants",
    adminGetPendingUsers: "admin:getPendingUsers",
    adminGetRoomsDetailed: "admin:getRoomsDetailed",
    adminGetRoomState: "admin:getRoomState",
    adminMuteUser: "admin:muteUser",
    adminMuteUserAudio: "admin:muteUserAudio",
    adminStopAllScreenShare: "admin:stopAllScreenShare",
    adminStopUserScreenShare: "admin:stopUserScreenShare",
    adminTransferHost: "admin:transferHost",
    adminAllowUsers: "admin:allowUsers",
    adminBlockUsers: "admin:blockUsers",
    adminUnblockUsers: "admin:unblockUsers",
    adminRevokeAllowedUsers: "admin:revokeAllowedUsers",
    adminSetPolicies: "admin:setPolicies",
    adminCloseRoom: "admin:closeRoom",
    adminEndRoom: "admin:endRoom",
  },

  /** Server → client: notifications and broadcast state. */
  serverToClient: {
    // Join / waiting room lifecycle
    joinApproved: "joinApproved",
    joinRejected: "joinRejected",
    userRequestedJoin: "userRequestedJoin",
    userAdmitted: "userAdmitted",
    userRejected: "userRejected",
    userJoined: "userJoined",
    userLeft: "userLeft",
    pendingUsersSnapshot: "pendingUsersSnapshot",
    pendingUserLeft: "pendingUserLeft",
    waitingRoomStatus: "waitingRoomStatus",

    // Media
    newProducer: "newProducer",
    producerClosed: "producerClosed",
    participantMuted: "participantMuted",
    participantCameraOff: "participantCameraOff",
    setVideoQuality: "setVideoQuality",
    consumerTelemetry: "consumerTelemetry",

    // Chat / reactions / hand / identity
    chatMessage: "chatMessage",
    chatHistorySnapshot: "chatHistorySnapshot",
    reaction: "reaction",
    handRaised: "handRaised",
    handRaisedSnapshot: "handRaisedSnapshot",
    displayNameUpdated: "displayNameUpdated",
    displayNameSnapshot: "displayNameSnapshot",

    // Host / role
    hostAssigned: "hostAssigned",
    hostChanged: "hostChanged",

    // Room policy state
    roomLockChanged: "roomLockChanged",
    chatLockChanged: "chatLockChanged",
    noGuestsChanged: "noGuestsChanged",
    dmStateChanged: "dmStateChanged",
    ttsDisabledChanged: "ttsDisabledChanged",

    // Session lifecycle / disruptive
    kicked: "kicked",
    roomClosed: "roomClosed",
    roomEnded: "roomEnded",
    redirect: "redirect",
    serverRestarting: "serverRestarting",

    // Admin notices
    adminNotice: "adminNotice",
    adminUsersChanged: "adminUsersChanged",
    adminMediaEnforced: "admin:mediaEnforced",
    adminBulkMediaEnforced: "admin:bulkMediaEnforced",
    adminHandsCleared: "admin:handsCleared",
    adminProducerClosed: "admin:producerClosed",
    adminRoomStateChanged: "admin:roomStateChanged",

    // Shared browser
    browserState: "browser:state",
    browserClosed: "browser:closed",

    // Apps SDK
    appsState: "apps:state",
    appsYjsUpdate: "apps:yjs:update",
    appsAwareness: "apps:awareness",

    // Webinar
    webinarFeedChanged: "webinar:feedChanged",
    webinarAttendeeCountChanged: "webinar:attendeeCountChanged",

    // Meeting / webinar config broadcasts
    meetingConfigChanged: "meeting:configChanged",
    webinarConfigChanged: "webinar:configChanged",
  },
} as const;

export type ClientToServerEvent =
  (typeof SFU_EVENTS.clientToServer)[keyof typeof SFU_EVENTS.clientToServer];
export type ServerToClientEvent =
  (typeof SFU_EVENTS.serverToClient)[keyof typeof SFU_EVENTS.serverToClient];
export type SfuSystemEvent =
  (typeof SFU_EVENTS.system)[keyof typeof SFU_EVENTS.system];
export type SfuEventName = ClientToServerEvent | ServerToClientEvent | SfuSystemEvent;
