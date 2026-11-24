# Build an Authority App

An authority app keeps its state on the SFU. Participants send actions, the server decides, and each connection receives only the rows it may see. Use it for anything a participant must not be able to forge or read: a vote, a hidden answer, a draw, a sign-up sheet with one slot each.

A shared Yjs document is still the right tool for content with no rules, such as whiteboard strokes. Every participant can read and rewrite a Yjs document, so it cannot hold a ballot.

## Scaffold

```bash
pnpm -C packages/apps-sdk run new:app sign-up --runtime authority
```

An app id is at most 48 lowercase letters, digits and dashes, starting with a letter. That rule is `appIdSchema` in `@conclave/apps-sdk/authority`, and `defineContract`, `new:app` and `check:apps` all check an id against it. The id is also the app's folder and the first part of its package subpaths, so `new:app` refuses one the SDK already uses (`authority`, `native-embed`, `sdk`, `apps`, `core`, `web`, `server`, `native`) and one `package.json` already exports something under. It refuses before writing any file.

This creates three entry points:

| Entry | Loaded by | Holds |
| --- | --- | --- |
| `core/index.ts` | browser and SFU | the contract: action, query and view shapes |
| `server/index.ts` | SFU only | tables, rules, projections, timers |
| `web/index.ts` | browser | the panel that renders the view |

`check:apps` fails any browser or native file that imports a `server` entry, so private rules and answer keys cannot reach a bundle. It reads imports from the syntax tree, however the path is written. It also fails an import whose path is built at run time where that path could reach server code, because a bundler ships every file such a path could name.

## 1. Write the contract

```ts
import { defineContract, s } from "@conclave/apps-sdk/authority";

export const signUpContract = defineContract({
  id: "sign-up",
  major: 1,
  surface: "panel",
  actions: {
    join: { input: s.null(), receipt: s.null() },
    leave: { input: s.null(), receipt: s.null() },
  },
  queries: {},
  views: {
    entries: s.object({
      id: s.string({ max: 64 }),
      name: s.string({ max: 200 }),
      joinedAt: s.number(),
    }),
    mine: s.object({}),
  },
});
```

Inputs are parsed at the socket before any rule runs. Unknown input fields are dropped. Outputs are checked the other way: a projected row with a field its schema does not name is withheld, so a view cannot leak a field by accident.

## 2. Write the rules

```ts
import {
  defineAuthority, key, reject, table, type Subject,
} from "@conclave/apps-sdk/authority/server";

type Entry = { id: string; subject: Subject; name: string; joinedAt: number; order: number };
const ORDER = key("last");

export const signUpAuthority = defineAuthority({
  contract: signUpContract,
  tables: {
    entries: table<Entry>({ maxRows: 500 }),
    order: table<{ last: number }>({ maxRows: 1 }),
  },
  timers: {},
  canView: ({ role }) => role === "moderator" || role === "member",
  actions: {
    join: {
      roles: ["moderator", "member"],
      rate: { burst: 5, perSecond: 1 },
      run(ctx, tx) {
        const order = (tx.get("order", ORDER)?.last ?? 0) + 1;
        tx.put("order", ORDER, { last: order });
        tx.insertIfAbsent("entries", key(ctx.subject), {
          id: ctx.nextId("e"),
          subject: ctx.subject,
          name: ctx.displayName,
          joinedAt: ctx.now,
          order,
        });
        return null;
      },
    },
    // ...
  },
  queries: {},
  onTimer: {},
  views: {
    entries: {
      kind: "shared",
      source: "entries",
      project: (row) => ({
        key: row.id,
        value: { id: row.id, name: row.name, joinedAt: row.joinedAt },
      }),
    },
    mine: {
      kind: "personal",
      source: "entries",
      owner: (row) => row.subject,
      project: () => ({ key: "entry", value: {} }),
    },
  },
  mergeSubjects(_ctx, tx, { from, into }) {
    const entry = tx.get("entries", key(from));
    if (!entry) return undefined;
    tx.delete("entries", key(from));
    const kept = tx.get("entries", key(into));
    if (!kept || entry.order < kept.order) {
      tx.put("entries", key(into), { ...entry, subject: into });
    }
    return undefined;
  },
});
```

An app with a personal view keeps rows by person, so it must define `mergeSubjects`. The room can learn late that two subjects are one person, for example a guest whose two tabs got different passes. It then runs `mergeSubjects` once in every app, in one transaction, and moves everything kept under `from` to `into`. After the merge the person has one subject everywhere.

The rule a merge follows: it leaves what one person would have if they had done the surviving actions themselves, in the order they happened.

- Of two actions that are one per person (two ballots in one poll, two answers in one round, two joins), the earlier one survives, because the later one would have been refused.
- A rule an action checks is applied the way the action checked it: in the order the actions happened, against the state at that moment. A cap on open questions is checked against the questions open when each one was asked, so a question answered before the next was asked frees its place, and one reopened later does not take it back. Keep where in that order a row changed state if a rule depends on it.
- Of two writes of the same row, the later one survives, because it would have overwritten the first.
- Counts, totals and scores are worked out again from what survives, and stored results (a tally, a leaderboard) are rebuilt.
- A merge sees the rows, not the history, so store each action's place in a strict order whenever that order decides which row survives or how a rule applied. A time is not enough, because two actions can share a millisecond. Keep a counter row the app bumps once per action, as the `order` table above does, and compare by it.
- A field that only records when a row last changed, such as `updatedAt`, may keep the later time.
- An action of one subject that undid or cleared the other subject's rows saw none of them, so a merge cannot reproduce it; both effects stay.

