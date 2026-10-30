#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct PeopleHostPoliciesTests {
    private func makePeople() -> PeoplePresenter {
        let shell = MeetingShellPresenter()
        return PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
    }

    private func ids(_ people: PeoplePresenter, _ section: PeopleSectionID) -> [String] {
        people.snapshot.section(section)?.rowIds ?? []
    }

    private func inputs(_ state: PeopleFixtureState) -> PeopleInputs {
        PeopleFixtureScript.inputs(for: state)
    }

    private func roster(local: String, _ people: [PeopleParticipantInput], isAdmin: Bool = false, callSession: Int = 1,
                        loaded: Bool = true) -> PeopleInputs {
        PeopleInputs.make(callSession: callSession, phase: MeetingPhaseKind.inCall.rawValue, localUserId: local,
                          participants: people, isRosterLoaded: loaded, isAdmin: isAdmin)
    }

    @Test func orderIsYouHostCoHostsThenJoinSerial() {
        let people = makePeople()
        people.apply(inputs(.host6))
        #expect(ids(people, .inMeeting) == ["u-ishaan", "u-avery", "u-lee", "u-sam", "u-priya", "u-omar"])
        people.apply(inputs(.guest4))
        #expect(ids(people, .inMeeting) == ["u-sam", "u-ishaan", "u-avery", "u-lee"])
        people.apply(inputs(.cohostViewingHost))
        #expect(ids(people, .inMeeting) == ["u-avery", "u-ishaan", "u-lee"])

        people.apply(roster(local: "me", [
            PeopleParticipantInput.make(userId: "me", displayName: "Me", isLocal: true),
            PeopleParticipantInput.make(userId: "z", displayName: "Zed"),
            PeopleParticipantInput.make(userId: "b", displayName: "Bea", joinSerial: 2),
            PeopleParticipantInput.make(userId: "a", displayName: "Al", joinSerial: 2),
            PeopleParticipantInput.make(userId: "c", displayName: "Cy", joinSerial: 1),
        ]))
        #expect(ids(people, .inMeeting) == ["me", "c", "a", "b", "z"])

        let stageOrder = StageOrderPolicy.joinOrder(PeopleFixtureScript.stageInputs(for: .host6).participants)
        people.apply(inputs(.host6))
        #expect(Array(ids(people, .inMeeting).dropFirst()) == stageOrder)
    }

    @Test func rolesFollowTheHostIdAndTheHostList() {
        #expect(PeopleOrderPolicy.viewerRole(inputs(.host6)) == .host)
        #expect(PeopleOrderPolicy.viewerRole(inputs(.cohostViewingHost)) == .coHost)
        #expect(PeopleOrderPolicy.viewerRole(inputs(.guest4)) == .participant)
        #expect(PeopleOrderPolicy.viewerRole(PeopleInputs.make(localUserId: "me", isAdmin: true)) == .host)
        #expect(PeopleOrderPolicy.viewerRole(PeopleInputs.make(localUserId: "me", isAdmin: true, isWebinarAttendee: true)) == .attendee)
        let people = makePeople()
        people.apply(inputs(.host6))
        #expect(people.rows.entry(for: "u-avery").model.role == .coHost)
        #expect(people.rows.entry(for: "u-ishaan").model.role == .host)
        #expect(people.rows.entry(for: "u-ishaan").model.isSelf)
        #expect(people.rows.entry(for: "u-lee").model.role == .participant)
        #expect(people.snapshot.isPrimaryHost && people.snapshot.canUseHostActions && people.snapshot.isHostViewer)
        people.apply(inputs(.guest4))
        #expect(people.rows.entry(for: "u-ishaan").model.role == .host)
        #expect(!people.snapshot.isHostViewer && !people.snapshot.canUseHostActions)
    }

    @Test func raisedHandsQueueByRaisedAtThenJoinSerial() {
        let people = makePeople()
        people.apply(inputs(.hostHands3))
        #expect(ids(people, .raisedHands) == ["u-avery", "u-sam", "u-lee"])
        #expect(people.rows.entry(for: "u-avery").model.handOrder == 1)
        #expect(people.rows.entry(for: "u-sam").model.handOrder == 2)
        #expect(people.rows.entry(for: "u-lee").model.handOrder == 3)
        #expect(people.rows.entry(for: "u-ishaan").model.handOrder == 0)

        people.apply(roster(local: "me", [
            PeopleParticipantInput.make(userId: "me", displayName: "Me", isLocal: true),
            PeopleParticipantInput.make(userId: "a", displayName: "Al", isHandRaised: true, joinSerial: 3),
            PeopleParticipantInput.make(userId: "b", displayName: "Bea", isHandRaised: true, joinSerial: 9, raisedAtMillis: 5000),
            PeopleParticipantInput.make(userId: "c", displayName: "Cy", isHandRaised: true, joinSerial: 1),
        ]))
        #expect(ids(people, .raisedHands) == ["b", "c", "a"])
    }

    @Test func waitingIsHostOnlyAndSortedByName() {
        let people = makePeople()
        people.apply(inputs(.hostWaiting3))
        #expect(ids(people, .waiting) == ["waiting:guest-71a2", "waiting:p-lee", "waiting:p-sam"])
        #expect(people.snapshot.sections.first?.id == PeopleSectionID.waiting.rawValue)
        let lee = people.waiting.entry(for: "waiting:p-lee").model
        #expect(lee.serverId == "p-lee" && lee.name == "Lee Park" && lee.isEnabled)

        people.apply(PeopleFixtureScript.peopleInputs(roster: PeopleFixtureScript.roster(for: .guest4), state: .hostWaiting3))
        #expect(people.snapshot.section(.waiting) == nil)
        #expect(!people.waiting.contains("waiting:p-lee"))
        #expect(PeopleOrderPolicy.waitingKey("p-1") == "waiting:p-1" && PeopleOrderPolicy.attendeeKey("a-1") == "attendee:a-1")
    }

    @Test func sectionsCarryCountsSearchKeysAndNames() {
        let people = makePeople()
        people.apply(inputs(.host6))
        #expect(people.snapshot.sections.map(\.id) == ["raisedHands", "inMeeting"])
        let meeting = people.snapshot.section(.inMeeting)
        #expect(meeting?.count == 6)
        #expect(meeting?.searchKeys == ["ishaan", "avery lee", "lee park", "sam ito", "priya n.", "omar k."])
        #expect(meeting?.names == ["Ishaan", "Avery Lee", "Lee Park", "Sam Ito", "Priya N.", "Omar K."])
        #expect(ids(people, .raisedHands) == ["u-avery"])

        #expect(people.rows.entry(for: "u-lee").model.detail == .presenting)
        #expect(people.rows.entry(for: "u-omar").model.detail == .reconnecting)
        #expect(people.rows.entry(for: "u-omar").model.isReconnecting)

        let samActions = people.rows.entry(for: "u-sam").model.actions
        #expect(!samActions.isEmpty, "row actions arrived with PPL-2")
        #expect(PeopleActionPolicy.groupOrder(samActions).first == 0 && samActions.last?.action == .remove)
    }

    @Test func attendeesAndLeavingPeopleNeverBecomeRows() {
        let people = makePeople()
        people.apply(roster(local: "me", [
            PeopleParticipantInput.make(userId: "me", displayName: "Me", isLocal: true),
            PeopleParticipantInput.make(userId: "att", displayName: "Attendee", isWebinarAttendee: true, joinSerial: 1),
            PeopleParticipantInput.make(userId: "gone", displayName: "Gone", isLeaving: true, joinSerial: 2),
            PeopleParticipantInput.make(userId: "dup", displayName: "Dup", joinSerial: 3),
            PeopleParticipantInput.make(userId: "dup", displayName: "Dup Again", joinSerial: 3),
        ]))
        #expect(ids(people, .inMeeting) == ["me", "dup"])
        #expect(!people.rows.contains("att") && !people.rows.contains("gone"))
        #expect(people.snapshot.section(.inMeeting)?.count == 2)
    }

    @Test func oneRowMutationWritesOneRowAndNoRevision() {
        let people = makePeople()
        people.apply(inputs(.host6))
        let revision = people.snapshot.revision
        let writes = people.rowWriteCount
        let lee = people.rows.entry(for: "u-lee")
        let leeModel = lee.model
        let muted = PeopleFixtureScript.peopleInputs(
            roster: PeopleFixtureScript.toggledMute(PeopleFixtureScript.hostSix(), userId: "u-sam"), state: .host6)
        people.apply(muted)
        #expect(people.rowWriteCount == writes + 1)
        #expect(people.snapshot.revision == revision, "a mute is not a structure change")
        #expect(!people.rows.entry(for: "u-sam").model.isMuted)
        #expect(people.rows.entry(for: "u-lee") === lee && lee.model == leeModel)

        people.apply(muted)
        #expect(people.rowWriteCount == writes + 1 && people.snapshot.revision == revision)

        var renamed: [PeopleFixturePerson] = []
        for person in PeopleFixtureScript.hostSix() {
            renamed.append(person.userId == "u-sam"
                ? PeopleFixturePerson.make(person.userId, "Samuel Ito", joinSerial: person.joinSerial)
                : person)
        }
        people.apply(PeopleFixtureScript.peopleInputs(roster: renamed, state: .host6))
        #expect(people.snapshot.revision == revision + 1)
        #expect(people.snapshot.section(.inMeeting)?.searchKeys.contains("samuel ito") == true)
    }

    @Test func speakerChangesPublishNothingToPeople() {
        let shell = MeetingShellPresenter()
        let stage = StagePresenter(shell: shell)
        let people = PeoplePresenter(shell: shell, stage: stage)
        stage.apply(PeopleFixtureScript.stageInputs(for: .host6))
        people.apply(inputs(.host6))
        let revision = people.snapshot.revision
        let writes = people.rowWriteCount
        let order = ids(people, .inMeeting)
        var at = 1000.0
        var last = ""
        for id in PeopleFixtureScript.speakerScript(for: .host6) {
            stage.speakerChanged(id, atMillis: at)
            at += 300.0
            last = id
        }
        #expect(PeopleFixtureScript.speakerScript(for: .host6).count == 20)
        #expect(people.snapshot.revision == revision && people.rowWriteCount == writes)
        #expect(ids(people, .inMeeting) == order, "People never follows the active speaker (D16)")

        #expect(people.speaking === stage.speaking)
        #expect(people.speaking.state(for: last).isSpeaking)
        #expect(!people.speaking.state(for: "u-ishaan").isSpeaking)
    }

    @Test func searchFiltersSearchKeysOnly() {
        let people = makePeople()
        people.apply(inputs(.host6))
        let sections = people.snapshot.sections
        let av = PeopleSearchPolicy.filter(sections, query: "av")
        #expect(av.map(\.id) == ["raisedHands", "inMeeting"])
        #expect(av.map(\.rowIds) == [["u-avery"], ["u-avery"]])
        #expect(av.map(\.count) == [1, 1])
        #expect(av.map(\.names) == [["Avery Lee"], ["Avery Lee"]])
        #expect(PeopleSearchPolicy.resultCount(av) == 2)
        #expect(PeopleSearchPolicy.filter(sections, query: "  AV ") == av)
        #expect(PeopleSearchPolicy.filter(sections, query: "zz").isEmpty)
        #expect(PeopleSearchPolicy.resultCount(PeopleSearchPolicy.filter(sections, query: "zz")) == 0)
        #expect(PeopleSearchPolicy.filter(sections, query: "") == sections)
        #expect(!PeopleSearchPolicy.isSearching("   ") && PeopleSearchPolicy.isSearching(" a"))

        #expect(PeopleSearchPolicy.filter(sections, query: "park").first?.rowIds == ["u-lee"])
        people.apply(inputs(.longNames))
        let rtl = PeopleSearchPolicy.filter(people.snapshot.sections, query: "\u{0639}\u{0628}\u{062F}")
        #expect(rtl.first?.rowIds == ["u-long-3"])
    }

    @Test func blockedReasonFootersAndTheLoadingRow() {
        #expect(PeopleRowPolicy.blockedReason(phase: "inCall", isNetworkOffline: false) == .none)
        #expect(PeopleRowPolicy.blockedReason(phase: "recovering", isNetworkOffline: false) == .reconnecting)
        #expect(PeopleRowPolicy.blockedReason(phase: "recovering", isNetworkOffline: true) == .offline)
        #expect(PeopleRowPolicy.blockedReason(phase: "entering", isNetworkOffline: false) == .notJoined)
        #expect(PeopleRowPolicy.blockedReason(phase: "leaving", isNetworkOffline: false) == .notJoined)
        let people = makePeople()
        people.apply(inputs(.hostRecovering))
        #expect(people.snapshot.blockedReason == "reconnecting" && !people.snapshot.canUseHostActions)
        #expect(PeopleRowPolicy.inMeetingFooter(people.snapshot) == .recovering)
        #expect(!people.waiting.entry(for: "waiting:p-sam").model.isEnabled)
        #expect(people.waiting.entry(for: "waiting:p-sam").model.reason == "reconnecting")
        #expect(ids(people, .inMeeting).count == 6, "every row stays while recovering (D11)")
        people.apply(inputs(.hostOffline))
        #expect(PeopleRowPolicy.inMeetingFooter(people.snapshot) == .offline)
        people.apply(inputs(.alone))
        #expect(PeopleRowPolicy.inMeetingFooter(people.snapshot) == .alone)

        people.apply(PeopleFixtureScript.peopleInputs(roster: PeopleFixtureScript.roster(for: .guest4), state: .hostRecovering))
        #expect(PeopleRowPolicy.inMeetingFooter(people.snapshot) == .none)
        people.apply(roster(local: "me", [PeopleParticipantInput.make(userId: "me", displayName: "Me", isLocal: true)], loaded: false))
        #expect(!people.snapshot.isRosterLoaded && PeopleRowPolicy.inMeetingFooter(people.snapshot) == .none)
        #expect(ids(people, .inMeeting) == ["me"], "the You row shows before the roster arrives")
    }

    @Test func accessSummaryInviteLinkAndQuestionsVisibility() {
        #expect(PeopleRowPolicy.accessSummary(isRoomLocked: true, isNoGuests: true) == .locked)
        #expect(PeopleRowPolicy.accessSummary(isRoomLocked: false, isNoGuests: true) == .signedInOnly)
        #expect(PeopleRowPolicy.accessSummary(isRoomLocked: false, isNoGuests: false) == .openToAll)
        #expect(PeopleRowPolicy.qaVisible(viewerRole: .host, isWebinarEnabled: true, isWebinarQaEnabled: true))
        #expect(PeopleRowPolicy.qaVisible(viewerRole: .coHost, isWebinarEnabled: true, isWebinarQaEnabled: true))
        #expect(!PeopleRowPolicy.qaVisible(viewerRole: .participant, isWebinarEnabled: true, isWebinarQaEnabled: true))
        #expect(!PeopleRowPolicy.qaVisible(viewerRole: .host, isWebinarEnabled: false, isWebinarQaEnabled: true))
        #expect(!PeopleRowPolicy.qaVisible(viewerRole: .host, isWebinarEnabled: true, isWebinarQaEnabled: false))
        let people = makePeople()
        people.apply(inputs(.host6))
        #expect(people.snapshot.accessSummary == "open")
        #expect(people.snapshot.inviteLink == StageFixtureScript.meetingLink && people.snapshot.roomLabel == StageFixtureScript.roomLabel)
        let revision = people.snapshot.revision
        people.apply(PeopleInputs.make(callSession: 1, phase: "inCall", localUserId: "u-ishaan",
                                       participants: inputs(.host6).participants, isRosterLoaded: true, isAdmin: true,
                                       hostUserId: "u-ishaan", hostUserIds: ["u-ishaan", "u-avery"],
                                       meetingLink: StageFixtureScript.meetingLink, roomLabel: StageFixtureScript.roomLabel,
                                       isRoomLocked: true, webinarAttendeeCount: 128))
        #expect(people.snapshot.accessSummary == "locked" && people.snapshot.revision == revision + 1)
        #expect(people.attendeeCount == 128, "the attendee count is its own property")
    }

    @Test func destinationsScrollOnceAndRepeatsDoNothing() throws {
        let people = makePeople()
        people.apply(inputs(.hostWaiting3))
        people.panelDidOpen(destination: .peopleWaiting, presentationID: 7)
        let request = try #require(people.focusRequest)
        #expect(request.sectionId == "waiting")
        people.focusRequestHandled(id: request.id + 1)
        #expect(people.focusRequest == request)
        people.focusRequestHandled(id: request.id)
        #expect(people.focusRequest == nil)

        people.panelDidOpen(destination: .peopleWaiting, presentationID: 7)
        #expect(people.focusRequest == nil)
        #expect(people.focusReadout() == "destination=peopleWaiting scrolls=1")
        people.panelDidClose(presentationID: 7)
        people.panelDidOpen(destination: .none, presentationID: 8)
        #expect(people.focusRequest == nil && people.focusReadout() == "destination=none scrolls=0")

        let session = people.shell.panels.snapshot.session
        let raised = PanelDestinationRequest(sequence: 3, session: session, presentationID: 8, panel: .participants,
                                             invoker: .call, destination: .peopleRaisedHands, targetId: "")
        people.destinationRequested(raised)
        let next = try #require(people.focusRequest)
        #expect(next.sectionId == "raisedHands" && next.id > request.id)
        people.focusRequestHandled(id: next.id)
        people.destinationRequested(raised)
        #expect(people.focusRequest == nil, "the same sequence is one request")
        people.destinationRequested(PanelDestinationRequest(sequence: 4, session: session, presentationID: 9, panel: .participants,
                                                            invoker: .call, destination: .peopleWaiting, targetId: ""))
        people.destinationRequested(PanelDestinationRequest(sequence: 5, session: session, presentationID: 8, panel: .chat,
                                                            invoker: .call, destination: .chatPrivate, targetId: "u-sam"))
        #expect(people.focusRequest == nil)
    }

    @Test func theCoordinatorDismissalClosesThePresentation() throws {
        let shell = MeetingShellPresenter()
        let people = PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
        shell.panels.present(.participants, from: .call, destination: .peopleWaiting)
        let current = try #require(shell.panels.snapshot.current)
        people.panelDidOpen(destination: current.destination, presentationID: current.presentationID)
        people.panelSnapshotChanged()
        #expect(people.openPresentationID == current.presentationID)
        shell.panels.dismiss(cancelPending: true)
        people.panelSnapshotChanged()
        #expect(people.openPresentationID == current.presentationID, "still dismissing")
        shell.panels.didDismiss(session: shell.panels.snapshot.session, presentationID: current.presentationID)
        people.panelSnapshotChanged()
        #expect(people.openPresentationID == 0 && people.focusRequest == nil)
        people.presentationDidChange(coverage: .partial, onHostPage: true)
        #expect(people.coverage == .partial && people.isOnHostPage)
    }

    @Test func losingHostWhileOpenShowsTheNoticeUntilClose() {
        let people = makePeople()
        people.apply(inputs(.lostHost))
        #expect(people.snapshot.section(.waiting) != nil)
        people.panelDidOpen(destination: .none, presentationID: 11)
        let lost = PeopleFixtureScript.peopleInputs(roster: PeopleFixtureScript.roster(for: .lostHost), state: .lostHost,
                                                    isAdminOverride: false)
        people.apply(lost)
        #expect(people.snapshot.viewerRole == .participant && people.snapshot.showsLostHostNotice)
        #expect(people.snapshot.section(.waiting) == nil && !people.waiting.contains("waiting:p-lee"))
        people.panelDidClose(presentationID: 11)
        #expect(!people.snapshot.showsLostHostNotice)

        let closed = makePeople()
        closed.apply(inputs(.lostHost))
        closed.apply(lost)
        #expect(!closed.snapshot.showsLostHostNotice)
        closed.panelDidOpen(destination: .none, presentationID: 12)
        closed.apply(inputs(.lostHost))
        #expect(!closed.snapshot.showsLostHostNotice && closed.snapshot.isHostViewer)
    }

    @Test func aNewCallSessionStartsClean() {
        let people = makePeople()
        people.apply(inputs(.host6))
        people.panelDidOpen(destination: .peopleRaisedHands, presentationID: 3)
        let revision = people.snapshot.revision
        people.apply(roster(local: "solo", [PeopleParticipantInput.make(userId: "solo", displayName: "Solo", isLocal: true)],
                            callSession: 2))
        #expect(!people.rows.contains("u-avery") && ids(people, .inMeeting) == ["solo"])
        #expect(people.snapshot.revision > revision && people.focusRequest == nil && people.openPresentationID == 0)
        let afterSwitch = people.snapshot.revision
        people.reset()
        #expect(people.snapshot.sections.isEmpty && people.snapshot.revision > afterSwitch && people.rows.count == 0)
    }

    @Test func avatarSeedsMatchTheStageTile() {
        #expect(PeopleRowPolicy.avatarSeed(name: "Avery Lee Smith", userId: "user-1", isLocal: false)
                == FacehashPresentation.seed(name: "Avery Lee", id: "user-1"))
        #expect(PeopleRowPolicy.avatarSeed(name: "", userId: "me", isLocal: true) == FacehashPresentation.seed(name: "You", id: "me"))
        let shell = MeetingShellPresenter()
        let stage = StagePresenter(shell: shell)
        let people = PeoplePresenter(shell: shell, stage: stage)
        stage.apply(PeopleFixtureScript.stageInputs(for: .host6))
        people.apply(inputs(.host6))
        for id in ["u-ishaan", "u-avery", "u-lee", "u-sam", "u-priya", "u-omar"] {
            #expect(stage.tileChrome.entry(for: id).model.avatarSeed == people.rows.entry(for: id).model.avatarSeed, "\(id)")
        }
    }

    @Test func everyFixtureBuildsOverTheSameStageRoster() {
        for state in PeopleFixtureState.allCases {
            let session = PeopleFixtureSession(state: state)
            #expect(!session.people.snapshot.sections.isEmpty, "\(state.rawValue)")
            #expect(session.people.snapshot.isRosterLoaded, "\(state.rawValue)")
            let stageIds = Set(session.stage.inputs.participants.map(\.userId))
            let peopleIds = Set(session.inputs.participants.map(\.userId))
            #expect(stageIds == peopleIds, "\(state.rawValue): the stage and People share canonical ids")
            #expect(session.people.recompose === session.recompose)
        }
        #expect(PeopleFixtureState(rawValue: "people-host-6") == .host6)
        #expect(PeopleFixtureScript.state(named: " people-alone ") == .alone)
        #expect(PeopleFixtureScript.searchText(for: .searchNone) == "zz")
        #expect(PeopleFixtureSession(state: .searchNone).people.initialSearchQuery == "zz")
        #expect(PeopleFixtureScript.openDestination(for: .hostWaiting3) == .peopleWaiting)
        #expect(PeopleFixtureScript.openDestination(for: .hostHands3) == .peopleRaisedHands)
        #expect(PeopleFixtureScript.openDestination(for: .host6) == .none)

        var hasArabic = false
        for person in PeopleFixtureScript.roster(for: .longNames) where !person.isLocal {
            #expect(person.name.count >= 60 && person.name.count <= 80, "\(person.name.count)")
            if person.name.unicodeScalars.contains(where: { $0.value >= 0x0600 && $0.value <= 0x06FF }) { hasArabic = true }
        }
        #expect(hasArabic)
        #expect(PeopleFixtureScript.waiting(for: .longNames).first.map { $0.displayName.count >= 60 } == true)
    }

    @Test func fixtureScriptsMoveOneRowAndLoseHost() throws {
        let session = PeopleFixtureSession(state: .host6)
        let revision = session.people.snapshot.revision
        let writes = session.people.rowWriteCount
        session.scriptedMute()
        #expect(session.people.rowWriteCount == writes + 1 && session.people.snapshot.revision == revision)
        #expect(session.people.rows.entry(for: "u-avery").model.isMuted, "the scripted mute flips Avery Lee")
        session.runSpeakerScript()
        #expect(session.people.snapshot.revision == revision && session.people.rowWriteCount == writes + 1)
        session.open(destination: .peopleWaiting)
        let current = try #require(session.shell.panels.snapshot.current)
        #expect(current.panel == .participants && current.destination == .peopleWaiting && current.invoker == .call)
        let lost = PeopleFixtureSession(state: .lostHost)
        lost.open(destination: .none)
        let open = try #require(lost.shell.panels.snapshot.current)
        lost.people.panelDidOpen(destination: open.destination, presentationID: open.presentationID)
        lost.loseHost()
        #expect(lost.people.snapshot.showsLostHostNotice && lost.people.snapshot.section(.waiting) == nil)
        #expect(lost.countersReadout().contains("lostHost=1"))
    }

    @Test func sharedPeopleSourcesStayInSkipLite() throws {
        let shared = try peopleFiles(under: "Sources/Conclave/Features/Meeting/People", extensions: ["swift"]).filter { !$0.contains("+iOS") }
        #expect(shared.count >= 6)
        for file in shared {
            let text = peopleCode(try peopleSource(file))
            #expect(!text.contains("#if"), "\(file) is shared and must not branch by platform")
            #expect(peopleMatches(#"\bprotocol\s"#, in: text).isEmpty, "\(file) declares a protocol")
            #expect(peopleMatches(#"case\s+\w+\("#, in: text).isEmpty, "\(file) has an associated value")
            #expect(peopleMatches(#"\.(map|compactMap|flatMap|filter)\(\w+(\.init)?\)"#, in: text).isEmpty, "\(file) maps with a function reference")
            #expect(peopleMatches(#"->\s*\("#, in: text).isEmpty, "\(file) returns a tuple")
            #expect(!text.contains("inout ") && !text.contains("isLetter"), "\(file)")
            #expect(!text.contains("withObservationTracking"), "\(file) observes itself")
            #expect(!text.contains("MeetingViewModel") && !text.contains("MeetingState"), "\(file) reads the core")
        }
    }

    @Test func peopleSourcesStayFlatDashFreeAndOffTheCore() throws {
        let files = try peopleFiles(under: "Sources/Conclave/Features/Meeting/People", extensions: ["swift"])
            + peopleFiles(under: "Sources/Conclave/Skip/ui/people", extensions: ["kt"])
        #expect(files.count >= 11)
        for file in files {
            let text = try peopleSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file) mentions a gradient")
            for pattern in ["glassEffect", "GlassEffectContainer", "ultraThinMaterial", "regularMaterial",
                            "preferredColorScheme", "announceForAccessibility", "HapticManager", "MeetingViewModel.shared",
                            "SearchBar(", "DockedSearchBar", "dynamicLightColorScheme", "dynamicDarkColorScheme", "LazyVGrid",
                            "@Stable", "@Immutable", "verticalScroll"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }

            if !file.contains("+iOS") {
                #expect(!text.contains("contextMenu"), "\(file) uses contextMenu outside an iOS-only file")
            }
            #expect(peopleMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x|white:)"#, in: text).isEmpty, "\(file) builds a color from a literal")
        }

        for file in files where file.contains("+iOS") || file.hasSuffix(".kt") {
            let text = peopleCode(try peopleSource(file))
            #expect(!text.contains("MeetingState") && !text.contains("MeetingViewModel"), "\(file) reads the core")
        }
    }

    @Test func iosPanelUsesTheShellPathSearchAndLeaves() throws {
        let panel = peopleNormalized(try peopleSource("Sources/Conclave/Features/Meeting/People/ParticipantsPanel+iOS.swift"))
        #expect(panel.contains("PanelShell(title: ConclaveStrings.text(\"Participants\")"))
        #expect(panel.contains("path: $route,"))
        #expect(panel.components(separatedBy: ".navigationDestination(for: PeopleRoute.self)").count - 1 == 1)
        #expect(panel.contains(".task(id: presentation.request.presentationID) { people.panelDidOpen("))
        #expect(panel.contains(".listStyle(.insetGrouped)"))
        #expect(panel.contains(".conclaveSearchable(text: $query, isPresented: $isSearching, prompt: ConclaveStrings.text(\"Search Participants\"))"))
        #expect(panel.contains("ConclaveSearchEmptyState(query: query"))
        #expect(panel.contains(".conclaveSearchAnnouncement(query: query, resultCount: PeopleSearchPolicy.resultCount(shown))"))
        #expect(panel.contains("PeopleSearchPolicy.filter(snapshot.sections, query: query)"))
        #expect(panel.contains("if on { promoteToLarge() }"))
        #expect(panel.contains("let target = PeopleFocusTarget.header(request.sectionId)"))
        #expect(panel.contains("proxy.scrollTo(target, anchor: .top)"))
        #expect(!panel.contains("proxy.scrollTo(request.sectionId"), "S1-T7: the destination scroll targets the section header")
        #expect(panel.contains("people.focusRequestHandled(id: request.id)"))
        #expect(panel.contains(".accessibilityRotor(Text(ConclaveStrings.text(\"Raised Hands\")))"))
        #expect(panel.contains("ShareLink(item: url, subject: Text(ConclaveStrings.text(\"Join My Conclave Meeting\"))"))
        #expect(panel.contains("NavigationLink(value: PeopleRoute.hostControls)"))
        #expect(panel.contains("people.destinationRequested(request)") && panel.contains("people.presentationDidChange(coverage: coverage"))
        #expect(!panel.contains(".onAppear"), "the presentation lifecycle drives open, never a root view's onAppear")
        #expect(!panel.contains("NavigationStack"), "the shell owns the one stack")
        let rows = peopleNormalized(try peopleSource("Sources/Conclave/Features/Meeting/People/PeopleRows+iOS.swift"))
        #expect(rows.contains("ConclavePersonRow(name: PeopleText.displayName(model)"))
        #expect(rows.contains("ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(model.avatarSeed), size: .row)"))
        #expect(rows.contains("static let separator = \" \\u{00B7} \""))

        let rowBody = try #require(rows.range(of: "struct PeopleRowView<Trailing: View>: View {"))
        let rowEnd = try #require(rows.range(of: "extension PeopleRowView where Trailing == EmptyView", range: rowBody.upperBound..<rows.endIndex))
        #expect(!String(rows[rowBody.upperBound..<rowEnd.lowerBound]).contains("speaking.isSpeaking"))
        #expect(rows.components(separatedBy: "speaking.isSpeaking").count - 1 == 2)
        #expect(rows.contains("HostingTheme.statusWarning") && rows.contains(".monospacedDigit()"))
        let fixture = try peopleSource("Sources/Conclave/Features/Meeting/People/Debug/PeopleFixtureView+iOS.swift")
        #expect(fixture.hasPrefix("#if DEBUG && os(iOS) && !SKIP\n"))
        for file in ["Sources/Conclave/Features/Meeting/People/ParticipantsPanel+iOS.swift",
                     "Sources/Conclave/Features/Meeting/People/PeopleRows+iOS.swift"] {
            #expect(try peopleSource(file).hasPrefix("#if os(iOS) && !SKIP\n"), "\(file)")
        }
    }

    @Test func androidPageUsesLazyListThePageStackAndTheSearchField() throws {
        let page = peopleNormalized(try peopleSource("Sources/Conclave/Skip/ui/people/ParticipantsPage.kt"))
        #expect(page.contains("contentMode = InCallPageContent.lazyList,"))
        #expect(page.contains("hideMiniTileWithIme = true,"))
        #expect(page.contains("hasComposer = false,"))
        #expect(page.contains("val pages = LocalPanelPageStack.current"))
        #expect(page.contains("isNested = pages?.isNested == true,") && page.contains("onBack = { pages?.pop() },"))
        #expect(page.contains("pages?.push(PeopleRoute.hostControls.rawValue)"))
        #expect(page.contains("ConclaveSearchField("))
        #expect(page.contains("LazyColumn(state = listState, contentPadding = reservation"))
        #expect(page.contains("items(entries, key = { it.key }, contentType = { it.kind })"))
        #expect(page.contains("remember(snapshot.revision, query) { PeopleSearchPolicy.filter(snapshot.sections, query = query) }"))
        #expect(page.contains("snapshotFlow { listState.isScrollInProgress }"))
        #expect(page.contains("people.focusRequestHandled(id = request.id)"))
        #expect(page.contains("if (reduceMotion) listState.scrollToItem(index) else listState.animateScrollToItem(index)"))
        #expect(page.contains("people.panelDidOpen(destination = request.destination, presentationID = request.presentationID)"))
        #expect(page.contains("stageShareMeetingLink(context, link, roomLabel)"))
        let row = peopleNormalized(try peopleSource("Sources/Conclave/Skip/ui/people/PersonRow.kt"))
        #expect(row.contains(".semantics(mergeDescendants = true) { if (texts.states.isNotEmpty()) stateDescription = texts.states }"))
        #expect(row.contains("hapticFeedbackEnabled = false,") && row.contains("haptics.gesture(FeedbackKind.longPress)"))
        #expect(row.contains("onClickLabel = texts.actionsLabel,") && row.contains("onLongClickLabel = texts.actionsLabel,"))
        #expect(row.contains("maxLines = 2, overflow = TextOverflow.Ellipsis"))
        #expect(row.contains("remember(model, showsQueue, queueCount, context) { personRowTexts(context, model, showsQueue, queueCount) }"))
        #expect(row.contains("ConclaveAvatarIdentity.fromSeed(model.avatarSeed)"))
        #expect(row.contains("LocalConclaveExtendedColors.current.handRaised"))

        #expect(row.components(separatedBy: "speaking.isSpeaking").count - 1 == 1)
        #expect(row.contains("private fun PeopleSpeakingIcon(speaking: TileSpeakingState) { if (speaking.isSpeaking) {"))
        let fixture = try peopleSource("Sources/Conclave/Skip/ui/people/debug/PeopleFixtureRoot.kt")
        #expect(fixture.contains("fun PeopleFixtureRoot(stateName: String, patternName: String? = null, forceScreenReader: Boolean = false)"))
        #expect(!fixture.contains("getStringExtra"), "MainActivity reads the extras behind FLAG_DEBUGGABLE")
    }

    @Test func peopleStringsExistOnBothPlatforms() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(peopleSource("Sources/Conclave/Resources/Localizable.xcstrings").utf8))
            as? [String: Any])
        let keys = Set((catalog["strings"] as? [String: Any] ?? [:]).keys)
        for file in try peopleFiles(under: "Sources/Conclave/Features/Meeting/People", extensions: ["swift"]) where file.contains("+iOS") {

            let text = try peopleSource(file).replacingOccurrences(of: "\\u{2019}", with: "\u{2019}")
                .replacingOccurrences(of: "\\u{2026}", with: "\u{2026}")
            for match in peopleCaptures(#"ConclaveStrings\.(?:text|format)\("([^"]+)""#, in: text) {
                #expect(keys.contains(match), "\(file): missing catalog key \(match)")
            }
        }
        let xml = try peopleSource("Android/app/src/main/res/values/strings.xml")
        let names = Set(peopleCaptures(#"<(?:string|plurals) name="([a-z0-9_]+)""#, in: xml))
        for file in try peopleFiles(under: "Sources/Conclave/Skip/ui/people", extensions: ["kt"]) {
            for match in peopleCaptures(#""((?:ppl|ds|native_panel)_[a-z0-9_]+)""#, in: try peopleSource(file)) {
                #expect(names.contains(match), "\(file): missing resource \(match)")
            }
        }

        for name in names where name.hasPrefix("ppl_") {
            #expect(!xml.contains("name=\"\(name)\">'"), "\(name)")
        }
        #expect(xml.contains("<string name=\"ppl_queue_position\">%1$d of %2$d in queue</string>"))
        #expect(xml.contains("<string name=\"ppl_sub_join\">%1$s \u{00B7} %2$s</string>"))
        #expect(keys.contains("You\u{2019}re the only one here.") && keys.contains("%lld of %lld in queue"))
    }
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct PeopleViewModelWiringTests {
    private func makeJoinedViewModel() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        return viewModel
    }

    @Test func everyPeopleFieldRefreshesPeopleOnceAndHotFieldsNever() {
        let viewModel = makeJoinedViewModel()
        let state = viewModel.state
        func refreshesOnce(_ name: String, _ change: () -> Void) {
            let before = viewModel.peopleRefreshCount
            change()
            #expect(viewModel.peopleRefreshCount == before + 1, "\(name) refreshed \(viewModel.peopleRefreshCount - before) times")
            #expect(viewModel.people.inputs == viewModel.makePeopleInputs(), "\(name) left stale People inputs")
        }
        func refreshesNever(_ name: String, _ change: () -> Void) {
            let before = viewModel.peopleRefreshCount
            change()
            #expect(viewModel.peopleRefreshCount == before, "\(name) refreshed People")
        }

        refreshesOnce("isNetworkOffline") { state.isNetworkOffline = true }
        refreshesOnce("connectionState") { state.connectionState = ConnectionState.reconnecting }
        refreshesOnce("roomId") { state.roomId = "room-b" }
        refreshesOnce("isRoomLocked") { state.isRoomLocked = true }
        refreshesOnce("isNoGuests") { state.isNoGuests = true }
        refreshesOnce("isWebinarEnabled") { state.isWebinarEnabled = true }
        refreshesOnce("isWebinarPublicAccess") { state.isWebinarPublicAccess = true }
        refreshesOnce("webinarAttendeeCount") { state.webinarAttendeeCount = 3 }
        refreshesOnce("webinarLinkURL") { state.webinarLinkURL = "https://example.com/w" }
        refreshesOnce("isAdmin") { state.isAdmin = true }
        refreshesOnce("hostUserId") { state.hostUserId = "local@example.com#local-session" }
        refreshesOnce("hostUserIds") { state.hostUserIds = ["local@example.com#local-session"] }
        refreshesOnce("displayName") { state.displayName = "Robin" }
        refreshesOnce("participants") { state.participants["r@example.com#r"] = Participant(id: "r@example.com#r", isCameraOff: false) }
        refreshesOnce("displayNames") { state.displayNames["r@example.com#r"] = "Rae Lynn Smith" }
        refreshesOnce("pendingUsers") { state.pendingUsers["p@example.com#p"] = "Pat" }
        refreshesOnce("hasInitialPresenceSnapshot") { state.hasInitialPresenceSnapshot = true }
        refreshesOnce("isMuted") { state.isMuted = false }
        refreshesOnce("isCameraOff") { state.isCameraOff = false }
        refreshesOnce("isScreenSharing") { state.isScreenSharing = true }
        refreshesOnce("isHandRaised") { state.isHandRaised = true }

        refreshesNever("activeSpeakerId") { state.activeSpeakerId = "r@example.com#r" }
        refreshesNever("webinarSpeakerUserId") { state.webinarSpeakerUserId = "r@example.com#r" }
        refreshesNever("webinarFeedMode") { state.webinarFeedMode = "manual" }
        refreshesNever("isAudioOnlyMode") { state.isAudioOnlyMode = true }
        refreshesNever("connectionQuality") { state.connectionQuality = .poor }
        refreshesNever("activeReactions") { state.activeReactions = [] }
        refreshesNever("joinFormErrorMessage") { state.joinFormErrorMessage = "Invalid" }
    }

    @Test func peopleInputsAreCanonicalWithFullNamesAndCoreSerials() {
        let viewModel = makeJoinedViewModel()
        let state = viewModel.state
        state.hasInitialPresenceSnapshot = true
        _ = viewModel.markRemoteParticipantPresent("ann@example.com#s1")
        _ = viewModel.markRemoteParticipantPresent("bob@example.com#s2")
        state.displayNames["ann@example.com#s1"] = "Ann Marie Jones"
        let inputs = viewModel.makePeopleInputs()
        #expect(inputs.participants.first?.isLocal == true && inputs.participants.first?.userId == state.userId)
        let ann = inputs.participants.first { $0.userId.hasPrefix("ann") }
        #expect(ann?.displayName == "Ann Marie Jones", "no two-word cut (S50 2 j)")
        let bob = inputs.participants.first { $0.userId.hasPrefix("bob") }
        #expect((ann?.joinSerial ?? 0) > 0 && (bob?.joinSerial ?? 0) > (ann?.joinSerial ?? 0))

        let stageAnn = viewModel.makeStageInputs().participants.first { $0.userId.hasPrefix("ann") }
        #expect(stageAnn?.joinSerial == ann?.joinSerial)
        #expect(viewModel.people.snapshot.section(.inMeeting)?.rowIds.first == state.userId)
    }

    @Test func losingHostClearsHostOnlyStateAndTheBadge() {
        let viewModel = makeJoinedViewModel()
        let state = viewModel.state
        state.isAdmin = true
        state.pendingUsers = ["p1": "Pat", "p2": "Quinn"]
        state.adminAllowedUserKeys = ["a@example.com"]
        #expect(viewModel.makeShellInputs().pendingUsersCount == 2)
        state.isAdmin = false
        #expect(state.pendingUsers.isEmpty && state.adminAllowedUserKeys.isEmpty)

        state.pendingUsers = ["p3": "Rae"]
        #expect(viewModel.makeShellInputs().pendingUsersCount == 0)
        #expect(viewModel.people.snapshot.section(.waiting) == nil)
    }
}
#endif

private func peoplePackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func peopleSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: peoplePackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func peopleFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = peoplePackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func peopleCode(_ text: String) -> String {
    var lines: [String] = []
    for line in text.components(separatedBy: "\n") {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("//") || trimmed.hasPrefix("*") || trimmed.hasPrefix("/*") { continue }
        if let range = line.range(of: " // ") {
            lines.append(String(line[line.startIndex..<range.lowerBound]))
        } else {
            lines.append(line)
        }
    }
    return lines.joined(separator: "\n")
}

private func peopleNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func peopleMatches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}

private func peopleCaptures(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        guard match.numberOfRanges > 1 else { return nil }
        return Range(match.range(at: 1), in: text).map { String(text[$0]) }
    }
}
#endif
