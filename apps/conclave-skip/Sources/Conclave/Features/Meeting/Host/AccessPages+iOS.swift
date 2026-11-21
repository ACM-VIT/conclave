#if os(iOS) && !SKIP
import SwiftUI

struct HostCodePageModel {
    let tag: String
    let pageTag: String
    let title: String
    let requiresCode: Bool
    let knownCode: String
    let saving: Bool
    let fieldID: String
    let introTitle: String
    let introBody: String
    let onTitle: String
    let turnOn: String
    let turnOff: String
    let confirmation: PeopleConfirmationKind
    let shareText: String
}

struct InviteCodePage: View {
    let people: PeoplePresenter

    var body: some View {
        let host = people.host
        let snapshot = host.snapshot
        let known = host.knownInviteCode
        let link = people.stage.layout.meetingLink
        HostCodePage(
            people: people,
            model: HostCodePageModel(
                tag: "host.inviteCode", pageTag: "host.page.inviteCode", title: ConclaveStrings.text("Invite Code"),
                requiresCode: snapshot.access.requiresCode, knownCode: known,
                saving: snapshot.inviteCodePhase == HostFieldPhase.sending, fieldID: HostFieldID.inviteCode,
                introTitle: ConclaveStrings.text("Ask for a Code to Join"),
                introBody: ConclaveStrings.text("Everyone who joins needs this code, even with the meeting link."),
                onTitle: ConclaveStrings.text("Invite Code Is On"),
                turnOn: ConclaveStrings.text("Turn On Invite Code"),
                turnOff: ConclaveStrings.text("Turn Off Invite Code\u{2026}"),
                confirmation: PeopleConfirmationKind.clearInviteCode,
                shareText: link.isEmpty ? ConclaveStrings.format("Conclave invite code: %@", known)
                    : ConclaveStrings.format("Join my Conclave meeting: %@\nInvite code: %@", link, known)),
            savedToken: snapshot.inviteCodeSavedSerial,
            draft: { host.drafts.meetingCode },
            setDraft: { host.drafts.meetingCode = $0 },
            onSave: { host.setMeetingInviteCode($0) },
            onClear: { host.requestClearMeetingInviteCode() })
    }
}

