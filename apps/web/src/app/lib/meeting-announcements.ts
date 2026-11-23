import type { ChatMessage, Participant } from "./types";
import { isSystemUserId } from "./utils";

export type MeetingAnnouncement =
  | { kind: "joined" | "left" | "raisedHand"; name: string }
  | { kind: "chat"; name: string; phrase: string; isPrivate: boolean };

export type RoomRoster = Map<string, { name: string; handRaised: boolean }>;

export const QUIET_JOIN_LEAVE_AT = 30;
const MAX_CHAT_TEXT = 140;

export function rosterOf(
  participants: Map<string, Participant>,
  currentUserId: string,
  nameOf: (userId: string) => string,
): RoomRoster {
  const roster: RoomRoster = new Map();
  for (const participant of participants.values()) {
    if (participant.userId === currentUserId) continue;
    if (isSystemUserId(participant.userId)) continue;
    if (participant.isLeaving) continue;
    roster.set(participant.userId, {
      name: nameOf(participant.userId),
      handRaised: participant.isHandRaised,
    });
  }
  return roster;
}

export function diffRoster(
  previous: RoomRoster,
  next: RoomRoster,
): MeetingAnnouncement[] {
  const quiet = Math.max(previous.size, next.size) >= QUIET_JOIN_LEAVE_AT;
  const events: MeetingAnnouncement[] = [];
  for (const [userId, person] of next) {
    const before = previous.get(userId);
    if (!before) {
      if (!quiet) events.push({ kind: "joined", name: person.name });
    } else if (person.handRaised && !before.handRaised) {
      events.push({ kind: "raisedHand", name: person.name });
    }
  }
  if (!quiet) {
    for (const [userId, person] of previous) {
      if (!next.has(userId)) events.push({ kind: "left", name: person.name });
    }
  }
  return events;
}

export function chatAnnouncement(message: ChatMessage): MeetingAnnouncement {
  const content = message.content.trim();
  const text = content.length > MAX_CHAT_TEXT ? `${content.slice(0, MAX_CHAT_TEXT)}…` : content;
  const isPrivate = Boolean(message.isDirect);
  const sent = isPrivate ? "sent you a private" : "sent a";
  const phrase = content
    ? isPrivate
      ? `sent you a private message: ${text}`
      : `says: ${text}`
    : message.gif
      ? `${sent} GIF`
      : message.image
        ? isPrivate
          ? "sent you a private image"
          : "sent an image"
        : `${sent} message`;
  return { kind: "chat", name: message.displayName || "Someone", phrase, isPrivate };
}

const listNames = (names: string[]): string => {
  const unique = Array.from(new Set(names));
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique[0]} and ${unique.length - 1} others`;
};

export function phraseAnnouncements(events: MeetingAnnouncement[]): string {
  const namesFor = (kind: MeetingAnnouncement["kind"]) =>
    events.filter((event) => event.kind === kind).map((event) => event.name);
  const sentences: string[] = [];
  const joined = namesFor("joined");
  if (joined.length) sentences.push(`${listNames(joined)} joined`);
  const left = namesFor("left");
  if (left.length) sentences.push(`${listNames(left)} left`);
  const hands = namesFor("raisedHand");
  if (hands.length) {
    sentences.push(
      `${listNames(hands)} ${new Set(hands).size === 1 ? "raised a hand" : "raised their hands"}`,
    );
  }
  const chats = events.filter(
    (event): event is Extract<MeetingAnnouncement, { kind: "chat" }> =>
      event.kind === "chat",
  );
  for (const [group, plural] of [
    [chats.filter((chat) => !chat.isPrivate), "new messages"],
    [chats.filter((chat) => chat.isPrivate), "private messages"],
  ] as const) {
    if (group.length === 1) {
      sentences.push(`${group[0].name} ${group[0].phrase}`);
    } else if (group.length > 1) {
      sentences.push(`${group.length} ${plural} from ${listNames(group.map((chat) => chat.name))}`);
    }
  }
  return sentences.join(". ");
}
