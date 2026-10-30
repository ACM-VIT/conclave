#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1ChatPhotosTests {
    private static let iosComposer = "Sources/Conclave/Features/Meeting/Chat/ChatComposer+iOS.swift"
    private static let androidComposer = "Sources/Conclave/Skip/ui/chat/ChatComposer.kt"
    private static let theme = "Sources/Conclave/Shared/Theme.swift"
    private static let fontFolders = ["Sources/Conclave/Resources/Fonts", "Android/app/src/main/res/font"]
    private static let scannedRoots = ["Sources/Conclave", "Android/app/src/main", "Tests/ConclaveTests", "Darwin"]
    private static let textExtensions: Set<String> = ["swift", "kt", "kts", "xml", "json", "yml", "yaml", "gradle", "plist", "pbxproj",
                                                      "xcconfig", "strings", "xcstrings", "properties", "pro", "txt", "md",
                                                      "entitlements", "html", "css", "js", "svg"]
    private static let fontExtensions: Set<String> = ["otf", "ttf", "ttc", "woff", "woff2"]

    @Test func theInlinePickerHidesItsOwnChromeSoOnlyTheComposerCloseRemains() throws {
        let ios = try s1cpSource(Self.iosComposer)
        let picker = try s1cpSlice(ios, from: "PhotosPicker(selection: $pickedItem", to: ".accessibilityIdentifier(\"chat.photos.inline\")")
        #expect(picker.contains(".photosPickerStyle(.inline)"))
        #expect(picker.contains(".photosPickerAccessoryVisibility(.hidden, edges: .all)"), "TH-241-10: the system close and segment row go")
        #expect(picker.contains(".photosPickerDisabledCapabilities(.selectionActions)"))
        #expect(!picker.contains(".frame(height:"), "the old fixed cap is replaced by the container policy")
        #expect(ios.components(separatedBy: "PhotosPicker(").count - 1 == 1)
        #expect(ios.components(separatedBy: "identifier: \"chat.photos.close\"").count - 1 == 1)
        #expect(!ios.contains(".photosPicker(isPresented:"), "the picker stays inline below the composer, never a sheet")
        #expect(!ios.contains(".photosPickerAccessoryVisibility(.visible"))
        let flat = s1cpFlat(ios)
        #expect(flat.contains("if showsPhotoPicker { ConclaveComposerDismissButton( title: ConclaveStrings.format(\"Close %@\", ConclaveStrings.text(\"Photo Library\")), identifier: \"chat.photos.close\", action: { showsPhotoPicker = false }) } else { ChatAttachMenu("))
        #expect(flat.contains("if showsPhotoPicker { let isCompactHeight = verticalSizeClass == .compact PhotosPicker(selection: $pickedItem, matching: .images, preferredItemEncoding: .current) {"))
    }

    @Test func thePickerHeightFollowsTheSizeClassFloorsAndTheSpaceAboveTheKeyboard() throws {
        let ios = try s1cpSource(Self.iosComposer)
        let flat = s1cpFlat(ios)
        #expect(flat.contains(".containerRelativeFrame(.vertical) { length, _ in ChatPhotoPickerSizing.height(available: length, isCompactHeight: isCompactHeight) }"))
        #expect(!ios.contains("220 : 400"))
        #expect(!ios.contains("photoPickerHeight") && !ios.contains("scaledPickerHeight"), "the picker no longer grows with text size")
        let sizing = try s1cpSizing(ios)
        let sizingFlat = s1cpFlat(sizing)
        #expect(sizingFlat.contains("static func height(available: CGFloat, isCompactHeight: Bool) -> CGFloat {"))
        #expect(sizingFlat.contains("let preferred = isCompactHeight ? compactHeight : min(max(regularMinimum, available * regularShare), regularMaximum)"))
        #expect(sizingFlat.contains("let reserve = isCompactHeight ? compactReserve : regularReserve"))
        #expect(sizingFlat.contains("return max(0, min(preferred, available - reserve))"))
        for gone in ["scaled", "reservedHeight", "dynamicTypeSize", "ScaledMetric"] {
            #expect(!sizing.contains(gone), "\(gone)")
        }
        for motion in ["withAnimation", ".animation(", ".transition(", "GeometryReader"] {
            #expect(!sizing.contains(motion) && !ios.contains(motion), "\(motion)")
        }

        let model = try S1cpPickerModel(sizing)
        #expect(model.minimum == 320.0 && model.compact == 220.0)
        #expect(model.maximum >= model.minimum && model.share > 0.0 && model.share < 1.0)
        #expect(model.compactReserve > 0.0 && model.compactReserve < model.regularReserve, "compact chrome is shorter than regular chrome")

        for available in [120.0, 300.0, 340.0, 354.0, 369.0, 381.0, 520.0, 630.0, 637.0, 760.0, 900.0, 1150.0] {
            let regular = model.height(available, isCompact: false)
            let landscape = model.height(available, isCompact: true)
            #expect(regular >= 0.0 && landscape >= 0.0)
            #expect(regular <= max(0.0, available - model.regularReserve), "never taller than the space above the keyboard: \(available)")
            #expect(landscape <= max(0.0, available - model.compactReserve), "never taller than the space above the keyboard: \(available)")
            #expect(regular <= model.maximum && regular <= max(model.minimum, available * model.share), "the grid stops at half the panel: \(available)")
            if available - model.regularReserve >= model.minimum {
                #expect(regular >= model.minimum, "regular height is at least 320 pt when it fits: \(available)")
            }
            if available - model.compactReserve >= model.compact {
                #expect(landscape == model.compact, "compact height is 220 pt when it fits: \(available)")
            }
        }
        #expect(model.height(760.0, isCompact: false) > model.minimum, "on a phone in portrait the grid takes more than the floor")
    }

    @Test func aLandscapeIPhone17eGetsTheCompactFloorAndLargeTextNeverGrowsThePicker() throws {
        let model = try S1cpPickerModel(s1cpSizing(s1cpSource(Self.iosComposer)))
        #expect(model.height(369.0, isCompact: true) == 220.0, "iPhone 17e landscape sheet, 390 pt minus the 21 pt home indicator")
        #expect(model.height(354.0, isCompact: true) == 220.0, "the shortest current landscape sheet with a home indicator")
        #expect(model.height(381.0, isCompact: true) == 220.0, "iPhone 17 landscape sheet")
        #expect(369.0 - model.height(369.0, isCompact: true) >= 140.0, "compact bar plus composer row stay visible above the picker")
        #expect(model.height(637.0, isCompact: false) == 320.0, "a 667 pt phone gets the floor whatever the text size")
        #expect(637.0 - model.height(637.0, isCompact: false) >= 317.0, "AX5 navigation bar, field row and a reply bar keep their room")
        #expect(model.height(760.0, isCompact: false) == 380.0, "iPhone 17 portrait: half the panel")
        #expect(model.height(1150.0, isCompact: false) == model.maximum)
    }

    @Test func onePickGivesOneChipAndCloseRestoresTheKeyboardOnlyIfItWasUp() throws {
        let ios = try s1cpSource(Self.iosComposer)
        let flat = s1cpFlat(ios)
        #expect(ios.contains("@State private var pickedItem: PhotosPickerItem? = nil"))
        #expect(!ios.contains("maxSelectionCount"), "one pick gives one chip")
        #expect(flat.contains("private func openPhotoLibrary() { focusMemo.photoPickerWasFocused = focused focused = false showsPhotoPicker = true }"))
        #expect(flat.contains(".onChange(of: pickedItem) { _, item in guard let item else { return } pickedItem = nil showsPhotoPicker = false guard acceptsPhotoIntake() else { return }"))
        #expect(ios.contains("if !showing { restoreFocus(wasFocused: focusMemo.takePhotoPicker()) }"))
        #expect(flat.contains("guard ChatComposerPolicy.restoresComposerFocus(wasFocused: wasFocused, assistiveTechRunning: voiceOverEnabled) else { return }"))
        #expect(ChatComposerPolicy.restoresComposerFocus(wasFocused: true, assistiveTechRunning: false))
        #expect(!ChatComposerPolicy.restoresComposerFocus(wasFocused: false, assistiveTechRunning: false))
        #expect(!ChatComposerPolicy.restoresComposerFocus(wasFocused: true, assistiveTechRunning: true))

        let kotlin = try s1cpSource(Self.androidComposer)
        #expect(kotlin.contains("ActivityResultContracts.PickVisualMedia()"), "Android keeps the system Photo Picker; the request was iOS-specific")
        #expect(kotlin.contains("pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))"))
        #expect(!kotlin.contains("ChatPhotoPickerSizing"))
    }

    @Test func noTrialFontReferenceOrFontFileRemains() throws {
        let token = ["poly", "sans"].joined()
        let root = s1cpRoot()
        var scanned = 0
        for base in Self.scannedRoots {
            let directory = root.appendingPathComponent(base)
            guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil) else { continue }
            while let url = enumerator.nextObject() as? URL {
                let relative = base + "/" + url.path.replacingOccurrences(of: directory.path + "/", with: "")
                #expect(!relative.lowercased().contains(token), "\(relative)")
                let ext = url.pathExtension.lowercased()
                #expect(!Self.fontExtensions.contains(ext), "\(relative) is a bundled font")
                guard Self.textExtensions.contains(ext), let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
                scanned += 1
                #expect(!text.lowercased().contains(token), "\(relative) names the trial font")
                if base == "Sources/Conclave" {
                    #expect(!text.contains("FontRegistration") && !text.contains("registerFonts"), "\(relative)")
                }
            }
        }
        #expect(scanned > 500)
        for folder in Self.fontFolders {
            let url = root.appendingPathComponent(folder)
            if FileManager.default.fileExists(atPath: url.path) {
                let entries = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
                #expect(entries.filter { !$0.hasPrefix(".") }.isEmpty, "\(folder) still holds font files")
            }
        }
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("Sources/Conclave/Shared/FontRegistration.swift").path))

        let theme = try s1cpSource(Self.theme)
        let font = try s1cpSlice(theme, from: "enum ACMFont {", to: "enum ACMSystemIcon {")
        #expect(font.contains("static func trial(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {\n        return Font.system(size: size, weight: weight, design: .default)\n    }"))
        #expect(font.contains("static func wide(_ size: CGFloat) -> Font {\n        return Font.system(size: size, weight: .bold, design: .default)\n    }"))
        for gone in [".custom(", "custom(", "UIFont", "static let", "static func mono", "#if"] {
            #expect(!font.contains(gone), "ACMFont still has \(gone)")
        }
        #expect(!theme.contains("import UIKit"))
    }
}

