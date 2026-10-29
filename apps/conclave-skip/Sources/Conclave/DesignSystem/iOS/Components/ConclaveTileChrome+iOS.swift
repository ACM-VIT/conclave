#if os(iOS) && !SKIP
import SwiftUI

struct ConclaveTileAction: Identifiable {
    let id: String
    let title: String
    let action: () -> Void
}

enum ConclaveTileVariant: String, CaseIterable {

    case grid

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

    let accessibilityName: String?
    let isSolo: Bool
    let showsHandBadge: Bool
    let overlayInsets: EdgeInsets
    @ViewBuilder let renderer: () -> Renderer
    @ViewBuilder let selfViewAccessory: () -> SelfViewAccessory

    init(model: TileChromeModel, speaking: TileSpeakingState, variant: ConclaveTileVariant = .grid,
         isSpotlight: Bool = false, cornerRadius: CGFloat = CGFloat(DesignTokens.radiusTile),
         actions: [ConclaveTileAction] = [], identifier: String, accessibilityName: String? = nil,
         isSolo: Bool = false, showsHandBadge: Bool = true,
         overlayInsets: EdgeInsets = EdgeInsets(),
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
        self.isSolo = isSolo
        self.showsHandBadge = showsHandBadge
        self.overlayInsets = overlayInsets
        self.renderer = renderer
        self.selfViewAccessory = selfViewAccessory
    }

    var body: some View {
        GeometryReader { proxy in
            let density = TileChromePolicy.density(width: Double(proxy.size.width), height: Double(proxy.size.height),
                                                   isSpotlight: isSpotlight)
            let insetSpeakingRing = cornerRadius == 0 && (overlayInsets.top > 0 || overlayInsets.bottom > 0)
            ZStack {
                renderer()
                    .accessibilityIgnoresInvertColors()
                if model.isCameraOff {
                    CameraOffFace(model: model, density: density, isSolo: isSolo, contentInsets: overlayInsets)
                }
                TileOverlays(model: model, speaking: speaking, variant: variant, density: density,
                             showsName: !isSolo || !model.isCameraOff, showsHandBadge: showsHandBadge,
                             selfViewAccessory: selfViewAccessory)
                    .padding(overlayInsets)
                if variant == .selfView {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
                }
                ConclaveSpeakingRing(state: speaking, cornerRadius: insetSpeakingRing ? CGFloat(DesignTokens.radiusTile) : cornerRadius)
                    .padding(insetSpeakingRing ? overlayInsets : EdgeInsets())
                    .padding(insetSpeakingRing ? CGFloat(DesignTokens.space8) : 0)
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

private struct TileValue: ViewModifier {
    let model: TileChromeModel
    let speaking: TileSpeakingState

    func body(content: Content) -> some View {
        let states = TileChromePolicy.states(model, isSpeaking: speaking.isSpeaking)
        content.accessibilityValue(states.map { ConclaveTileText.state($0) }.joined(separator: ", "))
    }
}

enum ConclaveTileText {

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
    let isSolo: Bool
    let contentInsets: EdgeInsets

    var body: some View {
        ZStack {
            HostingTheme.token(DesignTokens.iosInCallTile)
            if isSolo {
                SoloCameraOffIdentity(model: model)
                    .padding(contentInsets)
            } else if model.isVoiceAgent {

                Image(systemName: ConclaveSymbols.waveform)
                    .resizable()
                    .scaledToFit()
                    .fontWeight(.semibold)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .frame(width: CGFloat(TileChromePolicy.avatarSize(density)) * 0.5,
                           height: CGFloat(TileChromePolicy.avatarSize(density)) * 0.5)
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

private struct SoloCameraOffIdentity: View {
    let model: TileChromeModel

    var body: some View {
        ViewThatFits(in: .vertical) {
            VStack(spacing: 16) {
                avatar(diameter: 96)
                identity
            }
            HStack(spacing: 16) {
                avatar(diameter: 64)
                identity
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityHidden(true)
    }

    private func avatar(diameter: CGFloat) -> some View {
        ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(model.avatarSeed), size: .tile, diameter: diameter)
    }

    private var identity: some View {
        VStack(spacing: 6) {
            Text(ConclaveStrings.text("You"))
                .font(.headline)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            if model.isMuted {
                Label(ConclaveStrings.text("Muted"), systemImage: ConclaveSymbols.micSlashFill)
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .multilineTextAlignment(.center)
    }
}

private struct TileOverlays<SelfViewAccessory: View>: View {
    let model: TileChromeModel
    let speaking: TileSpeakingState
    let variant: ConclaveTileVariant
    let density: TileChromeDensity
    let showsName: Bool
    let showsHandBadge: Bool
    let selfViewAccessory: () -> SelfViewAccessory

    var body: some View {
        let badge = CGFloat(TileChromePolicy.badgeSize(density))
        let inset: CGFloat = density == .dense ? 4 : 8
        ZStack {
            Color.clear
            if variant == .grid && showsName {
                TileNamePill(model: model, speaking: speaking, density: density)
                    .padding(inset)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
            HStack(spacing: 4) {
                if model.isHandRaised && showsHandBadge {
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
