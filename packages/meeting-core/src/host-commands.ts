import { z } from "zod";

export const ROOM_LEASE_UNCONFIRMED_ERROR =
  "This meeting is moving between servers. Try again in a moment.";
export const WAITING_REQUEST_GONE_ERROR = "User not found in waiting room";

const userKeys = z.union([z.string(), z.array(z.string())]);
const target = z.looseObject({ userId: z.string() });
const flag = <Name extends string>(name: Name) => z.looseObject({ [name]: z.boolean() } as Record<Name, z.ZodBoolean>);
const bulkMedia = z.looseObject({
  includeAdmins: z.boolean().nullish(),
  includeAttendees: z.boolean().nullish(),
});
const closing = z.looseObject({
  message: z.string().nullish(),
  delayMs: z.number().nullish(),
});

/** What a host command carries before its ack, one schema per command. */
export const HOST_COMMAND_PAYLOADS = {
  kickUser: target,
  closeRemoteProducer: z.looseObject({ producerId: z.string() }),
  "admin:closeUserMedia": z.looseObject({
    userId: z.string(),
    kinds: z.unknown().nullish(),
    types: z.unknown().nullish(),
    reason: z.string().nullish(),
  }),
  "admin:muteUser": target,
  "admin:closeUserVideo": target,
  "admin:stopUserScreenShare": target,
  "admin:muteUserAudio": target,
  promoteHost: target,
  "admin:transferHost": target,
  "admin:allowUsers": z.looseObject({
    userKeys: userKeys.nullish(),
    allowWhenLocked: z.boolean().nullish(),
  }),
  "admin:createAdmission": z.unknown(),
  "admin:blockUsers": z.looseObject({
    userKeys: userKeys.nullish(),
    kickPresent: z.boolean().nullish(),
    reason: z.string().nullish(),
  }),
  "admin:unblockUsers": z.looseObject({ userKeys: userKeys.nullish() }),
  "admin:revokeAllowedUsers": z.looseObject({
    userKeys: userKeys.nullish(),
    revokeLocked: z.boolean().nullish(),
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
    unmuteAllowed: z.boolean().nullish(),
    videoAllowed: z.boolean().nullish(),
  }),
  "admin:setPolicies": z.looseObject({
    locked: z.boolean().nullish(),
    noGuests: z.boolean().nullish(),
    chatLocked: z.boolean().nullish(),
    ttsDisabled: z.boolean().nullish(),
    dmEnabled: z.boolean().nullish(),
    imageAttachmentsEnabled: z.boolean().nullish(),
    reactionsDisabled: z.boolean().nullish(),
    participantUnmuteAllowed: z.boolean().nullish(),
    participantVideoAllowed: z.boolean().nullish(),
  }),
  "admin:broadcastNotice": z.looseObject({
    message: z.string().nullish(),
    level: z.string().nullish(),
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
