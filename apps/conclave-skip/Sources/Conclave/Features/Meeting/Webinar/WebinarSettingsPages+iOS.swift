#if os(iOS) && !SKIP
import SwiftUI
import UIKit

enum WebinarSettingsText {
    static func watching(count: Int, max: Int) -> String {
        ConclaveStrings.format("Watching Count %lld %lld", count, max)
    }
}

struct WebinarSettingsPage<Route: Hashable>: View {
    let people: PeoplePresenter
    let link: (PeopleRoute) -> Route
    @Environment(\.dismiss) private var dismiss
    @State private var didAppear = false
    @State private var capacityText = ""
    @State private var showsCapacityError = false
    @State private var copiedToken = 0
    @State private var showsCopied = false
    @State private var copyFeedback = 0
    @FocusState private var capacityFocused: Bool

    var body: some View {
        let host = people.host
        let snapshot = host.snapshot
        let webinar = snapshot.webinar
        let blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
        Form {
            if snapshot.isConfigLoading {
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text(ConclaveStrings.text("Loading Settings"))
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("webinar.loading")
                }
            }
            Section {
                LabeledContent(ConclaveStrings.text("Watching")) {
                    WebinarWatchingValue(host: host, max: webinar.maxAttendees)
                }
                .accessibilityIdentifier("webinar.watching")
                HostPolicyToggleRow(people: people, policy: HostPolicyID.webinarPublic)
                HostPolicyToggleRow(people: people, policy: HostPolicyID.webinarLocked)
                HostPolicyToggleRow(people: people, policy: HostPolicyID.webinarQa)
                maxAttendeesRow(pending: snapshot.isFieldPending(HostFieldID.capacity), blocked: blocked)
                NavigationLink(value: link(PeopleRoute.attendeeCode)) {
                    LabeledContent(ConclaveStrings.text("Attendee Code"), value: HostText.onOff(webinar.requiresCode))
                }
                .accessibilityIdentifier("webinar.attendeeCode")
            } header: {
                Text(ConclaveStrings.text("Attendees"))
            } footer: {
                Text(ConclaveStrings.text("Public access lets people watch from the webinar link. Lock attendees stops new attendees from joining. Attendee Q&A lets attendees ask questions."))
            }
            Section {
                if !webinar.linkURL.isEmpty {

                    Text(webinar.linkURL)
                        .textSelection(.enabled)
                        .lineLimit(nil)
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .accessibilityIdentifier("webinar.link")
                }
                shareRow(webinar: webinar, blocked: blocked)
                Button {
                    copyLink()
                } label: {
                    HStack(spacing: 8) {
                        Label(showsCopied ? ConclaveStrings.text("Copied") : ConclaveStrings.text("Copy Link"),
                              systemImage: showsCopied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc)
                        Spacer(minLength: 0)
                        if webinar.linkPhase == WebinarLinkPhase.generating && webinar.linkURL.isEmpty {
                            ProgressView().accessibilityHidden(true)
                        }
                    }
                }

                .disabled(webinar.linkURL.isEmpty && blocked)
                .conclaveGestureFeedback(.linkCopied, trigger: copyFeedback)
                .accessibilityIdentifier("webinar.copy")
                NavigationLink(value: link(PeopleRoute.customLink)) {
                    LabeledContent(ConclaveStrings.text("Custom Link"), value: webinar.linkSlug)
                }
                .accessibilityIdentifier("webinar.customLink")
                VStack(alignment: .leading, spacing: 6) {
                    Button(role: .destructive) {
                        host.requestRotateLink()
                    } label: {
                        HStack(spacing: 8) {
                            Text(ConclaveStrings.text("Rotate Link\u{2026}"))
                            Spacer(minLength: 0)
                            if webinar.linkPhase == WebinarLinkPhase.rotating { ProgressView().accessibilityHidden(true) }
                        }
                    }
                    .disabled(blocked || webinar.linkPhase == WebinarLinkPhase.rotating)
                    .modifier(HostRowConfirmation(people: people, kinds: [PeopleConfirmationKind.rotateWebinarLink]))
                    .accessibilityIdentifier("webinar.rotate")
                    HostInlineFailureLine(people: people, sourceKey: HostFieldID.customLink)
                }
            } header: {
                Text(ConclaveStrings.text("Webinar Link"))
            } footer: {
                Text(ConclaveStrings.text("Share this link with people who should watch. Rotating it stops the old link from working."))
            }
        }
        .formStyle(.grouped)
        .navigationTitle(ConclaveStrings.text("Webinar Settings"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {

            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button(ConclaveStrings.text("Done")) { commitCapacity() }
                    .accessibilityIdentifier("webinar.capacity.done")
            }
        }
        .onAppear {
            guard !didAppear else { return }
            didAppear = true

            if !host.drafts.seededFromServer {
                host.drafts.capacity = String(webinar.maxAttendees)
                host.drafts.slug = webinar.linkSlug
                host.drafts.seededFromServer = true
            }
            capacityText = host.drafts.capacity
            host.refreshWebinarConfig()
        }
        .onChange(of: capacityText) { _, value in
            host.drafts.capacity = value
            if showsCapacityError && !WebinarSettingsPolicy.showsCapacityError(value) { showsCapacityError = false }
        }
        .onChange(of: capacityFocused) { _, focused in
            if !focused { commitCapacity() }
        }
        .onChange(of: snapshot.savedSerial) { _, _ in
            if host.snapshot.savedField == HostFieldID.capacity { capacityText = host.drafts.capacity }
        }
        .onChange(of: snapshot.rotatedLinkSerial) { _, _ in

            let fresh = host.snapshot.webinar.linkURL
            guard !fresh.isEmpty else { return }
            UIPasteboard.general.string = fresh
            copyFeedback += 1
            AccessibilityNotification.Announcement(ConclaveStrings.text("New link copied.")).post()
        }
        .onChange(of: host.isWebinarSettingsReachable) { _, reachable in
            if !reachable { dismiss() }
        }
        .task(id: copiedToken) {
            guard copiedToken > 0 else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { showsCopied = false }
        }
        .accessibilityIdentifier("host.page.webinar")
    }

