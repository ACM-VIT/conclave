# 0023. One lifecycle model for a meeting room

- Status: Accepted
- Date: 2026-11-23

## Context

PR #263 (knock by default, call recovery after a restart, the code's owner hosting, one owner per join) was fixed point by point, review round after review round, and each round's fix opened the next hole. The last point fixes left two: a tab that disconnected while reopening a lost call let the 10 s cleanup treat the unclaimed room as a finished meeting, which erased the lost call's hosts and removals and voided its passes; and a kick left the temporary host marker set, so the owner's later arrival demoted that key and readmitted the person it had removed. Both came from the same gap: no single description of what each event does to each piece of room state.

## Decision

This model is the source of truth for the room lifecycle. Code and tests follow it.

### State

| Piece | Where | Meaning |
|---|---|---|
| `awaitingOpener` | Room | Created and not yet claimed. Holds the lost call it was created for, if any. |
| `restorer` | Room | Claimed by someone who may not host the lost call; waits for someone from it until the call's window ends. |
| `lostCallEnded` | Room | The lost call's window ran out (`endLostCall` ran). |
| `endedForEveryone` | Room | A host ended the meeting. |
| `hostUserKey`, `adminUserKeys`, `temporaryHostUserKey` | Room | Host, co-hosts, and the person who hosts only because the owner was away. |
| `allowedUsers`, `lockedAllowedUsers` | Room | Admissions. |
| `readmissionRequiredUserKeys`, `blockedUsers` | Room | Removals: a host removed, blocked or took admission back. |
| `pendingClients` | Room | Knocks. |
| `ownerEmail`, `recoveryPassesVoidUntil` | Room | Whose code it is; passes signed up to this time are void. |
| Recovery record | Ledger | Last seen running (`liveAt`), hosts, temporary host, removals, `overAt`, writer, owner. A record seen running within 7 minutes is a lost call. |
| Invitee removals | Schedule | A booking's removed invitees, stamped, with the time removals last ended. |
| Next-meeting lobby | SFU | Knockers whose room closed, waiting for the next meeting at the code. |
| `joinAttempts` | Connection | Only the newest join of a connection may act. |

A room's stage follows from these: **Opening** (`awaitingOpener` set), **Recovering** (`restorer` set, window not over), **Lapsed** (`restorer` set, window over), **Running** (none of these, not ended), **Ended**. Only a Running room records its call (`recordsItsCall`): it alone writes running records, hands out recovery passes, and can end a meeting by emptying.

### Events

| Event | Stage | Hosts | Admissions and removals | Ledger, passes, schedule |
|---|---|---|---|---|
| A join creates the room | Opening | Restored from the lost call, less anyone removed | Restored removals; locked | Nothing |
| A join claims an Opening room (it created it, or may open the code) | One claim per room. Running if the claimer may host; Recovering if not. A lost call past its window ends first | The claimer hosts when Running; temporary host if the code has another owner | No change | Running: running record |
| A join into a claimed room | No change | Host only as the owner, a recorded host or co-host who is not removed, someone from a Recovering call, or someone who may open a Lapsed one | Seated if admitted, invited and not removed, or the room is unlocked; else knocks | Pass if Running |
| Admit | No change | No change | Admission given; that person's removal and block cleared (the host decided) | Running record; schedule decision |
| Reject | No change | No change | Knock dropped | Nothing |
| Kick, block | No change | That key's host, co-host and temporary host marks cleared | Admissions cleared; removal set; block also blocks | Running record; schedule decision |
| Revoke admission | No change | Kept, but a kept host right no longer gets past the removal | Removal set | Running record; schedule decision |
| Promote, transfer | No change | Co-host (temporary mark cleared), or host | No change | Running record |
| Owner arrives | Recovering or Lapsed: Running | Owner hosts; the temporary host is demoted | Demoted host stays admitted only if not removed; the owner's own removal is cleared (nobody removes the owner from its code) | Running record |
| Seated person leaves | No change | If no host is left, the next participant is promoted | No change | Nothing |
| Knocker leaves | No change | No change | Knock dropped | Nothing |
| A newer join on the same connection, or a disconnect | The older join stops at its next wait and changes nothing | No change | No change | Nothing |
| 10 s open deadline, still Opening | Nobody in it: closed (abandoned opening). People in it: Recovering for a lost call, else Running | Running: the first participant hosts | Knockers of a closed room go to the next-meeting lobby | Abandoned: nothing. Running: running record |
| Last seated person leaves | Closed | No change | Knockers go to the next-meeting lobby | Running: meeting over. Any other stage: nothing |
| Restart | Rooms gone | Kept in the ledger | Kept in the ledger | The record is the lost call for 7 minutes; its passes stay good |
| 7-minute lapse, nobody from the call came back | Lapsed. People in it: Running, one of them hosts. Nobody in it: closed, knockers told to retry and parked | Cleared | Removals and blocks cleared | Meeting over |
| End for everyone | Ended, closed after the goodbye | No change | Knockers told it ended | Meeting over |
| Meeting over | | | | Ledger: over (hosts and removals emptied, passes before now void). Schedule: removals before now ended |

