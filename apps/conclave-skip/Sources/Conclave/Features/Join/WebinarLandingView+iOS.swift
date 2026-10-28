#if os(iOS) && !SKIP
import SwiftUI

// ENT-9 (S10 12 c, e, f, g, h, i, k; RECONCILE R41; S10 Q7): the iOS webinar attendee landing, the `.webinarLanding`
// destination of the premeeting NavigationStack. System appearance, an inset grouped List, the one coral primary
// (Start Watching) in the lobby's bottom bar (iOS 26 `safeAreaBar`, 17 to 25 `safeAreaInset` on the grouped
// background), Cancel in the toolbar while joining. Every leaf reads the one `PremeetingPresenter.webinar` snapshot,
// which never changes once a second: the countdown is the system timer text (`CountdownText`). No preview, no
// capture, no permission prompt and no sound on any path (invariant 6). No haptic on Start Watching: the `joined` and
// `joinFailed` tokens come from the session.

struct WebinarLandingView: View {
    let route: PremeetingRoute
    let premeeting: PremeetingPresenter
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        WebinarLandingList(route: route, premeeting: premeeting)
            .modifier(WebinarLandingBottomBar(premeeting: premeeting, routeId: route.id))
            .modifier(WebinarLandingChrome(premeeting: premeeting, routeId: route.id))
            .navigationTitle(ConclaveStrings.text("Webinar"))
            .toolbarTitleDisplayMode(.inline)
            .task(id: route.id) {
                premeeting.webinarDidAppear(routeId: route.id)
            }
            .onDisappear {
                premeeting.webinarDidDisappear(routeId: route.id)
            }
            .onChange(of: scenePhase) { _, phase in
                // S10 12 c, l6: back to active re-runs the status policy at once (equality-guarded in the presenter).
                premeeting.webinarSceneDidChange(isActive: phase == .active)
            }
            .accessibilityIdentifier("webinar")
    }
}

// MARK: - List

private struct WebinarLandingList: View {
    let route: PremeetingRoute
    let premeeting: PremeetingPresenter
    @State private var calendarDraft: WebinarCalendarDraft? = nil

    var body: some View {
        let snapshot = premeeting.webinar?.routeId == route.id ? premeeting.webinar : nil
        #if DEBUG
        // S10 12 l4: counts this body's evaluations; the early fixture's value stays flat while the countdown ticks.
        let bodyCount = WebinarLandingDiagnostics.noteListBody()
        #endif
        List {
            if let snapshot, snapshot.status != .loading {
                WebinarHeaderSection(tag: snapshot.tag, title: snapshot.title, hostName: snapshot.hostName)
                WebinarStatusSections(snapshot: snapshot, premeeting: premeeting, onAddToCalendar: {
                    calendarDraft = WebinarLandingCopy.calendarDraft(snapshot)
                })
            } else {
                Section {
                    ConclaveLoadingStatus(label: ConclaveStrings.text("Loading Webinar"), identifier: "webinar.loading")
                        .padding(.vertical, 24)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollDismissesKeyboard(.interactively)
        .sheet(item: $calendarDraft) { draft in
            EventEditView(draft: draft) {
                calendarDraft = nil
            }
            .ignoresSafeArea()
        }
        .onChange(of: snapshot?.status) { previous, current in
            // S10 12 i: opening, the wait for the host and the end announce once, on a change only.
            guard let previous, let current, previous != current, WebinarLandingPolicy.announces(current) else { return }
            AccessibilityNotification.Announcement(WebinarLandingCopy.announcement(current)).post()
        }
        #if DEBUG
        .overlay(alignment: .topLeading) {
            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityLabel(Text(verbatim: "webinar.list.body " + String(bodyCount)))
                .accessibilityIdentifier("webinar.list.bodyCount")
        }
        #endif
    }
}

/// The tag, the title (a header) and "Hosted by" (S10 12 c).
private struct WebinarHeaderSection: View {
    let tag: WebinarLandingTag
    let title: String
    let hostName: String

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                if tag != .none {
                    WebinarStatusTag(tag: tag)
                }
                Text(title.isEmpty ? ConclaveStrings.text("Join the Audience") : title)
                    .font(.title2.weight(.bold))
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("webinar.title")
                Text(hostName.isEmpty ? ConclaveStrings.text("Hosted by the organizer")
                     : ConclaveStrings.format("Hosted by %@", hostName))
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .accessibilityIdentifier("webinar.host")
            }
            .padding(.vertical, 4)
        }
    }
}

