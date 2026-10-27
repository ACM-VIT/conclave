#if os(iOS) && !SKIP
import SwiftUI

// Video tile chrome (F00 C08 with S20 SR4): the chrome and camera-off presentation around a renderer. The renderer
// is the bottom layer, passed in by the stage and never recreated by chrome, theme, panel or speaker changes (PS
// P2); the chrome is a sibling overlay that observes only its `TileChromeModel`. The speaking ring and the speaking
// part of the tile value are leaves that read `TileSpeakingState`, so a speaker change redraws one stroke. Density
// comes from the slot size (dense below 139 x 167; spotlight from the caller). One accessibility element per tile:
// label = name ("You" locally), value = joined states, actions from the stage (Pin, host actions).

/// A named accessibility action on a tile (Pin, Unpin, host actions from S20 and S50).
struct ConclaveTileAction: Identifiable {
    let id: String
    let title: String
    let action: () -> Void
}

/// Which tile composition to draw.
enum ConclaveTileVariant: String, CaseIterable {
    /// A grid, spotlight or rail tile with the name pill.
    case grid
    /// The floating self view: no name pill, the muted badge top leading, a 1 pt border, the flip button from the
    /// caller bottom trailing.
    case selfView
}

struct ConclaveTileChrome<Renderer: View, SelfViewAccessory: View>: View {
    let model: TileChromeModel
    let speaking: TileSpeakingState
    let variant: ConclaveTileVariant
    let isSpotlight: Bool
    let cornerRadius: CGFloat
    let actions: [ConclaveTileAction]
    let identifier: String
    /// Replaces the spoken name when set (S20 12 i: the attendee program feed reads "Live Video from %@").
    let accessibilityName: String?
    @ViewBuilder let renderer: () -> Renderer
    @ViewBuilder let selfViewAccessory: () -> SelfViewAccessory

    init(model: TileChromeModel, speaking: TileSpeakingState, variant: ConclaveTileVariant = .grid,
         isSpotlight: Bool = false, cornerRadius: CGFloat = CGFloat(DesignTokens.radiusTile),
         actions: [ConclaveTileAction] = [], identifier: String, accessibilityName: String? = nil,
         @ViewBuilder renderer: @escaping () -> Renderer,
         @ViewBuilder selfViewAccessory: @escaping () -> SelfViewAccessory) {
        self.model = model
        self.speaking = speaking
        self.variant = variant
        self.isSpotlight = isSpotlight
        self.cornerRadius = cornerRadius
        self.actions = actions
        self.identifier = identifier
        self.accessibilityName = accessibilityName
        self.renderer = renderer
        self.selfViewAccessory = selfViewAccessory
    }

