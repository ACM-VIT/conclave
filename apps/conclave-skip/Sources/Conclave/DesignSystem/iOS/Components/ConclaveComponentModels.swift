import Foundation
import Observation

// Shared (transpiled) value types and pure policies behind the FND-1 and FND-2 components (F00 2.6, C06, C08,
// C13, C16, C18, C22; S20 0.5 SR4; S70 13 j). This file has no platform guard on purpose: the iOS components
// (`+iOS.swift`) and the handwritten Compose components (`K/ui/components/`) take the same inputs, and the host
// tests check the policies on both platforms. It lives in the Components folder because that is the foundation
// owner's boundary (PLAN "File ownership"); a later move to `S/DesignSystem/` is a rename only.
//
// Skip Lite rules: String raw-value enums, scalar structs and arrays of structs, no associated values, no tuples.

// MARK: Motion durations (F00 9, A5; S10 R3; S20 SR2)

/// Named motion durations both platforms build their animation specs from, so the iOS `Animation` constants and
/// the Compose specs cannot drift apart. Values are milliseconds unless the name says otherwise.
enum ConclaveMotionDurations {
    /// `motion.fast` (`packages/ui-tokens/src/tokens.ts`): banner and toast enter and exit, 8 pt travel.
    static let fastMillis = 120
    /// Banner and toast travel distance in points (iOS) or dp (Android).
    static let bannerTravel = 8.0
    /// Chrome auto-hide fade (M3 short4).
    static let chromeFadeMillis = 200
    /// S10 R3 cross-fade, also the Reduce Motion replacement for the entry expansion.
    static let crossFadeMillis = 200
    /// S20 SR2 stage swap.
    static let stageSwapMillis = 200
    /// S20 SR2 tile reflow (iOS snappy duration; Android uses the spatial spring).
    static let tileReflowMillis = 220
    /// S20 SR2 zoom snap.
    static let zoomSnapMillis = 250
    /// S10 R3 entry expansion spring response in seconds (critically damped).
    static let entryExpandResponseSeconds = 0.38
    /// Android spatial default spring (AND 14.2): damping ratio and stiffness.
    static let spatialDampingRatio = 0.9
    static let spatialStiffness = 700.0
}

/// F00 2.6 A6: one disabled opacity per platform.
enum ConclaveDisabledOpacity {
    /// R02: iOS dims a disabled control to 40%.
    static let ios = 0.4
    /// M3 disabled content alpha.
    static let android = 0.38
}

// MARK: System accessibility (S70 13 j)

/// Fixed defaults when the platform has no recommendation (Android API 28, every iOS version).
enum SystemAccessibilityDefaults {
    /// S20 Q7: chrome auto-hides after 5 s; Android stretches it through `getRecommendedTimeoutMillis`.
    static let autoHideBaseMillis = 5000.0
    /// F00 C13: an informational toast stays 4 s.
    static let toastMillis = 4000.0
    /// F00 C13: a toast with an action stays 8 s.
    static let actionToastMillis = 8000.0
}

/// What presenters need from the system accessibility readers (S70 13 j). Everything else is read by leaf views
/// from the environment or composition locals. Pushed into the stage presenter and the toast hosts.
struct SystemAccessibilityState: Equatable {
    /// VoiceOver or Switch Control on iOS; TalkBack touch exploration or any running service on Android. Blocks
    /// chrome auto-hide and keeps action toasts until they are dismissed.
    let isScreenReaderRunning: Bool
    /// iOS 18 Assistive Access (false on iOS 17 and on Android); blocks auto-hide like a screen reader.
    let isAssistiveAccessRunning: Bool
    /// Reduce Motion, Prefer Cross-Fade Transitions or Android "Remove animations".
    let reduceMotion: Bool
    /// The auto-hide delay: Android API 29 and later scale the 5 s base; otherwise the base.
    let recommendedTimeoutMillis: Double
    let differentiateWithoutColor: Bool

    static let standard = SystemAccessibilityState(isScreenReaderRunning: false, isAssistiveAccessRunning: false,
                                                   reduceMotion: false,
                                                   recommendedTimeoutMillis: SystemAccessibilityDefaults.autoHideBaseMillis,
                                                   differentiateWithoutColor: false)

    /// True when chrome must never auto-hide (S20 8 `screenReader`).
    var blocksAutoHide: Bool { isScreenReaderRunning || isAssistiveAccessRunning }
}

