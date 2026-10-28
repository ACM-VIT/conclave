#if os(iOS) && !SKIP
import Foundation

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

    static func appearanceDetail(id: String) -> String {
        switch id {
        case EffectsCatalog.studioLighting: return ConclaveStrings.text("Makes it easier to see you against a bright background")
        case EffectsCatalog.studioLook: return ConclaveStrings.text("Sharpens your features when needed so people can see you better")
        default: return ConclaveStrings.text("Keeps you in the center of the frame")
        }
    }

    static func sectionTitle(_ kind: EffectKind) -> String {
        switch kind {
        case .none, .blur: return ConclaveStrings.text("Blur")
        case .personal: return ConclaveStrings.text("Personal")
        case .image, .filter, .style, .appearance: return ConclaveStrings.text("Backgrounds")
        }
    }

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

    static func tileValue(_ item: EffectItem) -> String {
        if item.isProcessing { return ConclaveStrings.text("Applying") }
        return item.isSelected ? ConclaveStrings.text("Selected") : ""
    }

    static func blockedReason(_ item: EffectItem) -> String? {
        guard item.isBlockedBySystem else { return nil }
        if item.kind == EffectKind.blur { return ConclaveStrings.text("Portrait is on in Video Effects.") }
        return ConclaveStrings.text("A background is on in Video Effects.")
    }
}
#endif
