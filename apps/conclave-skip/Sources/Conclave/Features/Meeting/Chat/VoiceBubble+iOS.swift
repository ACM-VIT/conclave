#if os(iOS) && !SKIP
import SwiftUI

// S40 3 c and 6 c (CHT-6): voice messages on iOS. `ChatVoiceControl` is the header inside a voice row's bubble and
// the only view that reads `chat.playback` (one small view redraws when playback moves, R13: a static glyph, no
// equalizer); `ChatVoiceAccessibilityActions` adds "Play Voice Message" or "Stop Speaking" to the row's summary
// element; `ChatVoiceModeRow` is the composer's voice row and `ChatVoiceAttachItem` the attach menu item. Replay is
// local ("Only you will hear it"). No haptic for play, stop or voice mode (D6, Q11). The rows and the composer mount
// these (HD request B5-T7 R2 to B5-T6, who owns the chat row and composer files this batch).

/// Canonical playback, stop and voice-message artwork; `speaking` remains the S40 3 e waveform.
enum VoiceSymbols {
    static let play = ConclaveSymbols.playFill
    static let stop = ConclaveSymbols.stopFill
    static let speaking = ConclaveSymbols.waveform
    static let voiceMessage = ConclaveSymbols.speakerWave2

    /// Speaking status has distinct artwork from the playback action.
    static var showsSpeakingMark: Bool {
        play != speaking
    }
}

/// S40 3 g and 6 g voice copy (Apple title case for controls, sentence case for the line, values and placeholders).
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

    /// "Read aloud to everyone · System voice" (the hint and the voice kind joined with " · ", web parity).
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

    /// The composer's Send label: "Send Voice Message" in voice mode, else the F00 "Send".
    static func sendTitle(isVoiceMode: Bool) -> String {
        isVoiceMode ? ConclaveStrings.text("Send Voice Message") : ConclaveStrings.text("Send")
    }

    /// The row summary's value part and the composer field's mode value (3 i, 6 i).
    static var accessibilityValue: String {
        ConclaveStrings.text("Voice message")
    }

    /// Why the attach item is unavailable ("" when it is available): private mode first (D24), then the host switch.
    static func unavailableReason(_ composer: ChatComposerSnapshot) -> String {
        if composer.privateTo != nil { return ConclaveStrings.text("Private messages are text only.") }
        if !composer.voiceEnabled { return ConclaveStrings.text("Voice messages are turned off by the host.") }
        return ""
    }
}

/// S40 3 c voice header: play or stop (a 28 pt glyph in a 44 pt target), then "Voice Message" or "Speaking" and the
/// static speaking mark; the bubble's text (the full message, every line) follows it. With voice messages off by the
/// host the play control hides and the label stays (3 f). The label and mark are hidden from accessibility: the row's
/// summary speaks "Voice message", and the button is its own element.
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

/// 3 i: the voice row's summary action, "Play Voice Message" or "Stop Speaking", after the menu actions. Only voice
/// rows mount it, so only they read `chat.playback`.
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

/// S40 6 c voice mode row above the field: "Voice Message" over "Read aloud to everyone · System voice", with Exit in
/// voice mode. A typed `/tts ` draft shows the same row without Exit (web CHT-18; deleting the prefix leaves it).
/// Hidden in private mode (D24) and while the host turned voice messages off.
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

/// S40 6 c attach menu item "Voice Message": unavailable items stay in the menu, disabled, with the reason as a second
/// line (IOS 9.2, R10 pattern).
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
