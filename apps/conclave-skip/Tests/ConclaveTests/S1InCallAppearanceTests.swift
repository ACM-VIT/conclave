#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1InCallAppearanceTests {
    private static let appearance = "Sources/Conclave/DesignSystem/iOS/CallAppearance+iOS.swift"
    private static let shell = "Sources/Conclave/Features/Meeting/Panels/PanelShell+iOS.swift"
    private static let callRoot = "Sources/Conclave/Features/Meeting/Stage/CallRoot+iOS.swift"

    @Test func callRootRethemesItsWindowDarkOnEveryIOSVersion() throws {
        let flat = normalizedFND(try fndSource(Self.appearance))
        #expect(flat.contains("private struct ConclaveInCallRootKey: EnvironmentKey { static let defaultValue = false }"))
        #expect(flat.contains("var conclaveInCallRoot: Bool { get { self[ConclaveInCallRootKey.self] } set { self[ConclaveInCallRootKey.self] = newValue } }"))
        #expect(flat.contains(".environment(\\.conclaveInCallRoot, true) .preferredColorScheme(.dark)"))
        #expect(flat.contains("private var preference: ColorScheme? { isCall ? .dark : AppearancePreference.shared.mode.colorScheme }"))
        #expect(!flat.contains("toolbarColorScheme"))
        #expect(!flat.contains("#available(iOS 27.0"))
    }

    @Test func everyPanelUnderTheCallRootIsDark() throws {
        let flat = normalizedFND(try fndSource(Self.shell))
        #expect(flat.contains("@Environment(\\.conclaveInCallRoot) private var isUnderCallRoot"))
        #expect(flat.contains("private var scheme: ColorScheme { isUnderCallRoot || presentation.appearance == .inCall ? .dark : AppearancePreference.shared.mode.colorScheme ?? systemScheme }"))
        #expect(flat.contains("if hostStyle == .inspector { content.environment(\\.colorScheme, scheme) } else { content .environment(\\.colorScheme, scheme) .preferredColorScheme(scheme) }"))
    }

    @Test func callAppearanceWrapsBothPanelHosts() throws {
        let flat = normalizedFND(try fndSource(Self.callRoot))
        let sheet = try #require(flat.range(of: ".modifier(NativePanelSheetHost("))
        let inspector = try #require(flat.range(of: ".modifier(NativePanelInspectorHost("))
        let appearance = try #require(flat.range(of: ".conclaveCallAppearance()"))
        #expect(sheet.lowerBound < appearance.lowerBound)
        #expect(inspector.lowerBound < appearance.lowerBound)
    }
}
#endif
