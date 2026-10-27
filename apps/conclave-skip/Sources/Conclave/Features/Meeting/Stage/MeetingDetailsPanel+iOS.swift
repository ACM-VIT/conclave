#if os(iOS) && !SKIP
import Accessibility
import SwiftUI
import UIKit

// S20 15 (STG-6) on iOS: Meeting Details (`MeetingPanel.meetingInfo`), and its attendee variant Webinar Details (S20 12
// a, RECONCILE R44). One `PanelShell` with a path over the view-local `MeetingInfoRoute` (one
// `navigationDestination(for:)`), medium and large with the stage usable at medium, the inspector on regular x regular,
// system appearance (OD Q8 (6)). The list reads only `stage.meetingInfo` (built from inputs, equality guarded, S20 15 k)
// and draws the rows of `MeetingInfoPolicy.rows` in S20 15 b order. Copy confirms inline for 2 s (F00 C13: no toast on
// a system-appearance sheet) with the `linkCopied` gesture (SC21); share uses `ShareLink` with the F00 payload
// (RECONCILE R14), never the legacy `MeetingShare`. The webinar link is generated only by its one owner through
// `webinarLinkProvider` (S50 `HostControlsPresenter.ensureWebinarLink()`, RECONCILE R34). Host Controls pushes the S50
// content inside this panel and promotes a medium sheet to large first (R34); the attendee Settings row pushes the
// attendee settings rows (R44). Mounted by the native call root.

/// The pushed pages (view-local; associated values are fine in an iOS-only type): the S50 host pages, the attendee
/// Settings rows and its privacy policy page.
enum MeetingInfoRoute: Hashable {
    case host(PeopleRoute)
    case attendeeSettings
    case privacyPolicy
}

/// Generates a missing webinar link through its single owner and returns it (nil on failure).
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
                    MeetingDetailsDestination(route: route, people: people)
                }
        }
        .onChange(of: path.count) { previous, next in
            // Every push (Host Controls, Settings) promotes a medium sheet to large (PS 7.3, RECONCILE R34, R44).
            if next > previous { adapter.promoteToLarge() }
        }
        .background { MeetingDetailsLeaves(stage: stage, path: $path) }
        .accessibilityIdentifier("meetingInfo.panel")
    }
}

/// Zero-size leaf: losing host (or becoming an attendee) while on a host page pops back to the details (S50 12).
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

/// The root list (S20 15 b, c): one section per `MeetingInfoSection` with rows, in order.
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
        }
    }
}

/// One row. Value rows are `LabeledContent` (read as "Room Code, abc-defg-hij"); long values wrap, and the link may
/// break after a slash at the largest text sizes (15 f).
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

/// Share Invite with the one share payload (F00 11, RECONCILE R14); no `ShareLink` over an empty or invalid URL.
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

/// Copy Code and Copy Link (SC21): the pasteboard, one `linkCopied` per copy, the label reads "Copied" with a checkmark
/// for 2 s, and a polite announcement ("Code copied", "Link copied").
private struct MeetingDetailsCopyRow: View {
    let title: String
    let value: String
    let isLink: Bool
    let announcement: String
    @State private var copies = 0
    @State private var showsCopied = false

    var body: some View {
        Button {
            MeetingDetailsCopy.copy(value, isLink: isLink)
            copies += 1
            showsCopied = true
            AccessibilityNotification.Announcement(announcement).post()
        } label: {
            Label(showsCopied ? ConclaveStrings.text("Copied") : title,
                  systemImage: showsCopied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc)
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

/// Share Webinar Link (15 f): with a link, the system share sheet; without one (hosts only), the first tap generates it
/// through the one owner with a row spinner, and the row turns into the share control once the link arrives (SwiftUI
/// cannot open the share sheet without a tap on a `ShareLink`). Opening the panel never generates a link.
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

/// The webinar Copy row: copies an existing link at once; a missing one is generated first (row spinner), then copied.
private struct MeetingDetailsWebinarCopyRow: View {
    let info: MeetingInfoSnapshot
    let provider: MeetingDetailsWebinarLinkProvider?
    @State private var isGenerating = false
    @State private var copies = 0
    @State private var showsCopied = false

    var body: some View {
        Button {
            copyOrGenerate()
        } label: {
            HStack {
                Label(showsCopied ? ConclaveStrings.text("Copied") : ConclaveStrings.text("Copy Link"),
                      systemImage: showsCopied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc)
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

/// Host Controls (hosts only): a chevron row that pushes the S50 content inside this panel; while recovering it stays
/// visible, disabled, with "Unavailable while reconnecting" (15 f).
private struct MeetingDetailsHostControlsRow: View {
    let isEnabled: Bool

    var body: some View {
        NavigationLink(value: MeetingInfoRoute.host(PeopleRoute.hostControls)) {
            LabeledContent {
                if !isEnabled {
                    Text(ConclaveStrings.text("Unavailable while reconnecting"))
                }
            } label: {
                // `host_controls_item` is pending the icon lane (S30 CL11); the host concept glyph stands in, as in People.
                Label(ConclaveStrings.text("Host Controls"), systemImage: ConclaveSymbols.crownFill)
            }
        }
        .disabled(!isEnabled)
    }
}

/// The pushed pages.
private struct MeetingDetailsDestination: View {
    let route: MeetingInfoRoute
    let people: PeoplePresenter?

    var body: some View {
        switch route {
        case .host(let page):
            MeetingDetailsHostPage(route: page, people: people)
        case .attendeeSettings:
            MeetingDetailsAttendeeSettings()
        case .privacyPolicy:
            PrivacyPolicyScreen()
        }
    }
}

/// The S50 Host Controls content pushed inside Meeting Details: the same page Participants pushes (S50 6 a; S60 R6-3
/// mechanism), PPL-4's `HostPageView`, whose sub-page rows link into this panel's path through the
/// `MeetingInfoRoute.host` mirror (`link`, R50-2: one homogeneous path per stack). Without a People presenter (the
/// stage fixture) the empty `PeopleHostPage` stand-in keeps the push, the title and Back working (HD request B5-T2 R6).
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

/// The attendee path to Settings and the Privacy Policy (RECONCILE R44): the About rows that exist today. SET-1
/// (batch 6) replaces this body with the S60 call-scope Settings filtered for role attendee (Data Saver, iOS Haptics,
/// About with Export Diagnostics).
private struct MeetingDetailsAttendeeSettings: View {
    var body: some View {
        List {
            Section(ConclaveStrings.text("About")) {
                NavigationLink(value: MeetingInfoRoute.privacyPolicy) {
                    Text(ConclaveStrings.text("Privacy Policy"))
                }
                LabeledContent(ConclaveStrings.text("Version"), value: MeetingDetailsCopy.versionText())
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(ConclaveStrings.text("Settings"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("meetingInfo.page.attendeeSettings")
    }
}

/// iOS copy and helpers for Meeting Details (Apple title case, S20 15 g).
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

    /// The call session's start time, in the locale's short time style.
    static func startedTime(_ millis: Double) -> String {
        Date(timeIntervalSince1970: millis / 1000.0).formatted(date: .omitted, time: .shortened)
    }

    /// A zero-width space after each slash, so a long link wraps at its path breaks instead of mid-word (15 f).
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
