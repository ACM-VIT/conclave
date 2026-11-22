# Authority Runtime

Server-authoritative apps: state lives on the SFU, and each connection is sent only what it may see. The author surface is in `@conclave/apps-sdk/authority` (shared) and `@conclave/apps-sdk/authority/server` (SFU only). The host is in `packages/sfu/server/apps/authority`.

## What the host guarantees

These hold whatever an app's code or a client does.

| Area | Guarantee |
| --- | --- |
| Membership | Every request and every frame resolves the connection against the live room: the registered room, the exact client object, its socket, and that the socket is connected. A saved room or client is never trusted. |
| Invalidation | A subscription ends when its seat is replaced, removed or disconnected, or when its socket switches room. It restarts under a new generation when the seat's role changes or the room's mode changes. The room's mode and flags are read again before every frame, each later part of a large view or result included, so a change nobody announced still takes effect before the next send. |
| Subjects | One identity adapter turns a connection into an opaque room-scoped subject. Apps never see a user key, an email or a socket. |
| Personal rows | Reach every live connection of their owner and nobody else. |
| Retries | An operation id carries a nonce and an issue time. Its receipt is bound to the subject and the parsed request and is kept for as long as the id is valid. A repeat replays the first answer. The same id with a different request fails. An expired id fails. A resend stays in the room it was first sent to: when the room epoch changes, the client ends the action as `unknown-outcome`. |
| Delivery | Written rows are projected once per audience role. A recipient is sent a row only when its projection differs from what that audience holds, so a write nobody in an audience can see sends that audience nothing. |
| Transactions | A handler runs to completion alone. A rejection or a throw keeps none of its writes. A handler must be done when it returns: one that returns a promise is a fault and keeps nothing. A gate, `canView` or identity rule admits only on its exact answer, so one that returns a promise admits nobody. |
| Outputs | A projection or query result with a field its schema does not name is withheld. |

The uniqueness guarantee is one per verified subject. Two guest passes issued separately cannot be shown to be different people.

## Trust

Modules are reviewed code from this repository, listed by import in the SFU registry. Nothing a room, a client or a URL names is loaded. A module is trusted: the host bounds what it can do, but a module that projects a private field to the wrong role is a bug the review and the audience tests must catch.

## Wire

Old servers and old clients do not know these events. Support is learned from the capabilities exchange and from nothing else.

| Event | Direction | Purpose |
| --- | --- | --- |
| `apps:authority:capabilities` | client, acked | protocol, room epoch and the apps this connection may open |
| `apps:authority:capabilitiesChanged` | server | the same, when eligibility changes |
| `apps:authority:subscribe` | client, acked | open a view; the view follows as frames |
| `apps:authority:unsubscribe` | client | close it |
| `apps:authority:act` | client, acked | run an action under an operation id |
| `apps:authority:query` | client, acked | a one-shot read for the caller alone |
| `apps:authority:frame` | server | `replace`, `patch`, `revoke`, `query`, `queryAbort` |

A `replace` frame is a whole view under a new generation. It is read from the committed rows, so it never carries a row that was hidden, changed or removed a moment earlier, even when the flush that tells the other viewers has yet to run. A large one arrives in parts and is installed only when the last part is in. The parts are cut from one view, and each later part is sent as that view stands when it leaves: a row hidden since the first part is left out, and one that changed goes as it is. Nothing else is sent while the parts go. After the last, one patch catches the viewer up: what the parts carried, set against the view as committed at that moment, so it never sends a row older than one the viewer already has, nor one their view no longer has. A `patch` puts and removes whole rows and carries a per-subscription sequence that counts only frames sent. It carries `grants` when what the viewer may do has changed and their view has not been replaced. That is what a change of room policy sends: each viewer gets the rows that came out different for them, often none, and what they may now do. No view is sent again unless a snapshot was still on its way. Each connection is patched from its own snapshot on: it is not sent a change that snapshot already had, nor the key of a row that was gone before it. Frames also carry `revision`, the view's own version, and the client exposes it as `state.revision`, kept rising across a new subscription. It counts only that viewer: it moves when a frame completes a change to their view or replaces it, never for writes they cannot see, so nobody can count private ballots from it. A large clear sent over several flushes moves it with the flush that sends its last removals. An action's answer, a replayed one included, names the version that shows the action: the next one if the action wrote something, otherwise the one the viewer holds. A version an answer named is always sent at the next flush, even when nothing in the view changed, for example when two of their tabs cancelled each other out. An optimistic flag over the view belongs until `state.revision` reaches it, and no longer. A `revoke` withdraws the view, and the client forgets what it held. A client that sees a gap subscribes again.

