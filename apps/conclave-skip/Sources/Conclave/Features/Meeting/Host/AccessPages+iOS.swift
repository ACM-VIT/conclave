#if os(iOS) && !SKIP
import SwiftUI

struct InviteCodePage: View {
    let people: PeoplePresenter
    @State private var draft = ""
    @State private var didSeed = false
    @State private var showsSaved = false
    @State private var savedToken = 0
    @State private var copies = 0
    @State private var showsCopied = false
    @FocusState private var fieldFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let host = people.host
        let snapshot = host.snapshot
        let saving = snapshot.inviteCodePhase == HostFieldPhase.sending
        let blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
        let known = host.knownInviteCode
        let status = HostInviteCodePolicy.status(requiresCode: snapshot.access.requiresCode, knownCode: known)
        let canSave = HostControlsPolicy.canSaveInviteCode(draft, isPending: saving, isBlocked: blocked)
            && !HostInviteCodePolicy.isUnchanged(draft, knownCode: known)
        Form {
            Section {
                switch status {
                case .off:
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ConclaveStrings.text("Ask for a Code to Join"))
                            .font(.headline)
                        Text(ConclaveStrings.text("Everyone who joins needs this code, even with the meeting link."))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                case .onKnown:
                    VStack(alignment: .leading, spacing: 6) {
                        Text(ConclaveStrings.text("Current Code"))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text(known)
                            .font(.system(.title, design: .monospaced).weight(.semibold))
                            .kerning(2)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("host.inviteCode.current")
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                    Button {
                        copy(known)
                    } label: {
                        Label(showsCopied ? ConclaveStrings.text("Copied") : ConclaveStrings.text("Copy Code"),
                              systemImage: showsCopied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc)
                            .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                    }
                    .conclaveGestureFeedback(.linkCopied, trigger: copies)
                    .accessibilityIdentifier("host.inviteCode.copy")
                    ShareLink(item: shareText(known)) {
                        Label(ConclaveStrings.text("Share Code"), systemImage: ConclaveSymbols.squareAndArrowUp)
                    }
                    .accessibilityIdentifier("host.inviteCode.share")
                case .onUnknown:
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ConclaveStrings.text("Invite Code Is On"))
                            .font(.headline)
                        Text(ConclaveStrings.text("The current code was set earlier or by another host. Set a new one to see and share it."))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }
            }
            Section {
                HStack(spacing: 12) {
                    TextField(status == .off ? ConclaveStrings.text("Code") : ConclaveStrings.text("New Code"), text: $draft)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($fieldFocused)
                        .onSubmit { save(canSave) }
                        .disabled(saving || blocked)
                        .accessibilityIdentifier("host.inviteCode.field")
                    Button {
                        draft = HostInviteCodePolicy.generate()
                    } label: {
                        Image(systemName: ConclaveSymbols.arrowClockwise)
                    }
                    .buttonStyle(.borderless)
                    .disabled(saving || blocked)
                    .accessibilityLabel(ConclaveStrings.text("Generate a Code"))
                    .accessibilityIdentifier("host.inviteCode.generate")
                }
                HostInlineFailureLine(people: people, sourceKey: HostFieldID.inviteCode)
            } footer: {
                Text(ConclaveStrings.text("Short codes are easier to read out and type."))
            }
            Section {
                Button {
                    save(canSave)
                } label: {
                    HStack(spacing: 8) {
                        Text(status == .off ? ConclaveStrings.text("Turn On Invite Code") : ConclaveStrings.text("Save New Code"))
                            .fontWeight(.semibold)
                        Spacer(minLength: 0)
                        if saving { ProgressView().accessibilityHidden(true) }
                    }
                }
                .disabled(!canSave)
                .accessibilityIdentifier("host.inviteCode.save")
                if showsSaved {
                    Label(ConclaveStrings.text("Code saved"), systemImage: ConclaveSymbols.checkmark)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("host.inviteCode.saved")
                }
            }
            if status != .off {
                Section {
                    Button(ConclaveStrings.text("Turn Off Invite Code\u{2026}"), role: .destructive) {
                        host.requestClearMeetingInviteCode()
                    }
                    .disabled(saving || blocked)
                    .modifier(HostRowConfirmation(people: people, kinds: [PeopleConfirmationKind.clearInviteCode]))
                    .accessibilityIdentifier("host.inviteCode.remove")
                }
            }
        }
        .formStyle(.grouped)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(ConclaveStrings.text("Invite Code"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {

            if !didSeed {
                didSeed = true
                draft = host.drafts.meetingCode
            }
        }
        .onChange(of: draft) { _, value in
            host.drafts.meetingCode = value
        }
        .onChange(of: snapshot.inviteCodeSavedSerial) { _, _ in

            draft = host.drafts.meetingCode
            showsSaved = true
            savedToken += 1
            AccessibilityNotification.Announcement(ConclaveStrings.text("Code saved")).post()
        }
        .task(id: savedToken) {
            guard savedToken > 0 else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { showsSaved = false }
        }
        .task(id: copies) {
            guard copies > 0 else { return }
            try? await Task.sleep(for: .milliseconds(Int(MeetingInfoPolicy.copiedMillis)))
            if !Task.isCancelled { showsCopied = false }
        }
        .accessibilityIdentifier("host.page.inviteCode")
    }

    private func save(_ allowed: Bool) {
        guard allowed else {
            fieldFocused = false
            return
        }
        fieldFocused = false
        people.host.setMeetingInviteCode(draft)
    }

    private func copy(_ code: String) {
        UIPasteboard.general.string = code
        copies += 1
        withAnimation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion)) { showsCopied = true }
    }

    private func shareText(_ code: String) -> String {
        let link = people.stage.layout.meetingLink
        if link.isEmpty { return ConclaveStrings.format("Conclave invite code: %@", code) }
        return ConclaveStrings.format("Join my Conclave meeting: %@\nInvite code: %@", link, code)
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
