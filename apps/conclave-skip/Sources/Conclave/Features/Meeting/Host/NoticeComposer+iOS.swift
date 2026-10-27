#if os(iOS) && !SKIP
import SwiftUI

// S50 8 (PPL-4): the notice composer on iOS. The text and the level are view state seeded once from `host.drafts` and
// written back on change, so the counter, the error and the Send state update on every keystroke and the draft
// survives Back (8 c). The preview is the F00 C12 in-call banner drawn statically in a dark scoped region, so the host
// sees the real look. Send is this page's coral action; success clears the field and shows "Notice sent" inline for
// 2 s (no toasts on iOS system-appearance surfaces, F00 C13); a failure shows the PL14 line under Send with Retry.

struct NoticeComposerPage: View {
    let people: PeoplePresenter
    @State private var draft = ""
    @State private var level = HostNoticeLevel.info
    @State private var didSeed = false
    @State private var showsSent = false
    @State private var sentToken = 0
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let host = people.host
        let snapshot = host.snapshot
        let sending = snapshot.noticePhase == HostFieldPhase.sending
        let blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
        let count = draft.count
        Form {
            Section {
                TextField(ConclaveStrings.text("Message Everyone"), text: $draft, axis: .vertical)
                    .lineLimit(3...8)
                    .disabled(sending)
                    .accessibilityIdentifier("host.notice.field")
            } footer: {
                if HostControlsPolicy.showsNoticeCounter(count) {
                    Text(ConclaveStrings.format("Character Counter %lld %lld", count, HostControlsPolicy.noticeLimit))
                        .monospacedDigit()
                        .foregroundStyle(HostControlsPolicy.isNoticeTooLong(count) ? Color(uiColor: .systemRed) : Color.secondary)
                        .accessibilityLabel(ConclaveStrings.format("%lld of %lld Characters", count, HostControlsPolicy.noticeLimit))
                        .accessibilityIdentifier("host.notice.counter")
                }
            }
            Section {
                if dynamicTypeSize.isAccessibilitySize {
                    // F00 C21 c: at accessibility sizes the segments fall back to selectable rows.
                    Picker(ConclaveStrings.text("Level"), selection: $level) {
                        levelOptions
                    }
                    .pickerStyle(.inline)
                    .disabled(sending)
                } else {
                    Picker(ConclaveStrings.text("Level"), selection: $level) {
                        levelOptions
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .disabled(sending)
                }
            }
            Section {
                ConclaveBanner(kind: NoticeComposerPreview.bannerKind(level),
                               text: NoticeComposerPreview.text(sender: people.localName(), message: draft),
                               surface: .inCall, announces: false, identifier: "host.notice.preview")
                    .environment(\.colorScheme, .dark)
                    .frame(maxWidth: 560, alignment: .leading)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(NoticeComposerPreview.accessibilityLabel(level: level, sender: people.localName(), message: draft))
            } header: {
                Text(ConclaveStrings.text("Preview"))
            }
            Section {
                Button {
                    host.sendNotice(draft, level: level)
                } label: {
                    HStack(spacing: 8) {
                        Text(sending ? ConclaveStrings.text("Sending\u{2026}") : ConclaveStrings.text("Send Notice"))
                        Spacer(minLength: 0)
                        if sending { ProgressView().accessibilityHidden(true) }
                    }
                }
                .disabled(!HostControlsPolicy.canSendNotice(draft, isPending: sending, isBlocked: blocked))
                .accessibilityIdentifier("host.notice.send")
                if showsSent {
                    Label(ConclaveStrings.text("Notice sent"), systemImage: ConclaveSymbols.checkmark)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("host.notice.sent")
                }
                HostInlineFailureLine(people: people, sourceKey: HostFieldID.notice)
            }
        }
        .formStyle(.grouped)
        .navigationTitle(ConclaveStrings.text("Send a Notice"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if !didSeed {
                didSeed = true
                draft = host.drafts.noticeText
                level = HostControlsPolicy.normalizedLevel(host.drafts.noticeLevel)
            }
        }
        .onChange(of: draft) { _, value in
            host.drafts.noticeText = value
        }
        .onChange(of: level) { _, value in
            host.drafts.noticeLevel = value
        }
        .onChange(of: snapshot.noticeSentSerial) { _, _ in
            // The presenter cleared the draft on the acknowledgement (8 c).
            draft = host.drafts.noticeText
            showsSent = true
            sentToken += 1
        }
        .task(id: sentToken) {
            guard sentToken > 0 else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { showsSent = false }
        }
        .accessibilityIdentifier("host.page.notice")
    }

    @ViewBuilder
    private var levelOptions: some View {
        Text(ConclaveStrings.text("Info")).tag(HostNoticeLevel.info)
        Text(ConclaveStrings.text("Warning")).tag(HostNoticeLevel.warning)
        Text(ConclaveStrings.text("Urgent")).tag(HostNoticeLevel.error)
    }
}

/// The preview banner's kind and text (S50 8 b, F00 C12; the S20 host notice wording "From %@:").
enum NoticeComposerPreview {
    static func bannerKind(_ level: String) -> ConclaveBannerKind {
        switch level {
        case HostNoticeLevel.warning: return .warning
        case HostNoticeLevel.error: return .error
        default: return .info
        }
    }

    static func text(sender: String, message: String) -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = trimmed.isEmpty ? ConclaveStrings.text("Message Everyone") : trimmed
        if sender.isEmpty { return shown }
        return ConclaveStrings.format("From %@:", sender) + " " + shown
    }

    static func levelName(_ level: String) -> String {
        switch level {
        case HostNoticeLevel.warning: return ConclaveStrings.text("Warning")
        case HostNoticeLevel.error: return ConclaveStrings.text("Urgent")
        default: return ConclaveStrings.text("Info")
        }
    }

    /// One element, "Preview: Info notice, From Ishaan: ..." (S50 8 i); not a live region.
    static func accessibilityLabel(level: String, sender: String, message: String) -> String {
        ConclaveStrings.format("Preview: %@ notice, %@", levelName(level), text(sender: sender, message: message))
    }
}
#endif
