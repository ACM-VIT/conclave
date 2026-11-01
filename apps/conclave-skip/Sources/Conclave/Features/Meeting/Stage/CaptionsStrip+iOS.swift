#if os(iOS) && !SKIP
import MediaAccessibility
import SwiftUI
import UIKit

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

        text.foregroundColor = line.isFinal ? ink : (appearance.foreground ?? HostingTheme.inCallTextSecondary)
        return name + text
    }

    static func accessibilityValue(_ line: CaptionLine) -> String {
        if line.isPlaceholder { return ConclaveStrings.text("Captions will appear here.") }
        if line.speakerName.isEmpty { return line.text }
        return line.speakerName + ", " + line.text
    }
}

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

    func scaledFont(_ style: Font.TextStyle, weight: Font.Weight) -> Font {
        if relativeSize == 1 { return Font.system(style, weight: weight) }
        let base = UIFont.preferredFont(forTextStyle: style == .subheadline ? .subheadline : .body)
        return Font.system(size: base.pointSize * relativeSize, weight: weight)
    }
}
#endif
