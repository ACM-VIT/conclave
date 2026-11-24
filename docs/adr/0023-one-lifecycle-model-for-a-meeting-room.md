# 0023. One lifecycle model for a meeting room

- Status: Accepted
- Date: 2026-11-23

## Context

PR #263 (knock by default, call recovery after a restart, the code's owner hosting, one owner per join) was fixed point by point, review round after review round, and each round's fix opened the next hole. The last point fixes left two: a tab that disconnected while reopening a lost call let the 10 s cleanup treat the unclaimed room as a finished meeting, which erased the lost call's hosts and removals and voided its passes; and a kick left the temporary host marker set, so the owner's later arrival demoted that key and readmitted the person it had removed. Both came from the same gap: no single description of what each event does to each piece of room state. The next review found a third: a returning member who took over an owned lost call, or someone a lapse made host, kept host rights after the owner arrived, because only one grant path set the temporary mark. The one after that found that a forced drain, and a stop on SIGTERM, disconnected everyone while the rooms were still registered, so the last disconnect ended the meeting the other SFU was meant to recover. Then: host reasons are per person and seats are per tab, so kicking one tab of a host took the reason but left their other tab hosting. Then two more of the same kind: a host-wait deadline armed before a drain fired during the drain's notice and ended the call, and an operator reset reached a promoted host through their other tab, because a promotion was per tab while a kick was per person.

## Decision

This model is the source of truth for the room lifecycle. Code and tests follow it.

### State

| Piece | Where | Meaning |
|---|---|---|
| `awaitingOpener` | Room | Created and not yet claimed. Holds the lost call it was created for, if any. |
| `restorer` | Room | Claimed by someone who may not host the lost call; waits for someone from it until the call's window ends. |
| `lostCallEnded` | Room | The lost call's window ran out (`endLostCall` ran). |
| `endedForEveryone` | Room | A host ended the meeting. |
| `handingOff` | Room | The server is letting go of the room (a drain, a stop, a dead media worker, another SFU taking it): its call goes on elsewhere. |
| `hostReasonsByKey` | Room | Every host and the one reason they host: `owner`, `cohost`, `temporary` or `opener`. `adminUserKeys` is its keys. |
| `hostUserKey` | Room | The primary host, always one of the hosts. |
| `allowedUsers`, `lockedAllowedUsers` | Room | Admissions. |
| `readmissionRequiredUserKeys`, `blockedUsers` | Room | Removals: a host removed, blocked or took admission back. |
| `pendingClients` | Room | Knocks. |
| `ownerEmail`, `recoveryPassesVoidUntil` | Room | Whose code it is; passes signed up to this time are void. |
| Recovery record | Ledger | Last seen running (`liveAt`), hosts, co-hosts, removals, `overAt`, writer, owner. A record seen running within 7 minutes is a lost call. |
| Invitee removals | Schedule | A booking's removed invitees, stamped, with the time removals last ended. |
| Next-meeting lobby | SFU | Knockers whose room closed, waiting for the next meeting at the code. |
| `joinAttempts` | Connection | Only the newest join of a connection may act. |

A room's stage follows from these: **Opening** (`awaitingOpener` set), **Recovering** (`restorer` set, window not over), **Lapsed** (`restorer` set, window over), **Running** (none of these, not ended), **Waiting for a host** (Running with nobody seated as host and nobody eligible to promote; bounded by `cleanupDeadline`), **Handing off** (Running, `handingOff` set), **Ended**. Only a Running or Handing off room records its call (`recordsItsCall`): it alone writes running records and hands out recovery passes. Only a Running room can end a meeting by emptying (`endsWhenEmpty`).

### Events

