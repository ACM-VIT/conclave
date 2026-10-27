import Foundation
import Observation

/// S50 0.5: the session-owned People presenter, created with the S1 `MeetingShellPresenter` and the S20
/// `StagePresenter` and reset with them (S1C 3.2, 3.3 TEAR). The core pushes `PeopleInputs` through `apply(_:)` on its
/// own refresh path (PH1); the presenter never observes the core (SkipModel has no `withObservationTracking`). Views
/// read only this presenter: the container observes `snapshot` (structure), each row its own `PersonRowEntry` or
/// `WaitingRowEntry`, the speaking glyph the S20 `TileSpeakingStore` leaf, and the count leaves `attendeeCount` and
/// `qaUnseen`. A speaker change publishes nothing here (the presenter has no speaker hook).
///
/// PPL-1 scope: rows, sections, search inputs, the Host Controls row value, the panel lifecycle and the destination
/// scroll. Extension points (keep per-feature state here, not in the views): PPL-2 adds `perform`, the
/// `HostActionLedger`, `onCommand`, `finish`, `confirmation`, `lastFailure`, `feedbackState` and fills
/// `PersonRowModel.actions`; PPL-3 the waiting and hand actions; PPL-4 `host`; PPL-5 the webinar sections and
/// `webinarQueueKnown`; PPL-6 `qa` and `qaUnseen`; PPL-7 the full role-change table and `stageInvitation`.
@MainActor
@Observable
final class PeoplePresenter {
    private(set) var snapshot: PeopleSnapshot = PeopleSnapshot.empty
    /// Own stored property: only the Attendees count row reads it (S50 1 k).
    private(set) var attendeeCount: Int = 0
    /// Own stored property: only the Q&A row value reads it (PH7 feeds it with PPL-6).
    private(set) var qaUnseen: Int = 0
    /// The destination scroll target (S20 SR7); cleared by `focusRequestHandled(id:)`.
    private(set) var focusRequest: PeopleFocusRequest? = nil

    @ObservationIgnored let rows = PersonRowStore()
    @ObservationIgnored let waiting = WaitingRowStore()
    @ObservationIgnored let shell: MeetingShellPresenter
    /// The speaking leaf reads `stage.speaking` (S20 SL4); PPL-2 forwards Pin to `stage.togglePin(userId:)`.
    @ObservationIgnored let stage: StagePresenter
    /// Debug readout `people.recompose.<rowId>` (PL12); nil in production.
    @ObservationIgnored var recompose: PeopleRecomposeLedger? = nil
    /// The search text a panel opens with: always empty in production; the people-search-none fixture seeds "zz"
    /// (PL12). Read once when the panel mounts; the query itself stays view state (PL8).
    @ObservationIgnored var initialSearchQuery = ""

    @ObservationIgnored private(set) var inputs = PeopleInputs.make()
    /// Diagnostics for readouts and tests (never observed).
    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private(set) var rowWriteCount = 0
    @ObservationIgnored private(set) var coverage = PanelStageCoverage.none
    @ObservationIgnored private(set) var isOnHostPage = false
    @ObservationIgnored private(set) var openPresentationID = 0
    @ObservationIgnored private(set) var openDestination = PanelDestination.none
    /// `people.focus` (PL12): destinations requested this presentation and the scrolls the views performed.
    @ObservationIgnored private(set) var focusDestinations: [String] = []
    @ObservationIgnored private(set) var focusScrollCount = 0

    @ObservationIgnored private var nextFocusId = 0
    @ObservationIgnored private var lastDestinationSequence = -1
    @ObservationIgnored private var showsLostHost = false

    init(shell: MeetingShellPresenter, stage: StagePresenter) {
        self.shell = shell
        self.stage = stage
    }

    /// The S20 speaking store the row leaves read.
    var speaking: TileSpeakingStore { stage.speaking }

    // MARK: Core hooks

