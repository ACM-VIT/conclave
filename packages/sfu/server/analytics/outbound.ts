/**
 * The SFU's outbound schema for PostHog, and the posthog-node `beforeSend`
 * hook that builds every event from it.
 *
 * The schema lists every event the SFU sends, every property each may carry,
 * and the form of each value: an enum, a constant, a bounded number or an id
 * we generated, never free text. Each event is built from scratch through it:
 * anything not listed is never read, and a value that does not fit its form
 * is dropped. Exceptions are shaped first, so a frame names a file and a
 * function only for our own source.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventMessage } from "posthog-node";
import { z } from "zod";
import type { GameOptionSpec } from "../games/types.js";
import {
  isSentMessage,
  MESSAGE_WITHHELD,
  SENT_ERROR_TYPES,
  SENT_REGIONS,
  SERVER_ERROR_LEVELS,
  SERVER_ERROR_SOURCES,
  TYPE_WITHHELD,
} from "./errorReporter.js";

const PATH_WITHHELD = "[path]";
const FUNCTION_WITHHELD = "?";
const MAX_KNOWN_PATHS = 1000;
const MAX_POSITION = 100_000_000;
const MAX_EXCEPTIONS = 10;
const MAX_FRAMES = 500;

export type FramePathOptions = {
  /** The folder whose files may be named. */
  root: string;
  /** The folder posthog-node made frame paths relative to. */
  cwd: () => string;
};

/**
 * A frame's path relative to the SFU's folder, or [path]. A path is kept only
 * when it names a file of our own source: one that exists inside that folder
 * once links are followed and is not under node_modules. A name alone, a home
 * folder, a library's file or a Node internal is never sent.
 */
export const createFramePath = ({ root, cwd }: FramePathOptions) => {
  let realRoot: string | null = null;
  try {
    realRoot = realpathSync(root);
  } catch {}
  const known = new Map<string, string>();
  return (filename: string): string => {
    const key = `${cwd()}\0${filename}`;
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    let sent = PATH_WITHHELD;
    try {
      if (realRoot) {
        const inRoot = path.relative(realRoot, realpathSync(path.resolve(cwd(), filename)));
        const segments = inRoot.split(path.sep);
        if (inRoot && !path.isAbsolute(inRoot) && segments[0] !== ".." && !segments.includes("node_modules")) {
          sent = segments.join("/");
        }
      }
    } catch {}
    if (known.size < MAX_KNOWN_PATHS) known.set(key, sent);
    return sent;
  };
};

// The forms of a frame's file and function, which the shaper checks one by
// one, so a value that does not fit is withheld alone.
const FRAME_FILE = z
  .string()
  .regex(/^(?!\.\.?\/)(?!.*\/\.\.?\/)[\w.@+-]+(?:\/[\w.@+-]+)*$/)
  .max(300);
const FUNCTION_NAME = z.string().regex(/^[\w$.<>[\] ]{1,200}$/);
const MECHANISM_TYPES = ["generic", "chained", "onuncaughtexception", "onunhandledrejection"] as const;
const mechanismTypes = new Set<string>(MECHANISM_TYPES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isPosition = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_POSITION;

/**
 * A frame keeps its position and in-app flag, and its path and function name
 * only when it is an in-app frame of our own source. The module name
 * posthog-node derives from the full path, the source lines it reads from
 * disk and anything else are left out.
 */
const shapeFrame = (frame: Record<string, unknown>, framePath: (filename: string) => string) => {
  const ownPath =
    frame.in_app === true && typeof frame.filename === "string" ? framePath(frame.filename) : PATH_WITHHELD;
  const own = ownPath !== PATH_WITHHELD && FRAME_FILE.safeParse(ownPath).success;
  return {
    platform: "node:javascript",
    ...(typeof frame.filename === "string" ? { filename: own ? ownPath : PATH_WITHHELD } : {}),
    function: own && FUNCTION_NAME.safeParse(frame.function).success ? frame.function : FUNCTION_WITHHELD,
    ...(isPosition(frame.lineno) ? { lineno: frame.lineno } : {}),
    ...(isPosition(frame.colno) ? { colno: frame.colno } : {}),
    ...(typeof frame.in_app === "boolean" ? { in_app: frame.in_app } : {}),
  };
};

const sentTypes = new Set(SENT_ERROR_TYPES);

const shapeExceptionList = (value: unknown, framePath: (filename: string) => string) => {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).slice(0, MAX_EXCEPTIONS).map((entry) => {
    const { mechanism, stacktrace } = entry;
    const frames = isRecord(stacktrace) ? stacktrace.frames : undefined;
    return {
      type: typeof entry.type === "string" && sentTypes.has(entry.type) ? entry.type : TYPE_WITHHELD,
      value: typeof entry.value === "string" && isSentMessage(entry.value) ? entry.value : MESSAGE_WITHHELD,
      ...(isRecord(mechanism)
        ? {
            mechanism: {
              type: typeof mechanism.type === "string" && mechanismTypes.has(mechanism.type) ? mechanism.type : "generic",
              ...(typeof mechanism.handled === "boolean" ? { handled: mechanism.handled } : {}),
              ...(typeof mechanism.synthetic === "boolean" ? { synthetic: mechanism.synthetic } : {}),
              ...(isPosition(mechanism.exception_id) ? { exception_id: mechanism.exception_id } : {}),
              ...(isPosition(mechanism.parent_id) ? { parent_id: mechanism.parent_id } : {}),
            },
          }
        : {}),
      ...(Array.isArray(frames)
        ? {
            stacktrace: {
              type: "raw",
              frames: frames.filter(isRecord).slice(0, MAX_FRAMES).map((frame) => shapeFrame(frame, framePath)),
            },
          }
        : {}),
    };
  });
};

