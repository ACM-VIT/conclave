#if os(iOS) && !SKIP
import MediaAccessibility
import SwiftUI
import UIKit

// S20 10 c (SL11; TRN-1, S60 5): the captions strip between the banner and the toast lanes. It mounts only while
// captions are on and live notes are live for a non-attendee (`stage.captionsActive`), and only the strip reads the
// `CaptionLineFeed` leaf, so a caption delta redraws the strip and nothing else (S20 10 k). The speaker name in
// `.subheadline.weight(.semibold)`, then the line in `.body`: partial text in the secondary in-call ink, final text in
// the in-call text color; at most 2 lines (3 at accessibility sizes, the oldest words truncated); flat in-call surface
// with a 1 pt border, radius 12. The quiet first state reads "Captions will appear here." and the line hides after 6 s
// of silence (the feed decides). The strip is one Button "Open Transcript" with the latest line as its value; it is
// not a live region (captions are not announced). A custom Subtitles and Captioning style from Settings applies its
// colors and relative size (MediaAccessibility, domain user) and refreshes when the setting changes.

/// Mounts the strip while captions are active; reads one cold Bool.
struct CaptionsStripSlot: View {
    let stage: StagePresenter

    var body: some View {
        if stage.captionsActive {
            CaptionsStrip(feed: stage.captions, onOpen: { stage.openTranscript(destination: PanelDestination.transcriptLive) })
        }
    }
}

struct CaptionsStrip: View {
    let feed: CaptionLineFeed
    let onOpen: () -> Void
    @State private var appearance = CaptionAppearance.current()
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let line = feed.line
        if line.isVisible {
            Button(action: onOpen) {
                CaptionsStripText(line: line, appearance: appearance, lineLimit: typeSize.isAccessibilitySize ? 3 : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(appearance.background ?? HostingTheme.token(DesignTokens.iosInCallSurface),
                                in: RoundedRectangle(cornerRadius: CaptionsStripMetrics.radius))
                    .overlay {
                        RoundedRectangle(cornerRadius: CaptionsStripMetrics.radius).strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
                    }
                    .contentShape(RoundedRectangle(cornerRadius: CaptionsStripMetrics.radius))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ConclaveStrings.text("Open Transcript"))
            .accessibilityValue(CaptionsStripText.accessibilityValue(line))
            .accessibilityIdentifier("stage.captions")
            .onReceive(NotificationCenter.default.publisher(for: CaptionAppearance.changedNotification)) { _ in
                appearance = CaptionAppearance.current()
            }
        }
    }
}

enum CaptionsStripMetrics {
    static let radius = CGFloat(DesignTokens.radiusMedium)
}

/// The strip's text: speaker name then the line, or the quiet placeholder. Lines replace without animation (S20 10 h).
struct CaptionsStripText: View {
    let line: CaptionLine
    let appearance: CaptionAppearance
    let lineLimit: Int

    var body: some View {
        if line.isPlaceholder {
            Text(ConclaveStrings.text("Captions will appear here."))
                .font(.body)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .lineLimit(lineLimit)
        } else {
            // The oldest words leave first: the full line lays out at its natural height and the strip shows its last
            // `lineLimit` lines, clipped at the top (S20 10 c "oldest truncated"); the full text is the button's value.
            Text(attributed)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, maxHeight: maxHeight, alignment: .bottomLeading)
                .clipped()
        }
    }

    private var maxHeight: CGFloat {
        let lineHeight = UIFont.preferredFont(forTextStyle: .body).lineHeight * appearance.relativeSize
        return (lineHeight * CGFloat(lineLimit)).rounded(.up)
    }

    private var attributed: AttributedString {
        let ink = appearance.foreground ?? HostingTheme.token(DesignTokens.iosInCallText)
        var name = AttributedString(line.speakerName.isEmpty ? "" : line.speakerName + "  ")
        name.font = appearance.scaledFont(.subheadline, weight: .semibold)
        name.foregroundColor = ink
        var text = AttributedString(line.text)
        text.font = appearance.scaledFont(.body, weight: .regular)
        // Partial text is secondary (S60 R6-12); a custom caption color applies to both.
        text.foregroundColor = line.isFinal ? ink : (appearance.foreground ?? HostingTheme.inCallTextSecondary)
        return name + text
    }

    static func accessibilityValue(_ line: CaptionLine) -> String {
        if line.isPlaceholder { return ConclaveStrings.text("Captions will appear here.") }
        if line.speakerName.isEmpty { return line.text }
        return line.speakerName + ", " + line.text
    }
}

/// The person's Subtitles and Captioning style (MediaAccessibility, domain user). Each value applies only when its
/// behavior is `useValue`; otherwise the in-call tokens stand. User-chosen caption colors are a system preference, not
/// palette.
struct CaptionAppearance: Equatable {
    let foreground: Color?
    let background: Color?
    let relativeSize: CGFloat

    static let standard = CaptionAppearance(foreground: nil, background: nil, relativeSize: 1)
    static let changedNotification = Notification.Name(kMACaptionAppearanceSettingsChangedNotification as String)

    static func current() -> CaptionAppearance {
        var foregroundBehavior = MACaptionAppearanceBehavior.useContentIfAvailable
        let foregroundColor = MACaptionAppearanceCopyForegroundColor(.user, &foregroundBehavior).takeRetainedValue()
        var backgroundBehavior = MACaptionAppearanceBehavior.useContentIfAvailable
        let backgroundColor = MACaptionAppearanceCopyBackgroundColor(.user, &backgroundBehavior).takeRetainedValue()
        var opacityBehavior = MACaptionAppearanceBehavior.useContentIfAvailable
        let opacity = MACaptionAppearanceGetBackgroundOpacity(.user, &opacityBehavior)
        var sizeBehavior = MACaptionAppearanceBehavior.useContentIfAvailable
        let size = MACaptionAppearanceGetRelativeCharacterSize(.user, &sizeBehavior)
        let foreground: Color? = foregroundBehavior == .useValue ? Color(cgColor: foregroundColor) : nil
        var background: Color? = nil
        if backgroundBehavior == .useValue {
            let alpha = opacityBehavior == .useValue ? Double(opacity) : 1.0
            background = Color(cgColor: backgroundColor).opacity(alpha)
        }
        let relative: CGFloat = sizeBehavior == .useValue && size > 0 ? size : 1
        return CaptionAppearance(foreground: foreground, background: background, relativeSize: relative)
    }

    /// The text style's font. Only a custom caption size (a system preference the person chose) scales the point size
    /// the style resolves to at the current Dynamic Type size; every other case keeps the text style.
    func scaledFont(_ style: Font.TextStyle, weight: Font.Weight) -> Font {
        if relativeSize == 1 { return Font.system(style, weight: weight) }
        let base = UIFont.preferredFont(forTextStyle: style == .subheadline ? .subheadline : .body)
        return Font.system(size: base.pointSize * relativeSize, weight: weight)
    }
}
#endif
