#if os(iOS) && !SKIP
import SwiftUI

struct HostControlsContent<Route: Hashable>: View {
    let people: PeoplePresenter

    let link: (PeopleRoute) -> Route

    var body: some View {
        let snapshot = people.host.snapshot
        Group {
            if snapshot.isAvailable {
                HostControlsForm(people: people, snapshot: snapshot, link: link)
            } else {

                ContentUnavailableView {
                    Label(ConclaveStrings.text("Host Controls Unavailable"), systemImage: ConclaveSymbols.crownFill)
                } description: {
                    Text(ConclaveStrings.text("You\u{2019}re no longer a host."))
                }
                .accessibilityIdentifier("host.unavailable")
            }
        }
        .navigationTitle(ConclaveStrings.text("Host Controls"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct HostControlsForm<Route: Hashable>: View {
    let people: PeoplePresenter
    let snapshot: HostControlsSnapshot
    let link: (PeopleRoute) -> Route

    var body: some View {
        Form {
            if snapshot.isConfigLoading {
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text(ConclaveStrings.text("Loading Settings"))
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("host.loading")
                }
            }
            Section {
                ForEach(snapshot.visibleBulk()) { row in
                    HostBulkRowView(people: people, row: row)
                }
            } header: {
                Text(ConclaveStrings.text("Everyone"))
            }
            Section {
                ForEach(HostPolicyID.accessRows, id: \.self) { policy in
                    HostPolicyToggleRow(people: people, policy: policy)
                }
                NavigationLink(value: link(PeopleRoute.inviteCode)) {
                    LabeledContent(ConclaveStrings.text("Invite Code"), value: HostText.onOff(snapshot.access.requiresCode))
                }
                .accessibilityIdentifier("host.inviteCode")
                NavigationLink(value: link(PeopleRoute.accessList)) {
                    LabeledContent(ConclaveStrings.text("Access List"), value: HostText.accessSummary(snapshot.access))
                }
                .accessibilityIdentifier("host.accessList")
            } header: {
                Text(ConclaveStrings.text("Meeting Access"))
            } footer: {
                Text(ConclaveStrings.text("When the meeting is locked, new people wait until a host admits them. Guests are people who aren\u{2019}t signed in."))
            }
            .id(HostControlsAnchor.access)
            Section {
                ForEach(HostPolicyID.mediaRows, id: \.self) { policy in
                    HostPolicyToggleRow(people: people, policy: policy)
                }
            } header: {
                Text(ConclaveStrings.text("Participant Media"))
            } footer: {
                Text(ConclaveStrings.text("Turning these off also mutes microphones or stops cameras that are on. Hosts aren\u{2019}t affected."))
            }
            Section {
                ForEach(HostPolicyID.chatRows, id: \.self) { policy in
                    HostPolicyToggleRow(people: people, policy: policy)
                }
            } header: {
                Text(ConclaveStrings.text("Chat and Messages"))
            }
            Section {
                NavigationLink(value: link(PeopleRoute.notice)) {
                    Text(ConclaveStrings.text("Send a Notice"))
                }
                .accessibilityIdentifier("host.notice")
            } header: {
                Text(ConclaveStrings.text("Notice"))
            } footer: {
                Text(ConclaveStrings.text("Notices appear at the top of everyone\u{2019}s screen for 60 seconds."))
            }
            Section {
                HostPolicyToggleRow(people: people, policy: HostPolicyID.webinarMode)
                if snapshot.webinar.enabled {
                    NavigationLink(value: link(PeopleRoute.webinar)) {
                        LabeledContent {
                            HostWatchingValue(host: people.host)
                        } label: {
                            Text(ConclaveStrings.text("Webinar Settings"))
                        }
                    }
                    .accessibilityIdentifier("host.webinar")
                }
            } header: {
                Text(ConclaveStrings.text("Webinar"))
            } footer: {
                Text(ConclaveStrings.text("Webinar mode lets people watch from the webinar link without joining the call."))
            }
            Section {
                HostEndRow(people: people, snapshot: snapshot)
            }
        }
        .formStyle(.grouped)
        .accessibilityIdentifier("host.controls")
    }
}

enum HostControlsAnchor {
    static let access = "host.section.access"
}

private struct HostWatchingValue: View {
    let host: HostControlsPresenter

    var body: some View {
        Text(ConclaveStrings.format("%lld watching", host.attendeeCount))
            .monospacedDigit()
    }
}

private struct HostEndRow: View {
    let people: PeoplePresenter
    let snapshot: HostControlsSnapshot
    @State private var prompts = 0

    var body: some View {
        let shell = people.shell
        let confirmation = shell.session.confirmation
        let mine = confirmation?.invoker == MeetingConfirmationInvoker.hostControls ? confirmation : nil
        let ending = snapshot.endPhase == HostEndPhase.ending
        let failed = HostEndRow.endFailed(shell)
        VStack(alignment: .leading, spacing: 6) {
            Button(role: .destructive) {
                people.host.requestEndForEveryone()
            } label: {
                HStack(spacing: 8) {
                    Text(ending ? ConclaveStrings.text("Ending\u{2026}") : ConclaveStrings.text("End Call for Everyone\u{2026}"))
                    Spacer(minLength: 0)
                    if ending { ProgressView().accessibilityHidden(true) }
                }
            }
            .disabled(!snapshot.canEndForEveryone || ending)
            .accessibilityIdentifier("host.end")
            .confirmationDialog(ConclaveStrings.text("End Call for Everyone?"),
                                isPresented: Binding(get: { mine != nil }, set: { shown in
                                    if !shown, let open = shell.session.confirmation,
                                       open.invoker == MeetingConfirmationInvoker.hostControls {
                                        shell.cancelConfirmation(id: open.id)
                                    }
                                }),
                                titleVisibility: .visible, presenting: mine) { open in
                Button(ConclaveStrings.text("End Call for Everyone"), role: .destructive) {
                    _ = shell.confirmEndForEveryone(id: open.id)
                }
                .accessibilityIdentifier("host.end.confirm")
                Button(ConclaveStrings.text("Cancel"), role: .cancel) {
                    shell.cancelConfirmation(id: open.id)
                }
            } message: { _ in
                Text(ConclaveStrings.text("Everyone, including people waiting to join, will be disconnected."))
            }
            .onChange(of: mine?.id ?? 0) { _, id in
                if id != 0 { prompts += 1 }
            }
            .conclaveGestureFeedback(.endForEveryonePrompted, trigger: prompts)
            if failed && !ending {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: ConclaveSymbols.exclamationmarkTriangleFill)
                        .foregroundStyle(Color(uiColor: .systemRed))
                        .accessibilityHidden(true)
                    Text(ConclaveStrings.text("Couldn\u{2019}t end the call for everyone. Try again."))
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button(ConclaveStrings.text("Retry")) { people.host.requestEndForEveryone() }
                        .buttonStyle(.borderless)
                }
                .accessibilityIdentifier("host.failure.end")
            }
        }
    }

    static func endFailed(_ shell: MeetingShellPresenter) -> Bool {
        for row in shell.controls.rows {
            if row.id == MeetingControlID.endForEveryone.rawValue {
                return row.failure != MeetingActionFailure.none
            }
        }
        return false
    }
}

struct HostPageView<Route: Hashable>: View {
    let people: PeoplePresenter
    let page: PeopleRoute
    let link: (PeopleRoute) -> Route

