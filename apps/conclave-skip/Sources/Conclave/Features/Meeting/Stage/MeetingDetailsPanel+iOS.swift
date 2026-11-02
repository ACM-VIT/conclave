#if os(iOS) && !SKIP
import Accessibility
import SwiftUI
import UIKit

enum MeetingInfoRoute: Hashable {
    case host(PeopleRoute)
    case attendeeSettings
    case privacyPolicy
}

typealias MeetingDetailsWebinarLinkProvider = () async -> String?

struct MeetingDetailsPanel: View {
    let stage: StagePresenter
    let shell: MeetingShellPresenter
    let people: PeoplePresenter?
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    let webinarLinkProvider: MeetingDetailsWebinarLinkProvider?
    @Environment(\.conclaveSystemColorScheme) private var systemScheme
    @State private var path: [MeetingInfoRoute] = []

    var body: some View {
        let isAttendee = stage.meetingInfo?.isAttendee ?? false
        PanelShell(title: isAttendee ? ConclaveStrings.text("Webinar Details") : ConclaveStrings.text("Meeting Details"),
                   presentation: resolved, hostStyle: resolved.style, systemScheme: systemScheme, path: $path,
                   onClose: { shell.panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: { adapter.promoteToLarge() }) {
            MeetingDetailsList(stage: stage, webinarLinkProvider: webinarLinkProvider)
                .navigationDestination(for: MeetingInfoRoute.self) { route in
                    MeetingDetailsDestination(route: route, people: people, shell: shell)
                }
        }
        .onChange(of: path.count) { previous, next in

            if next > previous { adapter.promoteToLarge() }
        }
        .background { MeetingDetailsLeaves(stage: stage, path: $path) }
        .accessibilityIdentifier("meetingInfo.panel")
    }
}

private struct MeetingDetailsLeaves: View {
    let stage: StagePresenter
    @Binding var path: [MeetingInfoRoute]

    private var keepsHostPages: Bool {
        guard let info = stage.meetingInfo else { return false }
        return info.isHost && !info.isAttendee
    }

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onChange(of: keepsHostPages) { _, keeps in
                if !keeps && path.contains(where: { MeetingDetailsCopy.isHostRoute($0) }) { path = [] }
            }
    }
}

private struct MeetingDetailsList: View {
    let stage: StagePresenter
    let webinarLinkProvider: MeetingDetailsWebinarLinkProvider?

    var body: some View {
        if let info = stage.meetingInfo {
            List {
                ForEach(MeetingInfoPolicy.sections(info), id: \.self) { section in
                    MeetingDetailsSection(section: section, info: info, webinarLinkProvider: webinarLinkProvider)
                }
            }
            .listStyle(.insetGrouped)
            .accessibilityIdentifier("meetingInfo.list")
        } else {
            List {
                EmptyView()
            }
            .listStyle(.insetGrouped)
            .accessibilityIdentifier("meetingInfo.list")
        }
    }
}

private struct MeetingDetailsSection: View {
    let section: MeetingInfoSection
    let info: MeetingInfoSnapshot
    let webinarLinkProvider: MeetingDetailsWebinarLinkProvider?

    var body: some View {
        if let title = MeetingDetailsCopy.sectionTitle(section) {
            Section {
                rows
            } header: {
                Text(title)
            }
        } else {
            Section {
                rows
            }
        }
    }

    private var rows: some View {
        ForEach(MeetingInfoPolicy.sectionRows(info, section: section)) { row in
            MeetingDetailsRowView(row: row.row, info: info, webinarLinkProvider: webinarLinkProvider)
                .accessibilityIdentifier("meetingInfo.row." + row.id)
                .listRowBackground(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised))
        }
    }
}

private struct MeetingDetailsRowView: View {
    let row: MeetingInfoRowID
    let info: MeetingInfoSnapshot
    let webinarLinkProvider: MeetingDetailsWebinarLinkProvider?