struct HostCodePage: View {
    let people: PeoplePresenter
    let model: HostCodePageModel
    let savedToken: Int
    let draft: () -> String
    let setDraft: (String) -> Void
    let onSave: (String) -> Void
    let onClear: () -> Void
    @State private var text = ""
    @State private var didSeed = false
    @State private var seenSavedToken = 0
    @State private var showsSaved = false
    @State private var savedPulse = 0
    @State private var copies = 0
    @State private var showsCopied = false
    @FocusState private var fieldFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let snapshot = people.host.snapshot
        let blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
        let status = HostInviteCodePolicy.status(requiresCode: model.requiresCode, knownCode: model.knownCode)
        let canSave = HostControlsPolicy.canSaveInviteCode(text, isPending: model.saving, isBlocked: blocked)
            && !HostInviteCodePolicy.isUnchanged(text, knownCode: model.knownCode)
        Form {
            Section {
                switch status {
                case .off:
                    HostCodeIntro(title: model.introTitle, detail: model.introBody)
                case .onKnown:
                    VStack(alignment: .leading, spacing: 6) {
                        Text(ConclaveStrings.text("Current Code"))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text(model.knownCode)
                            .font(.system(.title, design: .monospaced).weight(.semibold))
                            .kerning(2)
                            .textSelection(.enabled)
                            .accessibilityIdentifier(model.tag + ".current")
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                    Button {
                        copy(model.knownCode)
                    } label: {
                        Label(showsCopied ? ConclaveStrings.text("Copied") : ConclaveStrings.text("Copy Code"),
                              systemImage: showsCopied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc)
                            .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                    }
                    .conclaveGestureFeedback(.linkCopied, trigger: copies)
                    .accessibilityIdentifier(model.tag + ".copy")
                    ShareLink(item: model.shareText) {
                        Label(ConclaveStrings.text("Share Code"), systemImage: ConclaveSymbols.squareAndArrowUp)
                    }
                    .accessibilityIdentifier(model.tag + ".share")
                case .onUnknown:
                    HostCodeIntro(title: model.onTitle,
                                  detail: ConclaveStrings.text("The current code was set earlier or by another host. Set a new one to see and share it."))
                }
            }
            Section {
                HStack(spacing: 12) {
                    TextField(status == .off ? ConclaveStrings.text("Code") : ConclaveStrings.text("New Code"), text: $text)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($fieldFocused)
                        .onSubmit { save(canSave) }
                        .disabled(model.saving || blocked)
                        .accessibilityIdentifier(model.tag + ".field")
                    Button {
                        text = HostInviteCodePolicy.generate()
                    } label: {
                        Image(systemName: ConclaveSymbols.arrowClockwise)
                    }
                    .buttonStyle(.borderless)
                    .disabled(model.saving || blocked)
                    .accessibilityLabel(ConclaveStrings.text("Generate a Code"))
                    .accessibilityIdentifier(model.tag + ".generate")
                }
                HostInlineFailureLine(people: people, sourceKey: model.fieldID)
            } footer: {
                Text(ConclaveStrings.text("Short codes are easier to read out and type."))
            }
            Section {
                Button {
                    save(canSave)
                } label: {
                    HStack(spacing: 8) {
                        Text(status == .off ? model.turnOn : ConclaveStrings.text("Save New Code"))
                            .fontWeight(.semibold)
                        Spacer(minLength: 0)
                        if model.saving { ProgressView().accessibilityHidden(true) }
                    }
                }
                .disabled(!canSave)
                .accessibilityIdentifier(model.tag + ".save")
                if showsSaved {
                    Label(ConclaveStrings.text("Code saved"), systemImage: ConclaveSymbols.checkmark)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier(model.tag + ".saved")
                }
            }
            if status != .off {
                Section {
                    Button(model.turnOff, role: .destructive) { onClear() }
                        .disabled(model.saving || blocked)
                        .modifier(HostRowConfirmation(people: people, kinds: [model.confirmation]))
                        .accessibilityIdentifier(model.tag + ".remove")
                }
            }
        }
        .formStyle(.grouped)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(model.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {

            if !didSeed {
                didSeed = true
                text = draft()
                seenSavedToken = savedToken
            }
        }
        .onChange(of: text) { _, value in
            setDraft(value)
        }
        .onChange(of: savedToken) { _, token in
            guard token > seenSavedToken else { return }
            seenSavedToken = token
            text = draft()
            showsSaved = true
            savedPulse += 1
            AccessibilityNotification.Announcement(ConclaveStrings.text("Code saved")).post()
        }
        .task(id: savedPulse) {
            guard savedPulse > 0 else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { showsSaved = false }
        }
        .task(id: copies) {
            guard copies > 0 else { return }
            try? await Task.sleep(for: .milliseconds(Int(MeetingInfoPolicy.copiedMillis)))
            if !Task.isCancelled { showsCopied = false }
        }
        .accessibilityIdentifier(model.pageTag)
    }

    private func save(_ allowed: Bool) {
        fieldFocused = false
        guard allowed else { return }
        onSave(text)
    }

    private func copy(_ code: String) {
        UIPasteboard.general.string = code
        copies += 1
        withAnimation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion)) { showsCopied = true }
    }
}

private struct HostCodeIntro: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct AccessListPage: View {
    let people: PeoplePresenter
    @State private var keyDraft = ""
    @State private var didSeed = false

