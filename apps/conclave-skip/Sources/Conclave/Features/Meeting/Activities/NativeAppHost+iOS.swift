#if os(iOS) && !SKIP
import Accessibility
import SwiftUI
import UIKit
import WebKit

struct NativeAppHostBody: View {
    let host: AppHostPresenter
    let onShowVideo: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pencilPalette: AppPencilResponse? = nil

    var body: some View {
        let model = host.model
        VStack(spacing: 0) {
            if model.tag != AppHostTag.none && model.phase != AppHostPhase.failed && model.phase != AppHostPhase.versionMismatch {
                AppHostTagRow(tag: model.tag)
            }
            ZStack {
                if model.wantsWebView {
                    AppHostCanvas(host: host, model: model, onPencil: handlePencil)
                        .popover(isPresented: Binding(get: { pencilPalette != nil }, set: { if !$0 { pencilPalette = nil } }),
                                 arrowEdge: .bottom) {
                            AppPencilPalette(host: host, kind: pencilPalette ?? AppPencilResponse.none,
                                             onDone: { pencilPalette = nil })
                                .presentationCompactAdaptation(.popover)
                                .environment(\.colorScheme, .dark)
                        }
                }
                switch model.phase {
                case .opening:
                    AppHostOpening(appId: model.appId)
                case .failed, .versionMismatch:
                    AppHostFailure(host: host, model: model, onShowVideo: onShowVideo)
                case .ready, .readOnly, .closing:
                    if model.appId == "whiteboard" && model.canEdit {
                        AppBoardEmptyHint(host: host)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if model.appId == "whiteboard" && model.canEdit
                && (model.phase == AppHostPhase.ready || model.phase == AppHostPhase.closing) {
                Rectangle()
                    .fill(HostingTheme.inCallBorder)
                    .frame(height: 1)
                    .accessibilityHidden(true)
                WhiteboardToolbar(host: host, onPalette: { pencilPalette = $0 })
            }
            if model.appId == "wheel" && model.canEdit
                && (model.phase == AppHostPhase.ready || model.phase == AppHostPhase.closing) {
                Rectangle()
                    .fill(HostingTheme.inCallBorder)
                    .frame(height: 1)
                    .accessibilityHidden(true)
                WheelCardBar(host: host)
            }
            if host.showsDebugReadouts {
                AppHostReadouts(host: host, registry: ActivityWebViewRegistry.shared)
            }
        }
        .onAppear { host.session?.setReduceMotion(reduceMotion) }
        .onChange(of: reduceMotion) { _, value in host.session?.setReduceMotion(value) }
        .onChange(of: host.model.wantsWebView) { _, wants in

            if !wants && !host.model.appSessionId.isEmpty {
                ActivityWebViewRegistry.shared.release(appSessionId: host.model.appSessionId)
            }
        }
        .modifier(AppExternalLinkConfirmation(registry: ActivityWebViewRegistry.shared))
        .background { AppPageAnnouncer(host: host) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("app.host." + model.phase.rawValue)
    }

    private func handlePencil(_ response: AppPencilResponse) {
        switch response {
        case .colorMenu, .strokeMenu, .toolPalette:
            if host.model.canEdit { pencilPalette = response }
        case .toggleEraser, .previousTool:
            _ = host.pencil(response)
        case .none:
            break
        }
    }
}

struct NativeAppHostMenu: View {
    let host: AppHostPresenter
    @State private var confirmsClose = false

    var body: some View {
        let model = host.model

        if model.appId == "watch" && (model.phase == AppHostPhase.ready || model.phase == AppHostPhase.readOnly) {
            AppWatchQueueButton(host: host)
        }
        if model.canClose || model.canLock {
            let name = AppHostCopy.name(model.appId)
            Menu {
                if model.canLock {
                    Toggle(isOn: Binding(get: { host.model.isLocked }, set: { _ = host.setLocked($0) })) {
                        Text(ConclaveStrings.text("Lock Editing"))
                    }
                    .disabled(model.lockPending)
                }
                if model.canClose {
                    Button(role: .destructive) {
                        confirmsClose = true
                    } label: {
                        Text(ConclaveStrings.format("Close %@…", name))
                    }
                    .disabled(model.closePending)
                }
            } label: {
                Group {
                    if model.closePending || model.lockPending {
                        ProgressView().tint(HostingTheme.token(DesignTokens.iosInCallText))
                    } else {
                        Image(systemName: ConclaveSymbols.ellipsis)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    }
                }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel(ConclaveStrings.format("More %@ Actions", name))
            .accessibilityIdentifier("app.host.menu")
            .confirmationDialog(ConclaveStrings.format("Close %@ for Everyone?", name), isPresented: $confirmsClose,
                                titleVisibility: .visible) {
                Button(ConclaveStrings.text("Close"), role: .destructive) { _ = host.confirmClose() }
                Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
            } message: {
                Text(model.appId == "whiteboard" ? ConclaveStrings.text("The board clears for everyone.")
                     : ConclaveStrings.text("Everyone returns to the meeting."))
            }
        }
    }
}

enum AppHostHeader {
    @MainActor
    static func status(_ host: AppHostPresenter) -> String {
        return AppHostCopy.status(host.model)
    }
}

struct AppHostCanvas: View {
    let host: AppHostPresenter
    let model: AppHostModel
    let onPencil: (AppPencilResponse) -> Void

    var body: some View {
        AppHostWebViewRepresentable(host: host, model: model, onPencil: onPencil)
            .background(HostingTheme.token(DesignTokens.iosInCallSurface))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(AppHostCopy.canvasLabel(model.appId))
            .accessibilityHint(model.canEdit && model.appId == "whiteboard"
                ? ConclaveStrings.text("Drawing works with touch or Apple Pencil. Use the toolbar to change tools.") : "")
            .accessibilityIdentifier("app.canvas")
    }
}

struct AppHostWebViewRepresentable: UIViewRepresentable {
    let host: AppHostPresenter
    let model: AppHostModel
    let onPencil: (AppPencilResponse) -> Void

    func makeCoordinator() -> AppHostPencilCoordinator {
        AppHostPencilCoordinator(onPencil: onPencil)
    }

    func makeUIView(context: Context) -> UIView {
        let container = UIView(frame: .zero)
        container.backgroundColor = .clear
        let pencil = UIPencilInteraction()
        pencil.delegate = context.coordinator
        container.addInteraction(pencil)
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        context.coordinator.onPencil = onPencil
        guard let session = host.session,
              let webView = ActivityWebViewRegistry.shared.webView(for: model, session: session) else {
            for view in container.subviews { view.removeFromSuperview() }
            return
        }
        session.setPencilOnly(UIPencilInteraction.prefersPencilOnlyDrawing)
        if webView.superview !== container {
            webView.removeFromSuperview()
            webView.frame = container.bounds
            webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(webView)
        }
    }

    static func dismantleUIView(_ container: UIView, coordinator: AppHostPencilCoordinator) {

        for view in container.subviews { view.removeFromSuperview() }
    }
}

@MainActor
final class AppHostPencilCoordinator: NSObject, UIPencilInteractionDelegate {
    var onPencil: (AppPencilResponse) -> Void

    init(onPencil: @escaping (AppPencilResponse) -> Void) {
        self.onPencil = onPencil
    }

    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        if #available(iOS 17.5, *) { return }
        onPencil(AppPencilPolicy.response(rawAction: UIPencilInteraction.preferredTapAction.rawValue))
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        onPencil(AppPencilPolicy.response(rawAction: UIPencilInteraction.preferredTapAction.rawValue))
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        if squeeze.phase != .ended { return }
        onPencil(AppPencilPolicy.response(rawAction: UIPencilInteraction.preferredSqueezeAction.rawValue))
    }
}

struct AppHostTagRow: View {
    let tag: AppHostTag

    var body: some View {
        HStack(spacing: 6) {
            if tag == AppHostTag.viewOnly || tag == AppHostTag.lockedForOthers {
                Image(systemName: ConclaveSymbols.lockFill)
                    .font(.caption)
                    .accessibilityHidden(true)
            }
            Text(AppHostCopy.tag(tag))
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(HostingTheme.inCallTextSecondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .overlay { Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("app.tag." + tag.rawValue)
    }
}

struct AppHostOpening: View {
    let appId: String

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .tint(HostingTheme.token(DesignTokens.iosInCallText))
            Text(ActivitiesCopy.opening(AppHostCopy.name(appId)))
                .font(.subheadline)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HostingTheme.token(DesignTokens.iosInCallSurface))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("app.opening")
    }
}

struct AppHostFailure: View {
    let host: AppHostPresenter
    let model: AppHostModel
    let onShowVideo: () -> Void

    var body: some View {
        let name = AppHostCopy.name(model.appId)
        VStack(spacing: 12) {
            Text(ActivitiesCopy.couldNotOpen(name))
                .font(.headline)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .multilineTextAlignment(.center)
            if let detail = AppHostCopy.failureDetail(model) {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .multilineTextAlignment(.center)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons }
                VStack(spacing: 8) { buttons }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HostingTheme.token(DesignTokens.iosInCallSurface))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("app.failed." + model.issue.rawValue)
    }

    @ViewBuilder private var buttons: some View {
        if model.hasEmbed && model.phase == AppHostPhase.failed {
            Button(ConclaveStrings.text("Try Again")) { host.retry() }
                .buttonStyle(.bordered)
                .tint(HostingTheme.token(DesignTokens.iosInCallText))
                .frame(minHeight: 44)
                .accessibilityIdentifier("app.retry")
        }
        Button(ConclaveStrings.text("Show Video")) { onShowVideo() }
            .buttonStyle(.bordered)
            .tint(HostingTheme.token(DesignTokens.iosInCallText))
            .frame(minHeight: 44)
            .accessibilityIdentifier("app.failedShowVideo")
    }
}

struct AppBoardEmptyHint: View {
    let host: AppHostPresenter

    var body: some View {
        if host.toolbar.elementCount == 0 && !host.toolbar.pageId.isEmpty {
            VStack(spacing: 6) {
                Text(ConclaveStrings.text("A Blank Board"))
                    .font(.headline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                Text(ConclaveStrings.text("Sketch, drop sticky notes, or point things out with the laser. Everyone in the call sees it live."))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.inCallTextTertiary)
                    .multilineTextAlignment(.center)
            }
            .padding(24)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}

struct WhiteboardToolbar: View {
    let host: AppHostPresenter
    let onPalette: (AppPencilResponse) -> Void
    @State private var renaming = false
    @State private var renameDraft = ""
    @State private var deleting = false

    var body: some View {
        let toolbar = host.toolbar
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    toolButton(AppWhiteboardTool.select, toolbar: toolbar)
                    toolButton(AppWhiteboardTool.pan, toolbar: toolbar)
                    toolButton(AppWhiteboardTool.pen, toolbar: toolbar)
                    toolButton(AppWhiteboardTool.highlighter, toolbar: toolbar)
                    toolButton(AppWhiteboardTool.eraser, toolbar: toolbar)
                    shapeMenu(toolbar)
                    toolButton(AppWhiteboardTool.text, toolbar: toolbar)
                    toolButton(AppWhiteboardTool.sticky, toolbar: toolbar)
                    toolButton(AppWhiteboardTool.laser, toolbar: toolbar)
                    colorMenu(toolbar)
                    widthMenu(toolbar)
                    AppToolButton(title: AppHostCopy.command(AppHostCommandKind.undo), isSelected: false,
                                  isPending: toolbar.isPending(AppHostCommandKind.undo), isEnabled: toolbar.canUndo) {
                        _ = host.perform(AppHostCommandKind.undo)
                    }
                    .keyboardShortcut("z", modifiers: .command)
                    AppToolButton(title: AppHostCopy.command(AppHostCommandKind.redo), isSelected: false,
                                  isPending: toolbar.isPending(AppHostCommandKind.redo), isEnabled: toolbar.canRedo) {
                        _ = host.perform(AppHostCommandKind.redo)
                    }
                    .keyboardShortcut("z", modifiers: [.command, .shift])
                    pageMenu(toolbar)
                    AppToolButton(title: AppHostCopy.command(AppHostCommandKind.zoomToFit), isSelected: false,
                                  isPending: toolbar.isPending(AppHostCommandKind.zoomToFit), isEnabled: true) {
                        _ = host.perform(AppHostCommandKind.zoomToFit)
                    }
                    AppToolButton(title: AppHostCopy.command(AppHostCommandKind.export), isSelected: false,
                                  isPending: toolbar.isPending(AppHostCommandKind.export), isEnabled: true) {
                        _ = host.perform(AppHostCommandKind.export)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            if toolbar.exportFailed {
                Text(ConclaveStrings.text("Couldn’t export the board. Try again."))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ConclaveStrings.text("Whiteboard Tools"))
        .accessibilityIdentifier("app.whiteboard.toolbar")
        .task(id: toolbar.exportSequence) {
            let png = host.takeExport()
            let sessionId = host.session?.appSessionId
            if !png.isEmpty {
                await NativeAppExport.share(pngBase64: png) { host.session?.appSessionId == sessionId && sessionId != nil }
            }
        }
        .alert(ConclaveStrings.text("Rename Page"), isPresented: $renaming) {
            TextField(ConclaveStrings.text("Page Name"), text: $renameDraft)
            Button(ConclaveStrings.text("Rename")) {
                _ = host.perform(AppHostCommandKind.renamePage, value: host.toolbar.pageId, extra: renameDraft)
            }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
        }
        .confirmationDialog(ConclaveStrings.format("Delete Page %@?", toolbar.pageName), isPresented: $deleting,
                            titleVisibility: .visible) {
            Button(ConclaveStrings.text("Delete"), role: .destructive) {
                _ = host.perform(AppHostCommandKind.deletePage, value: host.toolbar.pageId)
            }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
        } message: {
            Text(ConclaveStrings.text("Everyone loses this page."))
        }
    }

    private func toolButton(_ tool: AppWhiteboardTool, toolbar: AppToolbarModel) -> some View {
        AppToolButton(title: AppHostCopy.toolName(tool), isSelected: toolbar.tool == tool.rawValue,
                      isPending: toolbar.isPending(AppHostCommandKind.setTool), isEnabled: true) {
            _ = host.perform(AppHostCommandKind.setTool, value: tool.rawValue)
        }
    }

    private func shapeMenu(_ toolbar: AppToolbarModel) -> some View {
        let isShape = AppWhiteboardTool(rawValue: toolbar.tool)?.isShape ?? false
        return Menu {
            ForEach([AppWhiteboardTool.rect, AppWhiteboardTool.ellipse, AppWhiteboardTool.line, AppWhiteboardTool.arrow], id: \.self) { tool in
                Button {
                    _ = host.perform(AppHostCommandKind.setTool, value: tool.rawValue)
                } label: {
                    checkedLabel(AppHostCopy.toolName(tool), checked: toolbar.tool == tool.rawValue)
                }
            }
            Divider()
            ForEach(AppShapeFill.allCases, id: \.self) { fill in
                Button {
                    _ = host.perform(AppHostCommandKind.setFill, value: fill.rawValue)
                } label: {
                    checkedLabel(AppHostCopy.fillName(fill), checked: toolbar.filled == (fill == AppShapeFill.filled))
                }
            }
        } label: {
            AppToolLabel(title: ConclaveStrings.text("Whiteboard Tool Shape"), isSelected: isShape,
                         isPending: toolbar.isPending(AppHostCommandKind.setTool) || toolbar.isPending(AppHostCommandKind.setFill))
        }
        .accessibilityAddTraits(isShape ? [.isSelected] : [])
    }

    private func colorMenu(_ toolbar: AppToolbarModel) -> some View {
        Menu {
            ForEach(AppInkColor.allCases, id: \.self) { color in
                Button {
                    _ = host.perform(AppHostCommandKind.setColor, value: color.rawValue)
                } label: {
                    checkedLabel(AppHostCopy.colorName(color), checked: toolbar.color == color.rawValue)
                }
            }
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(AppInkSwatch.color(toolbar.color))
                    .overlay { Circle().strokeBorder(HostingTheme.inCallBorderStrong, lineWidth: 1) }
                    .frame(width: 16, height: 16)
                    .accessibilityHidden(true)
                AppToolLabel(title: ConclaveStrings.text("Whiteboard Tool Color"), isSelected: false,
                             isPending: toolbar.isPending(AppHostCommandKind.setColor))
            }
        }
        .accessibilityValue(AppInkColor(rawValue: toolbar.color).map { AppHostCopy.colorName($0) } ?? "")
    }

    private func widthMenu(_ toolbar: AppToolbarModel) -> some View {
        Menu {
            ForEach(AppStrokeWidths.steps, id: \.self) { width in
                Button {
                    _ = host.perform(AppHostCommandKind.setStrokeWidth, value: String(width))
                } label: {
                    checkedLabel(AppHostCopy.widthName(width), checked: toolbar.strokeWidth == width)
                }
            }
        } label: {
            AppToolLabel(title: ConclaveStrings.text("Whiteboard Tool Stroke Width"), isSelected: false,
                         isPending: toolbar.isPending(AppHostCommandKind.setStrokeWidth))
        }
        .accessibilityValue(AppHostCopy.widthName(toolbar.strokeWidth))
    }

    private func pageMenu(_ toolbar: AppToolbarModel) -> some View {
        Menu {
            ForEach(toolbar.pages) { page in
                Button {
                    _ = host.perform(AppHostCommandKind.setPage, value: page.id)
                } label: {
                    if page.isCurrent {
                        Label { Text(verbatim: page.name) } icon: { Image(systemName: ConclaveSymbols.checkmark) }
                    } else {
                        Text(verbatim: page.name)
                    }
                }
            }
            Divider()
            Button(ConclaveStrings.text("New Page")) { _ = host.perform(AppHostCommandKind.addPage) }
            Button(ConclaveStrings.text("Rename Page…")) {
                renameDraft = host.toolbar.pageName
                renaming = true
            }
            .disabled(toolbar.pageId.isEmpty)
            Button(ConclaveStrings.text("Delete Page…"), role: .destructive) { deleting = true }
                .disabled(toolbar.pages.count < 2)
        } label: {
            AppToolLabel(title: ConclaveStrings.text("Whiteboard Tool Page"), isSelected: false,
                         isPending: toolbar.isPending(AppHostCommandKind.setPage) || toolbar.isPending(AppHostCommandKind.addPage)
                            || toolbar.isPending(AppHostCommandKind.renamePage) || toolbar.isPending(AppHostCommandKind.deletePage))
        }
        .accessibilityValue(toolbar.pageName)
    }

    @ViewBuilder private func checkedLabel(_ title: String, checked: Bool) -> some View {
        if checked {
            Label(title, systemImage: ConclaveSymbols.checkmark)
        } else {
            Text(title)
        }
    }
}

struct AppToolButton: View {
    let title: String
    let isSelected: Bool
    let isPending: Bool
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            AppToolLabel(title: title, isSelected: isSelected, isPending: isPending)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : HostingTheme.disabledOpacity)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

struct AppToolLabel: View {
    let title: String
    let isSelected: Bool
    let isPending: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        ZStack {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .opacity(isPending ? 0.35 : 1)
            if isPending {
                ProgressView()
                    .controlSize(.small)
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
            }
        }
        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
        .padding(.horizontal, 12)
        .frame(minWidth: 44, minHeight: 44)
        .background(HostingTheme.token(isSelected ? DesignTokens.iosInCallSurfaceHigh : DesignTokens.iosInCallSurfaceRaised), in: shape)
        .overlay { shape.strokeBorder(isSelected ? HostingTheme.inCallBorderStrong : HostingTheme.inCallBorder, lineWidth: 1) }
        .contentShape(shape)
        .accessibilityValue(isPending ? ConclaveStrings.text("In Progress") : "")
    }
}

struct AppPencilPalette: View {
    let host: AppHostPresenter
    let kind: AppPencilResponse
    let onDone: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                switch kind {
                case .colorMenu:
                    ForEach(AppInkColor.allCases, id: \.self) { color in
                        row(AppHostCopy.colorName(color), checked: host.toolbar.color == color.rawValue) {
                            _ = host.perform(AppHostCommandKind.setColor, value: color.rawValue)
                        }
                    }
                case .strokeMenu:
                    ForEach(AppStrokeWidths.steps, id: \.self) { width in
                        row(AppHostCopy.widthName(width), checked: host.toolbar.strokeWidth == width) {
                            _ = host.perform(AppHostCommandKind.setStrokeWidth, value: String(width))
                        }
                    }
                default:
                    ForEach(AppWhiteboardTool.allCases, id: \.self) { tool in
                        row(AppHostCopy.toolName(tool), checked: host.toolbar.tool == tool.rawValue) {
                            _ = host.perform(AppHostCommandKind.setTool, value: tool.rawValue)
                        }
                    }
                }
            }
            .padding(.vertical, 8)
        }
        .frame(minWidth: 220, maxHeight: 360)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised))
    }

    private func row(_ title: String, checked: Bool, action: @escaping () -> Void) -> some View {
        Button {
            action()
            onDone()
        } label: {
            HStack {
                Text(title)
                Spacer(minLength: 8)
                if checked {
                    Image(systemName: ConclaveSymbols.checkmark)
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(checked ? [.isSelected] : [])
    }
}

struct AppExternalLinkConfirmation: ViewModifier {
    let registry: ActivityWebViewRegistry

    func body(content: Content) -> some View {
        content.confirmationDialog(ConclaveStrings.text("Open This Link in Safari?"),
                                   isPresented: Binding(get: { registry.pendingExternalURL != nil },
                                                        set: { if !$0 { registry.clearExternalLink() } }),
                                   titleVisibility: .visible) {
            Button(ConclaveStrings.text("Open")) {
                if let url = registry.pendingExternalURL {
                    registry.clearExternalLink()
                    ChatInAppBrowser.present(url)
                }
            }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) { registry.clearExternalLink() }
        } message: {
            Text(verbatim: registry.pendingExternalURL?.host ?? "")
        }
    }
}

struct AppHostReadouts: View {
    let host: AppHostPresenter
    let registry: ActivityWebViewRegistry

    var body: some View {
        HStack(spacing: 12) {
            Text(verbatim: "app.registrySerial=" + String(registry.registrySerial))
                .accessibilityIdentifier("app.registrySerial")
            Text(verbatim: "app.reloads=" + String(registry.reloads))
                .accessibilityIdentifier("app.reloads")
            Text(verbatim: "app.rejections=" + String(host.session?.rejectionCount ?? 0))
                .accessibilityIdentifier("app.rejections")
        }
        .font(.caption2.monospaced())
        .foregroundStyle(HostingTheme.inCallTextTertiary)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }
}

enum NativeAppExport {
    static func prepare(pngBase64: String, directory: URL = FileManager.default.temporaryDirectory) -> URL? {
        guard let data = Data(base64Encoded: pngBase64), !data.isEmpty else { return nil }
        let url = directory.appendingPathComponent("whiteboard-" + UUID().uuidString + ".png")
        do {
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
    }

    @MainActor
    static func share(pngBase64: String, isCurrent: () -> Bool) async {
        let file = await Task.detached(priority: .userInitiated) { prepare(pngBase64: pngBase64) }.value
        guard let url = file else { return }
        guard !Task.isCancelled, isCurrent() else {
            await discard(url)
            return
        }
        var root: UIViewController?
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene, windowScene.activationState == .foregroundActive else { continue }
            root = windowScene.keyWindow?.rootViewController
        }
        guard var top = root else {
            await discard(url)
            return
        }
        while let presented = top.presentedViewController { top = presented }
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in
            Task { await discard(url) }
        }
        if let popover = controller.popoverPresentationController {
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        top.present(controller, animated: true)
    }

    private static func discard(_ url: URL) async {
        await Task.detached(priority: .utility) { try? FileManager.default.removeItem(at: url) }.value
    }
}

enum AppInkSwatch {
    static func color(_ hex: String) -> Color {
        guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else {
            return HostingTheme.token(DesignTokens.iosInCallText)
        }
        return HostingTheme.token(0xFF00_0000 | Int64(value))
    }
}

struct WheelCardBar: View {
    let host: AppHostPresenter

    var body: some View {
        let wheel = host.wheel
        let spinBusy = wheel.spinning || wheel.isPending(AppPageCommandKind.spin)
        HStack(spacing: 8) {
            Button {
                _ = host.spinWheel()
            } label: {
                HStack(spacing: 8) {
                    if spinBusy { ProgressView().tint(HostingTheme.inCallOnCoral) }
                    Text(ConclaveStrings.text("Spin"))
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                }
                .foregroundStyle(HostingTheme.inCallOnCoral)
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(HostingTheme.coralFill)
            .disabled(!wheel.canSpin)
            .opacity(wheel.canSpin || spinBusy ? 1 : HostingTheme.disabledOpacity)
            .accessibilityValue(spinBusy ? ConclaveStrings.text("In Progress") : "")
            .accessibilityIdentifier("app.wheel.spin")
            Button {
                _ = host.openPage()
            } label: {
                Text(ConclaveStrings.text("Edit Names"))
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(HostingTheme.token(DesignTokens.iosInCallText))
            .accessibilityIdentifier("app.wheel.editNames")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

struct AppWatchQueueButton: View {
    let host: AppHostPresenter

    var body: some View {
        Button {
            _ = host.openPage()
        } label: {
            Text(ConclaveStrings.text("Queue"))
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .padding(.horizontal, 10)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("app.watch.queue")
    }
}

struct AppPageAnnouncer: View {
    let host: AppHostPresenter

    var body: some View {
        let winner = host.wheel.winnerSequence
        let title = host.watch.titleSequence
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onChange(of: winner) { _, _ in
                let label = host.wheel.winnerLabel
                if label.isEmpty { return }
                AccessibilityNotification.Announcement(ConclaveStrings.format("Winner: %@", label)).post()
            }
            .onChange(of: title) { _, _ in
                let name = host.watch.title
                if name.isEmpty { return }
                AccessibilityNotification.Announcement(name).post()
            }
    }
}

struct AppPageUnavailable: View {
    let appId: String

    var body: some View {
        Section {
            Text(AppHostCopy.pageClosed(appId))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("app.page.closed")
        }
    }
}

struct AppWheelPage: View {
    let host: AppHostPresenter
    @State private var draft = ""
    @State private var confirmsClear = false
    @FocusState private var focused: Bool
    @Environment(\.panelPromoteToLargeDetent) private var promoteToLarge

    var body: some View {
        let wheel = host.wheel
        let deleteAction: ((IndexSet) -> Void)? = wheel.canEdit ? { offsets in remove(offsets) } : nil
        List {
            if !wheel.isReady {
                AppPageUnavailable(appId: "wheel")
            } else {
                if wheel.canEdit {
                    Section {
                        TextField(ConclaveStrings.text("Add a Name"), text: $draft, axis: .vertical)
                            .lineLimit(1...4)
                            .textInputAutocapitalization(.words)
                            .submitLabel(.done)
                            .focused($focused)
                            .disabled(wheel.isFull)
                            .onSubmit { addDraft() }
                            .onChange(of: draft) { _, value in

                                if value.contains("\n") { addDraft() }
                            }
                            .onChange(of: focused) { _, isFocused in if isFocused { promoteToLarge() } }
                            .accessibilityIdentifier("app.wheel.add")
                        Button {
                            _ = host.addEveryoneToWheel()
                        } label: {
                            LabeledContent(ConclaveStrings.text("Add Everyone Here")) {
                                if wheel.isPending(AppPageCommandKind.addEntries, target: "everyone") {
                                    ProgressView()
                                } else {
                                    Text(ConclaveStrings.format("Wheel Missing Names %lld", wheel.missingNames.count))
                                }
                            }
                        }
                        .disabled(wheel.missingNames.isEmpty || wheel.isFull)
                        .accessibilityIdentifier("app.wheel.addEveryone")
                    } footer: {
                        if wheel.isFull {
                            Text(ConclaveStrings.text("The wheel is full."))
                                .accessibilityIdentifier("app.wheel.full")
                        }
                    }
                }
                Section {
                    if wheel.entries.isEmpty {
                        Text(ConclaveStrings.text("No names yet."))
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("app.wheel.empty")
                    } else {
                        ForEach(wheel.entries) { entry in
                            Text(verbatim: entry.label)
                                .opacity(wheel.isPending(AppPageCommandKind.removeEntry, target: entry.id) ? HostingTheme.disabledOpacity : 1)
                                .accessibilityIdentifier("app.wheel.entry")
                        }
                        .onDelete(perform: deleteAction)
                    }
                }
                Section {
                    if wheel.canEdit {
                        Button(ConclaveStrings.text("Shuffle")) { _ = host.shuffleWheel() }
                            .disabled(wheel.entries.count < 2 || wheel.isPending(AppPageCommandKind.shuffle))
                            .accessibilityIdentifier("app.wheel.shuffle")
                        Button(ConclaveStrings.text("Sort A to Z")) { _ = host.sortWheel() }
                            .disabled(wheel.entries.count < 2 || wheel.isPending(AppPageCommandKind.sort))
                            .accessibilityIdentifier("app.wheel.sort")
                        Button(ConclaveStrings.text("Clear Names…"), role: .destructive) { confirmsClear = true }
                            .disabled(wheel.entries.isEmpty || wheel.isPending(AppPageCommandKind.clearEntries))
                            .accessibilityIdentifier("app.wheel.clear")
                        Toggle(isOn: Binding(get: { host.wheel.removeWinner }, set: { _ = host.setWheelRemoveWinner($0) })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ConclaveStrings.text("Remove Winner After Each Spin"))
                                Text(ConclaveStrings.text("Winners come off the wheel automatically, so nobody gets picked twice"))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .disabled(wheel.isPending(AppPageCommandKind.setRemoveWinner))
                        .accessibilityIdentifier("app.wheel.removeWinner")
                    }
                    Toggle(ConclaveStrings.text("Wheel Sounds"), isOn: Binding(get: { host.wheel.sounds }, set: { _ = host.setWheelSounds($0) }))
                        .disabled(wheel.isPending(AppPageCommandKind.setSounds))
                        .accessibilityIdentifier("app.wheel.sounds")
                }
                if !wheel.results.isEmpty {
                    Section(ConclaveStrings.text("Results")) {
                        ForEach(wheel.results) { result in
                            LabeledContent {
                                Text(verbatim: result.byName)
                            } label: {
                                Text(verbatim: result.label)
                            }
                            .accessibilityIdentifier("app.wheel.result")
                        }
                        if wheel.canEdit {
                            Button(ConclaveStrings.text("Clear Results")) { _ = host.clearWheelResults() }
                                .disabled(wheel.isPending(AppPageCommandKind.clearResults))
                                .accessibilityIdentifier("app.wheel.clearResults")
                        }
                    }
                }
            }
        }
        .navigationTitle(AppHostCopy.name("wheel"))
        .task { host.refreshRoster() }
        .confirmationDialog(ConclaveStrings.text("Clear Names?"), isPresented: $confirmsClear, titleVisibility: .visible) {
            Button(ConclaveStrings.text("Clear Names"), role: .destructive) { _ = host.clearWheelNames() }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
        } message: {
            Text(ConclaveStrings.text("The wheel empties for everyone."))
        }
        .accessibilityIdentifier("app.wheel.page")
    }

    private func addDraft() {
        let text = draft
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if !text.isEmpty { draft = "" }
            return
        }
        if host.addWheelNames(text) == ActivityTapResult.dispatched { draft = "" }
    }

    private func remove(_ offsets: IndexSet) {
        let entries = host.wheel.entries
        for index in offsets where index < entries.count {
            _ = host.removeWheelEntry(entries[index].id)
        }
    }
}

struct AppWatchPage: View {
    let host: AppHostPresenter
    @State private var query = ""

    var body: some View {
        let watch = host.watch
        List {
            if !watch.isReady {
                AppPageUnavailable(appId: "watch")
            } else {
                AppWatchNowSection(watch: watch)
                AppWatchSearchSection(host: host, watch: watch)
                if query.isEmpty && watch.queue.isEmpty && watch.searchPhase == WatchSearchPhase.idle {
                    if !watch.trending.isEmpty {
                        Section(ConclaveStrings.text("Trending")) {
                            ForEach(watch.trending) { video in
                                AppWatchVideoRow(host: host, watch: watch, video: video)
                            }
                        }
                    }
                    Section(ConclaveStrings.text("Or Start with a Classic")) {
                        ForEach(WatchClassics.items) { video in
                            AppWatchVideoRow(host: host, watch: watch, video: video)
                        }
                    }
                }
                AppWatchQueueSection(host: host, watch: watch)
                AppWatchRequestsSection(host: host, watch: watch)
                if watch.isHost {
                    Section {
                        Toggle(ConclaveStrings.text("Everyone Can Control"), isOn: Binding(
                            get: { host.watch.everyoneCanControl },
                            set: { _ = host.setWatchEveryoneCanControl($0) }))
                            .disabled(watch.lockPending)
                            .accessibilityIdentifier("app.watch.everyoneCanControl")
                    } footer: {
                        Text(ConclaveStrings.text("Playback, seeking and the queue. Off means host only."))
                    }
                }
            }
        }
        .navigationTitle(AppHostCopy.name("watch"))
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: Text(ConclaveStrings.text("Search YouTube or Paste a Link")))
        .onSubmit(of: .search) {
            let submitted = query
            _ = host.submitWatchSearch(submitted)
            if !WatchLinkPolicy.videoId(submitted).isEmpty { query = "" }
        }
        .onChange(of: query) { _, value in
            if value.isEmpty { host.clearWatchSearch() }
        }
        .task { host.loadWatchTrending() }
        .accessibilityIdentifier("app.watch.page")
    }
}

struct AppWatchNowSection: View {
    let watch: WatchPageModel

    var body: some View {
        if !watch.videoId.isEmpty {
            Section {
                LabeledContent {
                    Text(AppHostCopy.playback(watch.playback))
                } label: {
                    Text(verbatim: watch.title.isEmpty ? AppHostCopy.name("watch") : watch.title)
                }
                .accessibilityIdentifier("app.watch.now")
            }
        } else if !watch.canControl {
            Section {
                Text(ConclaveStrings.text("Waiting for the host to start something. Playback stays in sync for everyone."))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("app.watch.waiting")
            }
        }
        if watch.requestDeclined {
            Section {
                Text(ConclaveStrings.text("Your request was declined."))
                    .accessibilityIdentifier("app.watch.declined")
            }
        }
    }
}

struct AppWatchSearchSection: View {
    let host: AppHostPresenter
    let watch: WatchPageModel

    var body: some View {
        switch watch.searchPhase {
        case .idle:
            EmptyView()
        case .searching:
            Section {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("app.watch.searching")
            }
        case .results:
            Section {
                ForEach(watch.results) { video in
                    AppWatchVideoRow(host: host, watch: watch, video: video)
                }
            }
        case .empty:
            Section {
                Text(ConclaveStrings.text("No Results"))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("app.watch.noResults")
            }
        case .unavailable:
            Section {
                Text(ConclaveStrings.text("Search is switched off on this server. Paste a YouTube link instead."))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("app.watch.searchOff")
            }
        case .failed:
            Section {
                Text(ConclaveStrings.text("Couldn’t search YouTube. Try again."))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("app.watch.searchFailed")
            }
        }
    }
}

struct AppWatchVideoRow: View {
    let host: AppHostPresenter
    let watch: WatchPageModel
    let video: WatchVideoModel

    var body: some View {
        let action = watch.pickAction
        let pending = watch.isPending(AppPageCommandKind.playNow, target: video.id)
            || watch.isPending(AppPageCommandKind.enqueue, target: video.id)
            || watch.isPending(AppPageCommandKind.request, target: video.id)
        let row = LabeledContent {
            if pending {
                ProgressView()
            } else if action != WatchPickAction.none {
                Text(AppHostCopy.pickAction(action))
                    .foregroundStyle(.tint)
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: video.title.isEmpty ? video.id : video.title)
                    .lineLimit(2)
                if !video.channel.isEmpty {
                    Text(verbatim: video.channel)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        if action == WatchPickAction.none {
            row
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("app.watch.video")
        } else {
            Button {
                _ = host.pickWatchVideo(video, action: action)
            } label: {
                row
            }
            .foregroundStyle(.primary)
            .disabled(pending)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if action == WatchPickAction.enqueue {
                    Button(ConclaveStrings.text("Play Now")) {
                        _ = host.pickWatchVideo(video, action: WatchPickAction.playNow)
                    }
                }
            }
            .accessibilityHint(AppHostCopy.pickAction(action))
            .accessibilityIdentifier("app.watch.video")
        }
    }
}

struct AppWatchQueueSection: View {
    let host: AppHostPresenter
    let watch: WatchPageModel

    var body: some View {
        let moveAction: ((IndexSet, Int) -> Void)? = watch.canControl ? { source, destination in move(source, destination) } : nil
        let deleteAction: ((IndexSet) -> Void)? = watch.canControl ? { offsets in remove(offsets) } : nil
        Section(ConclaveStrings.text("Up Next")) {
            if watch.queue.isEmpty {
                Text(ConclaveStrings.text("Nothing queued yet."))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("app.watch.queueEmpty")
            } else {
                ForEach(watch.queue) { item in
                    AppWatchQueueRow(host: host, watch: watch, item: item)
                }
                .onMove(perform: moveAction)
                .onDelete(perform: deleteAction)
            }
        }
    }

    private func move(_ source: IndexSet, _ destination: Int) {
        guard let first = source.first, source.count == 1 else { return }
        _ = host.moveQueuedVideoRow(from: first, to: destination)
    }

    private func remove(_ offsets: IndexSet) {
        let queue = host.watch.queue
        for index in offsets where index < queue.count {
            _ = host.removeQueuedVideo(queue[index].id)
        }
    }
}

struct AppWatchQueueRow: View {
    let host: AppHostPresenter
    let watch: WatchPageModel
    let item: WatchItemModel

    var body: some View {
        let pending = watch.isPending(AppPageCommandKind.playNow, target: item.id)
            || watch.isPending(AppPageCommandKind.move, target: item.id)
            || watch.isPending(AppPageCommandKind.remove, target: item.id)
        let index = watch.queue.firstIndex(where: { $0.id == item.id }) ?? 0
        LabeledContent {
            if pending {
                ProgressView()
            } else if watch.canControl {
                Button(ConclaveStrings.text("Play Now")) { _ = host.playQueuedVideo(item.id) }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("app.watch.queue.playNow")
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: item.title.isEmpty ? item.videoId : item.title)
                    .lineLimit(2)
                if !item.byName.isEmpty {
                    Text(verbatim: item.byName)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityIdentifier("app.watch.queue.item")
        .accessibilityActions {
            if watch.canControl && index > 0 {
                Button(ConclaveStrings.text("Move Up")) { _ = host.moveQueuedVideo(item.id, direction: -1) }
            }
            if watch.canControl && index < watch.queue.count - 1 {
                Button(ConclaveStrings.text("Move Down")) { _ = host.moveQueuedVideo(item.id, direction: 1) }
            }
        }
    }
}

struct AppWatchRequestsSection: View {
    let host: AppHostPresenter
    let watch: WatchPageModel

    var body: some View {
        if watch.isHost && !watch.requests.isEmpty {
            Section(ConclaveStrings.text("Requests")) {
                ForEach(watch.requests) { request in
                    let pending = watch.isPending(AppPageCommandKind.approve, target: request.id)
                        || watch.isPending(AppPageCommandKind.decline, target: request.id)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(verbatim: request.title.isEmpty ? request.videoId : request.title)
                            .lineLimit(2)
                        if !request.byName.isEmpty {
                            Text(verbatim: request.byName)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        HStack(spacing: 12) {
                            if pending {
                                ProgressView()
                            } else {
                                Button(ConclaveStrings.text("Add to Queue")) { _ = host.answerWatchRequest(request.id, approve: true) }
                                    .buttonStyle(.bordered)
                                    .accessibilityIdentifier("app.watch.request.approve")
                                Button(ConclaveStrings.text("Decline"), role: .destructive) {
                                    _ = host.answerWatchRequest(request.id, approve: false)
                                }
                                .buttonStyle(.bordered)
                                .accessibilityIdentifier("app.watch.request.decline")
                            }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("app.watch.request")
                }
            }
        } else if watch.canRequest {
            Section {
                if let mine = watch.myRequest {
                    LabeledContent {
                        Text(ConclaveStrings.text("Pending"))
                    } label: {
                        Text(verbatim: mine.title.isEmpty ? mine.videoId : mine.title)
                            .lineLimit(2)
                    }
                    .accessibilityIdentifier("app.watch.myRequest")
                    Button(ConclaveStrings.text("Cancel Request"), role: .destructive) { _ = host.cancelWatchRequest() }
                        .disabled(watch.isPending(AppPageCommandKind.cancelRequest))
                        .accessibilityIdentifier("app.watch.cancelRequest")
                }
            } header: {
                if watch.myRequest != nil { Text(ConclaveStrings.text("Requests")) }
            } footer: {
                Text(ConclaveStrings.text("Picks are sent to the host to approve."))
                    .accessibilityIdentifier("app.watch.requestFooter")
            }
        }
    }
}

enum AppHostCopy {
    static func name(_ appId: String) -> String {
        return ActivitiesCopy.appName(appId)
    }

    static func status(_ model: AppHostModel) -> String {
        if model.appId.isEmpty { return "" }
        if model.appId == "wheel" && model.nameCount > 0 {
            return ConclaveStrings.format("App Names %lld", model.nameCount)
        }
        if model.appId == "watch" && model.playback != "none" {
            return playback(model.playback)
        }
        if model.isLocked { return ConclaveStrings.text("Editing locked") }
        if model.appId == "whiteboard" && model.editorCount > 0 {
            return ConclaveStrings.format("App Editors %lld", model.editorCount)
        }
        return ""
    }

    static func playback(_ state: String) -> String {
        if state == "playing" { return ConclaveStrings.text("Playing") }
        if state == "paused" { return ConclaveStrings.text("Paused") }
        return ""
    }

    static func pickAction(_ action: WatchPickAction) -> String {
        switch action {
        case .none: return ""
        case .playNow: return ConclaveStrings.text("Play Now")
        case .enqueue: return ConclaveStrings.text("Add to Queue")
        case .request: return ConclaveStrings.text("Request")
        }
    }

    static func pageClosed(_ appId: String) -> String {
        return ConclaveStrings.format("App Page Closed %@", name(appId))
    }

    static func tag(_ tag: AppHostTag) -> String {
        switch tag {
        case .none: return ""
        case .viewOnly: return ConclaveStrings.text("View Only")
        case .lockedForOthers: return ConclaveStrings.text("Locked for Others")
        case .reconnecting: return ConclaveStrings.text("Reconnecting")
        }
    }

    static func failureDetail(_ model: AppHostModel) -> String? {
        if model.phase == AppHostPhase.versionMismatch {
            return ConclaveStrings.format("Update Conclave to use %@.", name(model.appId))
        }
        return nil
    }

    static func canvasLabel(_ appId: String) -> String {
        return appId == "whiteboard" ? ConclaveStrings.text("Whiteboard Canvas") : name(appId)
    }

    static func toolName(_ tool: AppWhiteboardTool) -> String {
        switch tool {
        case .select: return ConclaveStrings.text("Whiteboard Tool Select")
        case .pan: return ConclaveStrings.text("Whiteboard Tool Pan")
        case .pen: return ConclaveStrings.text("Whiteboard Tool Pen")
        case .highlighter: return ConclaveStrings.text("Whiteboard Tool Highlighter")
        case .eraser: return ConclaveStrings.text("Whiteboard Tool Eraser")
        case .rect: return ConclaveStrings.text("Whiteboard Tool Rectangle")
        case .ellipse: return ConclaveStrings.text("Whiteboard Tool Ellipse")
        case .line: return ConclaveStrings.text("Whiteboard Tool Line")
        case .arrow: return ConclaveStrings.text("Whiteboard Tool Arrow")
        case .text: return ConclaveStrings.text("Whiteboard Tool Text")
        case .sticky: return ConclaveStrings.text("Whiteboard Tool Sticky Note")
        case .laser: return ConclaveStrings.text("Whiteboard Tool Laser Pointer")
        }
    }

    static func fillName(_ fill: AppShapeFill) -> String {
        switch fill {
        case .outline: return ConclaveStrings.text("Whiteboard Shape Outline")
        case .filled: return ConclaveStrings.text("Whiteboard Shape Filled")
        }
    }

    static func widthName(_ width: Int) -> String {
        return ConclaveStrings.format("Stroke Width %lld", width)
    }

    static func command(_ kind: AppHostCommandKind) -> String {
        switch kind {
        case .undo: return ConclaveStrings.text("Whiteboard Undo")
        case .redo: return ConclaveStrings.text("Redo")
        case .zoomToFit: return ConclaveStrings.text("Zoom to Fit")
        case .export: return ConclaveStrings.text("Whiteboard Export")
        case .addPage: return ConclaveStrings.text("New Page")
        case .renamePage: return ConclaveStrings.text("Rename Page…")
        case .deletePage: return ConclaveStrings.text("Delete Page…")
        case .setTool: return ConclaveStrings.text("Whiteboard Tools")
        case .setColor: return ConclaveStrings.text("Whiteboard Tool Color")
        case .setStrokeWidth: return ConclaveStrings.text("Whiteboard Tool Stroke Width")
        case .setFill: return ConclaveStrings.text("Whiteboard Tool Shape")
        case .setPage: return ConclaveStrings.text("Whiteboard Tool Page")
        }
    }

    static func colorName(_ color: AppInkColor) -> String {
        switch color {
        case .white: return ConclaveStrings.text("Ink White")
        case .mist: return ConclaveStrings.text("Ink Mist")
        case .gray: return ConclaveStrings.text("Ink Gray")
        case .charcoal: return ConclaveStrings.text("Ink Charcoal")
        case .lightRed: return ConclaveStrings.text("Ink Light Red")
        case .red: return ConclaveStrings.text("Ink Red")
        case .rose: return ConclaveStrings.text("Ink Rose")
        case .pink: return ConclaveStrings.text("Ink Pink")
        case .lightOrange: return ConclaveStrings.text("Ink Light Orange")
        case .orange: return ConclaveStrings.text("Ink Orange")
        case .yellow: return ConclaveStrings.text("Ink Yellow")
        case .amber: return ConclaveStrings.text("Ink Amber")
        case .lightGreen: return ConclaveStrings.text("Ink Light Green")
        case .green: return ConclaveStrings.text("Ink Green")
        case .teal: return ConclaveStrings.text("Ink Teal")
        case .darkTeal: return ConclaveStrings.text("Ink Dark Teal")
        case .lightBlue: return ConclaveStrings.text("Ink Light Blue")
        case .blue: return ConclaveStrings.text("Ink Blue")
        case .lavender: return ConclaveStrings.text("Ink Lavender")
        case .purple: return ConclaveStrings.text("Ink Purple")
        }
    }
}
#endif