    var body: some View {
        switch row {
        case .roomCode:
            LabeledContent {
                Text(info.roomCode)
                    .textSelection(.enabled)
            } label: {
                Text(ConclaveStrings.text("Room Code"))
            }
        case .copyCode:
            MeetingDetailsCopyRow(title: ConclaveStrings.text("Copy Code"), value: info.roomCode, isLink: false,
                                  announcement: ConclaveStrings.text("Code copied"))
        case .meetingLink:
            LabeledContent {
                Text(MeetingDetailsCopy.breakable(MeetingLinkBuilder.displayText(info.link)))
                    .lineLimit(nil)
                    .textSelection(.enabled)
                    .accessibilityLabel(MeetingLinkBuilder.displayText(info.link))
            } label: {
                Text(ConclaveStrings.text("Meeting Link"))
            }
        case .shareInvite:
            MeetingDetailsInviteRow(link: info.link, roomLabel: info.roomLabel)
        case .copyLink:
            MeetingDetailsCopyRow(title: ConclaveStrings.text("Copy Link"), value: info.link, isLink: true,
                                  announcement: ConclaveStrings.text("Link copied"))
        case .meetingLocked:
            LabeledContent(ConclaveStrings.text("Meeting Locked"),
                           value: info.isLocked ? ConclaveStrings.text("On") : ConclaveStrings.text("Off"))
        case .liveNotes:
            LabeledContent(ConclaveStrings.text("Live Notes"),
                           value: ConclaveStrings.text(MeetingInfoPolicy.liveNotesCatalogKey(info.liveNotes)))
        case .captions:
            LabeledContent(ConclaveStrings.text("Captions"), value: ConclaveStrings.text("On"))
        case .inviteCodeRequired:
            LabeledContent(ConclaveStrings.text("Invite Code Required"), value: ConclaveStrings.text("On"))
        case .shareWebinarLink:
            MeetingDetailsWebinarShareRow(info: info, provider: webinarLinkProvider)
        case .copyWebinarLink:
            MeetingDetailsWebinarCopyRow(info: info, provider: webinarLinkProvider)
        case .hosts:
            LabeledContent {
                Text(ListFormatter.localizedString(byJoining: info.hostNames))
                    .lineLimit(nil)
            } label: {
                Text(ConclaveStrings.text("Hosts"))
            }
        case .started:
            LabeledContent(ConclaveStrings.text("Started"), value: MeetingDetailsCopy.startedTime(info.joinedAtMillis))
        case .connection:
            LabeledContent(ConclaveStrings.text("Your Connection"),
                           value: ConclaveStrings.text(ConnectionQualityLabelPolicy.catalogKey(info.connection)))
        case .hostControls:
            MeetingDetailsHostControlsRow(isEnabled: MeetingInfoPolicy.isHostControlsEnabled(info))
        case .webinarTitle:
            Text(info.webinarTitle.isEmpty ? ConclaveStrings.text("Webinar") : info.webinarTitle)
                .font(.headline)
                .lineLimit(nil)
                .accessibilityAddTraits(.isHeader)
        case .settings:
            NavigationLink(value: MeetingInfoRoute.attendeeSettings) {
                Label(ConclaveStrings.text("Settings"), systemImage: ConclaveSymbols.gearshape)
            }
        }
    }
}

private struct MeetingDetailsInviteRow: View {
    let link: String
    let roomLabel: String

    var body: some View {
        if let url = URL(string: link) {
            ShareLink(item: url, subject: Text(ConclaveStrings.text("Join My Conclave Meeting")),
                      message: Text(ConclaveStrings.text("Join me in this Conclave meeting.")),
                      preview: SharePreview(Text(roomLabel))) {
                Label(ConclaveStrings.text("Share Invite"), systemImage: ConclaveSymbols.squareAndArrowUp)
            }
        }
    }
}

private struct MeetingDetailsCopyRow: View {
    let title: String
    let value: String
    let isLink: Bool
    let announcement: String
    @State private var copies = 0
    @State private var showsCopied = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            MeetingDetailsCopy.copy(value, isLink: isLink)
            copies += 1
            showsCopied = true
            AccessibilityNotification.Announcement(announcement).post()
        } label: {
            Label(showsCopied ? ConclaveStrings.text("Copied") : title,
                  systemImage: showsCopied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc)
                .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                .animation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion), value: showsCopied)
        }
        .conclaveGestureFeedback(.linkCopied, trigger: copies)
        .task(id: copies) {
            guard copies > 0 else { return }
            try? await Task.sleep(for: .milliseconds(Int(MeetingInfoPolicy.copiedMillis)))
            if Task.isCancelled { return }
            showsCopied = false
        }
    }
}

private struct MeetingDetailsWebinarShareRow: View {
    let info: MeetingInfoSnapshot
    let provider: MeetingDetailsWebinarLinkProvider?
    @State private var isGenerating = false

    var body: some View {
        if !info.webinarLink.isEmpty, let url = URL(string: info.webinarLink) {
            ShareLink(item: url, preview: SharePreview(Text(MeetingDetailsCopy.webinarTitle(info)))) {
                Label(ConclaveStrings.text("Share Webinar Link"), systemImage: ConclaveSymbols.squareAndArrowUp)
            }
        } else {
            Button {
                generate()
            } label: {
                HStack {
                    Label(ConclaveStrings.text("Share Webinar Link"), systemImage: ConclaveSymbols.squareAndArrowUp)
                    Spacer(minLength: 8)
                    if isGenerating {
                        ProgressView()
                    }
                }
            }
            .disabled(isGenerating || provider == nil || !MeetingInfoPolicy.isWebinarLinkActionEnabled(info))
        }
    }