    var body: some View {
        let host = people.host
        let snapshot = host.snapshot
        let access = snapshot.access
        let blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
        let valid = HostControlsPolicy.normalizedAccessKey(keyDraft) != nil
        List {
            Section {
                TextField(ConclaveStrings.text("User Key or Email"), text: $keyDraft)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { if valid { host.allow(keyDraft) } }
                    .disabled(blocked)
                    .accessibilityIdentifier("host.access.field")
                if HostControlsPolicy.showsInvalidAccessKey(keyDraft) {
                    Text(ConclaveStrings.text("Enter a valid user key or email."))
                        .font(.footnote)
                        .foregroundStyle(Color(uiColor: .systemRed))
                        .accessibilityIdentifier("host.access.invalid")
                }
                HStack(spacing: 12) {
                    Button(ConclaveStrings.text("Allow")) { host.allow(keyDraft) }
                        .buttonStyle(.bordered)
                        .tint(.primary)
                        .disabled(!valid || blocked)
                        .accessibilityIdentifier("host.access.allow")
                    Button(ConclaveStrings.text("Block\u{2026}")) { host.requestBlock(keyDraft) }
                        .buttonStyle(.bordered)
                        .tint(Color(uiColor: .systemRed))
                        .disabled(!valid || blocked)
                        .modifier(HostRowConfirmation(people: people, kinds: [PeopleConfirmationKind.block]))
                        .accessibilityIdentifier("host.access.block")
                }
                HostInlineFailureLine(people: people, sourceKey: HostFieldID.accessKey)
            } footer: {
                Text(ConclaveStrings.text("Allowed people skip the waiting room, even when the meeting is locked. Blocked people can\u{2019}t join and are removed if they\u{2019}re here."))
            }
            Section {
                if access.allowed.isEmpty {
                    Text(ConclaveStrings.text("No one is on the allow list."))
                        .foregroundStyle(.secondary)
                }
                ForEach(access.allowed, id: \.self) { key in
                    HStack(spacing: 8) {
                        LabeledContent {
                            if access.lockedAllowed.contains(key) {
                                Text(ConclaveStrings.text("Also while locked"))
                            }
                        } label: {
                            Text(key).textSelection(.enabled)
                        }
                        if snapshot.pendingAccessKeys.contains(key) { ProgressView().accessibilityHidden(true) }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(ConclaveStrings.text("Revoke"), role: .destructive) { host.revoke(key) }
                    }
                    .contextMenu {
                        Button(ConclaveStrings.text("Revoke"), role: .destructive) { host.revoke(key) }
                    }
                    .accessibilityAction(named: Text(ConclaveStrings.text("Revoke"))) { host.revoke(key) }
                }
            } header: {
                ConclaveSectionHeader(ConclaveStrings.text("Allowed"), count: access.allowedCount,
                                      identifier: "host.access.allowed.header")
                    .textCase(nil)
            }
            Section {
                if access.blocked.isEmpty {
                    Text(ConclaveStrings.text("No one is blocked."))
                        .foregroundStyle(.secondary)
                }
                ForEach(access.blocked, id: \.self) { key in
                    HStack(spacing: 8) {
                        Text(key).textSelection(.enabled)
                        Spacer(minLength: 0)
                        if snapshot.pendingAccessKeys.contains(key) { ProgressView().accessibilityHidden(true) }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(ConclaveStrings.text("Unblock")) { host.unblock(key) }
                            .tint(Color(uiColor: .systemGray))
                    }
                    .contextMenu {
                        Button(ConclaveStrings.text("Unblock")) { host.unblock(key) }
                    }
                    .accessibilityAction(named: Text(ConclaveStrings.text("Unblock"))) { host.unblock(key) }
                }
            } header: {
                ConclaveSectionHeader(ConclaveStrings.text("Blocked"), count: access.blockedCount,
                                      identifier: "host.access.blocked.header")
                    .textCase(nil)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(ConclaveStrings.text("Access List"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if access.isRefreshing {
                    ProgressView()
                } else {
                    Button {
                        host.refreshAccessLists()
                    } label: {
                        Label(ConclaveStrings.text("Refresh Access List"), systemImage: HostAccessSymbols.refresh)
                    }
                    .accessibilityIdentifier("host.access.refresh")
                }
            }
        }
        .onAppear {
            if !didSeed {
                didSeed = true
                keyDraft = host.drafts.accessKey
            }
        }
        .onChange(of: keyDraft) { _, value in
            host.drafts.accessKey = value
        }
        .onChange(of: snapshot.pendingAccessKeys) { _, _ in

            if host.drafts.accessKey != keyDraft { keyDraft = host.drafts.accessKey }
        }
        .task {
            host.refreshAccessLists()
        }
        .accessibilityIdentifier("host.page.accessList")
    }
}

enum HostAccessSymbols {
    static let refresh = "arrow.clockwise"
}
#endif