    /// Core only (PH1): the whole input set, equality guarded per published property and per row.
    func apply(_ next: PeopleInputs) {
        applyCount += 1
        // A new call session starts clean (S1C SES): rows, focus and the lost-host notice never carry over.
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            reset()
        }
        let previousViewer = snapshot.viewerRole
        inputs = next
        rebuild(previousViewer: previousViewer)
    }

    /// Core only: the S1 panel snapshot changed. When the presentation this presenter opened is no longer current the
    /// panel has closed (S50 1 c: `panelDidClose` comes from the coordinator's dismissal, never a root view's
    /// disappearance, so an iPad sheet-to-inspector move never closes it).
    func panelSnapshotChanged() {
        guard openPresentationID != 0 else { return }
        let current = shell.panels.snapshot.current
        if current == nil || current?.presentationID != openPresentationID || current?.panel != MeetingPanel.participants {
            panelDidClose(presentationID: openPresentationID)
        }
    }

    // MARK: Presentation lifecycle (the panel host)

    /// From the presentation lifecycle only (S50 1 c `.task(id: presentationID)`, 1 d `onMounted`): publishes the
    /// destination's scroll target once. A repeat for the same presentation (a host migration) does nothing, so the
    /// list never scrolls twice.
    func panelDidOpen(destination: PanelDestination, presentationID: Int) {
        if presentationID == 0 || presentationID == openPresentationID { return }
        openPresentationID = presentationID
        openDestination = destination
        focusDestinations = []
        focusScrollCount = 0
        if showsLostHost {
            showsLostHost = false
            rebuild(previousViewer: snapshot.viewerRole)
        }
        publishFocus(destination)
    }

    /// Clears the lost-host notice, coverage and any unhandled focus (PL14 inline failures join with PPL-2).
    func panelDidClose(presentationID: Int) {
        if presentationID == 0 || presentationID != openPresentationID { return }
        openPresentationID = 0
        openDestination = PanelDestination.none
        coverage = PanelStageCoverage.none
        isOnHostPage = false
        if focusRequest != nil { focusRequest = nil }
        if showsLostHost {
            showsLostHost = false
            rebuild(previousViewer: snapshot.viewerRole)
        }
    }

    /// A same-panel destination while Participants is open (S20 SR7, PNL-1 `destinationRequest`), for example the
    /// knock banner's View: the shown list scrolls to the section without a new presentation.
    func destinationRequested(_ request: PanelDestinationRequest) {
        guard openPresentationID != 0, request.panel == MeetingPanel.participants,
              request.presentationID == openPresentationID, request.session == shell.panels.snapshot.session,
              request.sequence != lastDestinationSequence else { return }
        lastDestinationSequence = request.sequence
        openDestination = request.destination
        publishFocus(request.destination)
    }

    /// The view scrolled (or found nothing to scroll to); a pop back from a pushed page finds `nil` and stays put.
    func focusRequestHandled(id: Int) {
        guard let request = focusRequest, request.id == id else { return }
        focusRequest = nil
        focusScrollCount += 1
    }

    /// The panel host reports the same coverage PS 6.2 reports to the stage (sheet medium partial, large full,
    /// inspector none, Android overlay full, side pane none) and whether a host page is on top; PPL-2's failure
    /// placement reads it (PL14 by origin, RECONCILE R2).
    func presentationDidChange(coverage: PanelStageCoverage, onHostPage: Bool) {
        self.coverage = coverage
        isOnHostPage = onHostPage
    }

    /// Questions and Answers replaces the panel (S50 1 a, 11); the row shows only while `snapshot.qaVisible`.
    func openQuestionsAndAnswers() {
        shell.panels.present(MeetingPanel.webinarQA, from: PanelInvoker.call)
    }

    /// With the S1 reset (S1C 3.3 TEAR): stores, focus and the open presentation clear; revisions keep growing so a
    /// view never mistakes a reset for "unchanged".
    func reset() {
        rows.removeAll()
        waiting.removeAll()
        inputs = PeopleInputs.make()
        openPresentationID = 0
        openDestination = PanelDestination.none
        coverage = PanelStageCoverage.none
        isOnHostPage = false
        focusDestinations = []
        focusScrollCount = 0
        lastDestinationSequence = -1
        showsLostHost = false
        if focusRequest != nil { focusRequest = nil }
        if snapshot.withRevision(0) != PeopleSnapshot.empty {
            snapshot = PeopleSnapshot.empty.withRevision(snapshot.revision + 1)
        }
        if attendeeCount != 0 { attendeeCount = 0 }
        if qaUnseen != 0 { qaUnseen = 0 }
    }

    // MARK: Readouts (Debug fixture and tests)

    /// `people.revision`.
    func revisionReadout() -> String {
        "rev=" + String(snapshot.revision) + " sections=" + sectionSummary()
    }

    /// `people.focus`: the destinations requested this presentation and the scrolls performed.
    func focusReadout() -> String {
        let destinations = focusDestinations.isEmpty ? "none" : focusDestinations.joined(separator: ",")
        return "destination=" + destinations + " scrolls=" + String(focusScrollCount)
    }

    /// Section ids with counts in display order, for example `raisedHands:1,inMeeting:6`.
    func sectionSummary() -> String {
        var parts: [String] = []
        for section in snapshot.sections {
            parts.append(section.id + ":" + String(section.count))
        }
        return parts.isEmpty ? "none" : parts.joined(separator: ",")
    }

    // MARK: Rebuild

    private func publishFocus(_ destination: PanelDestination) {
        var sectionId = ""
        if destination == PanelDestination.peopleWaiting {
            sectionId = PeopleSectionID.waiting.rawValue
        } else if destination == PanelDestination.peopleRaisedHands {
            sectionId = PeopleSectionID.raisedHands.rawValue
        }
        if sectionId.isEmpty { return }
        focusDestinations.append(destination.rawValue)
        nextFocusId += 1
        focusRequest = PeopleFocusRequest(id: nextFocusId, sectionId: sectionId)
    }

    private func rebuild(previousViewer: PersonRole) {
        let ordered = PeopleOrderPolicy.order(inputs)
        let viewer = ordered.viewerRole
        // Lost host while the panel is open (S50 1 f, 12): host rows and sections leave in place and the notice stays
        // until the panel closes; regaining the role clears it. Becoming an attendee dismisses the panel (S1 ROLE).
        if openPresentationID != 0 && previousViewer.isHostRole && viewer == PersonRole.participant {
            showsLostHost = true
        }
        if viewer.isHostRole {
            showsLostHost = false
        }
        let blocked = PeopleRowPolicy.blockedReason(phase: inputs.phase, isNetworkOffline: inputs.isNetworkOffline)

        var handPosition: [String: Int] = [:]
        var position = 0
        for person in ordered.raisedHands {
            position += 1
            handPosition[person.userId] = position
        }

        var rowKeys: [String] = []
        var meetingKeys: [String] = []
        var meetingSearch: [String] = []
        var meetingNames: [String] = []
        var namesById: [String: String] = [:]
        for person in ordered.inMeeting {
            let role = PeopleOrderPolicy.role(person, inputs: inputs)
            let model = PeopleRowPolicy.rowModel(person, role: role, handOrder: handPosition[person.userId] ?? 0)
            if rows.write(model) { rowWriteCount += 1 }
            rowKeys.append(model.id)
            meetingKeys.append(model.id)
            meetingSearch.append(model.name.lowercased())
            meetingNames.append(model.name)
            namesById[person.userId] = model.name
        }
        rows.prune(keeping: rowKeys)

        var handKeys: [String] = []
        var handSearch: [String] = []
        var handNames: [String] = []
        for person in ordered.raisedHands {
            let name = namesById[person.userId] ?? ""
            handKeys.append(PeopleOrderPolicy.rosterKey(person.userId))
            handSearch.append(name.lowercased())
            handNames.append(name)
        }

        var waitingKeys: [String] = []
        var waitingSearch: [String] = []
        var waitingNames: [String] = []
        let waitingEnabled = blocked == MeetingBlockedReason.none
        for request in ordered.waiting {
            let model = PeopleRowPolicy.waitingModel(request, isEnabled: waitingEnabled, reason: blocked.rawValue)
            waiting.write(model)
            waitingKeys.append(model.id)
            waitingSearch.append(model.name.lowercased())
            waitingNames.append(model.name)
        }
        waiting.prune(keeping: waitingKeys)

        var sections: [PeopleSection] = []
        if !waitingKeys.isEmpty {
            sections.append(PeopleSection(id: PeopleSectionID.waiting.rawValue, count: waitingKeys.count, rowIds: waitingKeys,
                                          searchKeys: waitingSearch, names: waitingNames))
        }
        if !handKeys.isEmpty {
            sections.append(PeopleSection(id: PeopleSectionID.raisedHands.rawValue, count: handKeys.count, rowIds: handKeys,
                                          searchKeys: handSearch, names: handNames))
        }
        sections.append(PeopleSection(id: PeopleSectionID.inMeeting.rawValue, count: meetingKeys.count, rowIds: meetingKeys,
                                      searchKeys: meetingSearch, names: meetingNames))

        let candidate = PeopleSnapshot(
            revision: snapshot.revision,
            sections: sections,
            isRosterLoaded: inputs.isRosterLoaded,
            viewerRole: viewer,
            isPrimaryHost: viewer == PersonRole.host,
            canUseHostActions: viewer.isHostRole && blocked == MeetingBlockedReason.none,
            blockedReason: blocked.rawValue,
            inviteLink: inputs.meetingLink,
            roomLabel: inputs.roomLabel,
            webinarEnabled: inputs.isWebinarEnabled,
            webinarLink: inputs.webinarLink,
            webinarPublic: inputs.isWebinarPublic,
            accessSummary: PeopleRowPolicy.accessSummary(isRoomLocked: inputs.isRoomLocked, isNoGuests: inputs.isNoGuests).rawValue,
            qaVisible: PeopleRowPolicy.qaVisible(viewerRole: viewer, isWebinarEnabled: inputs.isWebinarEnabled,
                                                 isWebinarQaEnabled: inputs.isWebinarQaEnabled),
            webinarQueueKnown: false,
            showsLostHostNotice: showsLostHost
        )
        if candidate != snapshot {
            snapshot = candidate.withRevision(snapshot.revision + 1)
        }
        if attendeeCount != inputs.webinarAttendeeCount { attendeeCount = inputs.webinarAttendeeCount }
    }
}