    private func generate() {
        guard let provider, !isGenerating else { return }
        isGenerating = true
        Task { @MainActor in
            _ = await provider()
            isGenerating = false
        }
    }
}

private struct MeetingDetailsWebinarCopyRow: View {
    let info: MeetingInfoSnapshot
    let provider: MeetingDetailsWebinarLinkProvider?
    @State private var isGenerating = false
    @State private var copies = 0
    @State private var showsCopied = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            copyOrGenerate()
        } label: {
            HStack {
                Label(showsCopied ? ConclaveStrings.text("Copied") : ConclaveStrings.text("Copy Link"),
                      systemImage: showsCopied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc)
                    .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                    .animation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion), value: showsCopied)
                Spacer(minLength: 8)
                if isGenerating {
                    ProgressView()
                }
            }
        }
        .disabled(isGenerating || (info.webinarLink.isEmpty && provider == nil) || !MeetingInfoPolicy.isWebinarLinkActionEnabled(info))
        .conclaveGestureFeedback(.linkCopied, trigger: copies)
        .task(id: copies) {
            guard copies > 0 else { return }
            try? await Task.sleep(for: .milliseconds(Int(MeetingInfoPolicy.copiedMillis)))
            if Task.isCancelled { return }
            showsCopied = false
        }
    }

    private func copyOrGenerate() {
        if !info.webinarLink.isEmpty {
            copy(info.webinarLink)
            return
        }
        guard let provider, !isGenerating else { return }
        isGenerating = true
        Task { @MainActor in
            let link = await provider() ?? ""
            isGenerating = false
            if !link.isEmpty { copy(link) }
        }
    }

    private func copy(_ link: String) {
        MeetingDetailsCopy.copy(link, isLink: true)
        copies += 1
        showsCopied = true
        AccessibilityNotification.Announcement(ConclaveStrings.text("Link copied")).post()
    }
}

private struct MeetingDetailsHostControlsRow: View {
    let isEnabled: Bool

    var body: some View {
        NavigationLink(value: MeetingInfoRoute.host(PeopleRoute.hostControls)) {
            LabeledContent {
                if !isEnabled {
                    Text(ConclaveStrings.text("Unavailable while reconnecting"))
                }
            } label: {

                Label(ConclaveStrings.text("Host Controls"), systemImage: ConclaveSymbols.personBadgeShieldCheckmarkFill)
            }
        }
        .disabled(!isEnabled)
    }
}

private struct MeetingDetailsDestination: View {
    let route: MeetingInfoRoute
    let people: PeoplePresenter?
    let shell: MeetingShellPresenter

    var body: some View {
        switch route {
        case .host(let page):
            MeetingDetailsHostPage(route: page, people: people)
        case .attendeeSettings:

            SettingsAttendeeList(settings: shell.settings,
                                 link: { route in route == SettingsRoute.privacy ? MeetingInfoRoute.privacyPolicy : nil })
        case .privacyPolicy:
            PrivacyPolicyScreen()
        }
    }
}

private struct MeetingDetailsHostPage: View {
    let route: PeopleRoute
    let people: PeoplePresenter?

    var body: some View {
        if let people {
            HostPageView(people: people, page: route, link: { MeetingInfoRoute.host($0) })
        } else {
            PeopleHostPage(route: route)
        }
    }
}

enum MeetingDetailsCopy {
    static func sectionTitle(_ section: MeetingInfoSection) -> String? {
        switch section {
        case .status: return ConclaveStrings.text("Status")
        case .webinar: return ConclaveStrings.text("Webinar")
        default: return nil
        }
    }

    static func webinarTitle(_ info: MeetingInfoSnapshot) -> String {
        info.webinarTitle.isEmpty ? ConclaveStrings.text("Webinar") : info.webinarTitle
    }

    static func startedTime(_ millis: Double) -> String {
        Date(timeIntervalSince1970: millis / 1000.0).formatted(date: .omitted, time: .shortened)
    }

    static func breakable(_ link: String) -> String {
        link.replacingOccurrences(of: "/", with: "/\u{200B}")
    }

    static func copy(_ value: String, isLink: Bool) {
        if isLink, let url = URL(string: value) {
            UIPasteboard.general.url = url
        } else {
            UIPasteboard.general.string = value
        }
    }

    static func versionText() -> String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    static func isHostRoute(_ route: MeetingInfoRoute) -> Bool {
        if case .host = route { return true }
        return false
    }
}
#endif
