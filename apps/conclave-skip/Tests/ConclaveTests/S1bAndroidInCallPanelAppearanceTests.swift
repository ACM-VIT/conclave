#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1bAndroidInCallPanelAppearanceTests {
    private static let host = "Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt"
    private static let callRoot = "Sources/Conclave/Skip/ui/call/stage/CallRoot.kt"
    private static let appRoot = "Sources/Conclave/Skip/ui/AppRoot.kt"

    @Test func androidCallHostRendersEveryPanelInCall() throws {
        let flat = normalizedFND(try fndSource(Self.host))
        #expect(flat.contains("internal fun PanelHostDecision.underCallRoot(inCallRoot: Boolean): PanelHostDecision = if (inCallRoot && !inCallAppearance) copy(inCallAppearance = true) else this"))
        #expect(flat.contains("readout: PanelHostReadout, inCallRoot: Boolean = true,"))
        #expect(flat.contains("remember(request, window.horizontalRegular, window.verticalRegular, accessibilitySize, inCallRoot)"))
        #expect(flat.contains("panelHostDecision(request, window, isAccessibilitySize = accessibilitySize).underCallRoot(inCallRoot)"))
    }

    @Test func callRootKeepsTheDefaultAndThePreviewOptsOut() throws {
        let root = normalizedFND(try fndSource(Self.callRoot))
        #expect(root.contains("NativePanelHost( panels = shell.panels, lifetime = lifetime, focus = focus, readout = readout, systemBars ="))
        let preview = normalizedFND(try fndSource(Self.appRoot))
        #expect(preview.contains("NativePanelHost( panels = presenter.panels, lifetime = lifetime, focus = focus, readout = readout, inCallRoot = false,"))
    }

    @Test func everyCallPanelReadsTheHostDecisionAppearance() throws {
        let root = normalizedFND(try fndSource(Self.callRoot))
        let reads = root.components(separatedBy: "appearance = if (decision.inCallAppearance) PanelAppearance.inCall else PanelAppearance.system,").count - 1
        let arguments = root.components(separatedBy: "appearance = ").count - 1
        #expect(reads > 0 && reads == arguments)
    }
}
#endif