/// The C06 status tag: Live is the functional live color plus the word, never the color alone; Starts Soon and Ended
/// are neutral (S10 12 c, i; R5).
private struct WebinarStatusTag: View {
    let tag: WebinarLandingTag

    var body: some View {
        HStack(spacing: 6) {
            if tag == .live {
                Circle()
                    .fill(HostingTheme.statusLive)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
            }
            Text(WebinarLandingCopy.tag(tag))
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("webinar.tag")
    }
}

// MARK: - Status sections (S10 12 f)

private struct WebinarStatusSections: View {
    let snapshot: WebinarLandingSnapshot
    let premeeting: PremeetingPresenter
    let onAddToCalendar: () -> Void

    var body: some View {
        switch snapshot.status {
        case .loading:
            EmptyView()
        case .early:
            WebinarEarlySections(snapshot: snapshot, onAddToCalendar: onAddToCalendar)
        case .openNow:
            WebinarOpenSections(snapshot: snapshot, premeeting: premeeting)
        case .joining, .almostThere, .waitingForHost:
            WebinarProgressSection(status: snapshot.status)
        case .locked, .full, .unavailable, .ended, .cancelled, .failed:
            Section {
                WebinarStatusMessage(snapshot: snapshot, premeeting: premeeting)
            }
        }
    }
}

/// Early: "You're a Little Early", the countdown leaf and the opens note, then Add to Calendar and Share Link.
private struct WebinarEarlySections: View {
    let snapshot: WebinarLandingSnapshot
    let onAddToCalendar: () -> Void

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(ConclaveStrings.text("You\u{2019}re a Little Early"))
                    .font(.headline)
                if snapshot.startsAtMillis > 0.0 {
                    CountdownText(startsAtMillis: snapshot.startsAtMillis)
                }
                if snapshot.earlyEntryMinutes > 0 {
                    Text(ConclaveStrings.format("The lobby opens %lld minutes before the start.",
                                                Int64(snapshot.earlyEntryMinutes)))
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .accessibilityIdentifier("webinar.opensNote")
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("webinar.early")
        }
        Section {
            if snapshot.startsAtMillis > 0.0 {
                Button(ConclaveStrings.text("Add to Calendar"), action: onAddToCalendar)
                    .accessibilityIdentifier("webinar.calendar")
            }
            if let url = URL(string: snapshot.link), !snapshot.link.isEmpty {
                ShareLink(ConclaveStrings.text("Share Link"), item: url)
                    .accessibilityIdentifier("webinar.share")
            }
        }
        .tint(HostingTheme.coralText)
    }
}

/// Open: the name field when needed (40 at most, counter from 30, R41), the invite field when needed, then the
/// attendee note. The fields keep their own text; the presenter gets every change.
private struct WebinarOpenSections: View {
    let snapshot: WebinarLandingSnapshot
    let premeeting: PremeetingPresenter

    var body: some View {
        if snapshot.needsName {
            WebinarNameSection(routeId: snapshot.routeId, limit: snapshot.nameLimit, premeeting: premeeting)
        }
        if snapshot.needsInviteCode {
            WebinarInviteSection(routeId: snapshot.routeId, isInvalid: snapshot.inviteCodeInvalid, premeeting: premeeting)
        }
        Section {
        } footer: {
            Text(ConclaveStrings.text("You\u{2019}ll join as an attendee. Your camera and mic stay off."))
                .accessibilityIdentifier("webinar.attendeeNote")
        }
    }
}

private struct WebinarNameSection: View {
    let routeId: Int
    let limit: Int
    let premeeting: PremeetingPresenter
    @State private var name = ""

    var body: some View {
        Section {
            HStack(spacing: 8) {
                ConclaveTextField(ConclaveStrings.text("Your Name"), text: $name, kind: .name, identifier: "webinar.name") {
                    premeeting.startWatching()
                }
                ConclaveCharacterCounter(count: name.count, limit: limit, visibleFrom: DisplayNamePolicy.counterThreshold,
                                         identifier: "webinar.name.counter")
            }
        } footer: {
            Text(ConclaveStrings.text("Add your name so the host knows who\u{2019}s asking when you join the Q&A."))
                .accessibilityIdentifier("webinar.name.footer")
        }
        .task(id: routeId) {
            // The field comes back after Cancel with the name already typed (never on a body re-run).
            let draft = premeeting.webinarNameText
            if name != draft {
                name = draft
            }
        }
        .onChange(of: name) {
            // R41: typing stops at 40 (the 41st character is rejected).
            let capped = DisplayNamePolicy.capped(name)
            if capped != name {
                name = capped
                return
            }
            premeeting.setWebinarName(name)
        }
    }
}