    private func maxAttendeesRow(pending: Bool, blocked: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Stepper(onIncrement: { stepCapacity(by: 10) }, onDecrement: { stepCapacity(by: -10) }) {
                LabeledContent(ConclaveStrings.text("Max Attendees")) {
                    HStack(spacing: 8) {
                        if pending { ProgressView().accessibilityHidden(true) }
                        TextField(ConclaveStrings.text("Max Attendees"), text: $capacityText)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                            .monospacedDigit()
                            .frame(maxWidth: 80)
                            .focused($capacityFocused)
                            .accessibilityLabel(ConclaveStrings.text("Max Attendees"))
                            .accessibilityIdentifier("webinar.capacity.field")
                    }
                }
            }
            .disabled(blocked || pending)
            .accessibilityIdentifier("webinar.capacity")
            if showsCapacityError {
                Text(ConclaveStrings.text("Enter a number from 1 to 5,000."))
                    .font(.footnote)
                    .foregroundStyle(Color(uiColor: .systemRed))
                    .accessibilityIdentifier("webinar.capacity.error")
            }
            HostInlineFailureLine(people: people, sourceKey: HostFieldID.capacity)
        }
    }

    private func stepCapacity(by delta: Int) {
        let current = HostControlsPolicy.capacity(capacityText) ?? people.host.snapshot.webinar.maxAttendees
        let next = min(HostControlsPolicy.capacityMax, max(HostControlsPolicy.capacityMin, current + delta))
        capacityText = String(next)
        commitCapacity()
    }

    private func commitCapacity() {
        capacityFocused = false
        if WebinarSettingsPolicy.showsCapacityError(capacityText) {
            showsCapacityError = true
            return
        }
        showsCapacityError = false
        guard let value = WebinarSettingsPolicy.capacityToCommit(capacityText,
                                                                  current: people.host.snapshot.webinar.maxAttendees) else { return }
        people.host.setMaxAttendees(value)
    }

    @ViewBuilder
    private func shareRow(webinar: WebinarSettingsModel, blocked: Bool) -> some View {
        if let url = URL(string: webinar.linkURL), !webinar.linkURL.isEmpty {
            ShareLink(item: url) {
                Label(ConclaveStrings.text("Share Webinar Link"), systemImage: ConclaveSymbols.squareAndArrowUp)
            }
            .accessibilityIdentifier("webinar.share")
        } else {
            Button {
                Task { _ = await people.host.ensureWebinarLink() }
            } label: {
                HStack(spacing: 8) {
                    Label(webinar.linkPhase == WebinarLinkPhase.generating ? ConclaveStrings.text("Generating\u{2026}")
                          : ConclaveStrings.text("Share Webinar Link"), systemImage: ConclaveSymbols.squareAndArrowUp)
                    Spacer(minLength: 0)
                    if webinar.linkPhase == WebinarLinkPhase.generating { ProgressView().accessibilityHidden(true) }
                }
            }
            .disabled(blocked || webinar.linkPhase == WebinarLinkPhase.generating)
            .accessibilityIdentifier("webinar.share.generate")
            if webinar.linkPhase == WebinarLinkPhase.failed {
                Text(ConclaveStrings.text("Webinar link unavailable."))
                    .font(.footnote)
                    .foregroundStyle(Color(uiColor: .systemRed))
                    .accessibilityIdentifier("webinar.link.failed")
            }
        }
    }

    private func copyLink() {
        let host = people.host
        Task {
            guard let value = await host.ensureWebinarLink(), !value.isEmpty else { return }
            UIPasteboard.general.string = value
            copyFeedback += 1
            showsCopied = true
            copiedToken += 1
            AccessibilityNotification.Announcement(ConclaveStrings.text("Copied")).post()
        }
    }
}

