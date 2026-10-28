#if canImport(CoreText)
import CoreText
import Foundation

enum FontRegistration {
    static func registerFonts() {
        let fontFiles = [
            "PolySansTrial-Neutral",
            "PolySansTrial-Median",
            "PolySansTrial-Bulky",
            "PolySansTrial-BulkyWide",
            "PolySansTrial-NeutralMono",
            "PolySansTrial-MedianMono",
            "PolySansTrial-BulkyMono"
        ]

        for name in fontFiles {

            guard let url = Bundle.module.url(forResource: name, withExtension: "otf", subdirectory: "Fonts")
                ?? Bundle.module.url(forResource: name, withExtension: "otf") else {
                logger.error("Missing font resource: \(name, privacy: .public)")
                continue
            }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}
#else
enum FontRegistration {
    static func registerFonts() {}
}
#endif
