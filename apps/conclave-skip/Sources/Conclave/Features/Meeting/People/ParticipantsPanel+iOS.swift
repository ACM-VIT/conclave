#if os(iOS) && !SKIP
import SwiftUI

// S50 1 (PPL-1): the iOS Participants panel. One `PanelShell` with the R50-2 path binding over `PeopleRoute` (one
// `navigationDestination(for:)`), a lazy inset-grouped `List` that observes only `people.snapshot` (structure) while
// every row observes its own entry, the `.searchable` drawer (F00 C20, filtered on the cached snapshot by
// `PeopleSearchPolicy`, never row entries), the destination scroll from `people.focusRequest`, and leaves that report
// coverage, forward same-panel destinations and pop a host page after losing host. Presentation per PS 6.2: medium
// and large with the stage interactive at medium, the inspector on regular x regular; system appearance (OD Q8 (6)).
// People hosts no renderer and never touches media (D20). Mounted by the native call root (HD request B4-T7 R3).

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
                    // PPL-4 (S50 6 to 8): Host Controls and its pages, pushed inside this panel's one stack.
                    HostPageView(people: people, page: page, link: { $0 })
                }
        }
        // The presentation lifecycle, not the root List's onAppear: a pop never re-runs it, and a repeat for the same
        // presentation (a sheet to inspector move) does nothing (S50 1 c).
        .task(id: presentation.request.presentationID) {
            people.panelDidOpen(destination: presentation.request.destination,
                                presentationID: presentation.request.presentationID)
            // PL14: panel-origin failures render inline on iOS.
            people.platform = NoticePlatform.ios
        }
        // RECONCILE R34: every push of Host Controls content into a medium sheet promotes it to large.
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

/// The root list (S50 1 c). Reads `people.snapshot` and `people.focusRequest` only; rows read their entries.
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
                // PL14: the one inline failure slot for row actions (the lost-host banner slot).
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
                            // PPL-5 (S50 10 c): the watching count row, its own leaf on `people.attendeeCount`.
                            WebinarWatchingRow(people: people)
                        }
                        ForEach(section.rowIds, id: \.self) { key in
                            // Only Raised Hands rows read the queue size, so a hand change never re-evaluates the others.
                            PeopleSectionRow(people: people, sectionId: section.id, key: key,
                                             queueCount: section.id == PeopleSectionID.raisedHands.rawValue ? queueCount : 0,
                                             rotorNamespace: rotorNamespace)
                        }
                        if section.id == PeopleSectionID.inMeeting.rawValue && !snapshot.isRosterLoaded && !searching {
                            // Static label and the system spinner (R13), after the You row (S50 1 f).
                            ConclaveLoadingStatus(label: ConclaveStrings.text("Loading Participants"), identifier: "people.loading")
                        }
                    } header: {
                        if section.id == PeopleSectionID.attendees.rawValue {
                            WebinarAttendeesHeader(people: people)
                        } else {
                            PeopleSectionHeader(section: section)
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
                    // The iOS 17 system search empty state with its own localized copy (S50 1 f).
                    ConclaveSearchEmptyState(query: query, identifier: "people.search.empty")
                }
            }
            .conclaveSearchable(text: $query, isPresented: $isSearching, prompt: ConclaveStrings.text("Search Participants"))
            .conclaveSearchAnnouncement(query: query, resultCount: PeopleSearchPolicy.resultCount(shown))
            .onChange(of: isSearching) { _, on in
                // PS 7.3: search focus promotes a medium sheet to large.
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
                // Cleared after the scroll, so popping back from a pushed page never scrolls again (S50 1 c).
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

/// One Raised Hands rotor entry, in queue order (S50 1 i).
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

/// One row of a section: waiting rows read `people.waiting`, the others `people.rows` plus their speaking leaf.
private struct PeopleSectionRow: View {
    let people: PeoplePresenter
    let sectionId: String
    let key: String
    let queueCount: Int
    let rotorNamespace: Namespace.ID

    var body: some View {
        if sectionId == PeopleSectionID.waiting.rawValue {
            PeopleWaitingRowView(entry: people.waiting.entry(for: key), probe: people.recompose)
        } else if key.hasPrefix(PeopleOrderPolicy.attendeePrefix) {
            // PPL-5 (S50 10 c): attendee hand-queue and invited rows carry their one inline action, not a Menu.
            WebinarAttendeeRowView(people: people, key: key, sectionId: sectionId, queueCount: queueCount)
                .accessibilityRotorEntry(id: sectionId + ":" + key, in: rotorNamespace)
        } else {
            let entry = people.rows.entry(for: key)
            // PPL-2 (S50 3 c): the trailing Menu, the accessibility actions, the context menu, the swipe and the
            // row-anchored confirmation, all from the row's own entry.
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

/// Share Invite, Host Controls and the Q&A row (S50 1 c). Hidden while a query is active, so search shows people only.
private struct PeopleActionRows: View {
    let people: PeoplePresenter
    let snapshot: PeopleSnapshot

    var body: some View {
        if !snapshot.inviteLink.isEmpty, let url = URL(string: snapshot.inviteLink) {
            Section {
                // One label and one payload on every surface (RECONCILE R14, S20 SC21); no ShareLink over an empty URL.
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
                        // `host_controls_item` is pending the icon lane (R50-4); the host concept glyph stands in.
                        Label(ConclaveStrings.text("Host Controls"), systemImage: ConclaveSymbols.crownFill)
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

/// Reads `people.qaUnseen` only (S50 1 k), so a new question never republishes the list.
private struct PeopleQaNewCount: View {
    let people: PeoplePresenter

    var body: some View {
        if people.qaUnseen > 0 {
            Text(ConclaveStrings.format("%lld new", people.qaUnseen))
                .monospacedDigit()
        }
    }
}

/// An empty host page for callers that hold no presenter (kept for the Meeting Details stand-in, HD request B5-T2 R6);
/// Participants pushes `HostPageView` (PPL-4).
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

/// Zero-size leaves (their reads never invalidate the list): coverage for PL14, same-panel destinations (S20 SR7) and
/// the lost-host pop (S50 1 f, 12).
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
                // Losing host pops a pushed host page (S50 12); the banner stays until the panel closes.
                if !isHost && !route.isEmpty { route = [] }
            }
    }
}
#endif