private struct WebinarWatchingValue: View {
    let host: HostControlsPresenter
    let max: Int

    var body: some View {
        Text(WebinarSettingsText.watching(count: host.attendeeCount, max: max))
            .monospacedDigit()
    }
}

struct AttendeeCodePage: View {
    let people: PeoplePresenter
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var didSeed = false
    @State private var showsSaved = false
    @State private var savedToken = 0

    var body: some View {
        let host = people.host
        let snapshot = host.snapshot
        let saving = snapshot.isFieldPending(HostFieldID.attendeeCode)
        let blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
        Form {
            Section {
                LabeledContent(ConclaveStrings.text("Status"), value: HostText.onOff(snapshot.webinar.requiresCode))
            }
            Section {
                TextField(ConclaveStrings.text("New Code"), text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { save() }
                    .disabled(saving || blocked)
                    .accessibilityIdentifier("webinar.attendeeCode.field")
                HostInlineFailureLine(people: people, sourceKey: HostFieldID.attendeeCode)
            } footer: {
                Text(ConclaveStrings.text("Attendees need this code to watch."))
            }
            Section {
                Button {
                    save()
                } label: {
                    HStack(spacing: 8) {
                        Text(ConclaveStrings.text("Save Code"))
                        Spacer(minLength: 0)
                        if saving { ProgressView().accessibilityHidden(true) }
                    }
                }
                .disabled(!WebinarSettingsPolicy.canSaveAttendeeCode(draft, isPending: saving, isBlocked: blocked))
                .accessibilityIdentifier("webinar.attendeeCode.save")
                if showsSaved {
                    Label(ConclaveStrings.text("Code saved"), systemImage: ConclaveSymbols.checkmark)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("webinar.attendeeCode.saved")
                }
                if snapshot.webinar.requiresCode {
                    Button(ConclaveStrings.text("Remove Code\u{2026}"), role: .destructive) {
                        host.requestClearAttendeeCode()
                    }
                    .disabled(saving || blocked)
                    .modifier(HostRowConfirmation(people: people, kinds: [PeopleConfirmationKind.clearAttendeeCode]))
                    .accessibilityIdentifier("webinar.attendeeCode.remove")
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(ConclaveStrings.text("Attendee Code"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if !didSeed {
                didSeed = true
                draft = host.drafts.attendeeCode
            }
        }
        .onChange(of: draft) { _, value in
            host.drafts.attendeeCode = value
        }
        .onChange(of: snapshot.savedSerial) { _, _ in
            guard host.snapshot.savedField == HostFieldID.attendeeCode else { return }
            draft = host.drafts.attendeeCode
            showsSaved = true
            savedToken += 1
            AccessibilityNotification.Announcement(ConclaveStrings.text("Code saved")).post()
        }
        .onChange(of: host.isWebinarSettingsReachable) { _, reachable in
            if !reachable { dismiss() }
        }
        .task(id: savedToken) {
            guard savedToken > 0 else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { showsSaved = false }
        }
        .accessibilityIdentifier("host.page.attendeeCode")
    }

    private func save() {
        people.host.setAttendeeCode(draft)
    }
}

struct CustomLinkPage: View {
    let people: PeoplePresenter
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var didSeed = false

    var body: some View {
        let host = people.host
        let snapshot = host.snapshot
        let saving = snapshot.isFieldPending(HostFieldID.customLink)
        let blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
        Form {
            Section {
                TextField(ConclaveStrings.text("custom-link"), text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .submitLabel(.done)
                    .onSubmit { save() }
                    .disabled(saving || blocked)
                    .accessibilityLabel(ConclaveStrings.text("Custom Link"))
                    .accessibilityIdentifier("webinar.customLink.field")
                HostInlineFailureLine(people: people, sourceKey: HostFieldID.customLink)
            } footer: {
                Text(ConclaveStrings.text("Use 3 to 32 lowercase letters, numbers or hyphens."))
            }
            Section {
                Button {
                    save()
                } label: {
                    HStack(spacing: 8) {
                        Text(ConclaveStrings.text("Save Link"))
                        Spacer(minLength: 0)
                        if saving { ProgressView().accessibilityHidden(true) }
                    }
                }
                .disabled(!WebinarSettingsPolicy.canSaveSlug(draft, isPending: saving, isBlocked: blocked))
                .accessibilityIdentifier("webinar.customLink.save")
                if !snapshot.webinar.linkSlug.isEmpty {
                    Button(ConclaveStrings.text("Clear Link"), role: .destructive) {
                        host.clearLinkSlug()
                    }
                    .disabled(saving || blocked)
                    .accessibilityIdentifier("webinar.customLink.clear")
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(ConclaveStrings.text("Custom Link"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if !didSeed {
                didSeed = true
                draft = host.drafts.slug.isEmpty ? snapshot.webinar.linkSlug : host.drafts.slug
            }
        }
        .onChange(of: draft) { _, value in
            let sanitized = WebinarSettingsPolicy.sanitizedSlug(value)
            if sanitized != value {
                draft = sanitized
                return
            }
            host.drafts.slug = sanitized
        }
        .onChange(of: snapshot.savedSerial) { _, _ in
            guard host.snapshot.savedField == HostFieldID.customLink else { return }
            draft = host.drafts.slug
        }
        .onChange(of: host.isWebinarSettingsReachable) { _, reachable in
            if !reachable { dismiss() }
        }
        .accessibilityIdentifier("host.page.customLink")
    }

    private func save() {
        people.host.setLinkSlug(draft)
    }
}
#endif