/// Pure mapping from raw platform readings to `SystemAccessibilityState`, shared so both platforms read settings
/// the same way and the host tests cover it.
enum SystemAccessibilityMapping {
    /// iOS: VoiceOver and Switch Control both count as a screen reader for auto-hide; Reduce Motion or Prefer
    /// Cross-Fade Transitions both remove travel (S70 13 c).
    static func iosState(voiceOver: Bool, switchControl: Bool, assistiveAccess: Bool, reduceMotion: Bool,
                         prefersCrossFade: Bool, differentiateWithoutColor: Bool) -> SystemAccessibilityState {
        return SystemAccessibilityState(isScreenReaderRunning: voiceOver || switchControl,
                                        isAssistiveAccessRunning: assistiveAccess,
                                        reduceMotion: reduceMotion || prefersCrossFade,
                                        recommendedTimeoutMillis: SystemAccessibilityDefaults.autoHideBaseMillis,
                                        differentiateWithoutColor: differentiateWithoutColor)
    }

    /// Android: touch exploration or any enabled service blocks auto-hide; an animator duration scale of 0 is
    /// "Remove animations"; a missing recommendation (API 28) keeps the base (S70 13 d).
    static func androidState(touchExploration: Bool, anyServiceEnabled: Bool, animatorDurationScale: Double,
                             recommendedTimeoutMillis: Double?) -> SystemAccessibilityState {
        let timeout = recommendedTimeoutMillis ?? SystemAccessibilityDefaults.autoHideBaseMillis
        return SystemAccessibilityState(isScreenReaderRunning: touchExploration || anyServiceEnabled,
                                        isAssistiveAccessRunning: false,
                                        reduceMotion: animatorDurationScale == 0.0,
                                        recommendedTimeoutMillis: timeout > 0.0 ? timeout : SystemAccessibilityDefaults.autoHideBaseMillis,
                                        differentiateWithoutColor: false)
    }

    /// Android Bold Text: `Configuration.fontWeightAdjustment` (API 31) is positive while it is on.
    static func androidBoldText(fontWeightAdjustment: Int) -> Bool {
        return fontWeightAdjustment > 0
    }

    /// Android contrast level (`UiModeManager.getContrast()`, API 34): 0 standard, 0.5 medium, 1 high. Medium
    /// and high read as increased; the high-contrast tokens arrive with WP4 (Q10), the reader exists now.
    static func androidIncreasedContrast(contrastLevel: Double?) -> Bool {
        guard let level = contrastLevel else { return false }
        return level > 0.0
    }
}

// MARK: Toast timing (F00 C13)

/// The toast host times a toast itself; the presenter sets no expiry (S20 SR5). An action toast persists under a
/// screen reader until it is dismissed or replaced (F00 AX11); 0 means "persist".
enum ConclaveToastTiming {
    static func durationMillis(hasAction: Bool, isScreenReaderRunning: Bool, isProgress: Bool = false) -> Double {
        if isProgress { return 0.0 }
        if hasAction && isScreenReaderRunning { return 0.0 }
        return hasAction ? SystemAccessibilityDefaults.actionToastMillis : SystemAccessibilityDefaults.toastMillis
    }
}

/// One toast as the host draws it: text already resolved per platform by the lane owner (S20 `MeetingNotice` with
/// `lane == .toast`, mapped by STG-5). Empty strings mean "none".
struct ConclaveToastItem: Equatable, Identifiable {
    let id: String
    let message: String
    /// Action label ("View", "Retry", "Undo"); empty for an informational toast.
    let actionTitle: String
    let actionId: String
    /// Chat previews and raised hands show a 24 pt avatar; empty draws none.
    let avatarName: String
    let avatarId: String
    /// Failures announce at high priority on iOS; events at low priority.
    let isFailure: Bool
    /// The operation owner removes or replaces progress; platform timeout must not hide it.
    let isProgress: Bool

    init(id: String, message: String, actionTitle: String, actionId: String, avatarName: String, avatarId: String,
         isFailure: Bool, isProgress: Bool = false) {
        self.id = id
        self.message = message
        self.actionTitle = actionTitle
        self.actionId = actionId
        self.avatarName = avatarName
        self.avatarId = avatarId
        self.isFailure = isFailure
        self.isProgress = isProgress
    }

    var hasAction: Bool { !actionTitle.isEmpty }
    var hasAvatar: Bool { !avatarName.isEmpty || !avatarId.isEmpty }
}

// MARK: Avatar identity (F00 C07)

/// The deterministic face of a person, computed once per (name, id) and cached in the row or tile model (F00 C07
/// k). It reuses the web-parity hash in `FacehashPresentation`; the fill comes from `DesignTokens.avatarPalette`, so
/// "Guest" is the same magenta on web, iOS and Android.
struct ConclaveAvatarIdentity: Equatable {
    let seed: String
    let paletteIndex: Int
    let faceIndex: Int
    let mouthIndex: Int

    static func make(name: String, id: String?) -> ConclaveAvatarIdentity {
        return fromSeed(FacehashPresentation.seed(name: name, id: id))
    }