| Event | Stage | Hosts | Admissions and removals | Ledger, passes, schedule |
|---|---|---|---|---|
| A join creates the room | Opening | Restored from the lost call with their reasons, removed ones too (the join keeps them out until a host lets them in). Still unclaimed when the call's window ends, the lost call ends | Restored removals; locked | Nothing |
| A join claims an Opening room (it created it, may open the code, or is seated as its host) | One claim per room. Running if the claimer may host; Recovering if not. A lost call past its window ends first | The claimer hosts when Running, as a fallback | No change | Running: running record |
| A join into a claimed room | No change | Host only as the owner, a recorded host who is not removed (keeping their reason), someone from a Recovering call, or someone who may open a Lapsed one (both as a fallback) | Seated if admitted, invited and not removed, or the room is unlocked; else knocks | Pass if Running |
| Admit | No change | No change | Admission given; that person's removal and block cleared (the host decided) | Running record; schedule decision |
| Reject | No change | No change | Knock dropped | Nothing |
| Kick, block (with or without removing them) | No change | That key's host reason cleared, every tab of theirs stops hosting, then the host follow-up. A kick, and a block that removes, takes every tab of the person out of the call, each told it was removed | Admissions cleared; removal set; block also blocks | Running record; schedule decision |
| Revoke admission | No change | Kept, but a kept host right no longer gets past the removal | Removal set | Running record; schedule decision |
| Promote, transfer | No change | Co-host, whatever reason they had, on every tab of theirs; transfer also makes them primary. Promoting the owner's tab is the owner arriving | No change | Running record |
| Operator reset (`remove-non-admins`) | No change | No change: anyone holding a host reason is skipped, whichever tab is visited | Everyone else is kicked, as a kick | Running record; schedule decision |
| Owner arrives | Recovering or Lapsed: Running | Owner hosts and is primary; every temporary host is demoted; co-hosts keep their seat | Demoted host stays admitted only if not removed; the owner's own removal is cleared (nobody removes the owner from its code) | Running record |
| Seated person leaves | No change | Host follow-up | No change | Nothing |
| Knocker leaves | No change | No change | Knock dropped | Nothing |
| A newer join on the same connection, or a disconnect | The older join stops at its next wait and changes nothing | No change | No change | Nothing |
| 10 s open deadline, still Opening | Nobody in it: closed (abandoned opening). People in it: Recovering for a lost call, else Running | Running: the first participant hosts as a fallback | Knockers of a closed room go to the next-meeting lobby | Abandoned: nothing. Running: running record |
| Last seated person leaves | Closed | No change | Knockers go to the next-meeting lobby | Running: meeting over. Any other stage: nothing |
| Restart (the process died) | Rooms gone | Kept in the ledger | Kept in the ledger | The record is the lost call for 7 minutes; its passes stay good |
| Force drain (`POST /drain` or `/admin/drain` with `force`) | Handing off, then closed before anyone is disconnected | No change, and no fallback promotions while it hands off | No change; knockers and lobby guests are told to reconnect | The record is the lost call; nothing ends |
| Stop (SIGTERM or SIGINT) | Handing off before the sockets close | No change, and no fallback promotions as people disconnect | No change | The record is the lost call; nothing ends |
| Dead media worker | Handing off, closed, then its people are disconnected | No change | No change | The record is the lost call; nothing ends |
| Another SFU takes the room (lease lost or ownership moved) | Handing off, closed; its sockets stay | No change | No change | The record is the lost call; nothing ends |
| 7-minute lapse, nobody from the call came back | Lapsed. People in it: Running, one of them hosts as a fallback. Nobody in it: closed, knockers told to retry and parked | Cleared | Removals and blocks cleared | Meeting over |
| End for everyone | Ended, closed after the goodbye | No change | Knockers told it ended | Meeting over |
| Meeting over | | | | Ledger: over (hosts and removals emptied, passes before now void). Schedule: removals before now ended |

### Two endings

An **abandoned opening** is a room that closes before anyone claims it, or a Recovering room that closes before anyone from its call comes back. It writes nothing and ends nothing: the lost call, its passes and its removals stand until its window ends. A **meeting over** comes only from a Running room emptying, a lapse, or an end for everyone, and it alone clears hosts and removals or voids passes.

### Removal wins

No path that grants entry clears a removal it did not decide. Admit and allow are a host's decision and clear it. Demotion, locking the room, a recovery pass, an invitation, and a kept host or co-host right do not. Removing someone clears every mark tied to them: admissions, host, co-host and temporary host. The code's owner is the one exception: its own arrival clears its removal.

