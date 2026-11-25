# 0023. One lifecycle model for a meeting room

- Status: Accepted
- Date: 2026-11-23

## Context

PR #263 (knock by default, call recovery after a restart, the code's owner hosting, one owner per join) was fixed point by point, review round after review round, and each round's fix opened the next hole. The last point fixes left two: a tab that disconnected while reopening a lost call let the 10 s cleanup treat the unclaimed room as a finished meeting, which erased the lost call's hosts and removals and voided its passes; and a kick left the temporary host marker set, so the owner's later arrival demoted that key and readmitted the person it had removed. Both came from the same gap: no single description of what each event does to each piece of room state. The next review found a third: a returning member who took over an owned lost call, or someone a lapse made host, kept host rights after the owner arrived, because only one grant path set the temporary mark. The one after that found that a forced drain, and a stop on SIGTERM, disconnected everyone while the rooms were still registered, so the last disconnect ended the meeting the other SFU was meant to recover. Then: host reasons are per person and seats are per tab, so kicking one tab of a host took the reason but left their other tab hosting. Then two more of the same kind: a host-wait deadline armed before a drain fired during the drain's notice and ended the call, and an operator reset reached a promoted host through their other tab, because a promotion was per tab while a kick was per person. The final review after that found the same gap from the other side: paths the model never drove. A turned-away webinar attendee left its new room unclaimed forever, a host switching rooms on one socket left the old room with no host and no deadline, a switch overtaken mid-way left the new room's host wait cancelled, and a host blocked without removal was never told. The guest pass (#264) landed at the same time and made "a person" a guest with one key per tab. The review after the merge found four places that still compared raw keys: the ledger kept a removed guest's tab key but not the pass behind it, so a fresh tab after a restart walked back in; a co-host's second tab got a temporary reason of its own, which the owner's arrival then took away from the whole person; the occupancy route asked about `guest-<sessionId>`, which a guest with a pass no longer joins as; and the self-kick check let a guest host remove their own other tab.

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
| Admission ledger | Room | Admissions and refusals by pass and by key (#264). A guest is every key of the same pass group; "a person" below means that guest, or one signed-in account. |
| `readmissionRequiredUserKeys`, `blockedUsers` | Room | Removals: a host removed, blocked or took admission back. |
| `pendingClients` | Room | Knocks. |
| `ownerEmail`, `recoveryPassesVoidUntil` | Room | Whose code it is; passes signed up to this time are void. |
| Recovery record | Ledger | Last seen running (`liveAt`), hosts, co-hosts, removals, `overAt`, writer, owner. A record seen running within 7 minutes is a lost call. |
| Invitee removals | Schedule | A booking's removed invitees, stamped, with the time removals last ended. |
| Next-meeting lobby | SFU | Knockers whose room closed, waiting for the next meeting at the code. |
| `joinAttempts` | Connection | Only the newest join of a connection may act. A join attempt per tab and per room is counted too: the last join for a room settles it if it is still unclaimed. |

A room's stage follows from these: **Opening** (`awaitingOpener` set), **Recovering** (`restorer` set, window not over), **Lapsed** (`restorer` set, window over), **Running** (none of these, not ended), **Waiting for a host** (Running with nobody seated as host and nobody eligible to promote; bounded by `cleanupDeadline`), **Handing off** (Running, `handingOff` set), **Ended**. Only a Running or Handing off room records its call (`recordsItsCall`): it alone writes running records and hands out recovery passes. Only a Running room can end a meeting by emptying (`endsWhenEmpty`).

### Events

| Event | Stage | Hosts | Admissions and removals | Ledger, passes, schedule |
|---|---|---|---|---|
| A join creates the room | Opening. The claim is released only when a join is seated or queued; when the last join for the room ends without that, the room is settled at once (closed if nobody is in it, else handed to its people), and the 10 s deadline is there for a join that hangs | Restored from the lost call with their reasons, removed ones too (the join keeps them out until a host lets them in). Still unclaimed when the call's window ends, the lost call ends | Restored removals; locked | Nothing |
| A join claims an Opening room (it created it, may open the code, or is seated as its host) | One claim per room. Running if the claimer may host; Recovering if not. A lost call past its window ends first | The claimer hosts when Running, as a fallback | No change | Running: running record |
| A join into a claimed room | No change | Host only as the owner, a recorded host who is not removed (keeping their reason), a person who hosts here right now (their new tab gets their live role), someone from a Recovering call, or someone who may open a Lapsed one (both as a fallback). An eligible person seated in a Running room with no host is made host at once | Seated if admitted, invited and not removed, or the room is unlocked and they were not removed; else knocks | Pass if Running |
| Admit | No change | No change | Admission given; that person's removal and block cleared (the host decided) | Running record; schedule decision |
| Reject | No change | No change | Knock dropped | Nothing |
| Kick, block (with or without removing them) | No change | That key's host reason cleared, every tab of theirs stops hosting, then the host follow-up. A kick, and a block that removes, takes every tab of the person out of the call, each told it was removed | Admissions cleared; removal set; block also blocks | Running record; schedule decision |
| Revoke admission | No change | Kept, but a kept host right no longer gets past the removal | Removal set | Running record; schedule decision |
| Promote, transfer | No change | Co-host, whatever reason they had, on every tab of theirs; transfer also makes them primary. Promoting the owner's tab is the owner arriving | No change | Running record |
| Operator reset (`remove-non-admins`) | No change | No change: anyone holding a host reason is skipped, whichever tab is visited | Everyone else is kicked, as a kick | Running record; schedule decision |
| Owner arrives | Recovering or Lapsed: Running | Owner hosts and is primary; every temporary host is demoted; co-hosts keep their seat | Demoted host stays admitted only if not removed; the owner's own removal is cleared (nobody removes the owner from its code) | Running record |
| Seated person leaves (closes the tab, drops past the grace, switches to another room on the same socket, or is removed) | No change | One teardown (`teardownClient`) and the host follow-up, for every one of these | No change | Nothing |
| A switch to another room on the same socket | The new room's seat is made before anything awaits; the socket joins the new room's channel as it is seated and leaves the old one after | Host follow-up for the old room | No change | Nothing |
| Knocker leaves | No change | No change | Knock dropped | Nothing |
| A newer join on the same connection, or a disconnect | The older join stops at its next wait and changes nothing | No change | No change | Nothing |
| 10 s open deadline, still Opening | Nobody in it: closed (abandoned opening). People in it: Recovering for a lost call still in its window, else Running (a lost call past its window ends) | Running: the first participant hosts as a fallback | Knockers of a closed room go to the next-meeting lobby | Abandoned: nothing. Running: running record |
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

One function, `ensureHost`, runs after every kick, every block (whether or not it removes the person), every forced removal and every disconnect. It decides on what the action left, not on what the removed seat was: if nobody is seated as host, it promotes the first eligible participant as a fallback; if nobody is eligible, the room is Waiting for a host for `adminCleanupTimeout` (2 minutes), tells knockers nobody can let them in, and at the deadline promotes anyone eligible who arrived meanwhile, closes the room if it emptied, or ends the meeting for everyone. Eligible means not removed, not blocked and not needing readmission: a fallback never hands the host's seat to someone a host put out. It also runs when a seat joins a room with no host, so an eligible arrival is made host at once instead of at the deadline. It does nothing in a room that is Opening, Recovering, Handing off or Ended, which have deadlines of their own.

### Announcing roles

Every role change goes through one function, `Room.publishRoles`, called by the only two seat-role mutators (`promoteSeatsOf`, `demoteSeatsWithoutRights`) and by a change of primary host. It tells the apps (`membership`), each promoted tab (`hostAssigned`, once, and never a webinar attendee's tab), each demoted tab (`hostRemoved`), and every seat the room's hosts (`hostChanged`, `adminUsersChanged`). No caller can change a role without all four, and no caller sends any of them itself.

### One grant path

Every host grant goes through one function, `applyHostGrant(room, { userKey, basis, guestProof?, primary? }, { joining? })` in `packages/sfu/server/admin/controlPlane.ts`: a join that hosts (as the owner, a recorded or live host, with a host claim, as the opener, or taking over a lost call), a promotion, a transfer (`primary: true`), and every fallback (`ensureHost`, its deadline, the 10 s handover and the lapse). It does all of it, in one turn and in this order: `Room.mayGrantHost` (never a blocked person; a fallback never goes to a person who needs readmission or to a room handing off, unless that person hosts here right now), `Room.grantHost` (the reason, every seat of the person that may host, and the announcement), the primary host if there is none (or always, for a transfer), the owner's arrival (`welcomeOwner` and its notice), and then every promoted seat is made able to act as host before anything awaits: its socket's context points at the seat and room, and the admin handlers are registered. Seats other than the joining one also get the host's snapshots (lobby, chat, lock, room state); the joining seat gets them from its join. Knockers are told a host is available when the room had none. A join grants only after its seat is in the room, so the grant reaches every tab of the person, the joining one included, and a join that stops at a later wait leaves no host seat that cannot act. `restoreLostCall` is the one other caller of `grantHost`: it runs while the room is created, before any seat exists. Nothing else may call `grantHost` or change a seat's class.

### Server-initiated shutdown

A drain, a stop, a dead media worker and a room another SFU takes over are not meetings ending. The room goes Handing off first: it still writes running records and hands out passes, but emptying ends nothing and nobody is promoted as its people disconnect. A drain closes its rooms the non-ending way before it disconnects anyone, as a dead worker does. The call stays a lost call in the ledger, with its hosts, removals and passes, and comes back on whichever SFU people reach.

A server writes what other servers read about a room (the recovery record, an invitee's removal or readmission, the end of a meeting and its removals) only through `writeSharedRoomState` in `rooms.ts`, and signs recovery passes only while `holdsRoomLease` says yes (the check and the signature are one synchronous step, and the pass carries the time it was signed).

Every shared write is fenced at commit, not at the check. A claim of a code that was not already this server's gets a new **ownership generation** from the registry (on Redis, the server's clock in milliseconds and never below the last one handed out for that code, so a Redis restart that loses the keys still hands out a larger one; the local registry keeps one per code until it releases the code). Before a new room reads anything, it fences: it writes its generation into the booking's write marker (SQLite table, JSON field, Redis hash) and publishes a copy of the newest recovery record under its own id and generation. Every later write carries the generation it was decided under, and the store applies it only if no newer generation has fenced it, inside the same transaction or script as the write; a ledger record from an older generation never goes on top of a newer one. A server that paused between its lease check and its write, or whose lease Redis forgot, is refused by the store. A renewal that had to claim the code again (`continuous: false`) hands the live room off before it serves another command, because what it holds may be stale.

1. **A host's action waits for the lease, and its answer waits for its writes.** Every host command on a socket and every operator route on a room checks its arguments against its schema (`@conclave/meeting-core/host-commands`) as it arrives, before any wait, and answers "That request was not valid." to anything else. It then runs at once while the lease is held, or waits for one renewal (at most `ROOM_LEASE_CONFIRM_MS`, 5 s) and runs only if the same room is still registered and the lease never lapsed; otherwise it answers `ROOM_LEASE_UNCONFIRMED_ERROR` (HTTP 503) and changes nothing. The writes the action makes are collected, and its answer is sent only once they all landed, within `ROOM_WRITE_COMMIT_MS` (5 s); if one did not, the answer is `ROOM_LEASE_UNCONFIRMED_ERROR`. A delayed command runs through the same listener guard as an immediate one, and every fire-and-forget promise in the SFU goes through `runDetached`, which logs a failure instead of letting it end the process.
2. **Teardown writes what it owes before it lets go.** `cleanupRoom` decides the meeting's end first, then closes the room, then releases the lease; the release waits for every write in flight for the code (bounded by `ROOM_WRITE_COMMIT_MS`) and never runs while a new room is being made on the code.
3. **A write carries its value and is kept until the lease is settled.** A write is decided as an immutable snapshot (the record or decision it will save, and the time it was decided), never a live reference to the room, so a drain or a close before it lands changes nothing it saves. One the fence refuses while this server may still own the room (a timer's, a join's) waits in `deferredRoomWrites`; a continuous renewal writes them all in order before anything newer, and a renewal that had to claim the code again, or that finds another owner, drops them with an error (and hands the room off when another server owns it). A write the store refuses at commit is dropped the same way.

A time stamped on a shared write is the time it was decided, under the generation it carries, so a newer owner's decisions always win.

The room owns every deadline that can end or change a meeting (the 10 s open deadline, the host wait, the lost call's window and its lapse) and arms them through one function. Entering Handing off cancels all of them, none arms while Handing off, and each checks the stage again when it fires, so a notice of any length cannot end the call it is handing off.

### Host reasons

Every host right goes through one function, `Room.grantHost(userKey, basis)`, which records why the person hosts. The basis is `owner` (the code's account), `promoted` (a host made them co-host or transferred to them, or a host claim the client policy allows) or `fallback` (they host because nobody better was there: they opened the room, took over a Recovering call with a pass or a Lapsed one, were promoted when the last host left, or were handed the room at the 10 s deadline or the lapse). A fallback is `temporary` on a code that has an owner and `opener` on one that has none. A grant never lowers a reason: owner over co-host over a fallback. The host map and the primary host are read-only outside `Room`, so nothing else can set host state; the compiler rejects a direct write. The ledger keeps which hosts are co-hosts, so a restart restores every reason. A record from an earlier build counts every host but its temporary one as a co-host.

When the owner's seat becomes a host (the owner joins, or a host promotes or hands the room to one of the owner's tabs), every temporary host loses host rights and stays an admitted participant if no host removed them; co-hosts keep theirs.

### Which proofs carry what

A guest proof reaches other keys in one of two ways, and every check names which (`Reach` in `Room.ts`: `"rights"` or `"removal"`); the compiler rejects a check that does not.

- **A right follows only a key the join route issued from a pass for this room** (`guest-gp_...`, from a room-scoped token). Host reasons, co-host rights, live host seats, admissions past the lock or the waiting room, stage invites, a view of the headcount, lobby rows and the role a person's tabs share all reach from one such key to another of the same guest, and never to or from a key a client named itself (`guest-<sessionId>`, from a token that names no room, with or without a pass proof). Such a key holds only what was given to that very key. A token that names no room can be copied into any meeting, so a pass it shows proves the browser, not a right here.
- **A removal follows every proof.** A block, a removal mark, a waiting-room refusal, a move back to the audience and a kick reach the key, the pass its token shows whatever the token's scope, the pass the room bound the key to, and every pass linked to those. Lifting one (an admission) reaches exactly as far. So does the self-action check: a host cannot kick, or turn away a knock of, anyone a removal by them would reach.

The occupancy route asks as the pass alone (key `""`), which is as good as a key issued from it: the web read the pass cookies itself for this room. It weighs every proof it is sent, up to `MAX_BROWSER_GUEST_PASSES` (16, shared by the web and the SFU), and vouches for nobody past that. A key issued from a pass is always bound to the pass it shows, even when it held something before it was bound.

### One person, many keys

`Room.personOf(userKey, reach, guestProof?, passes?)` is the one map from a key to its person: the key, plus every pass of the guest record behind it (the pass the key is bound to and the passes linked to it, or the passes a join shows before they are linked). A signed-in account, or a key with no pass, is a person of one key. Every identity comparison goes through it: `isSamePerson` (the self-kick check), `guestHolds` (host rights, blocks, readmission marks, live host seats), `identitiesOfSameGuest` (kicks, removals, demotions, admissions, the reasons a grant compares) and `principalsOfJoin` (the admission ledger). A key that holds a host reason or a readmission mark keeps its pass binding, and the ledger records the passes of each such guest key (`guestPasses`), written whenever one is bound or linked, so a restart restores who is who before it restores what they hold. The occupancy route sends the proofs of the browser's pass cookies with its question, and the SFU answers for the person. What stays per key is what belongs to one tab: a seat, a recovery pass, a waiting request and an entry in the block list.

A reason belongs to a person and a seat to a tab, so one person can hold several host seats. Whenever a reason goes (a kick, a block, a demotion, the lapse), every seat of that person stops being a host at once; no seat is ever a host without its person's reason. The same holds the other way: whenever a reason is granted (a promotion, a transfer, a fallback, a host's join), every seat of that person becomes a host at once and each is told. Host rights are per person, as a kick is. With the guest pass, a guest's keys are one person: a kick, a block, a readmission mark and host rights cover every key of the same guest, and an admission clears the readmission mark and the blocks for all of them. A grant to one key of a person keeps the strongest reason the person holds on every key that has one, so a second tab never adds a weaker reason, and the owner's arrival demotes a person only when their strongest reason is temporary. Unblocking alone readmits no one: the guest knocks, and a host lets them in.

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
12. No room with nobody in it and nobody knocking outlives its open deadline.
13. Every room with someone in it or knocking has a host, or is in a stage whose armed deadline will give it one (Opening, Recovering, Waiting for a host).
14. A Running room with no host has nobody seated who may host.
15. Every role change is told to the tabs it affects, to every seat in the room (who hosts, who is the main host), and to the room's apps.
16. Every check is per person: a guest's tabs, each with a key of its own, share one role and one host reason, nobody removes their own other tab, and a removal or a host right holds for the guest's later tabs, after a restart too.
17. A right never reaches a key a client named itself through the pass its token shows; a removal always does (see "Which proofs carry what").
18. Every seat that is a host can act as one: its socket's context points at that seat and room and has the admin handlers, whichever path made it a host and whether or not the join that did so finished.
19. A server that no longer holds a room's lease writes nothing shared about that room: no recovery record, no invitee removal or readmission, no end of the meeting's removals, no recovery pass. Its timers touch only its own memory until a continuous renewal confirms the lease.
20. No shared write is silently lost: a host's action answers success only once its writes landed, teardown writes before it releases the lease, and a write that waits for the lease is written in order or dropped with an error only when the lease was broken or a newer owner fenced it.
21. A store never applies a write from an ownership generation older than one that has fenced it, whatever the writer's clock or cached lease says.
22. No host command crashes or stalls the SFU on arguments it does not take: each is answered with a failure as it arrives. Each command still takes what the apps in the field send it, an absent value sent as null included.
23. Nobody a host removed gets in by opening the room first: a removed person who creates a room knocks in it, as anywhere else (the code's owner and a configured host excepted). Their knock claims the opening only where the room then waits for a lost call's people, so the room keeps what their knock showed of them; elsewhere the room stays unopened for whoever may open it, and the knock waits for the next meeting.
24. Turning away a knock never takes a host right from the person behind it: only a removal does. A tab of a person who holds a right gets that right back when it rejoins, as their other tabs keep it.

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
- A removed person knocks even when a host has opened the room up, and unblocking a guest does not let them back in on its own: a host does.
- A webinar attendee turned away (invite code, lock, full) leaves no room behind, and no running record.
- Every scripted case in the model test goes red when its fix is taken out (checked by deleting each fix in place); three of them need two or three layers removed, because the guest pass added a second guard of its own.
- A tombstone that has stood 90 days goes, with its directory: a record decided that long ago carries times past every window, so a write that lands over the gap says nothing to a recall. An ad hoc code's owner is forgotten after 90 days unused.
- A guest with a pass is one person across tabs, reloads and restarts: a fresh tab of a removed guest knocks after a restart, a guest host's fresh tab hosts again, a co-host's second tab is a co-host, a guest host cannot remove their own other tab, and an admitted guest's reloaded tab sees the headcount.
- An old app's tab (a token that names no room) that shows a guest's pass knocks on its own, is let in on its own, and never hosts through the guest's other tabs; it is removed with them, and a host's removal of it removes them. Two old-app tabs that show one pass are two requests in the lobby.
- A join with a host claim from a removed person knocks like anyone removed, unless the claim is a forced host's (configuration outside the room).
- A fallback host becomes the primary host when the room has none, as a host's join always did.
- Revisit if the stages become fields of their own, or if another path that grants entry is added: it must follow the removal rule, and a path that grants a host right must go through `applyHostGrant`.

## Alternatives considered

- **Keep fixing point by point:** rejected. Every round of point fixes opened another path.
- **One stage field on the room instead of `awaitingOpener`, `restorer` and `endedForEveryone`:** deferred. The stage is derived from them here, and the model test checks the derivation.
- **Close an Opening room with people in it at 10 s:** rejected. It would put people already in the call out.
- **Tie a pass to the room that wrote the lost record:** rejected. After two losses in a row it would turn away people whose pass came from the first room.

## Code

- `packages/sfu/config/classes/Room.ts`: `Reach`, `mayGrantHost`, `personOf`, `isSamePerson`, `identitiesOfSameGuest`, `guestPassesFor`, `restoreGuestPasses`, `publishRoles`, `promoteSeatsOf`, `demoteSeatsWithoutRights`, `hasLiveHostSeat`, `needsReadmission`, `armLifecycleTimer`, `cancelLifecycleTimers`, `armOpeningDeadline`, `openingDeadline`, `grantHost`, `seatsOf`, `hostReasonOf`, `makePrimaryHost`, `welcomeOwner`, `promoteClientToAdmin`, `restoreLostCall`, `recordsItsCall`, `beginHandOff`, `endsWhenEmpty`, `removeUser`, `keepAdmitted`, `blockUser`, `demoteToParticipant`, `endLostCall`
- `packages/sfu/server/roomRecoveryLedger.ts`: `coHostUserKeys` and `guestPasses` in the record; `pruneRoom` retires a 90-day-old tombstone
- `packages/sfu/server/serverShutdown.ts`: `forceDrainRooms`, `handOffRooms`; `createSfuServer` `stop`, `init.ts` `cleanupDeadWorkerRooms`, `rooms.ts` `handOffRoomState`
- `packages/sfu/test/server-shutdown.test.ts`: a forced drain through the real `POST /drain` route, and the operator block and reset routes
- `packages/sfu/server/http/createApp.ts`: the operator reset route, and `viewerProof` on the occupancy route
- `apps/web/src/app/api/sfu/rooms/[roomId]/route.ts`, `apps/web/src/lib/guest-pass.ts` `guestPassProofsOf`: the occupancy question names the browser's passes
- `packages/sfu/server/admin/controlPlane.ts`: `applyHostGrant` (the one grant path), `ensureHost`, `teardownClient`, `removeSeats`, `settleUnclaimedRoom`, `offerLapsedRoom`, `kickClient`, `blockUserKey`, `applyRoomPolicyUpdate`
- `packages/sfu/server/socket/handlers/joinRoom.ts`: the claim of an Opening room (released in `releaseClaim`, settled in `endJoinAttempt`), the decide-then-commit order, the host decision for a removed key, the room switch
- `apps/web/src/app/hooks/useMeetSocket.ts`: a join after approval follows an SFU redirect, as a first join and a reconnect do; every planned disconnect goes through `retireSocket` (`apps/web/src/app/lib/retire-socket.ts`), which takes the socket out of `socketRef` before it disconnects, so its own disconnect listener never starts a second reconnect
- `packages/sfu/server/roomRegistry.ts` `holdsLease`, `packages/sfu/server/rooms.ts` `holdsRoomLease`: the lease fence on every shared write (`noteMeetingOver`, the recovery record, invitee decisions, the pass sweep, the join's record and pass); `writeSharedRoomState`, `confirmRoomLease`, `settleRoomLease` and `releaseRoomLease` in `rooms.ts`, the host-command gate in `adminHandlers.ts` (`onHostAction`) and the operator-route gate in `createApp.ts`; `packages/sfu/test/stale-owner-fence.test.ts` checks every pair of host action (kick, admit, end, last person leaving) and lease state (held, renewing, lapsed but still the owner, lost) for the answer and the shared state it leaves, and drives two SFUs on one SQLite schedule through a lapsed lease, a takeover, a removal and an overdue grace timer
- `packages/sfu/server/roomRecoveryPass.ts`: `issueRoomRecoveryPass`
- `packages/sfu/server/rooms.ts`: `cleanupRoom`, `noteMeetingOver`
- `packages/sfu/test/room-lifecycle-model.test.ts`: the seeded random sequences (300 in CI; `ROOM_LIFECYCLE_SEQUENCES` and `ROOM_LIFECYCLE_FIRST_SEED` for longer runs) and one scripted case per finding; it drives a second room for switches, unlocked rooms, scheduled webinar attendees, in-place demotion, a disconnect grace of 0, 15 or 120 s, a guest with a pass whose every tab, reload and fresh tab has a key of its own and whose tabs alternate between two passes that each name the other (`guestWas`), an old app's tab that shows the guest's pass under a key it names itself, joins with a host claim on a client that allows host joins, a second tab whose join drops after it is seated, and a restart on an SFU with no record of the call (`rosterKnown: false`); its checks compare people, not keys, ask the room whether the old app's pass is linked to the guest, and require every host seat to be able to act
- `packages/sfu/test/guest-proof-reach.test.ts`: the reach table, every right and every removal against an old app's key and a key issued from the pass
