#if os(iOS) && !SKIP
import SwiftUI

enum ActivityChromeSymbols {
    static func glyph(_ glyph: ActivityGlyph) -> String {
        switch glyph {
        case .game: return ConclaveSymbols.gamecontrollerFill
        case .whiteboard: return ConclaveSymbols.pencilAndScribble
        case .wheel: return "chart.pie"
        case .watch: return ConclaveSymbols.playRectangle
        case .app: return ConclaveSymbols.squareGrid2x2
        case .browser: return ConclaveSymbols.globe
        }
    }

    static func tool(_ tool: AppWhiteboardTool) -> String {
        switch tool {
        case .select: return "cursorarrow"
        case .pan: return "hand.draw"
        case .pen: return "pencil.tip"
        case .highlighter: return "highlighter"
        case .eraser: return "eraser"
        case .rect: return "rectangle"
        case .ellipse: return "circle"
        case .line: return "line.diagonal"
        case .arrow: return "arrow.up.right"
        case .text: return "textformat"
        case .sticky: return "note.text"
        case .laser: return "cursorarrow.rays"
        }
    }

    static func command(_ kind: AppHostCommandKind) -> String {
        switch kind {
        case .undo: return ConclaveSymbols.arrowUturnBackward
        case .redo: return "arrow.uturn.forward"
        case .zoomToFit: return ConclaveSymbols.arrowUpLeftAndArrowDownRight
        case .export: return ConclaveSymbols.squareAndArrowUp
        case .addPage: return ConclaveSymbols.plus
        case .renamePage: return ConclaveSymbols.pencil
        case .deletePage: return ConclaveSymbols.trash
        case .setPage: return ConclaveSymbols.docOnDoc
        case .setStrokeWidth: return "lineweight"
        case .setColor, .setFill, .setTool: return ConclaveSymbols.ellipsis
        }
    }
}

struct ActivityLoadingBlock: View {
    let title: String
    let identifier: String

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.regular)
                .tint(HostingTheme.inCallTextSecondary)
            Text(title)
                .font(.subheadline)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HostingTheme.token(DesignTokens.iosInCallTile))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}

struct ActivityFailureBlock: View {
    let title: String
    let detail: String?
    let showsRetry: Bool
    let identifier: String
    let retryIdentifier: String
    let showVideoIdentifier: String
    let onRetry: () -> Void
    let onShowVideo: () -> Void

    var body: some View {
        ViewThatFits(in: .vertical) {
            content
            ScrollView { content }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HostingTheme.token(DesignTokens.iosInCallTile))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private var content: some View {
        VStack(spacing: 16) {
            VStack(spacing: 8) {
                Image(systemName: ConclaveSymbols.exclamationmarkTriangleFill)
                    .font(.title2)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.headline)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let detail {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons }
                VStack(spacing: 8) { buttons }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var buttons: some View {
        if showsRetry {
            Button(action: onRetry) {
                Text(ConclaveStrings.text("Try Again"))
                    .font(.body.weight(.semibold))
                    .foregroundStyle(HostingTheme.inCallOnCoral)
                    .frame(minHeight: 44)
                    .padding(.horizontal, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(HostingTheme.coralFill)
            .accessibilityIdentifier(retryIdentifier)
        }
        Button(action: onShowVideo) {
            Text(ConclaveStrings.text("Show Video"))
                .font(.body.weight(.semibold))
                .frame(minHeight: 44)
                .padding(.horizontal, 4)
        }
        .buttonStyle(.bordered)
        .tint(HostingTheme.token(DesignTokens.iosInCallText))
        .accessibilityIdentifier(showVideoIdentifier)
    }
}

struct ActivityStatusChip: View {
    let title: String
    let showsLock: Bool
    let identifier: String

    var body: some View {
        ConclaveStageChip(title: title, systemImage: showsLock ? ConclaveSymbols.lockFill : nil, identifier: identifier)
            .padding(10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .allowsHitTesting(false)
    }
}

struct ActivityToolGlyph: View {
    let systemImage: String
    let isSelected: Bool
    let isPending: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        ZStack {
            Image(systemName: systemImage)
                .font(.body.weight(.medium))
                .opacity(isPending ? 0.35 : 1)
            if isPending {
                ProgressView()
                    .controlSize(.small)
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
            }
        }
        .foregroundStyle(isSelected ? HostingTheme.inCallCoralText : HostingTheme.token(DesignTokens.iosInCallText))
        .frame(width: ActivityToolMetrics.side, height: ActivityToolMetrics.side)
        .background(isSelected ? HostingTheme.token(DesignTokens.iosInCallSurfaceHigh) : Color.clear, in: shape)
        .overlay { shape.strokeBorder(isSelected ? HostingTheme.inCallBorderStrong : Color.clear, lineWidth: 1) }
        .contentShape(shape)
    }
}

struct ActivityToolButton: View {
    let title: String
    let systemImage: String
    let isSelected: Bool
    let isPending: Bool
    let isEnabled: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ActivityToolGlyph(systemImage: systemImage, isSelected: isSelected, isPending: isPending)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : HostingTheme.disabledOpacity)
        .help(title)
        .accessibilityLabel(title)
        .accessibilityValue(isPending ? ConclaveStrings.text("In Progress") : "")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityShowsLargeContentViewer { Label(title, systemImage: systemImage) }
        .accessibilityIdentifier(identifier)
    }
}

struct ActivityToolDivider: View {
    var body: some View {
        Rectangle()
            .fill(HostingTheme.inCallBorder)
            .frame(width: 1, height: 24)
            .padding(.horizontal, 4)
            .accessibilityHidden(true)
    }
}

enum ActivityToolMetrics {
    static let side: CGFloat = 44
}

enum ActivityHeaderMetrics {
    static let face: CGFloat = 36
    static let target: CGFloat = 44
}

struct ActivityHeaderCircle<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .frame(width: ActivityHeaderMetrics.face, height: ActivityHeaderMetrics.face)
            .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: Circle())
            .frame(minWidth: ActivityHeaderMetrics.target, minHeight: ActivityHeaderMetrics.target)
            .contentShape(Rectangle())
    }
}

struct ActivityHeaderCapsuleLabel: View {
    let title: String
    var isPending = false
    var isDestructive = false

    var body: some View {
        let ink = isDestructive ? HostingTheme.inCallLeave : HostingTheme.token(DesignTokens.iosInCallText)
        Group {
            if isPending {
                ProgressView()
                    .controlSize(.small)
                    .tint(ink)
            } else {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ink)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: ActivityHeaderMetrics.face)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: Capsule())
        .frame(minHeight: ActivityHeaderMetrics.target)
        .contentShape(Rectangle())
    }
}
#endif