The room epoch changes when the room is recreated. A request under an old epoch fails with `stale-epoch`.

## Limits

| Limit | Value |
| --- | --- |
| Action or query input | 16 KiB |
| Snapshot or query result | 1 MiB, sent in 64 KiB parts |
| Flush interval | 50 ms, immediate after a quiet period |
| Operation id validity | 120 s, issue time at most 5 s ahead |
| Accepted mutations per app per room | 120 a second, burst 240. Moderators have this to themselves and everyone else has it between them, so a crowd cannot use up a host's |
| Work in one transaction | 50,000 operations. A read or write is one. A `scan` costs one for each row it returns. Rows that are only walked, as `count` and `clear` do under a prefix, cost about one per 64. An action that goes over fails and keeps nothing, even if its handler catches the error |
| Rows of a `clear` that viewers who held them are told of per flush | 1,000 for each role, and 1,000 between everyone's own rows |
| Subscriptions per socket | 16 |
| Socket behind (resnapshot later) | more than 256 queued packets or 1 MiB. The queue is counted in bytes on every transport, long polling included, and asked before every frame, the catch-up after a snapshot in parts among them |
| Query on a socket that is behind | refused with `busy` |
| Streamed result on a socket that falls behind | waits for it, cut off after 5 s |
| Socket disconnected | more than 4,096 queued packets or 8 MiB |

Each table declares its own row cap. Per-action rates are declared by the module and follow the person across tabs. All of these are starting budgets in `limits.ts`.

## Turning it on

Set `SFU_APPS_AUTHORITY_ENABLED=1` on the SFU. With it off no authority event has a listener, so the SFU behaves like one that predates the runtime: a client's capability request goes unanswered and it opens no authority app. The web client then lists Polls and meeting Q&A in the Apps panel switched off, each with "Needs a server update", so their absence is explained. It does the same on any server that answers and does not offer them, such as one that runs the runtime without these two apps.

The switch is read once, when the SFU process starts. Changing it needs a restart of the SFU, and there is no live toggle. A process that is already running keeps the mode it started with for every room it holds, so during a rolling deploy the rooms on the old process stay as they were until they move or end.

Deploy the SFU before the web client that uses a new app or a new contract major. A room pins the modules it started with.

## Measuring

```bash
pnpm -C packages/sfu exec tsx scripts/measure-authority-scale.ts 50
pnpm -C packages/sfu exec tsx scripts/measure-authority-load.ts --out report.json
```

The first prints the runtime's own CPU and frame counts in process. The second starts a real SFU, joins real sockets through `joinRoom`, offers about 100 actions a second and reports the SFU's event-loop delay against an idle baseline, bytes read at each recipient's TCP socket, and unauthorized frames, which must be 0.

## State lifetime

State lives in the SFU process for the lifetime of the room. It is lost if the process dies, as game state is. A recreated room has a new epoch and starts empty.

## Apps that run on it

| App | Folder | What the server holds |
| --- | --- | --- |
| Polls | `src/apps/polls` | polls, one ballot per person per poll, results private to hosts until shared. A host's export is read in pages of at most 512 KiB and joined in the browser |
| Q&A | `src/apps/qa` | questions, one upvote per person per question, a question a host hides is seen by hosts only, and is gone for everyone else, its asker included, until a host brings it back. The book holds at most 300 questions and 400 KiB, so every viewer's view fits in one snapshot |

Both are panel apps. They open from the Apps panel, beside whatever is on the stage, and never take the stage or the whiteboard. Each has its hook in `web` (`usePolls`, `useQa`) and the web client draws the panel.

A signed-in person votes, asks and upvotes once per account across tabs and rejoins. A guest in a meeting can read both apps and is told to sign in to take part, until the verified guest pass gives guests an identity that survives a rejoin. In a webinar an attendee may ask and upvote as before.