    static func fromSeed(_ seed: String) -> ConclaveAvatarIdentity {
        let hash = FacehashPresentation.hashValue(for: seed)
        return ConclaveAvatarIdentity(seed: seed, paletteIndex: hash % DesignTokens.avatarPalette.count,
                                      faceIndex: FacehashPresentation.faceIndex(for: seed),
                                      mouthIndex: FacehashPresentation.mouthIndex(for: seed))
    }

    /// The identity fill as a generated ARGB token.
    var fill: Int64 { DesignTokens.avatarPalette[paletteIndex] }
}

/// Avatar diameters (F00 6): points on iOS, dp on Android.
enum ConclaveAvatarSize: String, CaseIterable {
    case mention, chat, row, tile, tileDense, lobby, spotlight

    var diameter: Double {
        switch self {
        case .mention: return 24.0
        case .chat: return 32.0
        case .row: return 40.0
        case .tile: return 44.0
        case .tileDense: return 30.0
        case .lobby: return 76.0
        case .spotlight: return 96.0
        }
    }

    /// Row and chat avatars scale with the body text on iOS (`@ScaledMetric`); the rest are geometry-bound.
    var scalesWithText: Bool { self == .mention || self == .chat || self == .row }
}

// MARK: Badges (F00 C06)

/// Count badge rules: hidden at zero, "99+" above 99 (numbers are formatted per locale by the platform).
enum ConclaveBadgeCount {
    static let cap = 99

    static func isVisible(_ count: Int) -> Bool { count > 0 }

    static func isCapped(_ count: Int) -> Bool { count > cap }

    /// The number the badge draws: the count, or the cap when it overflows (the platform adds "+").
    static func displayed(_ count: Int) -> Int { count > cap ? cap : count }
}

/// Role tags beside a person's name (F00 C06; S50 R50-5): iOS "Host", "Co-Host", "You"; Android sentence case.
enum ConclavePersonTag: String, CaseIterable {
    case host, cohost, you
}

/// Status badges on a video tile (F00 C06, C08).
enum ConclaveTileBadgeKind: String, CaseIterable {
    /// Warning fill with an ink glyph.
    case handRaised
    /// Label scrim with a paper glyph.
    case pinned, presenting
    /// Label scrim with the glyph in the warning color.
    case weakConnection
}

// MARK: Tile chrome (F00 C08 j with S20 SR4)

/// The chrome inputs of one tile, keyed by the canonical user id. No `isSpeaking` (the speaking ring leaf reads
/// `TileSpeakingState`, so a speaker change never re-evaluates chrome, F00 P2), no density (computed from the slot
/// size) and no video key (the renderer binding owns it). The S20 0.5 shape; StagePresenter (STG-1) builds it.
struct TileChromeModel: Equatable, Identifiable {
    let userId: String
    let displayName: String
    /// `FacehashPresentation.seed(name:id:)`, computed once by the presenter.
    let avatarSeed: String
    let isLocal: Bool
    let isMuted: Bool
    let isCameraOff: Bool
    let isHandRaised: Bool
    let isPinned: Bool
    let isPresenting: Bool
    let isWeakConnection: Bool
    let isReconnecting: Bool
    let reconnectReason: String
    /// Labels only; tiles draw no host glyph.
    let isHost: Bool
    /// A web-started AI voice agent (S20 3 f): the avatar is replaced by the agent mark.
    let isVoiceAgent: Bool

    var id: String { userId }
}

/// One per canonical id in the stage's speaking store (S20 0.5). Only the speaking ring leaf reads it, so a speaker
/// change redraws one stroke and nothing else. Writes are equality guarded.
@MainActor
@Observable
final class TileSpeakingState {
    private(set) var isSpeaking = false

    init(isSpeaking: Bool = false) {
        self.isSpeaking = isSpeaking
    }

    func update(isSpeaking: Bool) {
        if self.isSpeaking != isSpeaking { self.isSpeaking = isSpeaking }
    }
}

/// Tile chrome density, computed from the slot size (F00 C08 b; S20 SR4 adds spotlight).
enum TileChromeDensity: String, CaseIterable {
    case normal, dense, spotlight
}

/// The tile states folded into the tile's accessibility value, in this fixed order.
enum TileChromeStateKind: String, CaseIterable {
    case muted, cameraOff, speaking, handRaised, pinned, presenting, weakConnection, reconnecting
}

enum TileChromePolicy {
    /// F00 C08 b: dense below 139 tall or 167 wide (points or dp).
    static let denseHeight = 139.0
    static let denseWidth = 167.0

    static func density(width: Double, height: Double, isSpotlight: Bool) -> TileChromeDensity {
        if isSpotlight { return .spotlight }
        if height < denseHeight || width < denseWidth { return .dense }
        return .normal
    }

    /// Avatar diameter for a camera-off tile (F00 6): 44 normal, 30 dense, 96 spotlight.
    static func avatarSize(_ density: TileChromeDensity) -> Double {
        switch density {
        case .normal: return 44.0
        case .dense: return 30.0
        case .spotlight: return 96.0
        }
    }

