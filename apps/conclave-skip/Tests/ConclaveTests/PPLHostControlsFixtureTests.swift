#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct PPLHostControlsFixtureTests {
    private let hostSixIds = ["u-ishaan", "u-avery", "u-lee", "u-sam", "u-priya", "u-omar"]

    private let newStates: [PeopleFixtureState] = [.hostControlsDefault, .hostControlsPendingLock, .hostAccessLists,
                                                   .hostNoticeSending, .host6SlowAck, .host6Refused]

    private func session(_ state: PeopleFixtureState) -> PeopleFixtureSession {
        let session = PeopleFixtureSession(state: state)
        session.people.platform = NoticePlatform.ios
        session.holdsAcks = true
        return session
    }

    @Test func theNewStatesUseThePlannedNamesAndResolveOnTheIOSSelector() {
        #expect(newStates.map { $0.rawValue } == ["host-controls-default", "host-controls-pending-lock", "host-access-lists",
                                                  "host-notice-sending", "people-host-6-slow-ack", "people-host-6-refused"])
        for state in newStates {
            #expect(PeopleFixtureScript.state(named: " " + state.rawValue + " ") == state)
            #expect(NativeFixtureLaunch.iOSPeopleState(state.rawValue) == state, "\(state.rawValue)")
            #expect(NativeFixtureLaunch.iOSPeopleQaState(state.rawValue) == nil, "\(state.rawValue)")
            #expect(NativeFixtureLaunch.iOSSelector(system: nil, stage: nil, people: state.rawValue, premeeting: nil))
            #expect(PeopleWebinarFixtureScript.state(named: state.rawValue) == nil, "\(state.rawValue) must not shadow a webinar state")
        }
    }

    @Test func everyNewStateBuildsOverTheSameStageRoster() {
        for state in newStates {
            let session = PeopleFixtureSession(state: state)
            #expect(!session.people.snapshot.sections.isEmpty, "\(state.rawValue)")
            #expect(session.people.snapshot.isRosterLoaded, "\(state.rawValue)")
            #expect(Set(session.stage.inputs.participants.map(\.userId)) == Set(session.inputs.participants.map(\.userId)),
                    "\(state.rawValue)")
            #expect(session.people.snapshot.viewerRole == .host, "\(state.rawValue)")
            #expect(session.people.host.snapshot.isAvailable, "\(state.rawValue)")
        }
        for state in [PeopleFixtureState.hostControlsDefault, .hostControlsPendingLock, .host6SlowAck, .host6Refused] {
            #expect(PeopleFixtureScript.roster(for: state).map(\.userId) == hostSixIds, "\(state.rawValue)")
        }
        for state in [PeopleFixtureState.hostAccessLists, .hostNoticeSending] {
            #expect(PeopleFixtureScript.roster(for: state).map(\.userId) == ["u-ishaan"], "\(state.rawValue)")
        }
    }

    @Test func hostControlsStatesOpenTheHostControlsPanelOnLaunch() throws {
        for state in [PeopleFixtureState.hostControlsDefault, .hostControlsPendingLock, .hostNoticeSending] {
            let session = PeopleFixtureSession(state: state)
            #expect(PeopleFixtureScript.opensHostControls(state))
            session.openOnLaunch()
            let current = try #require(session.shell.panels.snapshot.current)
            #expect(current.panel == .hostControls && current.destination == .none, "\(state.rawValue)")
            #expect(session.countersReadout().contains("opens=hostControls"), "\(state.rawValue)")
        }
        let lists = PeopleFixtureSession(state: .hostAccessLists)
        lists.openOnLaunch()
        let access = try #require(lists.shell.panels.snapshot.current)
        #expect(access.panel == .hostControls && access.destination == .hostControlsAccess)
        for state in [PeopleFixtureState.host6SlowAck, .host6Refused, .host6] {
            let session = PeopleFixtureSession(state: state)
            #expect(!PeopleFixtureScript.opensHostControls(state))
            session.openOnLaunch()
            let current = try #require(session.shell.panels.snapshot.current)
            #expect(current.panel == .participants && current.destination == .none, "\(state.rawValue)")
        }
    }

    @Test func theDefaultStateFeedsHostControlsLikeTheSpecTable() {
        let host = PeopleFixtureSession(state: .hostControlsDefault).people.host.snapshot
        #expect(host.policy(.lockMeeting)?.isOn == false)
        #expect(host.policy(.allowGuests)?.isOn == true)
        #expect(!host.access.requiresCode)
        #expect(host.access.allowedCount == 2 && host.access.blockedCount == 1 && host.access.lockedAllowedCount == 0)
        for id in HostPolicyID.chatRows {
            #expect(host.policy(id)?.isOn == true, "\(id.rawValue)")
        }
        #expect(host.canEndForEveryone && host.endPhase == HostEndPhase.idle)
        #expect(PeopleFixtureSession(state: .hostControlsDefault).people.snapshot.accessSummary == PeopleAccessSummary.openToAll.rawValue)
    }

    @Test func theDefaultStateOffersEndForEveryoneThroughAHostFixtureShell() throws {
        let session = session(.hostControlsDefault)
        let host = session.people.host
        #expect(PeopleFixtureScript.endsForEveryone(.hostControlsDefault) && PeopleFixtureScript.endsForEveryone(.hostControlsPendingLock))
        #expect(host.snapshot.canEndForEveryone && session.shell.session.canEndForEveryone)
        host.requestEndForEveryone()
        let dialog = try #require(session.shell.session.confirmation)
        #expect(dialog.kind == .endForEveryone && dialog.invoker == MeetingConfirmationInvoker.hostControls)
        session.shell.cancelConfirmation(id: dialog.id)
        #expect(session.shell.session.confirmation == nil && host.snapshot.endPhase == HostEndPhase.idle)

        session.shell.toggleMicrophone()
        #expect(session.shell.session.canEndForEveryone, "a stage command keeps the fixture shell a host")
        host.requestEndForEveryone()
        let again = try #require(session.shell.session.confirmation)
        #expect(session.shell.confirmEndForEveryone(id: again.id) == .dispatched)
        #expect(PeopleFixtureScript.isEndPending(session.shell.controls.rows))
        #expect(host.snapshot.endPhase == HostEndPhase.ending)
        let leave = session.shell.controls.rows.first { $0.id == MeetingControlID.leave.rawValue }
        #expect(leave?.isEnabled == true, "Leave stays enabled while ending")
        for state in PeopleFixtureState.allCases where !PeopleFixtureScript.endsForEveryone(state) {
            let other = PeopleFixtureSession(state: state)
            #expect(!other.people.host.snapshot.canEndForEveryone, "\(state.rawValue)")
            #expect(!other.shell.session.canEndForEveryone, "\(state.rawValue)")
        }
    }

    @Test func webinarAndDirectMessagePolicyAcksReachParticipantsToo() {
        let session = session(.hostControlsDefault)
        let host = session.people.host
        #expect(!session.people.snapshot.webinarEnabled && session.people.inputs.isDmEnabled)
        #expect(host.setPolicy(.webinarMode, on: true) == .dispatched)
        session.releaseAcks()
        #expect(host.snapshot.policy(.webinarMode)?.isOn == true)
        #expect(session.people.snapshot.webinarEnabled && session.people.snapshot.section(.panelists) != nil)
        #expect(host.setPolicy(.webinarPublic, on: true) == .dispatched)
        session.releaseAcks()
        #expect(session.people.inputs.isWebinarPublic && session.people.snapshot.webinarPublic)
        #expect(host.setPolicy(.webinarQa, on: true) == .dispatched)
        session.releaseAcks()
        #expect(session.people.inputs.isWebinarQaEnabled)
        #expect(host.setPolicy(.directMessages, on: false) == .dispatched)
        session.releaseAcks()
        #expect(!session.people.inputs.isDmEnabled)
        #expect(host.setPolicy(.webinarMode, on: false) == .dispatched)
        session.releaseAcks()
        #expect(!session.people.snapshot.webinarEnabled && session.people.snapshot.section(.inMeeting) != nil)
        #expect(session.inputs == session.people.inputs)
        let plain = PeopleFixtureScript.peopleInputs(roster: PeopleFixtureScript.hostSix(), state: .host6)
        #expect(plain == PeopleFixtureScript.peopleInputs(roster: PeopleFixtureScript.hostSix(), state: .host6,
                                                          host: HostControlsInputs.make(callSession: 1)))
    }

    @Test func stopAllSharesAndCamerasOffChangeTheRosterAfterTheAck() throws {
        let session = session(.hostControlsDefault)
        let host = session.people.host
        #expect(host.snapshot.visibleBulk().map { $0.bulk } == [.muteAll, .camerasOff, .stopAllShares, .lowerAllHands])
        #expect(host.requestBulk(.stopAllShares) == .dispatched)
        let dialog = try #require(session.people.confirmation)
        #expect(dialog.kind == .stopAllShares)
        session.people.confirm(id: dialog.id, block: false)
        #expect(session.queuedAcks.first?.command.text == HostBulkID.stopAllShares.rawValue)
        #expect(session.inputs.participant("u-lee")?.isScreenSharing == true, "Lee keeps presenting until the ack")
        session.releaseAcks()
        #expect(session.inputs.participant("u-lee")?.isScreenSharing == false)
        #expect(session.stage.inputs.screenShareUserId.isEmpty)
        #expect(host.snapshot.visibleBulk().map { $0.bulk } == [.muteAll, .camerasOff, .lowerAllHands])
        #expect(session.people.feedbackState.token.kind == .hostBulkApplied)

        let cast = [PeopleFixturePerson.make("u-h", "Host", isLocal: true, isHost: true, isCameraOff: false, isPresenting: true),
                    PeopleFixturePerson.make("u-c", "Co", isCoHost: true, isCameraOff: false, isPresenting: true),
                    PeopleFixturePerson.make("u-p", "Guest", isCameraOff: false, isPresenting: true)]
        #expect(PeopleFixtureScript.camerasTurnedOff(cast).map(\.isCameraOff) == [false, false, true])
        #expect(PeopleFixtureScript.camerasTurnedOff(cast).map(\.isPresenting) == [true, true, true])
        #expect(PeopleFixtureScript.sharesStopped(cast).map(\.isPresenting) == [true, true, false])
        #expect(PeopleFixtureScript.sharesStopped(cast).map(\.isCameraOff) == [false, false, false])

        #expect(host.requestBulk(.camerasOff) == .dispatched)
        let cameras = try #require(session.people.confirmation)
        session.people.confirm(id: cameras.id, block: false)
        #expect(session.queuedAcks.first?.command.text == HostBulkID.camerasOff.rawValue)
        session.releaseAcks()
        #expect(session.countersReadout().contains("acks=2"))
        let cameraOn = session.inputs.participants.contains(where: { !$0.isCameraOff && $0.userId != "u-ishaan" && $0.userId != "u-avery" })
        #expect(!cameraOn)
    }

    @Test func aLockAckFlipsTheSwitchAndTheParticipantsAccessRow() throws {
        let session = session(.hostControlsDefault)
        let host = session.people.host
        #expect(host.setPolicy(.lockMeeting, on: true) == .dispatched)
        #expect(host.snapshot.policy(.lockMeeting)?.isPending == true && host.snapshot.policy(.lockMeeting)?.shownOn == true)
        let queued = try #require(session.queuedAcks.first)
        #expect(queued.ack == PeopleFixtureAck(delayMillis: PeopleFixtureScript.ackDelayMillis, failure: ""))
        #expect(session.hostReadout().contains("pending=lockMeeting"))
        session.releaseAcks()
        #expect(host.snapshot.policy(.lockMeeting)?.isOn == true && host.snapshot.policy(.lockMeeting)?.isPending == false)
        #expect(session.people.snapshot.accessSummary == PeopleAccessSummary.locked.rawValue)
        #expect(session.hostReadout().contains("locked=1") && session.hostReadout().contains("pending=none"))
        #expect(session.people.feedbackState.token.kind == .hostPolicyChanged)

        #expect(host.setPolicy(.lockMeeting, on: false) == .dispatched)
        session.releaseAcks()
        #expect(session.people.snapshot.accessSummary == PeopleAccessSummary.openToAll.rawValue)
        #expect(host.setPolicy(.allowGuests, on: false) == .dispatched)
        session.releaseAcks()
        #expect(host.snapshot.policy(.allowGuests)?.isOn == false)
        #expect(session.people.snapshot.accessSummary == PeopleAccessSummary.signedInOnly.rawValue)
        #expect(session.countersReadout().contains("acks=3"))
    }

    @Test func thePendingLockHoldsTwoSecondsThenReturnsOnceWithTheRefusal() throws {
        let session = session(.hostControlsPendingLock)
        let host = session.people.host
        #expect(host.setPolicy(.lockMeeting, on: true) == .dispatched)
        #expect(host.setPolicy(.lockMeeting, on: false) == .ignored)
        let queued = try #require(session.queuedAcks.first)
        #expect(queued.ack == PeopleFixtureAck(delayMillis: 2000.0, failure: HostActionFailure.rejectedByServer.rawValue))
        let pending = try #require(host.snapshot.policy(.lockMeeting))
        #expect(pending.isPending && pending.shownOn && !pending.isOn && !pending.isEnabled)
        session.releaseAcks()
        let settled = try #require(host.snapshot.policy(.lockMeeting))
        #expect(!settled.isPending && !settled.shownOn && !settled.isOn)
        #expect(session.people.lastFailure?.sourceKey == HostPolicyID.lockMeeting.rawValue)
        #expect(session.people.lastFailure?.failure == HostActionFailure.rejectedByServer.rawValue)
        #expect(session.people.feedbackState.token.kind == .hostActionFailed)
        #expect(session.people.snapshot.accessSummary == PeopleAccessSummary.openToAll.rawValue)

        #expect(host.setPolicy(.allowChat, on: false) == .dispatched)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: PeopleFixtureScript.ackDelayMillis, failure: ""))
        session.releaseAcks()
        #expect(host.snapshot.policy(.allowChat)?.isOn == false)
    }

    @Test func theAccessListsRevokeAtOnceAndBlockIsRateLimitedOnceThenRetries() throws {
        let session = session(.hostAccessLists)
        let host = session.people.host
        #expect(host.snapshot.access.allowed == ["ana@example.org", "guest-71a2"])
        #expect(host.snapshot.access.lockedAllowed == ["ana@example.org"])
        #expect(host.snapshot.access.blocked == ["spam@example.org"])

        #expect(host.revoke("guest-71a2") == .dispatched)
        #expect(host.snapshot.pendingAccessKeys == ["guest-71a2"])
        session.releaseAcks()
        #expect(host.snapshot.access.allowed == ["ana@example.org"])
        #expect(host.snapshot.pendingAccessKeys.isEmpty)

        #expect(host.dispatchBlock("troll@example.org") == .dispatched)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: PeopleFixtureScript.ackDelayMillis,
                                                                  failure: HostActionFailure.rateLimited.rawValue))
        session.releaseAcks()
        let failure = try #require(session.people.lastFailure)
        #expect(failure.failure == HostActionFailure.rateLimited.rawValue && failure.sourceKey == HostFieldID.accessKey)
        #expect(host.snapshot.access.blocked == ["spam@example.org"])

        session.people.retry(failureId: failure.id)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: PeopleFixtureScript.ackDelayMillis, failure: ""))
        session.releaseAcks()
        #expect(host.snapshot.access.blocked == ["spam@example.org", "troll@example.org"])
        #expect(session.people.lastFailure == nil)

        #expect(host.revoke("ana@example.org") == .dispatched)
        session.releaseAcks()
        #expect(host.snapshot.access.allowed.isEmpty && host.snapshot.access.lockedAllowed.isEmpty)
    }

    @Test func theNoticeSendsAfterOneAndAHalfSecondsAndTheSecondSendTimesOut() throws {
        let session = session(.hostNoticeSending)
        let host = session.people.host
        host.drafts.noticeText = "Five minutes left"
        #expect(host.sendNotice("Five minutes left", level: HostNoticeLevel.info) == .dispatched)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: 1500.0, failure: ""))
        #expect(host.snapshot.noticePhase == HostFieldPhase.sending)
        session.releaseAcks()
        #expect(host.snapshot.noticePhase == HostFieldPhase.sent && host.snapshot.noticeSentSerial == 1)
        #expect(host.drafts.noticeText.isEmpty)

        host.drafts.noticeText = "Wrapping up"
        #expect(host.sendNotice("Wrapping up", level: HostNoticeLevel.warning) == .dispatched)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: 1500.0, failure: HostActionFailure.ackTimedOut.rawValue))
        session.releaseAcks()
        #expect(host.snapshot.noticePhase == HostFieldPhase.failed && host.snapshot.noticeSentSerial == 1)
        #expect(host.drafts.noticeText == "Wrapping up")
        let failure = try #require(session.people.lastFailure)
        #expect(failure.failure == HostActionFailure.ackTimedOut.rawValue && failure.sourceKey == HostFieldID.notice)

        session.people.retry(failureId: failure.id)
        session.releaseAcks()
        #expect(host.snapshot.noticePhase == HostFieldPhase.sent && host.snapshot.noticeSentSerial == 2)
    }

    @Test func theSlowAckMuteStaysPendingThenFailsOnceWithoutASecondCommand() throws {
        let session = session(.host6SlowAck)
        let people = session.people
        #expect(people.perform(.mute, rowId: "u-priya", source: PeopleActionSource.rowMenu) == .dispatched)
        #expect(people.perform(.mute, rowId: "u-priya", source: PeopleActionSource.rowMenu) == .ignored)
        #expect(session.queuedAcks.count == 1)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: 2000.0, failure: HostActionFailure.rejectedByServer.rawValue))
        #expect(people.rows.entry(for: "u-priya").model.pendingAction == PersonActionID.mute.rawValue)
        session.releaseAcks()
        #expect(people.rows.entry(for: "u-priya").model.pendingAction.isEmpty)
        #expect(!people.rows.entry(for: "u-priya").model.isMuted)
        let failure = try #require(people.lastFailure)
        #expect(failure.action == PeopleCommandKind.mute.rawValue && failure.failure == HostActionFailure.rejectedByServer.rawValue)
        #expect(failure.placement == HostFailurePlacement.panelInline.rawValue)
        #expect(people.feedbackState.token.kind == .hostActionFailed)
        #expect(people.countersReadout().components(separatedBy: "command:mute").count - 1 == 1)

        let standard = PeopleFixtureAck(delayMillis: PeopleFixtureScript.ackDelayMillis, failure: "")
        for kind in [PeopleCommandKind.remove, .turnOffCamera, .makeCoHost, .changeName] {
            #expect(PeopleFixtureScript.ack(for: .host6SlowAck, command: PeopleCommand.make(kind, targetId: "u-lee"), attempt: 0)
                    == standard, "\(kind.rawValue)")
        }
    }

    @Test func theRefusedStateRateLimitsThenDisablesRenameAndRefusesRemove() throws {
        let session = session(.host6Refused)
        let people = session.people
        people.beginRename()
        #expect(people.submitRename("Ishaan K") == .dispatched)
        session.releaseAcks()
        #expect(people.rename.phase == .refused && people.rename.draft == "Ishaan K")
        #expect(people.rename.refusal == HostActionFailure.renameRateLimited.rawValue)

        #expect(people.submitRename("Ishaan K") == .dispatched)
        session.releaseAcks()
        #expect(people.rename.refusal == HostActionFailure.renameDisabled.rawValue)
        let change = people.rows.entry(for: "u-ishaan").model.actions.first { $0.action == .changeName }
        #expect(change?.isEnabled == false && change?.reason == PeopleActionReason.renameDisabled)

        people.perform(.remove, rowId: "u-lee", source: PeopleActionSource.rowMenu)
        let dialog = try #require(people.confirmation)
        #expect(dialog.kind == .remove)
        people.confirm(id: dialog.id, block: false)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: PeopleFixtureScript.ackDelayMillis,
                                                                  failure: HostActionFailure.superAdmin.rawValue))
        session.releaseAcks()
        #expect(people.lastFailure?.action == PeopleCommandKind.remove.rawValue)
        #expect(people.lastFailure?.failure == HostActionFailure.superAdmin.rawValue)
        #expect(people.rows.contains("u-lee"))
        #expect(PeopleFailureCopy.kind(action: people.lastFailure?.action ?? "", failure: people.lastFailure?.failure ?? "",
                                       sourceKey: people.lastFailure?.sourceKey ?? "") == PeopleFailureCopy.cantRemove)
    }

    @Test func everyStateBeforeThisBatchKeepsTheDefaultAcknowledgement() {
        let before: [PeopleFixtureState] = [.guest4, .host6, .hostWaiting3, .hostHands3, .hostRecovering, .hostOffline,
                                            .cohostViewingHost, .searchNone, .alone, .longNames, .lostHost, .hostWaitingLate]
        #expect(before.count + newStates.count == PeopleFixtureState.allCases.count)
        let standard = PeopleFixtureAck(delayMillis: PeopleFixtureScript.ackDelayMillis, failure: "")
        for state in before {
            for kind in PeopleCommandKind.allCases {
                for attempt in 0..<3 {
                    let command = PeopleCommand.make(kind, targetId: "u-lee", text: HostPolicyID.lockMeeting.rawValue)
                    #expect(PeopleFixtureScript.ack(for: state, command: command, attempt: attempt) == standard,
                            "\(state.rawValue) \(kind.rawValue)")
                }
            }
            #expect(PeopleFixtureScript.hostInputs(for: state) == HostControlsInputs.make(callSession: 1), "\(state.rawValue)")
        }
    }

    @Test func aPolicyAckChangesOnlyItsOwnServerField() {
        let base = PeopleFixtureScript.hostInputs(for: .hostControlsDefault)
        for id in HostPolicyID.allCases {
            for on in [true, false] {
                let next = PeopleFixtureScript.withPolicy(base, policy: id.rawValue, on: on)
                #expect(HostControlsPolicy.isOn(id, inputs: next) == on, "\(id.rawValue) \(on)")
                for other in HostPolicyID.allCases where other != id {
                    #expect(HostControlsPolicy.isOn(other, inputs: next) == HostControlsPolicy.isOn(other, inputs: base),
                            "\(id.rawValue) moved \(other.rawValue)")
                }
                #expect(next.allowedKeys == base.allowedKeys && next.blockedKeys == base.blockedKeys)
            }
        }
        #expect(PeopleFixtureScript.withPolicy(base, policy: "unknownPolicy", on: true) == base)
    }

    @Test func accessAcksMoveKeysBetweenTheServerLists() {
        let base = PeopleFixtureScript.hostInputs(for: .hostAccessLists)
        func after(_ kind: PeopleCommandKind, _ key: String = "") -> HostControlsInputs {
            PeopleFixtureScript.hostInputs(after: PeopleCommand.make(kind, targetId: key), current: base)
        }
        #expect(after(.allowKey, "spam@example.org").allowedKeys == ["ana@example.org", "guest-71a2", "spam@example.org"])
        #expect(after(.allowKey, "spam@example.org").blockedKeys.isEmpty)
        #expect(after(.blockKey, "ana@example.org").allowedKeys == ["guest-71a2"])
        #expect(after(.blockKey, "ana@example.org").lockedAllowedKeys.isEmpty)
        #expect(after(.blockKey, "ana@example.org").blockedKeys == ["spam@example.org", "ana@example.org"])
        #expect(after(.unblockKey, "spam@example.org").blockedKeys.isEmpty)
        #expect(after(.revokeKey, "ana@example.org").allowedKeys == ["guest-71a2"])
        #expect(after(.revokeKey, "ana@example.org").lockedAllowedKeys.isEmpty)
        #expect(after(.setMeetingInviteCode).meetingRequiresInviteCode)
        #expect(!PeopleFixtureScript.hostInputs(after: PeopleCommand.make(.clearMeetingInviteCode),
                                                current: after(.setMeetingInviteCode)).meetingRequiresInviteCode)
        #expect(after(.sendNotice) == base && after(.mute, "u-lee") == base && after(.refreshAccessLists) == base)
        #expect(PeopleFixtureScript.adding(["a", "b"], "a") == ["b", "a"])
        #expect(PeopleFixtureScript.removing(["a", "b"], "c") == ["a", "b"])
    }
}

private func pplHostSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func pplHostNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
