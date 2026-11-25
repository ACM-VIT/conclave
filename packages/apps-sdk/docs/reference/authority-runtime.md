# Authority Runtime

Server-authoritative apps: state lives on the SFU, and each connection is sent only what it may see. The author surface is in `@conclave/apps-sdk/authority` (shared) and `@conclave/apps-sdk/authority/server` (SFU only). The host is in `packages/sfu/server/apps/authority`.

## What the host guarantees

These hold whatever an app's code or a client does.

| Area | Guarantee |
| --- | --- |
| Membership | Every request and every frame resolves the connection against the live room: the registered room, the exact client object, its socket, and that the socket is connected. A saved room or client is never trusted. |
| Invalidation | A subscription ends when its seat is replaced, removed or disconnected, or when its socket switches room. It restarts under a new generation when the seat's role changes or the room's mode changes. The room's mode and flags are read again before every frame, each later part of a large view or result included, so a change nobody announced still takes effect before the next send. |
| Subjects | One identity adapter turns a connection into an opaque room-scoped subject. Apps never see a user key, an email or a socket. A person's name reaches an app at most `DISPLAY_NAME_MAX_LENGTH` (200) long, cut at its end where it is longer, so an app that bounds the names it stores by that constant is never handed one it would refuse. |
| Personal rows | Reach every live connection of their owner and nobody else. |
| One person, one subject | When the room learns that two subjects are one person (a guest whose passes it links), it keeps the subject that already holds app state and merges the other into it before any later request from that person. A merge is all or nothing across the room, and it is staged once. When a join plans the link, every app's `mergeSubjects` runs in its own staged transaction, and every row it would write is run through that app's views (owner and projection, for every role); the saved answers must also fit one person's cap. A fault, a refusal, a spent budget or a failed view check in any app refuses the link: each pass keeps its own subject and rows, and the SFU logs which app refused. The commit applies exactly what the plan staged, never a second run, and takes the merged rows into the views from the owner and projection results the plan checked, so it calls none of the apps' code again. It first checks that no app has committed anything since and that the guest's app state is as planned, then commits every app and moves the saved answers, and only then records the link. Nothing in it can stop part way: a view callback that throws while committed rows are taken in withholds that row (logged, and thrown at the next flush under view verification), as a projection that throws always has, and the row is tried again on the next flushes. A join that relied on a link whose commit does not happen is refused and asked to join again. An app with a personal view must define `mergeSubjects`; `defineAuthority` refuses one without it. |
| Retries | An operation id carries a nonce and an issue time. Its receipt is bound to the subject and the parsed request and is kept for as long as the id is valid. A repeat from a connection that may still view the app replays the first answer before any gate, identity rule, rate or budget is checked again, so a resend after a host closed Q&A, after a role change or after the person's passes were linked gets what happened. Receipts go wherever the subject's rows go when two subjects merge. They expire with their id and are swept on a timer, and an expired one never counts against the per-person cap. A client whose answer was lost does not give up when the resend meets the socket's act limit: only the transport limit sits before the receipt lookup, and a resend is safe to repeat, so it pauses and sends again. No wait outlives the id, the wait for an answer included: when one would, or the id's time runs out, the action ends as `unknown-outcome`, which says it may or may not have applied. The same id with a different request fails. An expired id fails. A resend stays in the room it was first sent to: when the room epoch changes, the client ends the action as `unknown-outcome`. |
| Delivery | Written rows are projected once per audience role, as each transaction commits, so the views are always the committed rows and reading them never changes them. A recipient is sent a row only when its projection differs from what that audience holds, so a write nobody in an audience can see sends that audience nothing. Each projected row needs its own key: a row that claims a key another row holds is withheld, and takes the key when it is given up, so a key handed from one row to another over two writes ends with the second. One still withheld at a flush is logged as a bug in the app. |
| Transactions | A handler runs to completion alone. A rejection or a throw keeps none of its writes. A handler must be done when it returns: one that returns a promise is a fault and keeps nothing. A gate, `canView` or identity rule admits only on its exact answer, so one that returns a promise admits nobody. |
| Outputs | A projection or query result with a field its schema does not name is withheld. A projection or a personal view's owner that throws, with any value, `undefined` included, withholds its row; the row is tried again on each of the next three flushes, and after that when it is next written. |

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

