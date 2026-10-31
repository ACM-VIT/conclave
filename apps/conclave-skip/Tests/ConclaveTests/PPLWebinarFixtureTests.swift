#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct PPLWebinarFixtureTests {
    private let attendeeStates: [PeopleWebinarFixtureState] = [.webinarAttendeeAck, .webinarAttendeePromoted]

    private func held(_ state: PeopleWebinarFixtureState) -> PeopleWebinarFixtureSession {
        let session = PeopleWebinarFixtureSession(state: state)
        session.people.platform = NoticePlatform.ios
        session.holdsAcks = true
        return session
    }

    @Test func theNewAttendeeStatesUseThePlannedNames() {
        #expect(PeopleWebinarFixtureState.webinarAttendeeAck.rawValue == "webinar-attendee-ack")
        #expect(PeopleWebinarFixtureState.webinarAttendeePromoted.rawValue == "webinar-attendee-promoted")
        for state in attendeeStates {
            #expect(PeopleWebinarFixtureScript.state(named: " " + state.rawValue + " ") == state)
            #expect(PeopleFixtureScript.state(named: state.rawValue) == nil, "\(state.rawValue) must not shadow a People state")
            #expect(PeopleWebinarFixtureScript.isAttendee(state))
            #expect(PeopleWebinarFixtureScript.baseState(state) == .guest4)
        }
    }

    @Test func everyWebinarStateLaunchesUnderTheSameNameOnBothPlatforms() throws {
        for state in PeopleWebinarFixtureState.allCases {
            #expect(NativeFixtureLaunch.iOSPeopleQaState(state.rawValue) == state, "\(state.rawValue)")
            #expect(NativeFixtureLaunch.iOSPeopleQaState(" " + state.rawValue + " ") == state, "\(state.rawValue)")
            #expect(NativeFixtureLaunch.iOSPeopleState(state.rawValue) == PeopleWebinarFixtureScript.baseState(state))
            #expect(NativeFixtureLaunch.iOSSelector(system: nil, stage: nil, people: state.rawValue, premeeting: nil))
        }
        #expect(NativeFixtureLaunch.iOSPeopleQaState("people-host-6") == nil)
        #expect(NativeFixtureLaunch.iOSPeopleQaState("webinar-unknown") == nil)
        #expect(NativeFixtureLaunch.iOSPeopleQaState(nil) == nil)
    }

    @Test func eachStateHasOneLaunchScriptOnBothRoots() {
        for state in PeopleWebinarFixtureState.allCases {
            let opens = PeopleWebinarFixtureScript.opensParticipants(state)
            let qa = PeopleWebinarFixtureScript.opensQuestionsAndAnswers(state)
            #expect(!(opens && qa), "\(state.rawValue) opens two panels")
            #expect(!(PeopleWebinarFixtureScript.turnsQaOff(state) && PeopleWebinarFixtureScript.deliversPromotion(state)))
            #expect(qa == PeopleWebinarFixtureScript.isQa(state))
            if PeopleWebinarFixtureScript.landsSpeakerSession(state) {
                #expect(PeopleWebinarFixtureScript.deliversPromotion(state) && PeopleWebinarFixtureScript.isAttendee(state))
            }
        }
        #expect(PeopleWebinarFixtureScript.opensParticipants(.webinarHostHands4))
        #expect(PeopleWebinarFixtureScript.opensParticipants(.webinarHostInvited))
        #expect(PeopleWebinarFixtureScript.turnsQaOff(.qaAttendeeOff))
        #expect(PeopleWebinarFixtureScript.deliversPromotion(.stageInvite))
        #expect(PeopleWebinarFixtureScript.deliversPromotion(.webinarAttendeePromoted))
        #expect(PeopleWebinarFixtureScript.opensQuestionsAndAnswers(.webinarAttendeeAck))
        #expect(!PeopleWebinarFixtureScript.opensQuestionsAndAnswers(.webinarAttendeePromoted))
    }

    @Test func theNewStatesAreAttendeesWithWebinarAndQaOn() {
        for state in attendeeStates {
            let session = PeopleWebinarFixtureSession(state: state)
            #expect(session.people.snapshot.webinarEnabled, "\(state.rawValue)")
            #expect(session.people.snapshot.viewerRole == .attendee, "\(state.rawValue)")
            #expect(session.people.qa.snapshot.isAttendee, "\(state.rawValue)")
            #expect(session.people.qa.snapshot.isEnabled, "\(state.rawValue)")
        }
        let ack = PeopleWebinarFixtureSession(state: .webinarAttendeeAck)
        #expect(ack.qaInputs.entries.map(\.id) == ["q1", "q2", "q3", "q4", "q5"])
        #expect(ack.people.qa.snapshot.composerEnabled)
        #expect(PeopleWebinarFixtureSession(state: .webinarAttendeePromoted).people.stageInvitation == nil)
    }

    @Test func attendeeQuestionsAreAcknowledgedSlowlyAndTheSecondOneTimesOut() throws {
        let session = held(.webinarAttendeeAck)
        let qa = session.people.qa
        qa.drafts.question = "Will the deck be shared?"
        #expect(qa.submit("Will the deck be shared?") == .dispatched)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: 2000.0, failure: ""))
        #expect(qa.snapshot.submitPhase == QaSubmitPhase.sending)
        #expect(qa.drafts.question == "Will the deck be shared?")
        session.releaseAcks()
        #expect(qa.snapshot.submitPhase == QaSubmitPhase.idle && qa.drafts.question.isEmpty)
        #expect(session.people.feedbackState.token.kind == .questionSent)
        let published = try #require(session.qaInputs.entries.last)
        #expect(published.id == "s1" && published.question == "Will the deck be shared?")
        #expect(published.userId == PeopleWebinarFixtureScript.attendeeSelf && published.status == QaStatus.pending.rawValue)
        #expect(qa.questions.entry(for: "s1").model.text == "Will the deck be shared?")
        #expect(session.submissions == 1)

        qa.drafts.question = "Is there a replay?"
        #expect(qa.submit("Is there a replay?") == .dispatched)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: 300.0, failure: HostActionFailure.ackTimedOut.rawValue))
        session.releaseAcks()
        #expect(qa.snapshot.submitPhase == QaSubmitPhase.failed)
        #expect(qa.drafts.question == "Is there a replay?")
        #expect(session.people.feedbackState.token.kind == .questionFailed)
        #expect(session.people.lastFailure?.sourceKey == QaFieldID.composer)
        #expect(session.submissions == 1 && session.qaInputs.entries.count == 6)

        #expect(qa.submit("Is there a replay?") == .dispatched)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: 2000.0, failure: ""))
        session.releaseAcks()
        #expect(session.submissions == 2 && session.qaInputs.entries.last?.id == "s2")
        #expect(session.countersReadout() == "qaSubmit,qaSubmit,qaSubmit")
    }

    @Test func anAttendeeVoteStaysPendingUntilTheSlowAcknowledgement() {
        let session = held(.webinarAttendeeAck)
        let qa = session.people.qa
        #expect(qa.toggleUpvote(id: "q2") == .dispatched)
        #expect(qa.toggleUpvote(id: "q2") == .ignored)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: 1500.0, failure: ""))
        #expect(qa.questions.entry(for: "q2").model.pendingAction == "upvote")
        session.releaseAcks()
        let row = qa.questions.entry(for: "q2").model
        #expect(row.pendingAction.isEmpty && row.hasUpvoted && row.upvotes == 5)
    }

    @Test func thePromotionArrivesAndNotNowIsAcknowledgedOnce() throws {
        let session = held(.webinarAttendeePromoted)
        session.deliverPromotion()
        let invitation = try #require(session.people.stageInvitation)
        #expect(invitation.promotedByName == PeopleWebinarFixtureScript.promotedByName)
        session.people.declineStageInvitation(id: invitation.id)
        session.people.declineStageInvitation(id: invitation.id)
        #expect(session.people.stageInvitation == nil)
        #expect(session.queuedAcks.count == 1)
        let queued = try #require(session.queuedAcks.first)
        #expect(queued.command.kind == .declineStage && queued.ack == PeopleFixtureAck(delayMillis: 150.0, failure: ""))
        session.releaseAcks()
        #expect(session.countersReadout() == "declineStage")
        #expect(session.people.countersReadout().contains("finish:declineStage:completed"))
        #expect(session.people.lastFailure == nil)

        session.deliverPromotion()
        #expect(session.people.stageInvitation != nil, "the fixture can deliver the invitation again")
    }

    @Test func acceptingThePromotionLandsTheSpeakerSession() async throws {
        let session = PeopleWebinarFixtureSession(state: .webinarAttendeePromoted)
        session.deliverPromotion()
        let invitation = try #require(session.people.stageInvitation)
        session.people.acceptStageInvitation(id: invitation.id)
        #expect(session.people.stageInvitation == nil)
        #expect(session.countersReadout() == "acceptStage")
        #expect(session.people.countersReadout().contains("acceptStage"))
        for _ in 0..<200 where session.people.snapshot.viewerRole == .attendee {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(session.people.snapshot.viewerRole == .participant)
        #expect(session.people.snapshot.webinarEnabled)
        #expect(session.people.inputs.callSession == 2 && !session.people.inputs.isWebinarAttendee)
        #expect(session.qaInputs.role == QaRole.none && session.qaInputs.callSession == 2)
        #expect(!session.people.qa.snapshot.isAttendee)
        session.deliverPromotion()
        #expect(session.people.stageInvitation == nil, "a speaker is never invited on stage again")
    }

    @Test func theSpeakerSessionMatchesTheGuestRosterOnStage() {
        let speaker = PeopleWebinarFixtureScript.speakerInputs(.webinarAttendeePromoted)
        let guest = PeopleFixtureScript.inputs(for: .guest4)
        #expect(speaker.participants.map(\.userId) == guest.participants.map(\.userId))
        #expect(speaker.localUserId == guest.localUserId && !speaker.isAdmin && !speaker.isWebinarAttendee)
        #expect(speaker.isWebinarEnabled && speaker.callSession == guest.callSession + 1)
        let qa = PeopleWebinarFixtureScript.speakerQaInputs(speaker)
        #expect(qa.role == QaRole.none && qa.isQaEnabled && qa.entries.isEmpty)
    }

    @Test func otherStatesKeepTheirAcknowledgementTable() {
        for state in PeopleWebinarFixtureState.allCases where state != .webinarAttendeeAck {
            for kind in PeopleCommandKind.allCases {
                for attempt in 0..<3 {
                    #expect(PeopleWebinarFixtureScript.ack(state, command: PeopleCommand.make(kind, targetId: "h0"), attempt: attempt)
                            == PeopleWebinarFixtureScript.ack(state, kind: kind), "\(state.rawValue) \(kind.rawValue)")
                }
            }
        }
        #expect(PeopleWebinarFixtureScript.ack(.webinarAttendeeAck, command: PeopleCommand.make(.declineStage), attempt: 0)
                == PeopleFixtureAck(delayMillis: 150.0, failure: ""))
        #expect(!PeopleWebinarFixtureScript.publishesSubmissions(.qaAttendee5))
    }

    @Test func aWrittenAnswerIsAcknowledgedAfterThreeHundredMilliseconds() {
        let written = PeopleCommand.make(.qaModerate, targetId: "h0", text: "Answered in the chat.", detail: QaModerationAction.answered)
        let plain = PeopleCommand.make(.qaModerate, targetId: "h0", detail: QaModerationAction.answered)
        for state in PeopleWebinarFixtureState.allCases {
            #expect(PeopleWebinarFixtureScript.ack(state, command: written, attempt: 0) == PeopleFixtureAck(delayMillis: 300.0, failure: ""),
                    "\(state.rawValue)")
            #expect(PeopleWebinarFixtureScript.ack(state, command: plain, attempt: 0) == PeopleFixtureAck(delayMillis: 150.0, failure: ""),
                    "\(state.rawValue)")
        }
    }

    @Test func bringOnStageMovesTheHandToAttendeesAsInvitedAndCancelRemovesIt() throws {
        let session = held(.webinarHostHands4)
        let people = session.people
        #expect(people.snapshot.section(.raisedHands)?.rowIds == ["attendee:a-priya", "attendee:a-omar", "attendee:a-mina", "attendee:a-jo"])
        #expect(people.perform(.bringOnStage, rowId: "attendee:a-priya", source: PeopleActionSource.rowMenu) == .dispatched)
        #expect(people.perform(.bringOnStage, rowId: "attendee:a-priya", source: PeopleActionSource.rowMenu) == .ignored)
        let queued = try #require(session.queuedAcks.first)
        #expect(queued.command.kind == .bringOnStage && queued.command.targetId == "a-priya")
        #expect(queued.ack == PeopleFixtureAck(delayMillis: 200.0, failure: ""))
        #expect(people.rows.entry(for: "attendee:a-priya").model.pendingAction == PersonActionID.bringOnStage.rawValue)
        session.releaseAcks()
        #expect(people.snapshot.section(.raisedHands)?.rowIds == ["attendee:a-omar", "attendee:a-mina", "attendee:a-jo"])
        #expect(people.snapshot.section(.attendees)?.rowIds == ["attendee:a-priya"])
        let invited = people.rows.entry(for: "attendee:a-priya").model
        #expect(invited.detail == .stageInvited && invited.pendingAction.isEmpty && invited.name == "Priya N.")
        #expect(people.feedbackState.token.kind == .hostInvitedToStage)
        #expect(session.peopleInputs.stageInvites == [PeopleStageInviteInput(userId: "a-priya", displayName: "Priya N.")])
        #expect(people.inputs == session.peopleInputs)

        #expect(people.perform(.cancelStageInvite, rowId: "attendee:a-priya", source: PeopleActionSource.rowMenu) == .dispatched)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: 150.0, failure: ""))
        session.releaseAcks()
        #expect(people.snapshot.section(.attendees)?.rowIds.isEmpty == true)
        #expect(!people.rows.contains("attendee:a-priya"))
        #expect(session.peopleInputs.stageInvites.isEmpty)
        #expect(session.countersReadout() == "bringOnStage,cancelStageInvite")
    }

    @Test func cancelInviteRemovesTheInvitedRowAfterTheAck() {
        let session = held(.webinarHostInvited)
        let people = session.people
        #expect(people.snapshot.section(.attendees)?.rowIds == ["attendee:a-mina"])
        #expect(people.perform(.cancelStageInvite, rowId: "attendee:a-mina", source: PeopleActionSource.rowMenu) == .dispatched)
        #expect(people.snapshot.section(.attendees)?.rowIds == ["attendee:a-mina"], "the row stays until the ack")
        session.releaseAcks()
        #expect(people.snapshot.section(.attendees)?.rowIds.isEmpty == true)
        #expect(people.snapshot.section(.raisedHands)?.count == 3)
    }

    @Test func moveToAudienceDropsThePanelistFromPeopleAndTheStage() throws {
        let session = held(.webinarHostHands4)
        let people = session.people
        #expect(people.attendeeCount == 128)
        let avery = people.rows.entry(for: "u-avery").model.actions.map { $0.action }
        #expect(!avery.contains(.moveToAudience), "never offered on a co-host")
        #expect(people.perform(.moveToAudience, rowId: "u-lee", source: PeopleActionSource.rowMenu) == .dispatched)
        let dialog = try #require(people.confirmation)
        #expect(dialog.kind == .moveToAudience)
        people.confirm(id: dialog.id, block: false)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: 150.0, failure: ""))
        #expect(people.snapshot.section(.panelists)?.rowIds.contains("u-lee") == true, "the row stays until the ack")
        session.releaseAcks()
        #expect(people.snapshot.section(.panelists)?.rowIds.contains("u-lee") == false)
        #expect(!people.rows.contains("u-lee"))
        #expect(people.attendeeCount == 129)
        #expect(people.feedbackState.token.kind == .hostMovedToAudience)
        #expect(!session.base.stage.inputs.participants.map(\.userId).contains("u-lee"))
        #expect(Set(session.base.stage.inputs.participants.map(\.userId)) == Set(people.inputs.participants.map(\.userId)))
    }

    @Test func moderationAcksMoveTheQuestionAndWrittenAnswersTakeLonger() throws {
        let session = held(.qaHostOpen7)
        let qa = session.people.qa
        #expect(qa.snapshot.counts == [7, 2, 1])
        #expect(qa.perform(hostAction: QaModerationAction.answered, id: "h0") == .dispatched)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: 150.0, failure: ""))
        #expect(qa.questions.entry(for: "h0").model.pendingAction == QaModerationAction.answered)
        session.releaseAcks()
        let marked = qa.questions.entry(for: "h0").model
        #expect(marked.status == .answered && marked.answeredByName == PeopleWebinarFixtureScript.moderatorName)
        #expect(marked.pendingAction.isEmpty && !qa.snapshot.questionIds.contains("h0"))
        #expect(qa.snapshot.counts == [6, 3, 1])

        qa.drafts.answers["h1"] = "In the chat after the session."
        #expect(qa.moderate(id: "h1", action: .answered, reopen: false, answerText: "In the chat after the session.") == .dispatched)
        #expect(session.queuedAcks.first?.ack == PeopleFixtureAck(delayMillis: 300.0, failure: ""))
        session.releaseAcks()
        let written = qa.questions.entry(for: "h1").model
        #expect(written.status == .answered && written.answerText == "In the chat after the session.")
        #expect(qa.snapshot.answeredQuestionId == "h1" && qa.drafts.answers["h1"] == nil)

        #expect(qa.perform(hostAction: QaModerationAction.answering, id: "h3") == .dispatched)
        session.releaseAcks()
        #expect(qa.questions.entry(for: "h3").model.status == .answering && qa.snapshot.questionIds.first == "h3")
        #expect(qa.perform(hostAction: QaModerationAction.reopen, id: "h7") == .dispatched)
        session.releaseAcks()
        #expect(qa.questions.entry(for: "h7").model.status == .pending && qa.questions.entry(for: "h7").model.answerText == "Answered live.")
        #expect(qa.perform(hostAction: QaModerationAction.dismissed, id: "h2") == .dispatched)
        session.releaseAcks()
        #expect(qa.questions.entry(for: "h2").model.status == .dismissed)
        #expect(qa.snapshot.counts == [5, 3, 2])
        #expect(session.countersReadout() == "qaModerate,qaModerate,qaModerate,qaModerate,qaModerate")
    }

    @Test func qaHostAnsweredOpensOnTheAnsweredFilterWithTwoEntries() throws {
        let session = PeopleWebinarFixtureSession(state: .qaHostAnswered)
        #expect(PeopleWebinarFixtureScript.initialFilter(.qaHostAnswered) == .answered)
        for state in PeopleWebinarFixtureState.allCases where state != .qaHostAnswered {
            #expect(PeopleWebinarFixtureScript.initialFilter(state) == .openQuestions, "\(state.rawValue)")
        }
        session.openQuestionsAndAnswers()
        let current = try #require(session.base.shell.panels.snapshot.current)
        #expect(current.panel == .webinarQA)
        #expect(session.people.qa.isPanelOpen)
        #expect(session.people.qa.snapshot.filter == .answered)
        #expect(session.people.qa.snapshot.questionIds == ["h7", "h8"])
        session.people.qa.panelDidOpen(presentationID: current.presentationID)
        #expect(session.people.qa.snapshot.filter == .answered, "the panel's own open keeps the filter")

        let open = PeopleWebinarFixtureSession(state: .qaHostOpen7)
        open.openQuestionsAndAnswers()
        #expect(open.base.shell.panels.snapshot.current?.panel == .webinarQA)
        #expect(open.people.qa.snapshot.filter == .openQuestions && open.people.qa.snapshot.questionIds.count == 7)
        #expect(!open.people.qa.isPanelOpen, "the panel registers its own open")
    }

    @Test func theBaseControlsLeftOnScreenKeepTheWebinarState() throws {
        for state in PeopleWebinarFixtureState.allCases {
            let session = PeopleWebinarFixtureSession(state: state)
            let before = session.people.inputs
            #expect(before == session.peopleInputs, "\(state.rawValue)")
            session.base.open(destination: .none)
            session.base.open(destination: .peopleRaisedHands)
            session.base.runSpeakerScript()
            #expect(session.people.inputs == before, "\(state.rawValue)")
            #expect(session.people.snapshot.webinarEnabled, "\(state.rawValue)")
        }
    }

    @Test func aSpeakerLandingThatOutlivesItsSessionIsDropped() async throws {
        let session = PeopleWebinarFixtureSession(state: .webinarAttendeePromoted)
        session.deliverPromotion()
        let invitation = try #require(session.people.stageInvitation)
        session.people.acceptStageInvitation(id: invitation.id)
        session.people.reset()
        try await Task.sleep(nanoseconds: 600_000_000)
        #expect(session.people.inputs.callSession == 0)
        #expect(session.peopleInputs.callSession == 1 && session.peopleInputs.isWebinarAttendee)
    }

    @Test func theQaOffStateTurnsTheComposerOff() {
        let session = PeopleWebinarFixtureSession(state: .qaAttendeeOff)
        #expect(session.people.qa.snapshot.isEnabled)
        session.turnQaOff()
        #expect(session.people.qa.snapshot.composerReason == QaComposerReason.qaOff)
        #expect(!session.people.qa.snapshot.composerEnabled)
    }
}

private func pplWebinarSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func pplWebinarNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
