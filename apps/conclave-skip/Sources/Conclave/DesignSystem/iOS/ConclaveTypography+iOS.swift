#if os(iOS) && !SKIP
import SwiftUI
import UIKit

/// SF Pro through Dynamic Type text styles only (TG 2.2). Each style scales on its own curve, and Bold Text
/// is honored by the system font. New screens use `.font(.body)` and friends directly; this adapter serves
/// the gallery and the optional legacy shim.
extension ConclaveTextStyle {
    var textStyle: Font.TextStyle {
        switch self {
        case .largeTitle: return .largeTitle
        case .title: return .title
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .body: return .body
        case .callout: return .callout
        case .subheadline: return .subheadline
        case .footnote: return .footnote
        case .caption: return .caption
        case .caption2: return .caption2
        }
    }

    /// The UIKit style behind `textStyle`, for the gallery's resolved point-size readout.
    var uiTextStyle: UIFont.TextStyle {
        switch self {
        case .largeTitle: return .largeTitle
        case .title: return .title1
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .body: return .body
        case .callout: return .callout
        case .subheadline: return .subheadline
        case .footnote: return .footnote
        case .caption: return .caption1
        case .caption2: return .caption2
        }
    }

    func font(_ weight: ConclaveTextWeight = .regular) -> Font {
        Font.system(textStyle, design: .default, weight: weight.fontWeight)
    }
}

extension ConclaveTextWeight {
    var fontWeight: Font.Weight {
        switch self {
        case .regular: return .regular
        case .medium: return .medium
        case .semibold: return .semibold
        case .bold: return .bold
        }
    }
}
#endif
