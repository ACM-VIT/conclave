#if os(iOS) && !SKIP
import LinkPresentation
import SwiftUI
import UIKit

enum DiagnosticsCopy {
    static var rowTitle: String { ConclaveStrings.text("Export Diagnostics") }
    static var footer: String {
        ConclaveStrings.text("Creates a file without names, messages or meeting codes that you can send to support.")
    }
    static var shareTitle: String { ConclaveStrings.text("Conclave diagnostics") }
    static var failure: String { ConclaveStrings.text("Couldn\u{2019}t create the diagnostics file.") }
    static var tryAgain: String { ConclaveStrings.text("Try Again") }
}

struct DiagnosticsExportRow: View {
    let presenter: DiagnosticsExportPresenter
    @State private var showsFailure = false
    @State private var anchor = DiagnosticsShareAnchorBox()

    var body: some View {
        Button {
            showsFailure = false
            presenter.export()
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(DiagnosticsCopy.rowTitle)
                Text(DiagnosticsCopy.footer)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .disabled(presenter.phase == DiagnosticsExportPhase.exporting)
        .accessibilityLabel(Text(DiagnosticsCopy.rowTitle))
        .accessibilityHint(Text(DiagnosticsCopy.footer))
        .accessibilityIdentifier("settings.row.exportDiagnostics")
        .background(DiagnosticsShareAnchor(box: anchor))
        .onChange(of: presenter.readyRevision) {
            let path = presenter.takePendingShare()
            guard !path.isEmpty else { return }
            DiagnosticsShareSheet.present(
                fileURL: URL(fileURLWithPath: path),
                title: DiagnosticsCopy.shareTitle,
                anchor: anchor.view,
                onFinish: { presenter.shareFinished() },
                onFailure: { presenter.shareFailed() }
            )
        }
        .onChange(of: presenter.failureRevision) {
            guard presenter.takePendingFailure() else { return }
            showsFailure = true
            UIAccessibility.post(notification: .announcement, argument: DiagnosticsCopy.failure)
        }
        if showsFailure {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(DiagnosticsCopy.failure)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(DiagnosticsCopy.tryAgain) {
                    showsFailure = false
                    presenter.export()
                }
                .buttonStyle(.borderless)
                .disabled(presenter.phase == DiagnosticsExportPhase.exporting)
                .accessibilityIdentifier("settings.exportDiagnostics.retry")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("settings.exportDiagnostics.failed")
        }
    }
}

#if DEBUG

struct DiagnosticsFixtureSection: View {
    @State private var tick = 0

    var body: some View {
        let marker = tick
        Section(ConclaveStrings.text("Diagnostics")) {
            LabeledContent(ConclaveStrings.text("Diagnostics Listeners"), value: readout(DiagnosticsReadout.listenersKey, marker))
                .accessibilityIdentifier(DiagnosticsReadout.listenersKey)
            LabeledContent(ConclaveStrings.text("Diagnostics Buffer"), value: readout(DiagnosticsReadout.bufferKey, marker))
                .accessibilityIdentifier(DiagnosticsReadout.bufferKey)
            Button(ConclaveStrings.text("Record Test Error")) {
                CallDiagnostics.shared.debugRecordClassifiedError()
                tick += 1
            }
            .accessibilityIdentifier("sys.diagTestError")
            Button(ConclaveStrings.text("Simulate Hang")) {
                CallDiagnostics.shared.debugSimulateHang(milliseconds: 2_000)
                tick += 1
            }
            .accessibilityIdentifier("sys.diagTestHang")
        }
    }

    private func readout(_ key: String, _ marker: Int) -> String {
        marker >= 0 ? CallDiagnostics.shared.readoutValue(key) : ""
    }
}
#endif

@MainActor
final class DiagnosticsShareAnchorBox {
    weak var view: UIView?
}

private struct DiagnosticsShareAnchor: UIViewRepresentable {
    let box: DiagnosticsShareAnchorBox

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        box.view = view
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        box.view = uiView
    }
}

@MainActor
enum DiagnosticsShareSheet {
    static func present(fileURL: URL, title: String, anchor: UIView?, onFinish: @escaping @MainActor () -> Void,
                        onFailure: @escaping @MainActor () -> Void) {
        guard let presenter = topViewController(anchor: anchor) else {
            onFailure()
            return
        }
        let item = DiagnosticsShareItem(fileURL: fileURL, title: title)
        let controller = UIActivityViewController(activityItems: [item], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in
            MainActor.assumeIsolated {
                onFinish()
            }
        }
        if let popover = controller.popoverPresentationController {
            if let anchor, anchor.window != nil {
                popover.sourceView = anchor
                popover.sourceRect = anchor.bounds
            } else if let view = presenter.view {
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            }
        }
        presenter.present(controller, animated: true)
    }

    private static func topViewController(anchor: UIView?) -> UIViewController? {
        var top = (anchor?.window ?? keyWindow())?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }

    private static func keyWindow() -> UIWindow? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.first
    }
}

final class DiagnosticsShareItem: NSObject, UIActivityItemSource {
    let fileURL: URL
    let title: String

    init(fileURL: URL, title: String) {
        self.fileURL = fileURL
        self.title = title
        super.init()
    }

    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any {
        fileURL
    }

    func activityViewController(_ activityViewController: UIActivityViewController,
                                itemForActivityType activityType: UIActivity.ActivityType?) -> Any? {
        fileURL
    }

    func activityViewController(_ activityViewController: UIActivityViewController,
                                subjectForActivityType activityType: UIActivity.ActivityType?) -> String {
        title
    }

    func activityViewControllerLinkMetadata(_ activityViewController: UIActivityViewController) -> LPLinkMetadata? {
        let metadata = LPLinkMetadata()
        metadata.title = title
        metadata.originalURL = fileURL
        metadata.url = fileURL
        return metadata
    }
}
#endif