const count = z.number().int().min(0).max(1_000_000);
const ms = z.number().int().min(0).max(7 * 24 * 3_600_000);
const position = z.number().int().min(0).max(MAX_POSITION);
const flag = z.boolean();
const SFU_ID = z.string().regex(/^sfu_[0-9a-f]{16}$/);
const USER_ID = z.string().regex(/^user_[0-9a-f]{32}$/);
const ROOM_KEY = z.string().regex(/^room_[0-9a-f]{32}$/);

/** What posthog-node adds to every event before `beforeSend`, that we keep. */
const SDK_PROPERTIES = {
  $lib: z.literal("posthog-node"),
  $lib_version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/),
  $is_server: z.literal(true),
  $geoip_disable: z.literal(true),
};

const exceptionListForm = z
  .array(
    z.object({
      type: z.enum(SENT_ERROR_TYPES as [string, ...string[]]),
      value: z.string().refine(isSentMessage),
      mechanism: z
        .object({
          type: z.enum(MECHANISM_TYPES),
          handled: flag.optional(),
          synthetic: flag.optional(),
          exception_id: position.optional(),
          parent_id: position.optional(),
        })
        .optional(),
      stacktrace: z
        .object({
          type: z.literal("raw"),
          frames: z
            .array(
              z.object({
                platform: z.literal("node:javascript"),
                // A path in the SFU's folder, which shapeFrame checked exists there.
                filename: z.union([z.literal(PATH_WITHHELD), FRAME_FILE]).optional(),
                // A function of our own source, or none.
                function: z.union([z.literal(FUNCTION_WITHHELD), FUNCTION_NAME]),
                lineno: position.optional(),
                colno: position.optional(),
                in_app: flag.optional(),
              }),
            )
            .max(MAX_FRAMES),
        })
        .optional(),
    }),
  )
  .max(MAX_EXCEPTIONS);

export type GameCatalog = ReadonlyArray<{ id: string; options: readonly GameOptionSpec[] }>;

export type OutboundOptions = {
  /** The SFU's release, SFU_RELEASE. */
  release: string;
  framePath: (filename: string) => string;
  /** The games the SFU runs, whose ids and options game events may name; the same array until they change. */
  games: () => GameCatalog;
  /** Whether the server registered a handler for this socket event. */
  isSocketEvent: (name: string) => boolean;
};

/**
 * Every game's options as event properties: a number within its bounds, a
 * select as one of its choices, and a text option only as whether it was set.
 */
const gameConfigForms = (games: GameCatalog) => {
  const forms = new Map<string, z.ZodType[]>();
  const add = (key: string, form: z.ZodType) => forms.set(key, [...(forms.get(key) ?? []), form]);
  for (const option of games.flatMap((game) => game.options)) {
    if (option.type === "number") add(`config_${option.id}`, z.number().min(option.min).max(option.max));
    else if (option.type === "select") add(`config_${option.id}`, z.enum(option.choices.map((choice) => choice.value)));
    else add(`has_${option.id}`, flag);
  }
  return Object.fromEntries(
    [...forms].map(([key, list]) => [key, list.length === 1 ? list[0] : z.union(list as [z.ZodType, z.ZodType])]),
  );
};

