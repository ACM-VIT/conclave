import { z } from "zod";

export const ROOM_LEASE_UNCONFIRMED_ERROR =
  "This meeting is moving between servers. Try again in a moment.";
export const WAITING_REQUEST_GONE_ERROR = "User not found in waiting room";

const userKeys = z.union([z.string(), z.array(z.string())]);
const target = z.looseObject({ userId: z.string() });
const flag = <Name extends string>(name: Name) => z.looseObject({ [name]: z.boolean() } as Record<Name, z.ZodBoolean>);
const bulkMedia = z.looseObject({
  includeAdmins: z.boolean().optional(),
  includeAttendees: z.boolean().optional(),
});
const closing = z.looseObject({
  message: z.string().optional(),
  delayMs: z.number().optional(),
});

/** What a host command carries before its ack, one schema per command. */
export const HOST_COMMAND_PAYLOADS = {
  kickUser: target,
  closeRemoteProducer: z.looseObject({ producerId: z.string() }),
  "admin:closeUserMedia": z.looseObject({
    userId: z.string(),
    kinds: z.unknown().optional(),
    types: z.unknown().optional(),
    reason: z.string().optional(),
  }),
  "admin:muteUser": target,
  "admin:closeUserVideo": target,
  "admin:stopUserScreenShare": target,
  "admin:muteUserAudio": target,
  promoteHost: target,
  "admin:transferHost": target,
  "admin:allowUsers": z.looseObject({
    userKeys: userKeys.optional(),
    allowWhenLocked: z.boolean().optional(),
  }),
  "admin:createAdmission": z.unknown(),
  "admin:blockUsers": z.looseObject({
    userKeys: userKeys.optional(),
    kickPresent: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  "admin:unblockUsers": z.looseObject({ userKeys: userKeys.optional() }),
  "admin:revokeAllowedUsers": z.looseObject({
    userKeys: userKeys.optional(),
    revokeLocked: z.boolean().optional(),
  }),
  redirectUser: z.looseObject({ userId: z.string(), newRoomId: z.string() }),
  admitUser: target,
  rejectUser: target,
  lockRoom: flag("locked"),
  setNoGuests: flag("noGuests"),
  lockChat: flag("locked"),
  setTtsDisabled: flag("disabled"),
  setDmEnabled: flag("enabled"),
  setImageAttachmentsEnabled: flag("enabled"),
  setReactionsDisabled: flag("disabled"),
  setParticipantMediaPermissions: z.looseObject({
    unmuteAllowed: z.boolean().optional(),
    videoAllowed: z.boolean().optional(),
  }),
  "admin:setPolicies": z.looseObject({
    locked: z.boolean().optional(),
    noGuests: z.boolean().optional(),
    chatLocked: z.boolean().optional(),
    ttsDisabled: z.boolean().optional(),
    dmEnabled: z.boolean().optional(),
    imageAttachmentsEnabled: z.boolean().optional(),
    reactionsDisabled: z.boolean().optional(),
    participantUnmuteAllowed: z.boolean().optional(),
    participantVideoAllowed: z.boolean().optional(),
  }),
  "admin:broadcastNotice": z.looseObject({
    message: z.string().optional(),
    level: z.string().optional(),
  }),
  "admin:endRoom": closing,
  "admin:closeRoom": closing,
} as const;

/** Host commands whose payload may be left out, so the ack comes first. */
export const HOST_COMMAND_OPTIONAL_PAYLOADS = {
  muteAll: bulkMedia,
  closeAllVideo: bulkMedia,
  "admin:stopAllScreenShare": bulkMedia,
} as const;

/** Host commands that carry nothing but their ack. */
export const HOST_COMMANDS_WITHOUT_PAYLOAD = [
  "getRooms",
  "admin:getRoomsDetailed",
  "admin:getRoomState",
  "admin:getParticipants",
  "admin:getPendingUsers",
  "admin:getAccessLists",
  "admin:admitAllPending",
  "admin:rejectAllPending",
  "getRoomLockStatus",
  "getChatLockStatus",
  "getTtsDisabledStatus",
  "getDmEnabledStatus",
  "getReactionsDisabledStatus",
  "admin:clearRaisedHands",
] as const;

export type HostCommand =
  | keyof typeof HOST_COMMAND_PAYLOADS
  | keyof typeof HOST_COMMAND_OPTIONAL_PAYLOADS
  | (typeof HOST_COMMANDS_WITHOUT_PAYLOAD)[number];

export const HOST_COMMANDS: readonly HostCommand[] = [
  ...(Object.keys(HOST_COMMAND_PAYLOADS) as HostCommand[]),
  ...(Object.keys(HOST_COMMAND_OPTIONAL_PAYLOADS) as HostCommand[]),
  ...HOST_COMMANDS_WITHOUT_PAYLOAD,
];

const isAck = (value: unknown): boolean => value === undefined || typeof value === "function";

/** Whether what a host command arrived with is what that command takes. */
export const isValidHostCommand = (command: HostCommand, args: readonly unknown[]): boolean => {
  if ((HOST_COMMANDS_WITHOUT_PAYLOAD as readonly string[]).includes(command)) {
    return args.length <= 1 && isAck(args[0]);
  }
  if (command in HOST_COMMAND_OPTIONAL_PAYLOADS) {
    if (typeof args[0] === "function") return args.length === 1;
    const schema = HOST_COMMAND_OPTIONAL_PAYLOADS[command as keyof typeof HOST_COMMAND_OPTIONAL_PAYLOADS];
    return args.length <= 2 && (args[0] === undefined || schema.safeParse(args[0]).success) && isAck(args[1]);
  }
  const schema = HOST_COMMAND_PAYLOADS[command as keyof typeof HOST_COMMAND_PAYLOADS];
  return args.length <= 2 && schema.safeParse(args[0]).success && isAck(args[1]);
};
