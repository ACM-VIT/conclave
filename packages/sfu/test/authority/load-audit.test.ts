/**
 * The load measurement's oracle. Its verdict is the count of unauthorized
 * frames, so it must neither miss a row that is someone else's nor blame a
 * person for a row that was theirs when the server sent it.
 */
import { describe, expect, it } from "vitest";
import type { AuthorityFrame, ProjectedRow } from "@conclave/apps-sdk/authority";
import { LoadAudit, type AuditPerson } from "../../scripts/authority-load-audit.js";

const hostPerson: AuditPerson = { key: "host@load.test", name: "Host", host: true };
const priya: AuditPerson = { key: "priya@load.test", name: "Priya", host: false };

/** A patch the server sent at `sentAt` on its own clock. */
const patch = (sentAt: number, ...put: ProjectedRow[]): AuthorityFrame => ({
  kind: "patch",
  subscription: "sub",
  generation: 1,
  serverNowMs: sentAt,
  seq: 1,
  put,
  remove: [],
});

const upvoteRow = (questionId: string): ProjectedRow => ({
  bucket: "myUpvotes",
  key: questionId,
  value: {},
});

/** An audit on a clock the test moves, with Priya's socket in the room. */
const setup = () => {
  const clock = { now: 1_000 };
  const audit = new LoadAudit(() => clock.now);
  const receive = (frame: AuthorityFrame, person = priya, removed = false) =>
    audit.frame({ person, removed }, frame);
  /** Sends an upvote or take-back at `sentAt` that is answered at `ackedAt`. */
  const upvote = (value: boolean, sentAt: number, ackedAt: number, ok = true) => {
    clock.now = sentAt;
    const answered = audit.upvote(priya, "q1", value);
    clock.now = ackedAt;
    answered(ok);
  };
  return { clock, audit, receive, upvote };
};

describe("a person's own upvote rows", () => {
  it("accepts a row sent while the upvote stood, however late it arrives", () => {
    const { clock, audit, receive, upvote } = setup();
    upvote(true, 1_000, 1_010);
    upvote(false, 2_000, 2_010);

    // Her other tab's socket was slow: the row left the server at 1 500.
    clock.now = 9_000;
    receive(patch(1_500, upvoteRow("q1")));

    expect(audit.finish().violations).toEqual([]);
  });

  it("flags a row sent after the take-back was answered, however soon it arrives", () => {
    const { clock, audit, receive, upvote } = setup();
    upvote(true, 1_000, 1_010);
    upvote(false, 2_000, 2_010);

    clock.now = 2_100;
    receive(patch(2_050, upvoteRow("q1")));

    expect(audit.finish().violations).toEqual(["Priya: someone else's upvote q1"]);
  });

  it("accepts a row when two tabs raced and the upvote landed second", () => {
    const { clock, audit, receive } = setup();
    // One tab upvotes and the other takes back in the same instant. The
    // server ran the take-back first, so the upvote stands.
    clock.now = 1_000;
    const upvoted = audit.upvote(priya, "q1", true);
    const takenBack = audit.upvote(priya, "q1", false);
    clock.now = 1_001;
    takenBack(true);
    clock.now = 1_002;
    upvoted(true);

    clock.now = 1_060;
    receive(patch(1_050, upvoteRow("q1")));

    expect(audit.finish().violations).toEqual([]);
  });

  it("flags a row for an upvote the server refused", () => {
    const { clock, audit, receive, upvote } = setup();
    upvote(true, 1_000, 1_010, false);

    clock.now = 1_100;
    receive(patch(1_050, upvoteRow("q1")));

    expect(audit.finish().violations).toEqual(["Priya: someone else's upvote q1"]);
  });

  it("flags a row for a question the person never upvoted", () => {
    const { audit, receive } = setup();

    receive(patch(1_000, upvoteRow("q9")));

    expect(audit.finish().violations).toEqual(["Priya: someone else's upvote q9"]);
  });
});

describe("question rows", () => {
  const questionRow = (id: string): ProjectedRow => ({
    bucket: "myQuestions",
    key: id,
    value: { hidden: null },
  });

  it("holds a row that beat its ack, and clears it once the ack names the question", () => {
    const { audit, receive } = setup();

    receive(patch(1_000, questionRow("q1")));
    audit.asked(priya, "q1");

    expect(audit.finish()).toEqual({ violations: [], questionRowsJudgedLate: 1 });
  });

  it("judges every row received before the verdict, whenever it came", () => {
    const { audit, receive } = setup();
    audit.finish();

    // A row that arrives while the script waits for the SFU's own report.
    receive(patch(1_000, questionRow("q2")));

    expect(audit.finish().violations).toEqual(["Priya: someone else's question q2"]);
  });

  it("flags a question a host hid that is sent to its own asker", () => {
    const { audit, receive } = setup();
    audit.asked(priya, "q3");

    // Still waiting in a webinar: theirs to see.
    receive(
      patch(1_000, {
        bucket: "myQuestions",
        key: "q3",
        value: { hidden: { question: { status: "pending" }, upvotes: 0 } },
      }),
    );
    // Hidden by a host: nobody's to see but a host's, the asker's included.
    receive(
      patch(1_010, {
        bucket: "myQuestions",
        key: "q3",
        value: { hidden: { question: { status: "dismissed" }, upvotes: 0 } },
      }),
    );

    expect(audit.finish().violations).toEqual(["Priya: their own hidden question q3"]);
  });
});

describe("other people's rows", () => {
  it("flags a private tally, another person's ballot and a dismissed question", () => {
    const { audit, receive } = setup();

    receive(
      patch(
        1_000,
        { bucket: "results", key: "p1", value: { voterCount: 3 } },
        { bucket: "myVotes", key: "p1", value: { optionIds: ["o1"] } },
        { bucket: "questions", key: "q1", value: { status: "dismissed" } },
      ),
    );
    receive(patch(1_000, { bucket: "results", key: "p1", value: { voterCount: 3 } }), hostPerson);

    expect(audit.finish().violations).toEqual([
      "Priya: private tally for poll p1",
      "Priya: someone else's ballot p1",
      "Priya: dismissed question q1",
    ]);
  });

  it("accepts a person's own ballot and flags any frame after removal", () => {
    const { audit, receive } = setup();
    audit.vote(priya, "p1");

    receive(patch(1_000, { bucket: "myVotes", key: "p1", value: { optionIds: ["o1"] } }));
    receive(patch(1_100), priya, true);

    expect(audit.finish().violations).toEqual(["Priya: patch frame after removal"]);
  });
});
