#if os(iOS) && !SKIP
import SwiftUI

struct ParticipantsPanel: View {
    let people: PeoplePresenter
    let shell: MeetingShellPresenter
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    @Environment(\.conclaveSystemColorScheme) private var systemScheme
    @State private var route: [PeopleRoute] = []
    @State private var query: String
    @State private var isSearching = false

    init(people: PeoplePresenter, shell: MeetingShellPresenter, adapter: NativePanelHostAdapter,
         presentation: NativePanelPresentation, resolved: PanelPresentation) {
        self.people = people
        self.shell = shell
        self.adapter = adapter
        self.presentation = presentation
        self.resolved = resolved
        _query = State(initialValue: people.initialSearchQuery)
    }

    var body: some View {
        PanelShell(title: ConclaveStrings.text("Participants"), presentation: resolved, hostStyle: resolved.style,
                   systemScheme: systemScheme, path: $route,
                   onClose: { shell.panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: { adapter.promoteToLarge() }) {
            ParticipantsList(people: people,
                             isMediumDetent: resolved.style == PanelHostStyle.sheet && adapter.detent == PanelDetent.medium,
                             query: $query, isSearching: $isSearching)
                .navigationDestination(for: PeopleRoute.self) { page in

                    HostPageView(people: people, page: page, link: { $0 })
                }
        }

        .task(id: presentation.request.presentationID) {
            people.panelDidOpen(destination: presentation.request.destination,
                                presentationID: presentation.request.presentationID)

            people.platform = NoticePlatform.ios
        }

        .onChange(of: route.count) { _, count in
            if count > 0 { adapter.promoteToLarge() }
        }
        .background {
            PeoplePanelLeaves(people: people, panels: shell.panels, adapter: adapter, resolved: resolved,
                              isOnHostPage: !route.isEmpty, route: $route)
        }
        .accessibilityIdentifier("people.panel")
    }
}

private struct ParticipantsList: View {
    let people: PeoplePresenter
    let isMediumDetent: Bool
    @Binding var query: String
    @Binding var isSearching: Bool
    @Environment(\.panelPromoteToLargeDetent) private var promoteToLarge
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var rotorNamespace
    @State private var placement = PeopleFocusPlacement()

