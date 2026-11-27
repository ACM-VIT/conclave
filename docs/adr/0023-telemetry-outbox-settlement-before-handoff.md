# 0023. Apply telemetry settlement before handing a batch to another tab

- Status: Accepted
- Date: 2026-11-27

## Context

A tab can learn the result of an unload beacon while a confirmation request is still in flight. An answer kept only in that tab still applies when the tab saves the batch for another tab. A saved batch can also outlive the five-minute mark retention period if no tab could finish it.

## Decision

| What the tab knows | What it does |
| --- | --- |
| A terminal reply, or every event was refused | Do not send, save for handoff, or count the batch as expired. |
| A partial refusal or retry floor | Filter refused UUIDs and preserve the later retry time and higher attempt count before sending, saving for handoff, or counting expiry. |
| A previously saved batch has unreadable marks | Defer send, handoff, and expiry until the marks can be read, unless local facts already prove settlement. |
| A valid mark is past its retention period | Prune it only after confirming its batch is absent. This also applies when the store needs space for another mark. |

Handoff saves the reconciled batch with the same claim and lease. It does not replace another tab's saved claim. The store refuses new marks at capacity if it cannot safely reclaim space. A local answer cannot reach another tab if neither the mark nor the reconciled batch can be saved.
