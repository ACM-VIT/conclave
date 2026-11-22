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

A `replace` frame is a whole view under a new generation. A large one arrives in parts and is installed only when the last part is in. A `patch` puts and removes whole rows and carries a per-subscription sequence that counts only frames sent. A `revoke` withdraws the view, and the client forgets what it held. A client that sees a gap subscribes again.

The room epoch changes when the room is recreated. A request under an old epoch fails with `stale-epoch`.

## Limits

| Limit | Value |
| --- | --- |
| Action or query input | 16 KiB |
| Snapshot or query result | 1 MiB, sent in 64 KiB parts |
| Flush interval | 50 ms, immediate after a quiet period |
| Operation id validity | 120 s, issue time at most 5 s ahead |
| Accepted mutations per app per room | 120 a second, burst 240 |
| Reads and writes in one transaction | 50,000. `clear` removes any number of rows for about one per 64 |
| Rows of a `clear` told to viewers per flush | 1,000 |
| Subscriptions per socket | 16 |
| Socket behind (resnapshot later) | more than 256 queued packets or 1 MiB |
| Query on a socket that is behind | refused with `busy` |
| Streamed result on a socket that falls behind | waits for it, cut off after 5 s |
| Socket disconnected | more than 4,096 queued packets or 8 MiB |

Each table declares its own row cap. Per-action rates are declared by the module and follow the person across tabs. All of these are starting budgets in `limits.ts`.

## Turning it on

Set `SFU_APPS_AUTHORITY_ENABLED=1` on the SFU. With it off no authority event has a listener, so the SFU behaves like one that predates the runtime: a client's capability request goes unanswered and it hides every authority app.

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
2. A Swift/Skip session per app: the capabilities exchange, subscribe, frame application (`replace` in parts, `patch` with the sequence check, `revoke`), and `act` with a retained operation id and retry inside one room epoch. `client.ts` is the reference, about 500 lines with no framework in it.
3. Fixtures shared with TypeScript: recorded frame sequences that both decoders must turn into the same view.
4. Clearing held rows on leave, reconnect and revoke, and on any reuse of a web view. On web, `AuthorityProvider` does this when `joined` goes false, through the client's `left()`.
5. A local panel selection in the Activities sheet, separate from the stage.

Until then native keeps its existing activities and ignores the new events. Legacy `webinar:qa:*` keeps working against a new SFU.