private func s1cpRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1cpSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1cpRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func s1cpFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1cpSlice(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1cpConstant(_ text: String, _ name: String) throws -> Double {
    let marker = "static let " + name + ": CGFloat = "
    let range = try #require(text.range(of: marker))
    let value = text[range.upperBound...].prefix { $0 == "." || $0.isNumber }
    return try #require(Double(String(value)))
}

private func s1cpSizing(_ ios: String) throws -> String {
    try s1cpSlice(ios, from: "private enum ChatPhotoPickerSizing {", to: "private struct ChatComposerSuggestions {")
}

private struct S1cpPickerModel {
    let minimum: Double
    let maximum: Double
    let share: Double
    let regularReserve: Double
    let compact: Double
    let compactReserve: Double

    init(_ sizing: String) throws {
        minimum = try s1cpConstant(sizing, "regularMinimum")
        maximum = try s1cpConstant(sizing, "regularMaximum")
        share = try s1cpConstant(sizing, "regularShare")
        regularReserve = try s1cpConstant(sizing, "regularReserve")
        compact = try s1cpConstant(sizing, "compactHeight")
        compactReserve = try s1cpConstant(sizing, "compactReserve")
    }

    func height(_ available: Double, isCompact: Bool) -> Double {
        let preferred = isCompact ? compact : min(max(minimum, available * share), maximum)
        let reserve = isCompact ? compactReserve : regularReserve
        return max(0.0, min(preferred, available - reserve))
    }
}
#endif