    var body: some View {
        GeometryReader { proxy in
            let density = TileChromePolicy.density(width: Double(proxy.size.width), height: Double(proxy.size.height),
                                                   isSpotlight: isSpotlight)
            ZStack {
                renderer()
                    .accessibilityIgnoresInvertColors()
                if model.isCameraOff {
                    CameraOffFace(model: model, density: density)
                }
                TileOverlays(model: model, speaking: speaking, variant: variant, density: density,
                             selfViewAccessory: selfViewAccessory)
                ConclaveSpeakingRing(state: speaking, cornerRadius: cornerRadius)
                if variant == .selfView {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityName ?? ConclaveTileText.label(model))
        .modifier(TileValue(model: model, speaking: speaking))
        .accessibilityActions {
            ForEach(actions) { item in
                Button(item.title, action: item.action)
            }
        }
        .accessibilityIdentifier(identifier)
    }
}

extension ConclaveTileChrome where SelfViewAccessory == EmptyView {
    init(model: TileChromeModel, speaking: TileSpeakingState, variant: ConclaveTileVariant = .grid,
         isSpotlight: Bool = false, cornerRadius: CGFloat = CGFloat(DesignTokens.radiusTile),
         actions: [ConclaveTileAction] = [], identifier: String, @ViewBuilder renderer: @escaping () -> Renderer) {
        self.init(model: model, speaking: speaking, variant: variant, isSpotlight: isSpotlight, cornerRadius: cornerRadius,
                  actions: actions, identifier: identifier, renderer: renderer, selfViewAccessory: { EmptyView() })
    }
}

/// The tile value: the model's states plus Speaking from the leaf. A modifier body re-runs on a speaker change
/// without re-evaluating the chrome inside it.
private struct TileValue: ViewModifier {
    let model: TileChromeModel
    let speaking: TileSpeakingState

    func body(content: Content) -> some View {
        let states = TileChromePolicy.states(model, isSpeaking: speaking.isSpeaking)
        content.accessibilityValue(states.map { ConclaveTileText.state($0) }.joined(separator: ", "))
    }
}

/// Localized state words for the tile value (F00 C08 g).
enum ConclaveTileText {
    /// S20 3 i: "You" for yours; the name plus "Host" or "AI" otherwise (joined like the tile value).
    static func label(_ model: TileChromeModel) -> String {
        if model.isLocal { return ConclaveStrings.text("You") }
        if model.isVoiceAgent { return model.displayName + ", " + ConclaveStrings.text("AI") }
        if model.isHost { return model.displayName + ", " + ConclaveTag.title(.host) }
        return model.displayName
    }

    static func state(_ kind: TileChromeStateKind) -> String {
        switch kind {
        case .muted: return ConclaveStrings.text("Muted")
        case .cameraOff: return ConclaveStrings.text("Camera Off")
        case .speaking: return ConclaveStrings.text("Speaking")
        case .handRaised: return ConclaveStrings.text("Hand Raised")
        case .pinned: return ConclaveStrings.text("Pinned")
        case .presenting: return ConclaveStrings.text("Presenting")
        case .weakConnection: return ConclaveStrings.text("Weak Connection")
        case .reconnecting: return ConclaveStrings.text("Reconnecting")
        }
    }
}

/// The 2 pt coral inner stroke while speaking (5.973 against the tile); it appears and disappears without
/// animation, the presenter owns the hysteresis.
struct ConclaveSpeakingRing: View {
    let state: TileSpeakingState
    let cornerRadius: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .strokeBorder(HostingTheme.coralFill, lineWidth: 2)
            .opacity(state.isSpeaking ? 1 : 0)
            .accessibilityHidden(true)
    }
}

private struct CameraOffFace: View {
    let model: TileChromeModel
    let density: TileChromeDensity

    var body: some View {
        ZStack {
            HostingTheme.token(DesignTokens.iosInCallTile)
            if model.isVoiceAgent {
                Image(systemName: ConclaveSymbols.waveform)
                    .font(.system(size: CGFloat(TileChromePolicy.avatarSize(density)) * 0.5, weight: .semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .frame(width: CGFloat(TileChromePolicy.avatarSize(density)), height: CGFloat(TileChromePolicy.avatarSize(density)))
                    .background(HostingTheme.inCallLabelScrim, in: Circle())
                    .accessibilityHidden(true)
            } else {
                ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(model.avatarSeed), size: .tile,
                               diameter: CGFloat(TileChromePolicy.avatarSize(density)))
            }
        }
    }
}

private struct TileOverlays<SelfViewAccessory: View>: View {
    let model: TileChromeModel
    let speaking: TileSpeakingState
    let variant: ConclaveTileVariant
    let density: TileChromeDensity
    let selfViewAccessory: () -> SelfViewAccessory

