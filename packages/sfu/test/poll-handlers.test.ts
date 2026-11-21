import { describe, expect, it } from "vitest";
import type { Socket } from "socket.io";
import type { Room } from "../config/classes/Room.js";
import type { ConnectionContext } from "../server/socket/context.js";
import { registerPollHandlers } from "../server/socket/handlers/pollHandlers.js";
import { PollBook } from "../server/polls.js";
import type { PollView } from "../types.js";

type Handler = (...args: unknown[]) => void;
type Ack = Record<string, unknown> & { error?: string; poll?: PollView };

type Member = {
  id: string;
  name: string;
  isHost: boolean;
  isWebinarAttendee: boolean;
  received: PollView[];
  call: (event: string, payload?: unknown) => Ack;
};

const createRoom = () => {
  const clients = new Map<string, Member>();
  let sessions = 0;
  const room = {
    id: "room",
    channelId: "default:room",
    clients,
    polls: new PollBook(),
    userKeysById: new Map<string, string>(),
    isAdminClient: (client: Member) => client.isHost,
    getDisplayNameForUser: (userId: string) => clients.get(userId)?.name,
  };

  const join = (
    name: string,
    role: { isHost?: boolean; isWebinarAttendee?: boolean } = {},
  ): Member => {
    const handlers = new Map<string, Handler>();
    const received: PollView[] = [];
    const socket = {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      emit: (event: string, payload: { poll: PollView }) => {
        if (event === "poll:changed") received.push(payload.poll);
      },
    };
    sessions += 1;
    const userId = `${name.toLowerCase()}@x.com#tab${sessions}`;
    const member = {
      id: userId,
      name,
      isHost: role.isHost ?? false,
      isWebinarAttendee: role.isWebinarAttendee ?? false,
      received,
      socket,
      call: (event: string, payload?: unknown): Ack => {
        let response: Ack | undefined;
        const ack = (value: Ack) => {
          response = value;
        };
        const handler = handlers.get(event);
        if (!handler) throw new Error(`no handler for ${event}`);
        if (payload === undefined) handler(ack);
        else handler(payload, ack);
        if (!response) throw new Error(`${event} did not ack`);
        return response;
      },
    };
    clients.set(userId, member);
    room.userKeysById.set(userId, `${name.toLowerCase()}@x.com`);
    registerPollHandlers({
      socket: socket as unknown as Socket,
      currentRoom: room as unknown as Room,
      currentClient: member,
    } as unknown as ConnectionContext);
    return member;
  };

  return { join };
};

const votesOf = (poll: PollView | undefined) =>
  poll?.options.map((option) => option.votes);

const launch = (host: Member) => {
  const created = host.call("poll:create", {
    question: "Ship on Friday?",
    options: ["Yes", "No"],
    choiceMode: "single",
  });
  expect(created.error).toBeUndefined();
  return (created.poll as PollView).id;
};

describe("poll socket handlers", () => {
  it("only lets hosts create polls", () => {
    const { join } = createRoom();
    const guest = join("Gia");

    expect(
      guest.call("poll:create", { question: "Q?", options: ["A", "B"] }).error,
    ).toBe("Only hosts can run polls");
    expect(guest.call("poll:getState").polls).toEqual([]);
  });

  it("enforces one vote per person on the server", () => {
    const { join } = createRoom();
    const host = join("Hana", { isHost: true });
    const guest = join("Gia");
    const pollId = launch(host);

    const first = guest.call("poll:vote", { pollId, optionIds: ["o1"] });
    expect(first.poll?.myVote).toEqual(["o1"]);

    const second = guest.call("poll:vote", { pollId, optionIds: ["o2"] });
    expect(second.error).toBe("You already voted");
    expect(second.poll?.myVote).toEqual(["o1"]);

    const sameIdentityOtherTab = join("Gia");
    expect(
      sameIdentityOtherTab.call("poll:vote", { pollId, optionIds: ["o2"] }).error,
    ).toBe("You already voted");

    expect(votesOf(host.received.at(-1))).toEqual([1, 0]);
  });

  it("keeps tallies private until the host shares them", () => {
    const { join } = createRoom();
    const host = join("Hana", { isHost: true });
    const guest = join("Gia");
    const voter = join("Vic");
    const pollId = launch(host);

    expect(guest.received).toHaveLength(1);
    expect(votesOf(guest.received[0])).toEqual([undefined, undefined]);

    voter.call("poll:vote", { pollId, optionIds: ["o2"] });
    expect(guest.received).toHaveLength(1);
    expect(votesOf(host.received.at(-1))).toEqual([0, 1]);

    host.call("poll:share", { pollId, shared: true });
    expect(guest.received.at(-1)).toMatchObject({ resultsShared: true, voterCount: 1 });
    expect(votesOf(guest.received.at(-1))).toEqual([0, 1]);
  });

  it("closes voting when the host ends the poll", () => {
    const { join } = createRoom();
    const host = join("Hana", { isHost: true });
    const guest = join("Gia");
    const pollId = launch(host);

    expect(guest.call("poll:end", { pollId }).error).toBe("Only hosts can run polls");
    host.call("poll:end", { pollId });
    expect(guest.received.at(-1)?.status).toBe("ended");
    expect(guest.call("poll:vote", { pollId, optionIds: ["o1"] }).error).toBe(
      "This poll has ended",
    );
  });

  it("gives a late joiner the current poll state", () => {
    const { join } = createRoom();
    const host = join("Hana", { isHost: true });
    const pollId = launch(host);
    join("Gia").call("poll:vote", { pollId, optionIds: ["o1"] });
    host.call("poll:end", { pollId });
    host.call("poll:share", { pollId, shared: true });

    const late = join("Lou");
    const [poll] = late.call("poll:getState").polls as PollView[];
    expect(poll).toMatchObject({ id: pollId, status: "ended", myVote: [] });
    expect(votesOf(poll)).toEqual([1, 0]);
  });

  it("exports ballots for hosts only", () => {
    const { join } = createRoom();
    const host = join("Hana", { isHost: true });
    const guest = join("Gia");
    const pollId = launch(host);
    guest.call("poll:vote", { pollId, optionIds: ["o2"] });

    expect(guest.call("poll:export", { pollId }).error).toBe("Only hosts can run polls");
    const [ballot] = host.call("poll:export", { pollId }).ballots as {
      name: string;
      optionIds: string[];
    }[];
    expect(ballot).toMatchObject({ name: "Gia", optionIds: ["o2"] });
  });

  it("leaves webinar attendees out", () => {
    const { join } = createRoom();
    const host = join("Hana", { isHost: true });
    const attendee = join("Ari", { isWebinarAttendee: true });
    const pollId = launch(host);

    expect(attendee.received).toEqual([]);
    expect(attendee.call("poll:getState").error).toBe("Polls are not available here");
    expect(attendee.call("poll:vote", { pollId, optionIds: ["o1"] }).error).toBe(
      "Polls are not available here",
    );
  });
});