### Host follow-up

One function, `ensureHost`, runs after every kick, every block (whether or not it removes the person), every forced removal and every disconnect. It decides on what the action left, not on what the removed seat was: if nobody is seated as host, it promotes the first eligible participant as a fallback; if nobody is eligible, the room is Waiting for a host for `adminCleanupTimeout` (2 minutes), tells knockers nobody can let them in, and at the deadline promotes anyone eligible who arrived meanwhile, closes the room if it emptied, or ends the meeting for everyone. Eligible means not removed, not blocked and not needing readmission: a fallback never hands the host's seat to someone a host put out. It does nothing in a room that is Opening, Recovering, Handing off or Ended, which have deadlines of their own.

### Server-initiated shutdown

A drain, a stop, a dead media worker and a room another SFU takes over are not meetings ending. The room goes Handing off first: it still writes running records and hands out passes, but emptying ends nothing and nobody is promoted as its people disconnect. A drain closes its rooms the non-ending way before it disconnects anyone, as a dead worker does. The call stays a lost call in the ledger, with its hosts, removals and passes, and comes back on whichever SFU people reach.

The room owns every deadline that can end or change a meeting (the 10 s open deadline, the host wait, the lost call's window and its lapse) and arms them through one function. Entering Handing off cancels all of them, none arms while Handing off, and each checks the stage again when it fires, so a notice of any length cannot end the call it is handing off.

### Host reasons

Every host right goes through one function, `Room.grantHost(userKey, basis)`, which records why the person hosts. The basis is `owner` (the code's account), `promoted` (a host made them co-host or transferred to them, or a host claim the client policy allows) or `fallback` (they host because nobody better was there: they opened the room, took over a Recovering call with a pass or a Lapsed one, were promoted when the last host left, or were handed the room at the 10 s deadline or the lapse). A fallback is `temporary` on a code that has an owner and `opener` on one that has none. A grant never lowers a reason: owner over co-host over a fallback. The host map and the primary host are read-only outside `Room`, so nothing else can set host state; the compiler rejects a direct write. The ledger keeps which hosts are co-hosts, so a restart restores every reason. A record from an earlier build counts every host but its temporary one as a co-host.

When the owner's seat becomes a host (the owner joins, or a host promotes or hands the room to one of the owner's tabs), every temporary host loses host rights and stays an admitted participant if no host removed them; co-hosts keep theirs.

A reason belongs to a person (a user key) and a seat to a tab, so one person can hold several host seats. Whenever a reason goes (a kick, a block, a demotion, the lapse), every seat of that person stops being a host at once; no seat is ever a host without its person's reason. The same holds the other way: whenever a reason is granted (a promotion, a transfer, a fallback, a host's join), every seat of that person becomes a host at once and each is told. Host rights are per person, as a kick is.

### Invariants

1. A removed person never gets back in without a host letting them in (the owner excepted).
2. Inside its recovery window, a lost call keeps its hosts and removals in the ledger, and its passes stay good.
3. At most one join opens a room as its host, and while a call is lost only its hosts, its members who were not removed, or the owner host it.
4. No room stays locked with nobody to let anyone in past its deadline: 10 s while Opening, the lost call's window while Recovering, 2 minutes while Waiting for a host.
5. While the owner is here as host, the only hosts are the owner and the people a host made co-host.
6. Every host has exactly one recorded reason, and it is the right one.
7. No seat is a host (`Admin`) without a recorded host reason for its user key, whichever of the person's tabs it is.
8. A server-initiated shutdown (drain, stop, dead worker, another SFU taking the room) never ends a meeting, never voids its passes, and never adds to, clears or changes its hosts or removals, whatever deadline falls inside it.
9. A fallback never chooses a removed, blocked or needs-readmission person.
10. No seat belongs to a person a host kicked or blocked with removal, until a host lets them in again.
11. All seats of one person share one role: every tab of a host is a host, and no tab of anyone else is (observer and webinar attendee seats aside).