    var body: some View {
        let badge = CGFloat(TileChromePolicy.badgeSize(density))
        let inset: CGFloat = density == .dense ? 4 : 8
        ZStack {
            Color.clear
            if variant == .grid {
                TileNamePill(model: model, speaking: speaking, density: density)
                    .padding(inset)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
            HStack(spacing: 4) {
                if model.isHandRaised {
                    ConclaveTileBadge(kind: .handRaised, size: badge)
                }
                if variant == .selfView && model.isMuted {
                    MutedBadge(size: badge)
                }
            }
            .padding(inset)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            HStack(spacing: 4) {
                ForEach(TileChromePolicy.trailingBadges(model), id: \.self) { kind in
                    ConclaveTileBadge(kind: kind, size: badge)
                }
            }
            .padding(inset)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            if model.isReconnecting {
                Text(ConclaveStrings.text("Reconnecting"))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(HostingTheme.inCallLabelScrim, in: Capsule())
            }
            if variant == .selfView {
                selfViewAccessory()
                    .padding(inset)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
        }
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

private struct MutedBadge: View {
    let size: CGFloat

    var body: some View {
        Image(systemName: ConclaveSymbols.micSlashFill)
            .font(size < 20 ? .caption2.weight(.semibold) : .caption.weight(.semibold))
            .dynamicTypeSize(...DynamicTypeSize.large)
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .frame(width: size, height: size)
            .background(HostingTheme.inCallLabelScrim, in: Circle())
            .accessibilityHidden(true)
    }
}

/// The name pill: paper text on the label scrim (6.407 over white video, 12.105 under Increase Contrast), the
/// slashed microphone while muted and, under Differentiate Without Color, the waveform while speaking (AX8).
private struct TileNamePill: View {
    let model: TileChromeModel
    let speaking: TileSpeakingState
    let density: TileChromeDensity

    var body: some View {
        HStack(spacing: 4) {
            if model.isMuted {
                Image(systemName: ConclaveSymbols.micSlashFill)
                    .accessibilityHidden(true)
            }
            PillWaveform(state: speaking)
            Text(model.isLocal ? ConclaveStrings.text("You") : model.displayName)
                .lineLimit(1)
            if model.isVoiceAgent {
                Text(ConclaveStrings.text("AI"))
                    .fontWeight(.semibold)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
        }
        .font(density == .dense ? .caption2 : .footnote)
        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(HostingTheme.inCallLabelScrim, in: Capsule())
    }
}

/// The waveform inside the name pill: a leaf that alone reads the speaking state.
private struct PillWaveform: View {
    let state: TileSpeakingState
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    var body: some View {
        if state.isSpeaking && differentiateWithoutColor {
            Image(systemName: ConclaveSymbols.waveform)
                .accessibilityHidden(true)
        }
    }
}

/// Shows the waveform next to a name only while speaking under Differentiate Without Color; a leaf, so a speaker
/// change touches nothing else. Stages that draw a speaker cue outside the pill use it directly.
struct ConclaveSpeakingWaveform: View {
    let state: TileSpeakingState
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    var body: some View {
        if state.isSpeaking && differentiateWithoutColor {
            Image(systemName: ConclaveSymbols.waveform)
                .font(.footnote)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .padding(4)
                .background(HostingTheme.inCallLabelScrim, in: Capsule())
                .accessibilityHidden(true)
        }
    }
}

/// The "+N" overflow tile (F00 C08): up to three overlapping 30 pt avatars over the "+N" count, a Button that opens
/// People, labelled "N More Participants".
struct ConclaveOverflowTile: View {
    let count: Int
    let identities: [ConclaveAvatarIdentity]
    let cornerRadius: CGFloat
    let identifier: String
    let action: () -> Void

    init(count: Int, identities: [ConclaveAvatarIdentity], cornerRadius: CGFloat = CGFloat(DesignTokens.radiusTile),
         identifier: String, action: @escaping () -> Void) {
        self.count = count
        self.identities = identities
        self.cornerRadius = cornerRadius
        self.identifier = identifier
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                HStack(spacing: -8) {
                    ForEach(Array(identities.prefix(TileChromePolicy.overflowAvatarLimit)), id: \.seed) { identity in
                        ConclaveAvatar(identity: identity, size: .tileDense)
                    }
                }
                Text(ConclaveStrings.format("Overflow Count %lld", count))
                    .font(.title3.weight(.semibold).monospacedDigit())
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .background(HostingTheme.token(DesignTokens.iosInCallTile))
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .environment(\.colorScheme, .dark)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ConclaveStrings.format("%lld More Participants", count))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(identifier)
    }
}
#endif
