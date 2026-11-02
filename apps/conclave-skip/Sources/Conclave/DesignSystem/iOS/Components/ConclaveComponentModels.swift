import Foundation
import Observation

enum ConclaveMotionDurations {

    static let fastMillis = 120

    static let bannerTravel = 8.0

    static let chromeFadeMillis = 200

    static let crossFadeMillis = 200

    static let stageSwapMillis = 200

    static let tileReflowMillis = 220

    static let zoomSnapMillis = 250

    static let entryExpandResponseSeconds = 0.38

    static let spatialDampingRatio = 0.9
    static let spatialStiffness = 700.0
}

enum ConclaveDisabledOpacity {

    static let ios = 0.4

    static let android = 0.38
}

enum SystemAccessibilityDefaults {

    static let autoHideBaseMillis = 5000.0

    static let toastMillis = 4000.0

    static let actionToastMillis = 8000.0
}

struct SystemAccessibilityState: Equatable {

    let isScreenReaderRunning: Bool

    let isAssistiveAccessRunning: Bool

    let reduceMotion: Bool

    let recommendedTimeoutMillis: Double
    let differentiateWithoutColor: Bool

    static let standard = SystemAccessibilityState(isScreenReaderRunning: false, isAssistiveAccessRunning: false,
                                                   reduceMotion: false,
                                                   recommendedTimeoutMillis: SystemAccessibilityDefaults.autoHideBaseMillis,
                                                   differentiateWithoutColor: false)

    var blocksAutoHide: Bool { isScreenReaderRunning || isAssistiveAccessRunning }
}

enum SystemAccessibilityMapping {

    static func iosState(voiceOver: Bool, switchControl: Bool, assistiveAccess: Bool, reduceMotion: Bool,
                         prefersCrossFade: Bool, differentiateWithoutColor: Bool) -> SystemAccessibilityState {
        return SystemAccessibilityState(isScreenReaderRunning: voiceOver || switchControl,
                                        isAssistiveAccessRunning: assistiveAccess,
                                        reduceMotion: reduceMotion || prefersCrossFade,
                                        recommendedTimeoutMillis: SystemAccessibilityDefaults.autoHideBaseMillis,
                                        differentiateWithoutColor: differentiateWithoutColor)
    }

    static func androidState(touchExploration: Bool, anyServiceEnabled: Bool, animatorDurationScale: Double,
                             recommendedTimeoutMillis: Double?) -> SystemAccessibilityState {
        let timeout = recommendedTimeoutMillis ?? SystemAccessibilityDefaults.autoHideBaseMillis
        return SystemAccessibilityState(isScreenReaderRunning: touchExploration || anyServiceEnabled,
                                        isAssistiveAccessRunning: false,
                                        reduceMotion: animatorDurationScale == 0.0,
                                        recommendedTimeoutMillis: timeout > 0.0 ? timeout : SystemAccessibilityDefaults.autoHideBaseMillis,
                                        differentiateWithoutColor: false)
    }

    static func androidBoldText(fontWeightAdjustment: Int) -> Bool {
        return fontWeightAdjustment > 0
    }

    static func androidIncreasedContrast(contrastLevel: Double?) -> Bool {
        guard let level = contrastLevel else { return false }
        return level > 0.0
    }
}

enum ConclaveToastTiming {
    static func durationMillis(hasAction: Bool, isScreenReaderRunning: Bool, isProgress: Bool = false) -> Double {
        if isProgress { return 0.0 }
        if hasAction && isScreenReaderRunning { return 0.0 }
        return hasAction ? SystemAccessibilityDefaults.actionToastMillis : SystemAccessibilityDefaults.toastMillis
    }
}

struct ConclaveToastItem: Equatable, Identifiable {
    let id: String
    let message: String

    let actionTitle: String
    let actionId: String

    let avatarName: String
    let avatarId: String

    let isFailure: Bool

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

    var fill: Int64 { DesignTokens.avatarPalette[paletteIndex] }
}

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

    var scalesWithText: Bool { self == .mention || self == .chat || self == .row }
}

enum ConclaveBadgeCount {
    static let cap = 99

    static func isVisible(_ count: Int) -> Bool { count > 0 }

    static func isCapped(_ count: Int) -> Bool { count > cap }

    static func displayed(_ count: Int) -> Int { count > cap ? cap : count }
}

enum ConclavePersonTag: String, CaseIterable {
    case host, cohost, you
}

enum ConclaveTileBadgeKind: String, CaseIterable {

    case handRaised

    case pinned, presenting

    case weakConnection
}

struct TileChromeModel: Equatable, Identifiable {
    let userId: String
    let displayName: String

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

    let isHost: Bool

    let isVoiceAgent: Bool

    var id: String { userId }
}

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

enum TileChromeDensity: String, CaseIterable {
    case normal, dense, spotlight
}

enum TileChromeStateKind: String, CaseIterable {
    case muted, cameraOff, speaking, handRaised, pinned, presenting, weakConnection, reconnecting
}

enum TileChromePolicy {

    static let denseHeight = 139.0
    static let denseWidth = 167.0

    static func density(width: Double, height: Double, isSpotlight: Bool) -> TileChromeDensity {
        if isSpotlight { return .spotlight }
        if height < denseHeight || width < denseWidth { return .dense }
        return .normal
    }

    static func avatarSize(_ density: TileChromeDensity) -> Double {
        switch density {
        case .normal: return 44.0
        case .dense: return 30.0
        case .spotlight: return 96.0
        }
    }

    static func badgeSize(_ density: TileChromeDensity) -> Double {
        return density == .dense ? 16.0 : 24.0
    }

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

    static func trailingBadges(_ model: TileChromeModel) -> [ConclaveTileBadgeKind] {
        var result: [ConclaveTileBadgeKind] = []
        if model.isPinned { result.append(.pinned) }
        if model.isPresenting { result.append(.presenting) }
        if model.isWeakConnection { result.append(.weakConnection) }
        return result
    }

    static let overflowAvatarLimit = 3
}

enum MenuItemRole: String, CaseIterable {
    case normal, destructive, toggle
}

struct MenuItemModel: Equatable, Identifiable {
    let id: String
    let title: String
    let concept: String
    let role: MenuItemRole
    let isOn: Bool
    let isEnabled: Bool
    let disabledReason: String
}

struct MenuSectionModel: Equatable, Identifiable {
    let id: String
    let items: [MenuItemModel]
}

enum ConclaveMenuPolicy {

    static func isIconConsistent(_ section: MenuSectionModel) -> Bool {
        var withIcon = 0
        for item in section.items {
            if !item.concept.isEmpty { withIcon += 1 }
        }
        return withIcon == 0 || withIcon == section.items.count
    }

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

    case confirmation

    case alert
}

struct ConclaveDialogModel: Equatable {
    let kind: ConclaveDialogKind
    let title: String
    let message: String
    let confirmTitle: String
    let confirmRole: ConclaveDialogRole
}

struct ConclavePaletteOption: Equatable, Identifiable {
    let id: String
    let emoji: String
    let label: String
    let isSelected: Bool
}

enum ConclaveSurfaceContext: String, CaseIterable {

    case stage

    case overVideo

    case onSurface

    var allowsGlass: Bool { self == .stage }
}