### The old Q&A events

Released web and native clients send `webinar:qa:submit`, `webinar:qa:upvote` and `webinar:qa:moderate`, and are sent `webinar:qaSnapshot` and `webinar:qaChanged`. In a room that runs the Q&A app those events are an adapter over the app's book (`server/apps/authority/legacyWebinarQa.ts` in the SFU), so an old client and a new one see the same questions:

- A joining connection is followed as the app would follow it and is sent the old snapshot and change events. The adapter holds no questions, no copy of anyone's view and no visibility rule of its own. A frame only tells it which questions changed for a connection. What it says is read from that connection's view as committed at the moment of saying, after the seat has been checked against the room again, so a question hidden a moment before is said to be gone and never as it was.
- A connection is fed the old events for as long as it does not read Q&A itself. Once it holds its own subscription to the app the feed rests, and it starts again with a whole list when that subscription ends. Asking for capabilities changes nothing: the answer may reach a client after it has given up waiting and fallen back to the old events.
- A changed question is one `webinar:qaChanged` for each connection, as the old wire has it. The event is built and encoded once for everyone it reads the same for, which is everyone of a role who neither asked nor upvoted the question, and sockets are written 2,000 events a turn. A connection is sent a question again only when it reads differently from what it was last sent.
- A whole list is shared the same way. It holds the questions as anyone of a role reads them, is built and encoded once for all of them, and is written to 100 sockets a turn. A connection's own questions, which name it as the asker, follow as changes.
- Before anything is said to a connection its socket's queue is checked, as the runtime checks it before a frame. A socket that is behind is sent nothing more, whatever asked for it, and once it has caught up it is sent one whole list with the state as it is then.
- A change of room policy sends a list only to a connection whose view was withdrawn or given back, as an attendee's is when webinar mode goes off and on. Turning Q&A off or on changes who may ask and sends nothing on these events.
- The old upvote is a toggle. It runs the app's `toggleUpvote` action, and the reply carries the count that one transaction made.
- The native app up to build 63 saves the questions it upvoted and shows that over what a change event says. Whenever a person's upvote changes, on any of their connections, each of their old clients has what it saved checked against the book a flush interval later. One that still lists a question whose upvote is gone is sent a whole `webinar:qaSnapshot`, the one form that build applies to what it saved. This holds when two taps land in one flush and leave no change to send.
- A question that is gone, dropped from a full book or hidden by a host, is said to be gone once to each connection that lists it. The upvotes that go with a dropped question bring no list and no second word.
- The old events carry webinar Q&A only. Nothing is sent on them in a regular meeting.
- A seat id for the asker is given to hosts and to the asker. Everyone else gets an empty `userId`.

With the flag off the old events are served by the SFU's own webinar Q&A code, unchanged.

## What native needs

The native app does not speak this transport yet. To host an authority app it needs:

1. The seven events above in `SfuEvents.swift`, generated from one source with the web names.
2. A Swift/Skip session per app: the capabilities exchange, subscribe, frame application (`replace` in parts, `patch` with the sequence check and its optional `grants`, `revoke`), and `act` with a retained operation id and retry inside one room epoch. `client.ts` is the reference, about 500 lines with no framework in it.
3. Fixtures shared with TypeScript: recorded frame sequences that both decoders must turn into the same view.
4. Clearing held rows on leave, reconnect and revoke, and on any reuse of a web view. On web, `AuthorityProvider` does this when `joined` goes false, through the client's `left()`.
5. A local panel selection in the Activities sheet, separate from the stage.

Until then native keeps its existing activities and ignores the new events. Legacy `webinar:qa:*` keeps working against a new SFU.

For polls and Q&A in particular:

1. Two panels in the Activities sheet, built on the session above: a poll list with create, vote, end, share and CSV export for hosts, and a question list with ask, upvote and the host's answer, dismiss and reopen.
2. The same gating as web: show an app only when the SFU lists it in capabilities, and show the sign-in prompt when `needsIdentity` names the action.
3. Webinar Q&A on native keeps working through the old events with no change. Moving it to the app's session is what brings Q&A to native meetings.
4. A poll started while the panel is closed should raise the same "Vote" prompt the web toast does.
