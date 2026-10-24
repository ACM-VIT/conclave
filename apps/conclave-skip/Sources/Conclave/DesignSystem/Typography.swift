/// Platform text styles. iOS renders them through Dynamic Type text styles (`ConclaveTypography+iOS.swift`)
/// and Android through Material 3 type roles on the system sans-serif (`ConclaveTypography.kt`). There is
/// no custom font, and typography stays out of the token generator. New screens use the platform APIs
/// directly; this enum serves the legacy mapping, the component gallery and the optional legacy shim.
enum ConclaveTextStyle: String, CaseIterable {
    case largeTitle, title, title2, title3, headline, body, callout, subheadline, footnote, caption, caption2

    /// iOS point size at the default (Large) content size.
    var iosDefaultPoints: Double {
        switch self {
        case .largeTitle: return 34.0
        case .title: return 28.0
        case .title2: return 22.0
        case .title3: return 20.0
        case .headline: return 17.0
        case .body: return 17.0
        case .callout: return 16.0
        case .subheadline: return 15.0
        case .footnote: return 13.0
        case .caption: return 12.0
        case .caption2: return 11.0
        }
    }

    /// Apple's display name for the text style.
    var iosName: String {
        switch self {
        case .largeTitle: return "Large Title"
        case .title: return "Title"
        case .title2: return "Title 2"
        case .title3: return "Title 3"
        case .headline: return "Headline"
        case .body: return "Body"
        case .callout: return "Callout"
        case .subheadline: return "Subheadline"
        case .footnote: return "Footnote"
        case .caption: return "Caption"
        case .caption2: return "Caption 2"
        }
    }

    /// The Material 3 role this style renders with on Android.
    var androidRole: String {
        switch self {
        case .largeTitle: return "headlineLarge"
        case .title: return "headlineMedium"
        case .title2: return "headlineSmall"
        case .title3: return "titleLarge"
        case .headline: return "titleMedium"
        case .body: return "bodyLarge"
        case .callout: return "bodyLarge"
        case .subheadline: return "bodyMedium"
        case .footnote: return "bodySmall"
        case .caption: return "bodySmall"
        case .caption2: return "labelSmall"
        }
    }

    /// The role's Material 3 baseline size in sp at the pinned Material version.
    var androidRoleSp: Double {
        switch self {
        case .largeTitle: return 32.0
        case .title: return 28.0
        case .title2: return 24.0
        case .title3: return 22.0
        case .headline: return 16.0
        case .body: return 16.0
        case .callout: return 16.0
        case .subheadline: return 14.0
        case .footnote: return 12.0
        case .caption: return 12.0
        case .caption2: return 11.0
        }
    }

    /// The role's Material 3 baseline weight.
    var androidRoleWeight: Int {
        switch self {
        case .headline, .caption2: return 500
        default: return 400
        }
    }
}

enum ConclaveTextWeight: String, CaseIterable {
    case regular, medium, semibold, bold

    /// Numeric weight shared by both platforms' captions and the Android mapping.
    var numericWeight: Int {
        switch self {
        case .regular: return 400
        case .medium: return 500
        case .semibold: return 600
        case .bold: return 700
        }
    }

    /// Gallery caption name, shared by both platforms.
    var displayName: String {
        switch self {
        case .regular: return "Regular"
        case .medium: return "Medium"
        case .semibold: return "Semibold"
        case .bold: return "Bold"
        }
    }
}

struct ConclaveTypeSpec: Equatable {
    let style: ConclaveTextStyle
    let weight: ConclaveTextWeight
}

/// Deterministic mapping of the legacy custom-font sizes onto text styles (TG 2.4, Appendix A). It picks the
/// style whose iOS default size is nearest, ties round up toward legibility, and the weight is preserved.
enum LegacyTypeMapping {
    static func style(size: Double, weight: ConclaveTextWeight) -> ConclaveTextStyle {
        if size >= 31.0 { return .largeTitle }
        if size >= 25.0 { return .title }
        if size >= 21.0 { return .title2 }
        if size >= 18.5 { return .title3 }
        if size >= 16.5 {
            // 17 pt is shared by Body and Headline; the legacy weight decides which one.
            return weight == .semibold || weight == .bold ? .headline : .body
        }
        if size >= 15.5 { return .callout }
        if size >= 14.0 { return .subheadline }
        if size >= 12.5 { return .footnote }
        if size >= 11.5 { return .caption }
        return .caption2
    }

    static func spec(size: Double, weight: ConclaveTextWeight) -> ConclaveTypeSpec {
        ConclaveTypeSpec(style: style(size: size, weight: weight), weight: weight)
    }
}