A `replace` frame is a whole view under a new generation. It is read from the committed rows, so it never carries a row that was hidden, changed or removed a moment earlier, even when the flush that tells the other viewers has yet to run. A large one arrives in parts and is installed only when the last part is in. Each part's whole frame, envelope and all, stays within the part size, or carries one row. Rows can grow while the parts are on their way: a view that would pass the snapshot limit, as its parts carry it or as the catch-up after the last part would leave it, is withdrawn as `too-large` before it can be installed. The parts are cut from one view, and each later part is sent as that view stands when it leaves: a row hidden since the first part is left out, and one that changed goes as it is. Nothing else is sent while the parts go. After the last, one patch catches the viewer up: what the parts carried, set against the view as committed at that moment, so it never sends a row older than one the viewer already has, nor one their view no longer has. A `patch` puts and removes whole rows and carries a per-subscription sequence that counts only frames sent. It carries `grants` when what the viewer may do has changed and their view has not been replaced. That is what a change of room policy sends: each viewer gets the rows that came out different for them, often none, and what they may now do. No view is sent again unless a snapshot was still on its way. Each connection is patched from its own snapshot on: it is not sent a change that snapshot already had, nor the key of a row that was gone before it. Frames also carry `revision`, the view's own version, and the client exposes it as `state.revision`, kept rising across a new subscription. It counts only that viewer: it moves when a frame completes a change to their view or replaces it, never for writes they cannot see, so nobody can count private ballots from it. Rows a `clear` took are told to each viewer in its own turn: at most a budget of them a flush, counting only rows that viewer held, in the order of the clears and then by bucket and key. Rows they never held are passed over and cost them nothing, so what a viewer hears of a clear, and when, follows from its own view alone: neither a fresh tab nor anyone's private rows change it. They are told whether or not anything else changed in that flush, and a viewer's version moves with the flush that sends the last such row it held. An action's answer, a replayed one included, names the first version at which that subscription's view shows everything committed so far that changes it, the action and anyone else's writes alike. Only the subscription's own state decides it: whether its delivery was skipped because its socket fell behind (the answer then names the snapshot that recovers it), whether a snapshot of its own is still in parts, and what changed in its view since its snapshot. So it is the next version if anything committed has yet to reach that view, and the one the viewer holds otherwise, whatever happened before the subscription began. "Yet to reach" sets each row the viewer holds against what the committed rows project for them now. Writes are taken into the views as they commit, so another person opening the app reads the views without changing them, and changes nothing anyone else is sent or answered. The check costs nothing that grows with what waits for the next flush: a viewer from before everything pending is answered from counts kept as changes are noted, and an answer once named is not worked out again before the flush that sends it. Every frame lists its rows by bucket, then key, so not even their order follows what a cache took in when. A version an answer named is always sent at the next flush, even when nothing in the view changed, for example when two of their tabs cancelled each other out. An optimistic flag over the view belongs until `state.revision` reaches it, and no longer. One timing signal is left, and known: a flush runs at once when the room has been quiet and at most once an interval when it is busy, so when a viewer's frames arrive follows activity in the whole room. No count of writes kept from a viewer reaches them this way. A fixed tick would remove it at the cost of up to one interval of latency on a lone action, so it is not done. A `revoke` withdraws the view, and the client forgets what it held. A client that sees a gap subscribes again.

On the client, an app is unsupported only when the server's capability answer does not offer it, or the server never answers. A subscribe refused as `forbidden` revokes the view. Any other refusal, such as `rate-limited`, `capacity`, `busy` or a stale room or seat, leaves the view on its way: the client asks what the server offers again when the refusal says the room moved on, and subscribes again after a wait that doubles each time from half a second to 30 s, shortened by up to a quarter at random so clients refused together do not ask again together. An action pressed meanwhile waits for the view. Its issue time is read from the server's clock when it is first sent, as the capability answer told it until a frame does, so a client whose own clock is off is not refused for it.

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
| Rows of a `clear` one viewer is told of per flush | 1,000, counting only rows that viewer held |
| Subscriptions per socket | 16 |
| Socket behind (resnapshot later) | more than 256 queued packets or 1 MiB. The queue is counted in bytes on every transport, long polling included, and asked before every frame, the catch-up after a snapshot in parts among them |
| Query on a socket that is behind | refused with `busy` |
| Streamed result on a socket that falls behind | waits for it, cut off after 5 s |
| Socket disconnected | more than 4,096 queued packets or 8 MiB |

Each table declares its own row cap. Per-action rates are declared by the module and follow the person across tabs. All of these are starting budgets in `limits.ts`.

## Turning it on

Set `SFU_APPS_AUTHORITY_ENABLED=1` on the SFU. With it off no authority event has a listener, so the SFU behaves like one that predates the runtime: a client's capability request goes unanswered and it hides every authority app.

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

## What native needs

The native app does not speak this transport yet. To host an authority app it needs:

1. The seven events above in `SfuEvents.swift`, generated from one source with the web names.
2. A Swift/Skip session per app: the capabilities exchange, subscribe, frame application (`replace` in parts, `patch` with the sequence check and its optional `grants`, `revoke`), and `act` with a retained operation id and retry inside one room epoch, which keeps resending after a lost answer even when a resend is answered `rate-limited`, and never waits past the id's deadline. `client.ts` is the reference, about 500 lines with no framework in it.
3. Fixtures shared with TypeScript: recorded frame sequences that both decoders must turn into the same view.
4. Clearing held rows on leave, reconnect and revoke, and on any reuse of a web view. On web, `AuthorityProvider` does this when `joined` goes false, through the client's `left()`, and asks nothing before the room is joined.
5. A local panel selection in the Activities sheet, separate from the stage.

Until then native keeps its existing activities and ignores the new events. Legacy `webinar:qa:*` keeps working against a new SFU.
