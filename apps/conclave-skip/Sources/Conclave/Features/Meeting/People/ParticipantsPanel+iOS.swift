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
            ParticipantsList(people: people, query: $query, isSearching: $isSearching)
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
    @Binding var query: String
    @Binding var isSearching: Bool
    @Environment(\.panelPromoteToLargeDetent) private var promoteToLarge
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var rotorNamespace

    var body: some View {
        let snapshot = people.snapshot
        let searching = PeopleSearchPolicy.isSearching(query)
        let shown = PeopleSearchPolicy.filter(snapshot.sections, query: query)
        let queueCount = snapshot.section(PeopleSectionID.raisedHands)?.count ?? 0
        ScrollViewReader { proxy in
            List {

                PeopleFailureBannerSection(people: people)
                if snapshot.showsLostHostNotice {
                    Section {
                        ConclaveBanner(kind: .info, text: ConclaveStrings.text("You\u{2019}re no longer a host."), surface: .app,
                                       identifier: "people.lostHost")
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
                        }
                        if section.id == PeopleSectionID.inMeeting.rawValue && !snapshot.isRosterLoaded && !searching {

                            ConclaveLoadingStatus(label: ConclaveStrings.text("Loading Participants"), identifier: "people.loading")
                        }
                    } header: {
                        if section.id == PeopleSectionID.attendees.rawValue {
                            WebinarAttendeesHeader(people: people)
                        } else {

                            PeopleSectionHeader(people: people, section: section, showsActions: !searching)
                        }
                    } footer: {
                        if section.id == PeopleSectionID.attendees.rawValue && !searching {
                            WebinarAttendeesFooter(people: people, snapshot: snapshot)
                        } else if (section.id == PeopleSectionID.inMeeting.rawValue || section.id == PeopleSectionID.panelists.rawValue)
                                    && !searching,
                                  let text = PeopleText.footer(PeopleRowPolicy.inMeetingFooter(snapshot)) {
                            ConclaveSectionFooter(text, identifier: "people.section." + section.id + ".footer")
                        }
                    }
                    .id(section.id)
                }
            }
            .listStyle(.insetGrouped)
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
            .task(id: people.focusRequest?.id ?? 0) {
                guard let request = people.focusRequest else { return }
                if snapshot.section(PeopleSectionID(rawValue: request.sectionId) ?? PeopleSectionID.inMeeting) != nil {
                    if reduceMotion {
                        proxy.scrollTo(request.sectionId, anchor: .top)
                    } else {
                        withAnimation { proxy.scrollTo(request.sectionId, anchor: .top) }
                    }
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