private struct WebinarInviteSection: View {
    let routeId: Int
    let isInvalid: Bool
    let premeeting: PremeetingPresenter
    @State private var code = ""

    var body: some View {
        Section {
            ConclaveTextField(ConclaveStrings.text("Invite Code"), text: $code, kind: .code, identifier: "webinar.invite") {
                premeeting.startWatching()
            }
        } footer: {
            if isInvalid {
                ConclaveFieldError(text: ConclaveStrings.text("That invite code didn\u{2019}t work. Check it and try again."),
                                   identifier: "webinar.invite.error")
            } else {
                Text(ConclaveStrings.text("Enter the invite code from the organizer."))
                    .accessibilityIdentifier("webinar.invite.footer")
            }
        }
        .task(id: routeId) {
            let draft = premeeting.webinarInviteText
            if code != draft {
                code = draft
            }
        }
        .onChange(of: code) {
            premeeting.setWebinarInviteCode(code)
        }
    }
}

/// Joining, Almost There and the wait for the host: the system spinner with a static title (R13), and the wait's body.
private struct WebinarProgressSection: View {
    let status: WebinarLandingStatus

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    ProgressView()
                    Text(WebinarLandingCopy.progressTitle(status))
                        .font(.headline)
                }
                if status == .waitingForHost {
                    Text(ConclaveStrings.text("This page updates on its own when the host opens the room."))
                        .font(.subheadline)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("webinar.progress")
        }
    }
}

/// The C14 status message inside the list: locked, full, not available, ended, cancelled (Back to Home) and the failed
/// lookup or join (Try Again). The action is tonal; coral stays for Start Watching.
private struct WebinarStatusMessage: View {
    let snapshot: WebinarLandingSnapshot
    let premeeting: PremeetingPresenter

    var body: some View {
        let message = WebinarLandingCopy.message(snapshot)
        ContentUnavailableView {
            Label(WebinarLandingCopy.messageTitle(snapshot.status), systemImage: WebinarLandingCopy.symbol(snapshot.status))
                .accessibilityAddTraits(.isHeader)
        } description: {
            if !message.isEmpty {
                Text(message)
            }
        } actions: {
            if snapshot.action == .tryAgain {
                Button(ConclaveStrings.text("Try Again")) { premeeting.retryWebinar() }
                    .buttonStyle(.bordered)
                    .tint(Color.primary)
                    .accessibilityIdentifier("webinar.status.tryAgain")
            } else if snapshot.action == .backHome {
                Button(ConclaveStrings.text("Back to Home")) { premeeting.webinarBackHome() }
                    .buttonStyle(.bordered)
                    .tint(Color.primary)
                    .accessibilityIdentifier("webinar.status.backHome")
            }
        }
        .accessibilityIdentifier("webinar.status")
    }
}

// MARK: - Bottom bar and chrome

/// The lobby's bottom bar container (S10 12 c): Start Watching only while open, disabled (40%, C01) until a needed name
/// or invite code exists.
private struct WebinarLandingBottomBar: ViewModifier {
    let premeeting: PremeetingPresenter
    let routeId: Int

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.safeAreaBar(edge: .bottom) {
                WebinarPrimaryBar(premeeting: premeeting, routeId: routeId)
            }
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                WebinarPrimaryBar(premeeting: premeeting, routeId: routeId)
                    .background(Color(uiColor: .systemGroupedBackground))
            }
        }
    }
}

private struct WebinarPrimaryBar: View {
    let premeeting: PremeetingPresenter
    let routeId: Int

    var body: some View {
        if let snapshot = premeeting.webinar, snapshot.routeId == routeId, snapshot.action == .startWatching {
            ConclaveButton(ConclaveStrings.text("Start Watching"), role: .primary, isEnabled: snapshot.isPrimaryEnabled,
                           identifier: "webinar.startWatching") {
                premeeting.startWatching()
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
    }
}

/// While joining: Cancel replaces Back (and the swipe back), S10 12 f.
private struct WebinarLandingChrome: ViewModifier {
    let premeeting: PremeetingPresenter
    let routeId: Int

    func body(content: Content) -> some View {
        let snapshot = premeeting.webinar
        let isJoining = snapshot?.routeId == routeId && WebinarLandingPolicy.isJoining(snapshot?.status ?? .loading)
        content
            .navigationBarBackButtonHidden(isJoining)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if isJoining {
                        Button(ConclaveStrings.text("Cancel"), role: .cancel) { premeeting.cancelJoin() }
                            .accessibilityIdentifier("webinar.cancel")
                    }
                }
            }
    }
}

