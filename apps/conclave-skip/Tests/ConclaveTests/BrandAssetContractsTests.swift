#if !SKIP
#if canImport(AppKit)
import AppKit
#endif
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import Testing
@testable import Conclave

/// SYS-11 asset audit and source scans (S70 11 l 1, 2, 3, 5 and 6; SX8; SX9). Every asset is read from the
/// repository, so a regenerated or replaced file is checked as shipped.
struct BrandAssetContractsTests {
    // S70 11 l 1: the Icon Composer document is the app icon, with solid fills only.
    @Test func appIconDocumentUsesSolidFillsAndAMonoKnockout() throws {
        let document = try brandJSON("Darwin/AppIcon.icon/icon.json")
        for text in brandStrings(in: document) {
            #expect(!text.lowercased().contains("gradient"), "icon.json uses \(text)")
        }
        let ink = brandSRGB(DesignTokens.iosInCallStage)
        #expect(brandSRGB(DesignTokens.iosAppOnCoral) == ink)
        let fills = try #require(document["fill-specializations"] as? [[String: Any]])
        try #require(fills.count == 2)
        #expect(fills[0]["appearance"] == nil && brandSolid(fills[0]["value"]) == ink)
        #expect(fills[1]["appearance"] as? String == "dark" && brandSolid(fills[1]["value"]) == ink)
        #expect(document["fill"] == nil)
        let groups = try #require(document["groups"] as? [[String: Any]])
        try #require(groups.count == 1)
        let group = groups[0]
        #expect((group["shadow"] as? [String: Any])?["kind"] as? String == "none")
        #expect((group["translucency"] as? [String: Any])?["enabled"] as? Bool == false)
        let layers = try #require(group["layers"] as? [[String: Any]])
        #expect(layers.map { $0["name"] as? String ?? "" } == ["Letters", "Mark"])
        try #require(layers.count >= 2)
        let letters = layers[0], mark = layers[1]
        #expect(brandSolid(letters["fill"]) == ink)
        #expect(brandSolid(mark["fill"]) == brandSRGB(DesignTokens.coral))
        for layer in layers { #expect(layer["glass"] as? Bool == false) }
        // Clear and Tinted (the "tinted" mono specialization) hide the letters, leaving the knocked-out diamond.
        let hidden = try #require(letters["hidden-specializations"] as? [[String: Any]])
        #expect(hidden.count == 1 && hidden[0]["appearance"] as? String == "tinted" && hidden[0]["value"] as? Bool == true)
        #expect(mark["hidden-specializations"] == nil)
        #expect(letters["image-name"] as? String == "acm-letters.svg")
        #expect(mark["image-name"] as? String == "conclave-mark.svg")
        let assets = try FileManager.default.contentsOfDirectory(atPath: brandPackagePath("Darwin/AppIcon.icon/Assets"))
        #expect(assets.filter { !$0.hasPrefix(".") }.sorted() == ["acm-letters.svg", "conclave-mark.svg"])

        // Both layers carry the pinned brand path verbatim at 82 + 2.15x, today's 860 px diamond on 1024 px.
        let brand = try brandMark()
        let markSVG = try brandSource("Darwin/AppIcon.icon/Assets/conclave-mark.svg")
        let lettersSVG = try brandSource("Darwin/AppIcon.icon/Assets/acm-letters.svg")
        #expect(brandAttribute("d", in: markSVG) == brand.joined())
        #expect(brandAttribute("d", in: lettersSVG) == brand.dropFirst().joined())
        for svg in [markSVG, lettersSVG] {
            #expect(svg.hasPrefix("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1024\" height=\"1024\" viewBox=\"0 0 1024 1024\">"))
            #expect(brandAttribute("transform", in: svg) == "translate(82 82) scale(2.15)")
            #expect(brandAttribute("fill-rule", in: svg) == "evenodd")
            #expect(svg.components(separatedBy: "<path").count == 2)
        }
        #expect(brandAttribute("fill", in: markSVG) == brandHex(DesignTokens.coral))
        #expect(brandAttribute("fill", in: lettersSVG) == brandHex(DesignTokens.iosAppOnCoral))
    }

    // S70 11 l 1 and 11 c: no build can pick up the per-size set or the empty package set; iOS 17 stays.
    // actool (Xcode 27.1) ignores an AppIcon.appiconset next to AppIcon.icon and renders the iOS 17 to 25 images
    // from the document either way (SYS-11 review F1 experiment), so a kept set would only be dead weight.
    @Test func legacyIconSetsAreGoneAndTheDocumentIsTheAppIcon() throws {
        let files = FileManager.default
        #expect(!files.fileExists(atPath: brandPackagePath("Darwin/Assets.xcassets/AppIcon.appiconset")))
        // The empty package AppIcon set and the stale purple module AccentColor were the whole package catalog.
        #expect(!files.fileExists(atPath: brandPackagePath("Sources/Conclave/Resources/Assets.xcassets")))
        #expect(files.fileExists(atPath: brandPackagePath("Darwin/Assets.xcassets/AccentColor.colorset/Contents.json")))
        let project = try brandSource("Darwin/Conclave.xcodeproj/project.pbxproj")
        #expect(project.contains("/* AppIcon.icon */ = {isa = PBXFileReference; lastKnownFileType = folder.iconcomposer.icon; path = AppIcon.icon; sourceTree = \"<group>\"; };"))
        #expect(project.components(separatedBy: "/* AppIcon.icon in Resources */").count - 1 == 2)
        let settings = try brandSource("Darwin/Conclave.xcconfig")
        #expect(settings.contains("ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon\n"))
        #expect(settings.contains("IPHONEOS_DEPLOYMENT_TARGET = 17.0\n"))
        #expect(try brandSource("Package.swift").contains(".iOS(.v17)"))
    }

    // S70 11 l 2 and 11 d: vector adaptive layers, a single-path monochrome layer, the generated stage tile.
    @Test func androidAdaptiveIconIsVectorLayersWithASinglePathMonochrome() throws {
        let icon = try brandSource("Android/app/src/main/res/mipmap-anydpi/ic_launcher.xml")
        #expect(icon.contains("<background android:drawable=\"@color/ic_launcher_background\" />"))
        #expect(icon.contains("<foreground android:drawable=\"@drawable/ic_launcher_foreground\" />"))
        #expect(icon.contains("<monochrome android:drawable=\"@drawable/ic_launcher_monochrome\" />"))
        #expect(!icon.contains("@mipmap/ic_launcher_"))
        let manifest = try brandSource("Android/app/src/main/AndroidManifest.xml")
        #expect(manifest.contains("android:icon=\"@mipmap/ic_launcher\""))
        #expect(manifest.contains("android:roundIcon=\"@mipmap/ic_launcher\""))
        let path = try brandMark().joined()
        for name in ["ic_launcher_foreground", "ic_launcher_monochrome"] {
            let xml = try brandSource("Android/app/src/main/res/drawable/\(name).xml")
            #expect(xml.components(separatedBy: "<path").count == 2, "\(name) must be one path")
            #expect(brandAttribute("android:pathData", in: xml) == path)
            #expect(brandAttribute("android:fillType", in: xml) == "evenOdd")
            #expect(brandAttribute("android:width", in: xml) == "108dp")
            #expect(brandAttribute("android:scaleX", in: xml) == "0.165")
            #expect(brandAttribute("android:translateX", in: xml) == "21")
        }
        #expect(brandAttribute("android:fillColor", in: try brandSource("Android/app/src/main/res/drawable/ic_launcher_monochrome.xml")) == brandARGB(DesignTokens.neutralWhite))
        #expect(brandAttribute("android:fillColor", in: try brandSource("Android/app/src/main/res/drawable/ic_launcher_foreground.xml")) == brandARGB(DesignTokens.coral))
        #expect(try brandColors("values")["ic_launcher_background"] == brandARGB(DesignTokens.androidExtendedStage))
        #expect(try brandColors("values-night")["ic_launcher_background"] == nil)
    }

    // S70 11 l 2, 11 d and S10 1 d: launch themes set the splash color and never override the splash icon. Every
    // values* resource file is parsed as XML (review F5), so any spelling and any qualifier folder is covered.
    @Test func launchThemesNeverOverrideTheSplashIcon() throws {
        let forbidden: Set<String> = ["android:windowSplashScreenAnimatedIcon", "android:windowSplashScreenIconBackgroundColor",
                                      "android:windowSplashScreenBrandingImage", "android:windowSplashScreenAnimationDuration"]
        let res = brandPackagePath("Android/app/src/main/res")
        var backgrounds: [String: [String]] = [:]
        var parsedFiles = 0
        for folder in try FileManager.default.contentsOfDirectory(atPath: res) where folder.hasPrefix("values") {
            for file in try FileManager.default.contentsOfDirectory(atPath: res + "/" + folder) where file.hasSuffix(".xml") {
                parsedFiles += 1
                for item in try brandResourceItems("Android/app/src/main/res/\(folder)/\(file)") {
                    #expect(!forbidden.contains(item.name), "\(folder)/\(file) sets \(item.name)")
                    if item.name == "android:windowSplashScreenBackground" { backgrounds[folder, default: []].append(item.value) }
                }
            }
        }
        #expect(parsedFiles >= 6)
        // Until the S10 R4 flip the legacy entry launches dark in light mode too (S10 1 l7): the light splash keeps
        // the window's own background, which the legacy theme sets dark; night uses the generated launch color.
        #expect(backgrounds == ["values-night-v31": ["@color/conclave_window_background"], "values-v31": ["?android:attr/colorBackground"]])
        let night = try brandSource("Android/app/src/main/res/values-night-v31/themes.xml")
        let day = try brandSource("Android/app/src/main/res/values-v31/themes.xml")
        let base = try brandSource("Android/app/src/main/res/values/themes.xml")
        for theme in [night, day] {
            #expect(theme.contains("<style name=\"Theme.Conclave\" parent=\"Base.Theme.Conclave\">"))
        }
        #expect(try brandColors("values-night")["conclave_window_background"] == brandARGB(DesignTokens.androidDarkSurface))
        #expect(base.contains("<style name=\"Base.Theme.Conclave\" parent=\"Theme.Material3.Dark.NoActionBar\">"))
        #expect(base.contains("<style name=\"Theme.Conclave\" parent=\"Base.Theme.Conclave\" />"))
        #expect(!base.contains("windowSplashScreen"))
        #expect(try brandSource("Android/app/src/main/AndroidManifest.xml").contains("android:theme=\"@style/Theme.Conclave\""))
        #expect(!(try brandSource("Android/app/build.gradle.kts")).contains("core-splashscreen"))
    }

    // S70 11 l 3 and l 5, SX8: the status icon is the 24 dp letterless diamond, resolvable by its legal name.
    @Test func statusIconIsTheLetterlessDiamond() throws {
        let xml = try brandSource("Android/app/src/main/res/drawable/conclave_ic_stat.xml")
        let diamond = try brandMark()[0]
        #expect(xml.components(separatedBy: "<path").count == 2)
        #expect(brandAttribute("android:pathData", in: xml) == diamond)
        #expect(diamond.filter { $0 == "M" }.count == 1)
        #expect(brandAttribute("android:width", in: xml) == "24dp")
        #expect(brandAttribute("android:viewportWidth", in: xml) == "480")
        #expect(brandAttribute("android:translateX", in: xml) == "40")
        #expect(brandAttribute("android:fillColor", in: xml) == brandARGB(DesignTokens.neutralWhite))
        let resolver = try brandSource("Sources/Conclave/Skip/ui/theme/ConclaveResources.kt")
        #expect(resolver.contains("internal fun conclaveDrawableId(context: Context, name: String): Int"))
        #expect(resolver.contains("internal fun conclaveColorId(context: Context, name: String): Int"))
    }

    // S70 11 l 5 and SX9: the CallKit glyph is a 40 pt template, one color with alpha, letters dropped. It is the
    // generated vector of the pinned diamond (review F4), which actool renders at 1x, 2x and 3x.
    @Test func callKitTemplateIsLetterlessSingleColorWithAlpha() throws {
        let folder = "Darwin/Assets.xcassets/CallKitIcon.imageset"
        let names = try FileManager.default.contentsOfDirectory(atPath: brandPackagePath(folder)).filter { !$0.hasPrefix(".") }
        #expect(names.sorted() == ["CallKitIcon.svg", "Contents.json"])
        let contents = try brandJSON("\(folder)/Contents.json")
        #expect((contents["properties"] as? [String: Any])?["template-rendering-intent"] as? String == "template")
        let images = try #require(contents["images"] as? [[String: Any]])
        try #require(images.count == 1)
        #expect(images[0]["filename"] as? String == "CallKitIcon.svg")
        #expect(images[0]["idiom"] as? String == "universal" && images[0]["scale"] == nil)
        let svg = try brandSource("\(folder)/CallKitIcon.svg")
        #expect(svg.components(separatedBy: "<path").count == 2)
        #expect(brandAttribute("d", in: svg) == (try brandMark()[0]))
        #expect(brandAttribute("width", in: svg) == "40" && brandAttribute("height", in: svg) == "40")
        #expect(brandAttribute("viewBox", in: svg) == "0 0 400 400")
        // Template art keeps the default paint: one color, coverage in alpha.
        #expect(!svg.contains("fill"))
        #if canImport(AppKit)
        let image = try #require(NSImage(contentsOf: URL(fileURLWithPath: brandPackagePath("\(folder)/CallKitIcon.svg"))))
        for size in [40, 80, 120] {
            let raster = try brandRender(image, size: size)
            #expect(raster.alpha(0, 0) == 0 && raster.alpha(size - 1, size - 1) == 0)
            // Premultiplied black is 0 in every channel, so any second color would show up here.
            #expect(raster.maxColorComponent == 0, "\(size) px is not single color")
            #expect((0.5...0.7).contains(raster.opaqueFraction), "\(size) px coverage \(raster.opaqueFraction)")
            // The letters' box (81.6 to 319.8 by 167.7 to 233.5 of 400) is solid: no letter holes.
            let unit = Double(size) / 400
            for y in Int((168 * unit).rounded(.up))..<Int((233 * unit).rounded(.down)) {
                for x in Int((82 * unit).rounded(.up))..<Int((319 * unit).rounded(.down)) {
                    #expect(raster.alpha(x, y) == 255, "\(size) px has a hole at \(x),\(y)")
                }
            }
        }
        #endif
    }

    // S70 11 l 6 is not claimed (review F3 and ISSUE 1): the icon mark is not "Conclave" lettering, so no stand-in
    // ships under the wordmark name, and S10 R2 keeps its plain titleLarge fallback until owner-approved lettering.
    @Test func wordmarkStandInIsWithheld() throws {
        let files = FileManager.default
        #expect(!files.fileExists(atPath: brandPackagePath("Darwin/Assets.xcassets/ConclaveWordmark.imageset")))
        let res = brandPackagePath("Android/app/src/main/res")
        for folder in try files.contentsOfDirectory(atPath: res) where folder.hasPrefix("drawable") {
            let names = try files.contentsOfDirectory(atPath: res + "/" + folder)
            #expect(!names.contains { $0.hasPrefix("conclave_wordmark") }, "\(folder) ships a wordmark stand-in")
        }
    }

    // S70 11 l 6: the Google mark is the official art, unmodified, original rendering, at 20 pt or dp.
    @Test func googleMarkIsTheUnmodifiedOfficialArt() throws {
        let contents = try brandJSON("Darwin/Assets.xcassets/GoogleGMark.imageset/Contents.json")
        #expect((contents["properties"] as? [String: Any])?["template-rendering-intent"] as? String == "original")
        // SHA-256 of the art recovered from the official signin-assets.zip renders (sha256 ba884069...);
        // any recolor, crop or re-encode changes these.
        let pinned = ["7a0ab7882c142fa6277f5e5e196ae18b6867aba0b3dac06617892b0f99870667",
                      "bfd1e36a31841512b76c102d4ba506692ee0d3a288b5d37ba3a1b3bc9bcbc6c3",
                      "53f8975c6bc394703b7808556edb638d0c163c6e2eca42ec8709b1e49b965e84",
                      "33920827f09044067e0a997efd6c39fe2f8859ba2a21cb80be19c56b7b11fd36"]
        let files = [("Darwin/Assets.xcassets/GoogleGMark.imageset/GoogleGMark.png", 1),
                     ("Darwin/Assets.xcassets/GoogleGMark.imageset/GoogleGMark@2x.png", 2),
                     ("Darwin/Assets.xcassets/GoogleGMark.imageset/GoogleGMark@3x.png", 3),
                     ("Android/app/src/main/res/drawable-mdpi/google_g_mark.png", 1),
                     ("Android/app/src/main/res/drawable-xhdpi/google_g_mark.png", 2),
                     ("Android/app/src/main/res/drawable-xxhdpi/google_g_mark.png", 3),
                     ("Android/app/src/main/res/drawable-xxxhdpi/google_g_mark.png", 4)]
        for (file, scale) in files {
            let data = try Data(contentsOf: URL(fileURLWithPath: brandPackagePath(file)))
            #expect(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == pinned[scale - 1], "\(file) changed")
            let raster = try brandRaster(file)
            #expect(raster.width == 20 * scale && raster.height == 20 * scale && raster.hasAlpha)
            #expect(raster.alpha(0, 0) == 0)
            // Multi-color third-party mark: red, yellow, green and blue regions are all present.
            let hues = raster.opaqueHueFamilies
            for family in ["red", "yellow", "green", "blue"] { #expect(hues.contains(family), "\(file) lacks \(family)") }
        }
        #expect(!FileManager.default.fileExists(atPath: brandPackagePath("Android/app/src/main/res/drawable/google_g_mark.xml")))
    }

    // SX8 and SC20: generated system drawables and the notification accent, under legal names.
    @Test func systemDrawablesAndAccentAreGeneratedUnderLegalNames() throws {
        // Every file in every drawable folder, enumerated (review F6): AAPT2 rejects a file named MicFill1.
        var files = 0
        for (folder, name) in try brandDrawableFiles() {
            files += 1
            let stem = String(name.prefix { $0 != "." })
            #expect(brandLegalResourceName(stem) && (name.hasSuffix(".xml") || name.hasSuffix(".png")), "\(folder)/\(name)")
        }
        #expect(files >= 11)
        for name in ["conclave_mic_fill1", "conclave_mic_off_fill1", "conclave_call_end_fill1", "conclave_cancel_presentation_fill1",
                     "conclave_ic_stat", "ic_launcher_foreground", "ic_launcher_monochrome"] {
            let xml = try brandSource("Android/app/src/main/res/drawable/\(name).xml")
            #expect(xml.contains("<!-- GENERATED by packages/ui-tokens/scripts/gen-native-icons.py; do not edit. -->"), "\(name)")
            #expect(xml.components(separatedBy: "<path").count == 2, "\(name)")
        }
        for name in ["conclave_mic_fill1", "conclave_mic_off_fill1", "conclave_call_end_fill1", "conclave_cancel_presentation_fill1"] {
            let xml = try brandSource("Android/app/src/main/res/drawable/\(name).xml")
            #expect(brandAttribute("android:width", in: xml) == "24dp" && brandAttribute("android:fillColor", in: xml) == brandARGB(DesignTokens.neutralWhite))
        }
        #expect(try brandColors("values")["sys_notification_accent"] == brandARGB(DesignTokens.androidLightPrimary))
        #expect(try brandColors("values-night")["sys_notification_accent"] == brandARGB(DesignTokens.androidDarkPrimary))
    }

    // SX8 (review F2 and ISSUE 5): by-name lookups only fail at runtime, and the library unit tests cannot see app
    // resources, so the required SX8 names and every literal name the Skip bridges look up must exist in the app
    // module. The installed-APK readout is the aapt2 resource audit in the SYS-11 evidence.
    @Test func bridgeLookupNamesExistInTheAppModule() throws {
        let drawables = Set(try brandDrawableFiles().map { String($0.name.prefix { $0 != "." }) })
        let colors = try brandColors("values"), nightColors = try brandColors("values-night")
        for name in ["conclave_ic_stat", "conclave_mic_fill1", "conclave_mic_off_fill1", "conclave_call_end_fill1",
                     "conclave_cancel_presentation_fill1", "google_g_mark"] {
            #expect(drawables.contains(name), "missing app drawable \(name)")
        }
        #expect(colors["sys_notification_accent"] != nil && nightColors["sys_notification_accent"] != nil)
        let skip = brandPackagePath("Sources/Conclave/Skip")
        let lookup = try NSRegularExpression(pattern: #"conclave(Drawable|Color)Id\(\s*[^,()]+,\s*"([^"]*)"\s*\)"#)
        let enumerator = try #require(FileManager.default.enumerator(atPath: skip))
        while let file = enumerator.nextObject() as? String {
            guard file.hasSuffix(".kt") else { continue }
            let source = try String(contentsOfFile: skip + "/" + file, encoding: .utf8)
            let ns = source as NSString
            for match in lookup.matches(in: source, range: NSRange(location: 0, length: ns.length)) {
                let kind = ns.substring(with: match.range(at: 1)), name = ns.substring(with: match.range(at: 2))
                let exists = kind == "Drawable" ? drawables.contains(name) : colors[name] != nil
                #expect(exists, "\(file) looks up a missing app \(kind.lowercased()) \(name)")
            }
        }
    }

    @Test func brandAssetsAreFlatAndDashFree() throws {
        let files = ["Darwin/AppIcon.icon/icon.json", "Darwin/AppIcon.icon/Assets/conclave-mark.svg", "Darwin/AppIcon.icon/Assets/acm-letters.svg",
                     "Darwin/Assets.xcassets/CallKitIcon.imageset/Contents.json", "Darwin/Assets.xcassets/CallKitIcon.imageset/CallKitIcon.svg",
                     "Darwin/Assets.xcassets/GoogleGMark.imageset/Contents.json",
                     "Android/app/src/main/res/mipmap-anydpi/ic_launcher.xml", "Android/app/src/main/res/values/themes.xml",
                     "Android/app/src/main/res/values-v31/themes.xml", "Android/app/src/main/res/values-night-v31/themes.xml",
                     "Android/app/src/main/res/values/colors.xml", "Android/app/src/main/res/values-night/colors.xml",
                     "Sources/Conclave/Skip/ui/theme/ConclaveResources.kt"]
        let drawables = try FileManager.default.contentsOfDirectory(atPath: brandPackagePath("Android/app/src/main/res/drawable"))
            .filter { $0.hasSuffix(".xml") }.map { "Android/app/src/main/res/drawable/\($0)" }
        for file in files + drawables {
            let text = try brandSource(file)
            #expect(!text.lowercased().contains("gradient"), "\(file)")
            #expect(!text.unicodeScalars.contains { $0.value == 0x2013 || $0.value == 0x2014 }, "\(file) has an en or em dash")
        }
    }
}

// MARK: - Helpers

private struct BrandRaster {
    let width: Int
    let height: Int
    let hasAlpha: Bool
    let pixels: [UInt8] // premultiplied RGBA

    func alpha(_ x: Int, _ y: Int) -> UInt8 { pixels[(y * width + x) * 4 + 3] }

    var opaqueFraction: Double {
        var opaque = 0
        for index in stride(from: 3, to: pixels.count, by: 4) where pixels[index] == 255 { opaque += 1 }
        return Double(opaque) / Double(width * height)
    }

    var maxColorComponent: UInt8 {
        var result: UInt8 = 0
        for index in stride(from: 0, to: pixels.count, by: 4) { result = max(result, pixels[index], pixels[index + 1], pixels[index + 2]) }
        return result
    }

    var opaqueHueFamilies: Set<String> {
        var families: Set<String> = []
        for index in stride(from: 0, to: pixels.count, by: 4) where pixels[index + 3] == 255 {
            let r = Double(pixels[index]), g = Double(pixels[index + 1]), b = Double(pixels[index + 2])
            let high = max(r, g, b), low = min(r, g, b)
            guard high - low > 80 else { continue }
            var hue: Double
            if high == r { hue = (g - b) / (high - low) * 60 } else if high == g { hue = (2 + (b - r) / (high - low)) * 60 } else { hue = (4 + (r - g) / (high - low)) * 60 }
            if hue < 0 { hue += 360 }
            switch hue {
            case 0..<20, 340..<360: families.insert("red")
            case 40..<65: families.insert("yellow")
            case 90..<170: families.insert("green")
            case 200..<250: families.insert("blue")
            default: break
            }
        }
        return families
    }
}

private func brandRaster(_ packageRelativePath: String) throws -> BrandRaster {
    let url = URL(fileURLWithPath: brandPackagePath(packageRelativePath)) as CFURL
    let source = try #require(CGImageSourceCreateWithURL(url, nil))
    let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    let width = image.width, height = image.height
    let hasAlpha = ![CGImageAlphaInfo.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo)
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
    pixels.withUnsafeMutableBytes { buffer in
        let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        context?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    return BrandRaster(width: width, height: height, hasAlpha: hasAlpha, pixels: pixels)
}

#if canImport(AppKit)
/// Renders an image (here a vector asset) into a size x size premultiplied sRGB buffer.
private func brandRender(_ image: NSImage, size: Int) throws -> BrandRaster {
    var pixels = [UInt8](repeating: 0, count: size * size * 4)
    let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
    pixels.withUnsafeMutableBytes { buffer in
        guard let context = CGContext(data: buffer.baseAddress, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
        NSGraphicsContext.restoreGraphicsState()
    }
    return BrandRaster(width: size, height: size, hasAlpha: true, pixels: pixels)
}
#endif

/// Every non-hidden file in every res/drawable* folder of the app module, as (folder, file name).
private func brandDrawableFiles() throws -> [(folder: String, name: String)] {
    let res = brandPackagePath("Android/app/src/main/res")
    var result: [(folder: String, name: String)] = []
    for folder in try FileManager.default.contentsOfDirectory(atPath: res).sorted() where folder == "drawable" || folder.hasPrefix("drawable-") {
        for name in try FileManager.default.contentsOfDirectory(atPath: res + "/" + folder).sorted() where !name.hasPrefix(".") {
            result.append((folder, name))
        }
    }
    return result
}

/// AAPT2 resource names: lowercase a to z first, then lowercase letters, digits and underscore.
private func brandLegalResourceName(_ name: String) -> Bool {
    guard let first = name.unicodeScalars.first, first.value >= 0x61 && first.value <= 0x7A else { return false }
    return name.unicodeScalars.allSatisfy { ($0.value >= 0x61 && $0.value <= 0x7A) || ($0.value >= 0x30 && $0.value <= 0x39) || $0 == "_" }
}

/// Every `item` element of an Android values resource file as (name attribute, trimmed text).
private func brandResourceItems(_ packageRelativePath: String) throws -> [(name: String, value: String)] {
    let parser = try #require(XMLParser(contentsOf: URL(fileURLWithPath: brandPackagePath(packageRelativePath))))
    let collector = BrandItemCollector()
    parser.delegate = collector
    #expect(parser.parse(), "\(packageRelativePath) is not well-formed XML")
    return collector.items
}

private final class BrandItemCollector: NSObject, XMLParserDelegate {
    var items: [(name: String, value: String)] = []
    private var name: String?
    private var text = ""

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName: String?,
                attributes: [String: String] = [:]) {
        guard elementName == "item" else { return }
        name = attributes["name"] ?? ""
        text = ""
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if name != nil { text += string }
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName: String?) {
        guard elementName == "item", let current = name else { return }
        items.append((current, text.trimmingCharacters(in: .whitespacesAndNewlines)))
        name = nil
    }
}

/// The pinned brand mark's subpaths: the diamond first, then the four letter contours.
private func brandMark() throws -> [String] {
    let svg = try String(contentsOf: brandRepoRoot().appendingPathComponent("packages/ui-tokens/icons/brand/conclave-mark.svg"), encoding: .utf8)
    let d = try #require(brandAttribute("d", in: svg))
    let parts = d.components(separatedBy: "M").dropFirst().map { "M" + $0 }
    try #require(parts.count == 5)
    return parts
}

private func brandColors(_ folder: String) throws -> [String: String] {
    let xml = try brandSource("Android/app/src/main/res/\(folder)/colors.xml")
    var result: [String: String] = [:]
    let regex = try NSRegularExpression(pattern: #"<color name="([a-z0-9_]+)">(#[0-9A-F]{8})</color>"#)
    let ns = xml as NSString
    for match in regex.matches(in: xml, range: NSRange(location: 0, length: ns.length)) {
        result[ns.substring(with: match.range(at: 1))] = ns.substring(with: match.range(at: 2))
    }
    return result
}

/// The single value of `name="..."` in a file (nil when absent or repeated).
private func brandAttribute(_ name: String, in source: String) -> String? {
    let pattern = "(?:^|[\\s<])" + NSRegularExpression.escapedPattern(for: name) + "=\"([^\"]*)\""
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
    let ns = source as NSString
    let matches = regex.matches(in: source, range: NSRange(location: 0, length: ns.length))
    guard matches.count == 1 else { return nil }
    return ns.substring(with: matches[0].range(at: 1))
}

private func brandSRGB(_ argb: Int64) -> String {
    let red = Double((argb >> 16) & 0xFF) / 255, green = Double((argb >> 8) & 0xFF) / 255, blue = Double(argb & 0xFF) / 255
    return String(format: "srgb:%.5f,%.5f,%.5f,1.00000", red, green, blue)
}

private func brandARGB(_ argb: Int64) -> String { String(format: "#%08llX", argb) }

private func brandHex(_ argb: Int64) -> String { String(format: "#%06llX", argb & 0xFFFFFF) }

private func brandSolid(_ value: Any?) -> String? {
    guard let fill = value as? [String: Any], fill.count == 1 else { return nil }
    return fill["solid"] as? String
}

private func brandStrings(in value: Any) -> [String] {
    if let dictionary = value as? [String: Any] { return dictionary.flatMap { [$0.key] + brandStrings(in: $0.value) } }
    if let array = value as? [Any] { return array.flatMap { brandStrings(in: $0) } }
    if let string = value as? String { return [string] }
    return []
}

private func brandJSON(_ packageRelativePath: String) throws -> [String: Any] {
    let data = try Data(contentsOf: URL(fileURLWithPath: brandPackagePath(packageRelativePath)))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private func brandSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: URL(fileURLWithPath: brandPackagePath(packageRelativePath)), encoding: .utf8)
}

private func brandPackagePath(_ packageRelativePath: String) -> String {
    brandRepoRoot().appendingPathComponent("apps/conclave-skip").appendingPathComponent(packageRelativePath).path
}

private func brandRepoRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}
#endif