    var body: some View {
        switch page {
        case .root, .hostControls:
            HostControlsContent(people: people, link: link)
        case .inviteCode:
            InviteCodePage(people: people)
        case .accessList:
            AccessListPage(people: people)
        case .notice:
            NoticeComposerPage(people: people)
        case .webinar:
            WebinarSettingsPage(people: people, link: link)
        case .attendeeCode:
            AttendeeCodePage(people: people)
        case .customLink:
            CustomLinkPage(people: people)
        }
    }
}

struct HostControlsPanel: View {
    let people: PeoplePresenter
    let shell: MeetingShellPresenter
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    @Environment(\.conclaveSystemColorScheme) private var systemScheme
    @State private var route: [PeopleRoute] = []

    var body: some View {
        PanelShell(title: ConclaveStrings.text("Host Controls"), presentation: resolved, hostStyle: resolved.style,
                   systemScheme: systemScheme, path: $route,
                   onClose: { shell.panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: { adapter.promoteToLarge() }) {
            ScrollViewReader { proxy in
                HostControlsContent(people: people, link: { $0 })
                    .navigationDestination(for: PeopleRoute.self) { page in
                        HostPageView(people: people, page: page, link: { $0 })
                    }
                    .task(id: presentation.request.presentationID) {
                        people.platform = NoticePlatform.ios
                        people.hostPanelDidOpen(presentationID: presentation.request.presentationID)

                        if presentation.request.destination == PanelDestination.hostControlsAccess {
                            proxy.scrollTo(HostControlsAnchor.access, anchor: .top)
                        }
                    }
            }
        }

        .onChange(of: route.count) { _, count in
            if count > 0 { adapter.promoteToLarge() }
        }
        .onChange(of: people.host.snapshot.isAvailable) { _, available in

            if !available && !route.isEmpty { route = [] }
        }
        .accessibilityIdentifier("host.panel")
    }
}
#endif