### Two endings

An **abandoned opening** is a room that closes before anyone claims it, or a Recovering room that closes before anyone from its call comes back. It writes nothing and ends nothing: the lost call, its passes and its removals stand until its window ends. A **meeting over** comes only from a Running room emptying, a lapse, or an end for everyone, and it alone clears hosts and removals or voids passes.

### Removal wins

No path that grants entry clears a removal it did not decide. Admit and allow are a host's decision and clear it. Demotion, locking the room, a recovery pass, an invitation, and a kept host or co-host right do not. Removing someone clears every mark tied to them: admissions, host, co-host and temporary host. The code's owner is the one exception: its own arrival clears its removal.

### Invariants

1. A removed person never gets back in without a host letting them in (the owner excepted).
2. Inside its recovery window, a lost call keeps its hosts and removals in the ledger, and its passes stay good.
3. At most one join opens a room as its host, and while a call is lost only its hosts, its members who were not removed, or the owner host it.
4. No room stays locked with nobody to let anyone in past its deadline: 10 s while Opening, the lost call's window while Recovering.

## Consequences

- A tab that goes away while reopening a lost call no longer erases that call. The room closes at 10 s with nothing written.
- A kicked or blocked temporary host loses that mark, and a demotion never readmits anyone.
- A co-host whose admission was taken back knocks like anyone else.
- An Opening room with people in it at 10 s is handed to them instead of staying locked with no host.
- A Lapsed room with nobody in it closes and parks its knockers for the next meeting, even if their tabs never ask again.
- Only a Running room hands out recovery passes. Someone seated in a Recovering room gets one at the next refresh after the call is running again, within a minute.
- Revisit if the stages become fields of their own, or if another path that grants entry is added: it must follow the removal rule.

## Alternatives considered

- **Keep fixing point by point:** rejected. Every round of point fixes opened another path.
- **One stage field on the room instead of `awaitingOpener`, `restorer` and `endedForEveryone`:** deferred. The stage is derived from them here, and the model test checks the derivation.
- **Close an Opening room with people in it at 10 s:** rejected. It would put people already in the call out.
- **Tie a pass to the room that wrote the lost record:** rejected. After two losses in a row it would turn away people whose pass came from the first room.

## Code

- `packages/sfu/config/classes/Room.ts`: `recordsItsCall`, `removeUser`, `keepAdmitted`, `blockUser`, `demoteToParticipant`, `endLostCall`
- `packages/sfu/server/admin/controlPlane.ts`: `settleUnclaimedRoom`, `offerLapsedRoom`, `kickClient`, `applyRoomPolicyUpdate`
- `packages/sfu/server/socket/handlers/joinRoom.ts`: the claim of an Opening room, the host decision for a removed key
- `packages/sfu/server/roomRecoveryPass.ts`: `issueRoomRecoveryPass`
- `packages/sfu/server/rooms.ts`: `cleanupRoom`, `noteMeetingOver`
- `packages/sfu/test/room-lifecycle-model.test.ts`: the seeded random sequences (300 in CI; `ROOM_LIFECYCLE_SEQUENCES` and `ROOM_LIFECYCLE_FIRST_SEED` for longer runs) and one scripted case per finding