// MARK: - Copy (S10 12 g; Apple title case for titles and buttons, sentence case for bodies)

enum WebinarLandingCopy {
    static func tag(_ tag: WebinarLandingTag) -> String {
        switch tag {
        case .live:
            return ConclaveStrings.text("Live")
        case .startsSoon:
            return ConclaveStrings.text("Starts Soon")
        case .ended:
            return ConclaveStrings.text("Ended")
        case .none:
            return ""
        }
    }

    static func progressTitle(_ status: WebinarLandingStatus) -> String {
        switch status {
        case .almostThere:
            return ConclaveStrings.text("Almost There")
        case .waitingForHost:
            return ConclaveStrings.text("Waiting for the Host to Start")
        default:
            return ConclaveStrings.text("Getting You In")
        }
    }

    static func messageTitle(_ status: WebinarLandingStatus) -> String {
        switch status {
        case .locked:
            return ConclaveStrings.text("This webinar is locked.")
        case .full:
            return ConclaveStrings.text("This webinar is full.")
        case .unavailable:
            return ConclaveStrings.text("This webinar isn\u{2019}t available.")
        case .ended:
            return ConclaveStrings.text("Webinar Ended")
        case .cancelled:
            return ConclaveStrings.text("Webinar Cancelled")
        default:
            return ConclaveStrings.text("We Hit a Snag")
        }
    }

    /// The body under the title: the organizer guidance, the lookup failure, or for a failed join the classifier's
    /// clean sentence class (the S10 8 g bodies the lobby uses), so a failure never says only "We Hit a Snag".
    static func message(_ snapshot: WebinarLandingSnapshot) -> String {
        switch snapshot.status {
        case .ended:
            return ConclaveStrings.text("Reach out to the organizer for a replay or about future sessions.")
        case .cancelled:
            return ConclaveStrings.text("The organizer cancelled this session. Reach out to them for an update.")
        case .failed:
            return ConclaveStrings.text("Couldn\u{2019}t load this webinar.")
        default:
            return ""
        }
    }

    static func symbol(_ status: WebinarLandingStatus) -> String {
        switch status {
        case .ended, .cancelled:
            return ConclaveSymbols.infoCircle
        case .failed:
            return ConclaveSymbols.exclamationmarkOctagonFill
        default:
            return ConclaveSymbols.exclamationmarkTriangleFill
        }
    }

    static func announcement(_ status: WebinarLandingStatus) -> String {
        switch status {
        case .openNow:
            return ConclaveStrings.text("Start Watching")
        case .waitingForHost:
            return ConclaveStrings.text("Waiting for the Host to Start")
        case .ended:
            return ConclaveStrings.text("Webinar Ended")
        case .cancelled:
            return ConclaveStrings.text("Webinar Cancelled")
        default:
            return ""
        }
    }

    /// The prefilled event: the title (or the fallback), the start and the end (else one hour), the link.
    static func calendarDraft(_ snapshot: WebinarLandingSnapshot) -> WebinarCalendarDraft {
        let endMillis = WebinarLandingPolicy.eventEndMillis(startsAtMillis: snapshot.startsAtMillis,
                                                            endsAtMillis: snapshot.endsAtMillis)
        return WebinarCalendarDraft(
            id: snapshot.revision,
            title: snapshot.title.isEmpty ? ConclaveStrings.text("Webinar") : snapshot.title,
            startsAt: Date(timeIntervalSince1970: snapshot.startsAtMillis / 1000.0),
            endsAt: Date(timeIntervalSince1970: endMillis / 1000.0),
            link: snapshot.link
        )
    }
}

#if DEBUG
/// S10 12 l4 (Debug): the landing list's body evaluations, read through the hidden `webinar.list.bodyCount` element.
enum WebinarLandingDiagnostics {
    private static var listBodyCount = 0

    static func noteListBody() -> Int {
        listBodyCount += 1
        return listBodyCount
    }
}
#endif
#endif