    var body: some View {
        let snapshot = people.snapshot
        let searching = PeopleSearchPolicy.isSearching(query)
        let shown = PeopleSearchPolicy.filter(snapshot.sections, query: query)
        let queueCount = snapshot.section(PeopleSectionID.raisedHands)?.count ?? 0
        let focusId = people.focusRequest?.id ?? 0
        ScrollViewReader { proxy in
            List {

                PeopleFailureBannerSection(people: people)
                if snapshot.showsLostHostNotice {
                    Section {
                        ConclaveBanner(kind: .info, text: ConclaveStrings.text("You\u{2019}re no longer a host."), surface: .app,
                                       identifier: "people.lostHost")
                            .id(PeopleFocusTarget.lostHost)
                    }
                }
                if !searching {
                    PeopleActionRows(people: people, snapshot: snapshot)
                }
                ForEach(shown) { section in
                    Section {
                        if section.id == PeopleSectionID.attendees.rawValue && !searching {

                            WebinarWatchingRow(people: people)
                        }
                        ForEach(section.rowIds, id: \.self) { key in

                            PeopleSectionRow(people: people, sectionId: section.id, key: key,
                                             queueCount: section.id == PeopleSectionID.raisedHands.rawValue ? queueCount : 0,
                                             rotorNamespace: rotorNamespace)
                                .id(PeopleFocusTarget.row(section.id, key))
                        }
                        if section.id == PeopleSectionID.inMeeting.rawValue && !snapshot.isRosterLoaded && !searching {

                            ConclaveLoadingStatus(label: ConclaveStrings.text("Loading Participants"), identifier: "people.loading")
                        }
                    } header: {
                        Group {
                            if section.id == PeopleSectionID.attendees.rawValue {
                                WebinarAttendeesHeader(people: people)
                            } else {

                                PeopleSectionHeader(people: people, section: section, showsActions: !searching)
                            }
                        }
                        .modifier(PeopleFocusHeaderTarget(sectionId: section.id, placement: placement))
                    } footer: {
                        if section.id == PeopleSectionID.attendees.rawValue && !searching {
                            WebinarAttendeesFooter(people: people, snapshot: snapshot)
                        } else if (section.id == PeopleSectionID.inMeeting.rawValue || section.id == PeopleSectionID.panelists.rawValue)
                                    && !searching,
                                  let text = PeopleText.footer(PeopleRowPolicy.inMeetingFooter(snapshot)) {
                            ConclaveSectionFooter(text, identifier: "people.section." + section.id + ".footer")
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .onGeometryChange(for: CGRect.self) { geometry in
                let frame = geometry.frame(in: .global)
                let insets = geometry.safeAreaInsets
                return CGRect(x: frame.minX, y: frame.minY + insets.top, width: frame.width,
                              height: max(0, frame.height - insets.top - insets.bottom))
            } action: { viewport in
                placement.viewport = viewport
            }
            .overlay {
                if searching && shown.isEmpty {

                    ConclaveSearchEmptyState(query: query, identifier: "people.search.empty")
                }
            }
            .conclaveSearchable(text: $query, isPresented: $isSearching, prompt: ConclaveStrings.text("Search Participants"))
            .conclaveSearchAnnouncement(query: query, resultCount: PeopleSearchPolicy.resultCount(shown))
            .onChange(of: isSearching) { _, on in

                if on { promoteToLarge() }
            }
            .task(id: PeopleFocusKey(id: focusId, isMediumDetent: focusId != 0 && isMediumDetent)) {
                guard let request = people.focusRequest else { return }
                let isShown = shown.contains { $0.id == request.sectionId }
                let step = people.focusStep(id: request.id, isShown: isShown, isSearching: searching, revision: snapshot.revision)
                if step == PeopleFocusStep.consumeNow || step == PeopleFocusStep.awaitSection {
                    people.focusRequestHandled(id: request.id)
                    return
                }
                guard step == PeopleFocusStep.placeHeader else { return }
                let target = PeopleFocusTarget.header(request.sectionId)
                var isLive = true
                var isPlaced = false
                var attempts = 0
                while isLive && !isPlaced && attempts < PeopleFocusTiming.scrollAttempts {
                    attempts += 1
                    let lead = PeopleFocusTarget.lead(before: request.sectionId,
                                                      in: PeopleSearchPolicy.filter(people.snapshot.sections, query: query),
                                                      snapshot: people.snapshot, isSearching: PeopleSearchPolicy.isSearching(query))
                    if let lead {
                        if reduceMotion {
                            proxy.scrollTo(lead, anchor: .top)
                        } else {
                            withAnimation { proxy.scrollTo(lead, anchor: .top) }
                        }
                    } else if reduceMotion {
                        proxy.scrollTo(target, anchor: .top)
                    } else {
                        withAnimation { proxy.scrollTo(target, anchor: .top) }
                    }
                    try? await Task.sleep(for: .milliseconds(reduceMotion ? PeopleFocusTiming.reducedSettleMilliseconds
                                                                           : PeopleFocusTiming.settleMilliseconds))
                    guard !Task.isCancelled else { return }
                    isLive = PeopleSearchPolicy.filter(people.snapshot.sections, query: query).contains { $0.id == request.sectionId }
                    isPlaced = isLive && placement.isHeaderPlaced(request.sectionId)
                }
                if isLive && !isPlaced && !isMediumDetent,
                   let first = PeopleSearchPolicy.filter(people.snapshot.sections, query: query)
                    .first(where: { $0.id == request.sectionId })?.rowIds.first {
                    let row = PeopleFocusTarget.row(request.sectionId, first)
                    if reduceMotion {
                        proxy.scrollTo(row, anchor: .bottom)
                    } else {
                        withAnimation { proxy.scrollTo(row, anchor: .bottom) }
                    }
                    try? await Task.sleep(for: .milliseconds(reduceMotion ? PeopleFocusTiming.reducedSettleMilliseconds
                                                                           : PeopleFocusTiming.settleMilliseconds))
                    guard !Task.isCancelled else { return }
                    isLive = PeopleSearchPolicy.filter(people.snapshot.sections, query: query).contains { $0.id == request.sectionId }
                    isPlaced = isLive && placement.isHeaderPlaced(request.sectionId)
                    if isLive && !isPlaced,
                       let lead = PeopleFocusTarget.lead(before: request.sectionId,
                                                         in: PeopleSearchPolicy.filter(people.snapshot.sections, query: query),
                                                         snapshot: people.snapshot, isSearching: PeopleSearchPolicy.isSearching(query)) {
                        if reduceMotion {
                            proxy.scrollTo(lead, anchor: .top)
                        } else {
                            withAnimation { proxy.scrollTo(lead, anchor: .top) }
                        }
                        try? await Task.sleep(for: .milliseconds(reduceMotion ? PeopleFocusTiming.reducedSettleMilliseconds
                                                                               : PeopleFocusTiming.settleMilliseconds))
                        guard !Task.isCancelled else { return }
                    }
                }
                if isLive && PeopleFocusPolicy.promotesToLarge(isPlaced: isPlaced, isMediumDetent: isMediumDetent) {
                    promoteToLarge()
                    try? await Task.sleep(for: .milliseconds(PeopleFocusTiming.settleMilliseconds))
                    guard !Task.isCancelled else { return }
                }

                people.focusRequestHandled(id: request.id)
            }
            .accessibilityRotor(Text(ConclaveStrings.text("Raised Hands"))) {
                ForEach(PeopleRotorEntry.hands(snapshot)) { entry in
                    AccessibilityRotorEntry(Text(entry.label), id: entry.id, in: rotorNamespace)
                }
            }
            .modifier(PeopleRenameAlertHost(people: people))
            .accessibilityIdentifier("people.list")
        }
    }
}

private struct PeopleRotorEntry: Identifiable {
    let id: String
    let label: String

    static func hands(_ snapshot: PeopleSnapshot) -> [PeopleRotorEntry] {
        guard let section = snapshot.section(PeopleSectionID.raisedHands) else { return [] }
        var result: [PeopleRotorEntry] = []
        for (index, key) in section.rowIds.enumerated() {
            let name = index < section.names.count ? section.names[index] : ""
            result.append(PeopleRotorEntry(id: section.id + ":" + key,
                                           label: name.isEmpty ? ConclaveStrings.text("You") : name))
        }
        return result
    }
}

private struct PeopleFocusKey: Equatable {
    let id: Int
    let isMediumDetent: Bool
}

private enum PeopleFocusTarget {
    static let lostHost = "people.lead.lostHost"
    static let invite = "people.lead.invite"
    static let hostControls = "people.lead.hostControls"
    static let questions = "people.lead.questions"

    static func header(_ sectionId: String) -> String {
        "people.header." + sectionId
    }

    static func row(_ sectionId: String, _ key: String) -> String {
        "people.row." + sectionId + ":" + key
    }

    static func lead(before sectionId: String, in sections: [PeopleSection], snapshot: PeopleSnapshot,
                     isSearching: Bool) -> String? {
        guard let index = sections.firstIndex(where: { $0.id == sectionId }) else { return nil }
        if index > 0 {
            let previous = sections[index - 1]
            guard let key = previous.rowIds.last else { return nil }
            return row(previous.id, key)
        }
        if !isSearching && snapshot.isHostViewer {
            return snapshot.qaVisible ? questions : hostControls
        }
        if !isSearching && !snapshot.inviteLink.isEmpty && URL(string: snapshot.inviteLink) != nil {
            return invite
        }
        return snapshot.showsLostHostNotice ? lostHost : nil
    }
}

private enum PeopleFocusTiming {
    static let settleMilliseconds = 450
    static let reducedSettleMilliseconds = 80
    static let scrollAttempts = 2
}

private final class PeopleFocusPlacement {
    var viewport = CGRect.null
    private var headers: [String: CGRect] = [:]

    func record(_ sectionId: String, frame: CGRect) {
        headers[sectionId] = frame
    }

    func forget(_ sectionId: String) {
        headers[sectionId] = nil
    }

    func isHeaderPlaced(_ sectionId: String) -> Bool {
        guard let frame = headers[sectionId], !viewport.isNull else { return false }
        return PeopleFocusPolicy.isHeaderPlaced(headerTop: Double(frame.minY), headerBottom: Double(frame.maxY),
                                                viewportTop: Double(viewport.minY), viewportBottom: Double(viewport.maxY))
    }
}

private struct PeopleFocusHeaderTarget: ViewModifier {
    let sectionId: String
    let placement: PeopleFocusPlacement

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { geometry in
                geometry.frame(in: .global)
            } action: { frame in
                placement.record(sectionId, frame: frame)
            }
            .onDisappear {
                placement.forget(sectionId)
            }
            .id(PeopleFocusTarget.header(sectionId))
    }
}

private struct PeopleSectionRow: View {
    let people: PeoplePresenter
    let sectionId: String
    let key: String
    let queueCount: Int
    let rotorNamespace: Namespace.ID

    var body: some View {
        if sectionId == PeopleSectionID.waiting.rawValue {
            PeopleWaitingRowView(people: people, entry: people.waiting.entry(for: key), probe: people.recompose)
        } else if key.hasPrefix(PeopleOrderPolicy.attendeePrefix) {

            WebinarAttendeeRowView(people: people, key: key, sectionId: sectionId, queueCount: queueCount)
                .accessibilityRotorEntry(id: sectionId + ":" + key, in: rotorNamespace)
        } else {
            let entry = people.rows.entry(for: key)

            PeopleRowView(entry: entry, speaking: people.speaking.state(for: key), sectionId: sectionId,
                          queueCount: queueCount, probe: people.recompose,
                          onAction: { action in people.perform(action, rowId: key, source: PeopleActionSource.a11y) }) { model in
                PeopleRowMenu(people: people, model: model, sectionId: sectionId)
            }
            .modifier(PeopleRowActionsModifier(people: people, entry: entry, sectionId: sectionId))
            .accessibilityRotorEntry(id: sectionId + ":" + key, in: rotorNamespace)
        }
    }
}

private struct PeopleActionRows: View {
    let people: PeoplePresenter
    let snapshot: PeopleSnapshot

    var body: some View {
        if !snapshot.inviteLink.isEmpty, let url = URL(string: snapshot.inviteLink) {
            Section {

                ShareLink(item: url, subject: Text(ConclaveStrings.text("Join My Conclave Meeting")),
                          message: Text(ConclaveStrings.text("Join me in this Conclave meeting.")),
                          preview: SharePreview(Text(snapshot.roomLabel))) {
                    Label(ConclaveStrings.text("Share Invite"), systemImage: ConclaveSymbols.squareAndArrowUp)
                }
                .accessibilityIdentifier("people.invite")
                .id(PeopleFocusTarget.invite)
            }
        }
        if snapshot.isHostViewer {
            Section {
                NavigationLink(value: PeopleRoute.hostControls) {
                    LabeledContent {
                        Text(PeopleText.accessSummary(snapshot.accessSummary))
                    } label: {

                        Label(ConclaveStrings.text("Host Controls"), systemImage: ConclaveSymbols.personBadgeShieldCheckmarkFill)
                    }
                }
                .accessibilityIdentifier("people.hostControls")
                .id(PeopleFocusTarget.hostControls)
                if snapshot.qaVisible {
                    Button {
                        people.openQuestionsAndAnswers()
                    } label: {
                        LabeledContent {
                            PeopleQaNewCount(people: people)
                        } label: {
                            Label(ConclaveStrings.text("Questions and Answers"), systemImage: ConclaveSymbols.questionmarkBubble)
                        }
                    }
                    .accessibilityIdentifier("people.qa")
                    .id(PeopleFocusTarget.questions)
                }
            }
        }
    }
}

private struct PeopleQaNewCount: View {
    let people: PeoplePresenter

    var body: some View {
        if people.qaUnseen > 0 {
            Text(ConclaveStrings.format("%lld new", people.qaUnseen))
                .monospacedDigit()
        }
    }
}

struct PeopleHostPage: View {
    let route: PeopleRoute

    var body: some View {
        List {
            EmptyView()
        }
        .listStyle(.insetGrouped)
        .navigationTitle(ConclaveStrings.text("Host Controls"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("people.page." + route.rawValue)
    }
}

private struct PeoplePanelLeaves: View {
    let people: PeoplePresenter
    let panels: PanelCoordinator
    let adapter: NativePanelHostAdapter
    let resolved: PanelPresentation
    let isOnHostPage: Bool
    @Binding var route: [PeopleRoute]

    private struct CoverageKey: Equatable {
        let coverage: String
        let onHostPage: Bool
    }

    var body: some View {
        let coverage = PanelPresentationPolicy.coverage(resolved, detent: adapter.detent)
        let isHostViewer = people.snapshot.isHostViewer
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .task(id: CoverageKey(coverage: coverage.rawValue, onHostPage: isOnHostPage)) {
                people.presentationDidChange(coverage: coverage, onHostPage: isOnHostPage)
            }
            .onChange(of: panels.destinationRequest) { _, request in
                if let request { people.destinationRequested(request) }
            }
            .onChange(of: isHostViewer) { _, isHost in

                if !isHost && !route.isEmpty { route = [] }
            }
    }
}
#endif