/** Each event the SFU sends: the form of its distinct id and of each property. */
const outboundEvents = ({ release, isSocketEvent }: OutboundOptions, catalog: GameCatalog) => {
  const ids = catalog.map((game) => game.id);
  const gameId = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never();
  // A game's phase is a label its own state machine names, such as "lobby".
  const phase = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
  const groups = { $groups: z.object({ room: ROOM_KEY }) };
  const game = { ...SDK_PROPERTIES, ...groups };
  const played = { ...game, instance_id: z.uuid(), game_id: gameId, player_count: count };
  return {
    $exception: {
      distinctId: SFU_ID,
      properties: {
        ...SDK_PROPERTIES,
        $exception_list: exceptionListForm,
        $exception_level: z.enum(SERVER_ERROR_LEVELS),
        $process_person_profile: z.literal(false),
        source: z.enum(SERVER_ERROR_SOURCES),
        sfu_instance_id: SFU_ID,
        sfu_region: z.enum(SENT_REGIONS as [string, ...string[]]),
        sfu_version: z.literal(release),
        socket_event: z.string().refine(isSocketEvent),
        process_event: z.enum(["uncaughtException", "unhandledRejection"]),
        worker_label: z.string().regex(/^\d{1,4}$/),
        worker_pid: z.number().int().min(0).max(4_194_304),
        respawn_attempt: count,
      },
    },
    $groupidentify: {
      distinctId: USER_ID,
      properties: {
        ...SDK_PROPERTIES,
        $group_type: z.literal("room"),
        $group_key: ROOM_KEY,
        $group_set: z.object({}),
      },
    },
    game_started: {
      distinctId: USER_ID,
      properties: { ...played, has_leaderboard: flag, ...gameConfigForms(catalog) },
    },
    game_vote_resolved: {
      distinctId: USER_ID,
      properties: { ...played, candidate_count: count, vote_count: count },
    },
    game_vote_opened: {
      distinctId: USER_ID,
      properties: { ...game, candidate_count: count, player_count: count, is_full_catalog: flag },
    },
    game_vote_cancelled: {
      distinctId: USER_ID,
      properties: { ...game, candidate_count: count, vote_count: count, player_count: count },
    },
    game_finished: {
      distinctId: USER_ID,
      properties: { ...played, duration_ms: ms, phase, has_leaderboard: flag },
    },
    game_ended: {
      distinctId: USER_ID,
      properties: { ...played, duration_ms: ms, phase, has_leaderboard: flag },
    },
  } satisfies Record<string, { distinctId: z.ZodType; properties: Record<string, z.ZodType> }>;
};

/**
 * Builds the posthog-node `beforeSend` hook: each event rebuilt from the
 * schema, or null to drop one that is not on the list.
 */
export const createOutboundEvent = (options: OutboundOptions) => {
  // Built again only when the games' catalog changes, as when they register.
  let built: { catalog: GameCatalog; events: ReturnType<typeof outboundEvents> } | null = null;
  return (message: EventMessage): EventMessage | null => {
    const catalog = options.games();
    if (built?.catalog !== catalog) built = { catalog, events: outboundEvents(options, catalog) };
    const { events } = built;
    if (!Object.hasOwn(events, message.event)) return null;
    const schema = events[message.event as keyof typeof events];
    const distinctId = schema.distinctId.safeParse(message.distinctId);
    if (!distinctId.success) return null;
    const raw = message.properties ?? {};
    const properties: Record<string, unknown> = {};
    for (const [key, form] of Object.entries(schema.properties)) {
      const value: unknown =
        key === "$exception_list" ? shapeExceptionList(raw[key], options.framePath) : raw[key];
      const parsed = (form as z.ZodType).safeParse(value);
      if (parsed.success && parsed.data !== undefined) properties[key] = parsed.data;
    }
    const room = ROOM_KEY.safeParse(message.groups?.room);
    const uuid = z.uuid().safeParse(message.uuid);
    const personProfile = message.options?.process_person_profile;
    return {
      distinctId: distinctId.data,
      event: message.event,
      properties,
      ...(room.success ? { groups: { room: room.data } } : {}),
      ...(uuid.success ? { uuid: uuid.data } : {}),
      ...(message.timestamp instanceof Date ? { timestamp: message.timestamp } : {}),
      ...(typeof personProfile === "boolean" ? { options: { process_person_profile: personProfile } } : {}),
      ...(typeof message.disableGeoip === "boolean" ? { disableGeoip: message.disableGeoip } : {}),
    };
  };
};

// The SFU's own folder (packages/sfu, /app/packages/sfu in the image), whose
// source the server runs.
export const SFU_ROOT = fileURLToPath(new URL("../../", import.meta.url));
