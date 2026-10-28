#if os(iOS) && !SKIP
import SwiftUI

enum VoiceSymbols {
    static let play = ConclaveSymbols.playFill
    static let stop = ConclaveSymbols.stopFill
    static let speaking = ConclaveSymbols.waveform
    static let voiceMessage = ConclaveSymbols.speakerWave2

    static var showsSpeakingMark: Bool {
        play != speaking
    }
}

enum VoiceCopy {
    static func header(isPlaying: Bool) -> String {
        isPlaying ? ConclaveStrings.text("Speaking") : ConclaveStrings.text("Voice Message")
    }

    static func playTitle(isPlaying: Bool) -> String {
        isPlaying ? ConclaveStrings.text("Stop Speaking") : ConclaveStrings.text("Play Voice Message")
    }

    static var playHint: String {
        ConclaveStrings.text("Only you will hear it")
    }

    static var modeTitle: String {
        ConclaveStrings.text("Voice Message")
    }

    static func modeLine(voiceKind: String) -> String {
        let kind = voiceKind == VoiceKind.personal.rawValue ? ConclaveStrings.text("Your voice") : ConclaveStrings.text("System voice")
        return ConclaveStrings.format("Voice Mode Line %@ %@", ConclaveStrings.text("Read aloud to everyone"), kind)
    }

    static var exitTitle: String {
        ConclaveStrings.text("Exit Voice Message")
    }

    static var placeholder: String {
        ConclaveStrings.text("Message to read aloud")
    }

    static func sendTitle(isVoiceMode: Bool) -> String {
        isVoiceMode ? ConclaveStrings.text("Send Voice Message") : ConclaveStrings.text("Send")
    }

    static var accessibilityValue: String {
        ConclaveStrings.text("Voice message")
    }

    static func unavailableReason(_ composer: ChatComposerSnapshot) -> String {
        if composer.privateTo != nil { return ConclaveStrings.text("Private messages are text only.") }
        if !composer.voiceEnabled { return ConclaveStrings.text("Voice messages are turned off by the host.") }
        return ""
    }
}

struct ChatVoiceControl: View {
    let row: ChatRowModel
    let chat: ChatPresenter
    @ScaledMetric(relativeTo: .body) private var glyphSize: CGFloat = 28

    var body: some View {
        let isPlaying = chat.playback.activeVoiceRowId == row.id
        HStack(spacing: CGFloat(DesignTokens.space4)) {
            if row.canPlayVoice {
                Button {
                    if isPlaying {
                        chat.stopVoice()
                    } else {
                        chat.playVoice(rowId: row.id)
                    }
                } label: {
                    Image(systemName: isPlaying ? VoiceSymbols.stop : VoiceSymbols.play)
                        .font(.body.weight(.semibold))
                        .frame(width: min(glyphSize, 44), height: min(glyphSize, 44))
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                        .accessibilityHidden(true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(VoiceCopy.playTitle(isPlaying: isPlaying))
                .accessibilityHint(isPlaying ? "" : VoiceCopy.playHint)
                .accessibilityIdentifier("chat.row." + row.id + ".voice")
            }
            Text(VoiceCopy.header(isPlaying: isPlaying))
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .accessibilityHidden(true)
            if VoiceSymbols.showsSpeakingMark {
                Image(systemName: VoiceSymbols.speaking)
                    .font(.caption)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

struct ChatVoiceAccessibilityActions: View {
    let row: ChatRowModel
    let chat: ChatPresenter

    var body: some View {
        if row.canPlayVoice {
            if chat.playback.activeVoiceRowId == row.id {
                Button(VoiceCopy.playTitle(isPlaying: true)) { chat.stopVoice() }
            } else {
                Button(VoiceCopy.playTitle(isPlaying: false)) { chat.playVoice(rowId: row.id) }
            }
        }
    }
}

struct ChatVoiceModeRow: View {
    let chat: ChatPresenter
    let composer: ChatComposerSnapshot
    let draft: String

    var body: some View {
        if VoiceMessagePolicy.showsComposerRow(isVoiceMode: composer.isVoiceMode, draft: draft,
                                               isPrivateMode: composer.privateTo != nil, voiceEnabled: composer.voiceEnabled) {
            HStack(alignment: .center, spacing: CGFloat(DesignTokens.space8)) {
                VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space2)) {
                    Label(VoiceCopy.modeTitle, systemImage: VoiceSymbols.voiceMessage)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(VoiceCopy.modeLine(voiceKind: composer.voiceKind))
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                if composer.isVoiceMode {
                    ConclaveComposerDismissButton(title: VoiceCopy.exitTitle, identifier: "chat.composer.voice.exit") {
                        chat.setVoiceMode(false)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat.composer.voice")
        }
    }
}

struct ChatVoiceAttachItem: View {
    let chat: ChatPresenter
    let composer: ChatComposerSnapshot

    var body: some View {
        let reason = VoiceCopy.unavailableReason(composer)
        Button {
            chat.setVoiceMode(true)
        } label: {
            Label {
                Text(VoiceCopy.modeTitle)
                if !reason.isEmpty {
                    Text(reason)
                }
            } icon: {
                Image(systemName: VoiceSymbols.voiceMessage)
            }
        }
        .disabled(!reason.isEmpty)
        .accessibilityIdentifier("chat.composer.attach.voice")
    }
}
#endif