## Consequences

- A tab that goes away while reopening a lost call no longer erases that call. The room closes at 10 s with nothing written.
- A kicked or blocked temporary host loses that mark, and a demotion never readmits anyone.
- A co-host whose admission was taken back knocks like anyone else.
- An Opening room with people in it at 10 s is handed to them instead of staying locked with no host.
- A Lapsed room with nobody in it closes and parks its knockers for the next meeting, even if their tabs never ask again.
- Only a Running room hands out recovery passes. Someone seated in a Recovering room gets one at the next refresh after the call is running again, within a minute.
- A kick removes the person, not the tab: all of their tabs leave the call and are each told why, and a host cannot kick their own other tab. Taking admission back, and a block that does not remove, stay entry-only: that person keeps their seat but is never a fallback host. When the last host goes and only such people are left, nobody is promoted; the meeting ends 2 minutes later unless a host comes back. Blocking a meeting's only host promotes someone else, as removing them does.
- A drain or a stop no longer ends the calls on that SFU: they come back on the next SFU as recovered calls, with their hosts, removals and passes. That holds for a long notice too: a host wait or a lapse that would fall inside it never fires.
- Promoting one tab makes every tab of that person a host, and an operator reset never removes a host through another of their tabs.
- A revoked co-host keeps their reason across a restart, so letting them back in makes them a co-host again whether or not the SFU restarted.
- Anyone who hosts an owned code only as a fallback (a pass takeover, a lapse, the last host leaving, the 10 s handover) loses host rights when the owner arrives; a co-host a host promoted keeps them.
- Revisit if the stages become fields of their own, or if another path that grants entry is added: it must follow the removal rule.

## Alternatives considered

- **Keep fixing point by point:** rejected. Every round of point fixes opened another path.
- **One stage field on the room instead of `awaitingOpener`, `restorer` and `endedForEveryone`:** deferred. The stage is derived from them here, and the model test checks the derivation.
- **Close an Opening room with people in it at 10 s:** rejected. It would put people already in the call out.
- **Tie a pass to the room that wrote the lost record:** rejected. After two losses in a row it would turn away people whose pass came from the first room.

## Code

- `packages/sfu/config/classes/Room.ts`: `armLifecycleTimer`, `cancelLifecycleTimers`, `armOpeningDeadline`, `grantHost`, `seatsOf`, `hostReasonOf`, `makePrimaryHost`, `welcomeOwner`, `promoteClientToAdmin`, `restoreLostCall`, `recordsItsCall`, `beginHandOff`, `endsWhenEmpty`, `removeUser`, `keepAdmitted`, `blockUser`, `demoteToParticipant`, `endLostCall`
- `packages/sfu/server/roomRecoveryLedger.ts`: `coHostUserKeys` in the record
- `packages/sfu/server/serverShutdown.ts`: `forceDrainRooms`, `handOffRooms`; `createSfuServer` `stop`, `init.ts` `cleanupDeadWorkerRooms`, `rooms.ts` `handOffRoomState`
- `packages/sfu/test/server-shutdown.test.ts`: a forced drain through the real `POST /drain` route, and the operator block and reset routes
- `packages/sfu/server/http/createApp.ts`: the operator reset route
- `packages/sfu/server/admin/controlPlane.ts`: `ensureHost`, `settleUnclaimedRoom`, `offerLapsedRoom`, `kickClient`, `applyRoomPolicyUpdate`
- `packages/sfu/server/socket/handlers/joinRoom.ts`: the claim of an Opening room, the host decision for a removed key
- `packages/sfu/server/roomRecoveryPass.ts`: `issueRoomRecoveryPass`
- `packages/sfu/server/rooms.ts`: `cleanupRoom`, `noteMeetingOver`
- `packages/sfu/test/room-lifecycle-model.test.ts`: the seeded random sequences (300 in CI; `ROOM_LIFECYCLE_SEQUENCES` and `ROOM_LIFECYCLE_FIRST_SEED` for longer runs) and one scripted case per finding