    /// Status badge diameter: 24 normal, 16 dense (F00 C08 b).
    static func badgeSize(_ density: TileChromeDensity) -> Double {
        return density == .dense ? 16.0 : 24.0
    }

    /// The states the tile value reads, in order. Speaking comes from the speaking leaf, not the model.
    static func states(_ model: TileChromeModel, isSpeaking: Bool) -> [TileChromeStateKind] {
        var result: [TileChromeStateKind] = []
        if model.isMuted { result.append(.muted) }
        if model.isCameraOff { result.append(.cameraOff) }
        if isSpeaking { result.append(.speaking) }
        if model.isHandRaised { result.append(.handRaised) }
        if model.isPinned { result.append(.pinned) }
        if model.isPresenting { result.append(.presenting) }
        if model.isWeakConnection { result.append(.weakConnection) }
        if model.isReconnecting { result.append(.reconnecting) }
        return result
    }

    /// Top trailing badges, in drawing order (the hand badge sits top leading on its own).
    static func trailingBadges(_ model: TileChromeModel) -> [ConclaveTileBadgeKind] {
        var result: [ConclaveTileBadgeKind] = []
        if model.isPinned { result.append(.pinned) }
        if model.isPresenting { result.append(.presenting) }
        if model.isWeakConnection { result.append(.weakConnection) }
        return result
    }

    /// The "+N" overflow tile shows at most three overlapping avatars.
    static let overflowAvatarLimit = 3
}

// MARK: Menus and dialogs (F00 C16 j, C18 j)

enum MenuItemRole: String, CaseIterable {
    case normal, destructive, toggle
}

/// One menu row. `concept` names a manifest icon concept (empty draws no icon; a group is icon-complete or
/// icon-free, F00 7.1). Unavailable rows stay, disabled, with the reason as a second line (R10).
struct MenuItemModel: Equatable, Identifiable {
    let id: String
    let title: String
    let concept: String
    let role: MenuItemRole
    let isOn: Bool
    let isEnabled: Bool
    let disabledReason: String
}

/// One section of a menu, in stable order; sections are separated by dividers.
struct MenuSectionModel: Equatable, Identifiable {
    let id: String
    let items: [MenuItemModel]
}

enum ConclaveMenuPolicy {
    /// F00 7.1 and H-06: icons for every item of a section or for none.
    static func isIconConsistent(_ section: MenuSectionModel) -> Bool {
        var withIcon = 0
        for item in section.items {
            if !item.concept.isEmpty { withIcon += 1 }
        }
        return withIcon == 0 || withIcon == section.items.count
    }

    /// S30 CL15 and F00 C16 c: destructive items sit last, after a separator, farthest from the invoking control.
    static func destructiveItemsAreLast(_ sections: [MenuSectionModel]) -> Bool {
        var seenDestructive = false
        for section in sections {
            for item in section.items {
                if item.role == .destructive {
                    seenDestructive = true
                } else if seenDestructive {
                    return false
                }
            }
        }
        return true
    }
}

enum ConclaveDialogRole: String, CaseIterable {
    case normal, destructive
}

enum ConclaveDialogKind: String, CaseIterable {
    /// Choices tied to an action, attached to the invoking control (iOS `confirmationDialog`).
    case confirmation
    /// A decision that needs an explanation (iOS `alert`).
    case alert
}

/// A dialog owned by the invoking surface (F00 C18 j). The cancel button is always the platform "Cancel" (or
/// "Not Now" for alerts); the End-for-everyone copy comes from S30 4 g.
struct ConclaveDialogModel: Equatable {
    let kind: ConclaveDialogKind
    let title: String
    let message: String
    let confirmTitle: String
    let confirmRole: ConclaveDialogRole
}

// MARK: Reaction palette (F00 C22)

/// One emoji in the palette row. `id` is the wire value (S30 `ReactionOptionModel.id`); `label` is the spoken name.
struct ConclavePaletteOption: Equatable, Identifiable {
    let id: String
    let emoji: String
    let label: String
    let isSelected: Bool
}

// MARK: Lobby and stage surfaces (F00 C03 f, C04 f; S10 L2, R9)

/// Where a call control or chrome button sits. Only `.stage` may take the glass branch.
enum ConclaveSurfaceContext: String, CaseIterable {
    /// Floating over the dark stage: glass on iOS 26 or later, the opaque fallback otherwise.
    case stage
    /// Over video inside the lobby preview card: never glass, an opaque label-scrim circle (S10 R9).
    case overVideo
    /// On the lobby card's flat toggle strip: never glass, the opaque fallback (S10 L2).
    case onSurface

    var allowsGlass: Bool { self == .stage }
}
