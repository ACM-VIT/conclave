#if os(iOS) && !SKIP
import Foundation

// S60 4 g (SET-6), L6-14 on iOS: one exhaustive mapping from the Effects vocabulary (tabs, catalog ids, camera states,
// issues) to String Catalog keys in Apple title case (Q13). Catalog names stay verbatim ("Camper vacation"). The S60
// table names `SettingsCopy+iOS.swift` for Effects too; that file belongs to SET-3 this batch, so the Effects half lives
// here (HD record B7-T2).
enum EffectsCopy {
    static func title() -> String {
        ConclaveStrings.text("Effects")
    }

    static func tabTitle(_ id: String) -> String {
        switch id {
        case EffectsCatalog.filters: return ConclaveStrings.text("Filters")
        case EffectsCatalog.appearance: return ConclaveStrings.text("Appearance")
        default: return ConclaveStrings.text("Backgrounds")
        }
    }

    /// A tile's name: the catalog title keyed by id; personal images read "Your Image %lld".
    static func itemTitle(_ item: EffectItem) -> String {
        if item.kind == EffectKind.personal {
            return ConclaveStrings.format("Your Image %lld", item.personalIndex + 1)
        }
        return itemTitle(id: item.id)
    }

    static func itemTitle(id: String) -> String {
        switch id {
        case EffectsCatalog.noBackground: return ConclaveStrings.text("None")
        case EffectsCatalog.slightBlur: return ConclaveStrings.text("Slight Blur")
        case EffectsCatalog.blur: return ConclaveStrings.text("Blur")
        case "camper-vacation": return ConclaveStrings.text("Camper vacation")
        case "coffee-shop": return ConclaveStrings.text("Coffee shop")
        case EffectsCatalog.noFilter: return ConclaveStrings.text("No Filter")
        case "sparkles": return ConclaveStrings.text("Sparkles")
        case "warm-glow": return ConclaveStrings.text("Warm glow")
        case EffectsCatalog.studioLighting: return ConclaveStrings.text("Studio Lighting")
        case EffectsCatalog.studioLook: return ConclaveStrings.text("Studio Look")
        case EffectsCatalog.framing: return ConclaveStrings.text("Framing")
        default: return id
        }
    }

    /// The Appearance rows' detail lines (4 g).
    static func appearanceDetail(id: String) -> String {
        switch id {
        case EffectsCatalog.studioLighting: return ConclaveStrings.text("Makes it easier to see you against a bright background")
        case EffectsCatalog.studioLook: return ConclaveStrings.text("Sharpens your features when needed so people can see you better")
        default: return ConclaveStrings.text("Keeps you in the center of the frame")
        }
    }

    /// The grid section a Backgrounds tile sits in at the large detent (4 c): Blur, Backgrounds, Personal.
    static func sectionTitle(_ kind: EffectKind) -> String {
        switch kind {
        case .none, .blur: return ConclaveStrings.text("Blur")
        case .personal: return ConclaveStrings.text("Personal")
        case .image, .filter, .style, .appearance: return ConclaveStrings.text("Backgrounds")
        }
    }

    /// The camera row (4 c, f); nil while the camera is on.
    static func cameraLine(_ camera: EffectsCameraState) -> String? {
        switch camera {
        case .on: return nil
        case .off: return ConclaveStrings.text("Camera is off for the meeting.")
        case .audioOnly: return ConclaveStrings.text("Turn off Audio Only to use effects.")
        case .blocked: return ConclaveStrings.text("Camera access is off")
        case .interrupted: return ConclaveStrings.text("Camera paused")
        case .disabledByHost: return ConclaveStrings.text("The host turned off cameras for this meeting.")
        }
    }

    /// The inline error row (4 f, g); nil without an issue.
    static func issue(_ issue: EffectsIssue) -> String? {
        switch issue {
        case .none: return nil
        case .format: return ConclaveStrings.text("This image format isn’t supported.")
        case .size: return ConclaveStrings.text("Choose an image under 12 MB.")
        case .decode: return ConclaveStrings.text("This image couldn’t be opened.")
        case .complex: return ConclaveStrings.text("Choose a less detailed image.")
        case .unavailable: return ConclaveStrings.text("Image effects aren’t available right now.")
        case .limit: return ConclaveStrings.text("You can keep up to 8 personal images. Remove one to add another.")
        }
    }

    /// The tile value (4 i): "Applying" while processing, "Selected" when chosen, empty otherwise.
    static func tileValue(_ item: EffectItem) -> String {
        if item.isProcessing { return ConclaveStrings.text("Applying") }
        return item.isSelected ? ConclaveStrings.text("Selected") : ""
    }

    /// Why a tile cannot be chosen right now (4 c, f); nil when it can.
    static func blockedReason(_ item: EffectItem) -> String? {
        guard item.isBlockedBySystem else { return nil }
        if item.kind == EffectKind.blur { return ConclaveStrings.text("Portrait is on in Video Effects.") }
        return ConclaveStrings.text("A background is on in Video Effects.")
    }
}
#endif