A merge must cost in proportion to the two subjects' own rows, never the room's. Read only what is theirs: point reads and scans under a key that starts with the subject. Where a table is keyed by something else first (a ballot by poll, an answer by round), keep a second table keyed by subject and use it. A result that ranks everyone, such as a leaderboard, is updated from the merged person's entry rather than rebuilt from every row. If it keeps only the top of the list, store whether it holds everyone, because a merge shortens the list and its length then says nothing. Rebuild it only when too few are left to show.

Check a merge with `mergeAgainstOnePerson` in `packages/sfu/test/authority/merge-check.ts`: it plays a script once as two subjects followed by the merge and once as one person, and compares every table. A step marked `sameMoment` happens in the same millisecond as the step before it. Order numbers are compared by rank and the counter row is left out, because a merged person may have made an action that one person would have been refused. Check its cost with `mergeCost`, which plays the same script with a crowd of other subjects. Every crowd action must succeed, so the check lifts the room's shared action rate while it sets up the room, and keeps the transaction budget. The merge's operations must be the same for a crowd of ten as for thousands.

The four things a module has:

- **Tables.** Keyed rows with a row cap. Writes happen only inside a handler's transaction: `get`, `insertIfAbsent`, `put`, `delete`, `clear`, `count` and `scan` by key prefix. Committed rows are frozen.
- **Actions.** A role list, an optional `when` condition, a rate, and a synchronous handler. The host checks the gate and parses the input before your code runs. Return the receipt, or call `reject("reason")` to refuse and keep nothing.
- **Views.** A shared view is projected once per audience role and cannot see who is looking. A personal view names an `owner` and reaches every connection of that subject and nobody else. Someone who opens the app is handed the rows as committed, so hiding a row takes effect for new viewers at once. People already watching are told within a flush interval.
- **Timers.** `tx.schedule(kind, key, atMs, payload)` inside a transaction, handled in `onTimer`. Recheck the phase in the handler: a timer for a round that has moved on should do nothing. Handlers are synchronous. An `async` timer handler does not compile, and any handler that returns a promise is a fault that keeps none of its writes.

### A parent and its rows

Key a parent's rows by the parent, as in `key(questionId, ctx.subject)`, and drop them with `tx.clear("upvotes", key(questionId))`. A transaction has a budget of 50,000 operations, and deleting rows one at a time costs two each, so a loop over a parent's rows fails the whole action once there are enough of them. `clear` costs about one operation per 64 rows. Reading, counting and clearing under a key prefix cost the rows under that prefix and no others, however large the table is. An action that runs out of budget fails and keeps nothing. Catching the error does not change that. When the transaction commits the rows are gone for every handler and from every view, so a new viewer is never sent one and a new row may take a view key one of them had. People who already held such a row are told a batch at a time.

### Once per person

Key the row by the subject and use `insertIfAbsent`. `key(pollId, ctx.subject)` is one ballot, and a second insert reports `exists`. Handlers never interleave, so two tabs cannot both pass the check.

`ctx.subject` is opaque, scoped to the room, and derived by the server. It is the same for a person across tabs and reconnects.

### Who counts as one person

An action needs a verified subject by default. A signed-in participant has one. A guest has one once the guest pass vouches for them. A guest without a verified pass gets `identity-required`, and the renderer is told through `state.needsIdentity`, so it can say why.

Set `identity: "any"` on an action whose rule does not rest on one-per-person, such as a host-only control.

### Projected keys

Each row a view projects needs its own key within its bucket. Use an id from `ctx.nextId()` stored on the row. If two rows project to one key, the runtime keeps the first and withholds the second.

### Cross-row data

A projector sees its own row, the viewer's role and the room policy. It cannot read another table. Keep a tally on the row it belongs to and update it in the same transaction as the ballot.

## 3. Render it

```tsx
import { useAuthority } from "@conclave/apps-sdk";

export function SignUpPanel() {
  const app = useAuthority(signUpContract);
  if (app.state.kind !== "ready") return <p>Not available here</p>;
  const { view, actions } = app.state;
  const joined = view.mine.size > 0;
  return (
    <button
      disabled={!actions.has(joined ? "leave" : "join")}
      onClick={() => void app.act(joined ? "leave" : "join", null)}
    >
      {joined ? "Leave the list" : "Join the list"}
    </button>
  );
}
```

`state.kind` is `ready` once the server has sent the view. `unsupported` means this server does not offer the app to this connection, which includes every SFU that predates the runtime. Hide the app's entry points in that case with `useAuthorityAvailable(contract)`.

`act` resolves with the server's answer. If the answer is lost it resends under the same operation id, so one press is one action.

## 4. Register it

1. Import the app's `server` entry in `packages/sfu/server/apps/authority/registry.ts`. The SFU runs only modules listed there.
2. List the app in the web meeting host.
3. Run `pnpm -C packages/apps-sdk run check:apps`.

## Test it

Write tests against the real runtime with the harness in `packages/sfu/test/authority/harness.ts`. Each tab is a real client session that holds only what the server sent it, so a passing check also shows the patch stream reproduces the server's view. Assert what a participant can and cannot see, and include a canary: a private value that must never appear in another audience's frames.

See [Authority Runtime](../reference/authority-runtime.md) for the guarantees, the wire and the limits.
