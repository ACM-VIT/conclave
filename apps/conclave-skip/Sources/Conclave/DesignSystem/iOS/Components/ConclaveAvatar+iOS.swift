#if os(iOS) && !SKIP
import SwiftUI

struct ConclaveAvatar: View {
    let identity: ConclaveAvatarIdentity
    let size: ConclaveAvatarSize

    let diameter: CGFloat?

    let standaloneLabel: String?
    let identifier: String?

    init(name: String, id: String?, size: ConclaveAvatarSize, standaloneLabel: String? = nil, identifier: String? = nil) {
        self.init(identity: ConclaveAvatarIdentity.make(name: name, id: id), size: size,
                  standaloneLabel: standaloneLabel, identifier: identifier)
    }

    init(identity: ConclaveAvatarIdentity, size: ConclaveAvatarSize, diameter: CGFloat? = nil,
         standaloneLabel: String? = nil, identifier: String? = nil) {
        self.identity = identity
        self.size = size
        self.diameter = diameter
        self.standaloneLabel = standaloneLabel
        self.identifier = identifier
    }

    var body: some View {
        Group {
            if let diameter {
                ConclaveAvatarFace(identity: identity, diameter: diameter)
            } else if size.scalesWithText {
                ScaledFace(identity: identity, base: CGFloat(size.diameter))
            } else {
                ConclaveAvatarFace(identity: identity, diameter: CGFloat(size.diameter))
            }
        }
        .accessibilityIgnoresInvertColors()
        .modifier(AvatarSemantics(label: standaloneLabel, identifier: identifier))
    }

    private struct ScaledFace: View {
        let identity: ConclaveAvatarIdentity
        @ScaledMetric private var scaled: CGFloat

        init(identity: ConclaveAvatarIdentity, base: CGFloat) {
            self.identity = identity
            _scaled = ScaledMetric(wrappedValue: base, relativeTo: .body)
        }

        var body: some View {
            ConclaveAvatarFace(identity: identity, diameter: scaled)
        }
    }
}

private struct AvatarSemantics: ViewModifier {
    let label: String?
    let identifier: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let label {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(label)
                .accessibilityAddTraits(.isImage)
                .accessibilityIdentifier(identifier ?? "")
        } else if let identifier {
            content
                .accessibilityHidden(true)
                .accessibilityIdentifier(identifier)
        } else {
            content.accessibilityHidden(true)
        }
    }
}

struct ConclaveAvatarFace: View {
    let identity: ConclaveAvatarIdentity
    let diameter: CGFloat

    var body: some View {
        let eyesWidth = diameter * 0.6
        let eyesHeight = eyesWidth / FacehashPresentation.faceAspect(for: identity.faceIndex)
        let metrics = FacehashPresentation.mouthMetrics(for: identity.mouthIndex)
        let mouthWidth = max(6.0, diameter * metrics.widthFraction)
        let mouthHeight = mouthWidth * metrics.viewBox.height / metrics.viewBox.width
        let strokeWidth = max(1.4, mouthWidth / 8.0)
        let feature = HostingTheme.token(DesignTokens.neutralWhite)
        Circle()
            .fill(HostingTheme.token(identity.fill))
            .frame(width: diameter, height: diameter)
            .overlay {
                Circle().strokeBorder(HostingTheme.token(DesignTokens.avatarRing), lineWidth: 1)
            }
            .overlay {
                VStack(spacing: diameter * 0.08) {
                    FacehashEyesShape(variant: identity.faceIndex)
                        .fill(feature)
                        .frame(width: eyesWidth, height: eyesHeight)
                    mouth(width: mouthWidth, height: mouthHeight, strokeWidth: strokeWidth, feature: feature)
                }
            }
    }

    @ViewBuilder
    private func mouth(width: CGFloat, height: CGFloat, strokeWidth: CGFloat, feature: Color) -> some View {
        switch identity.mouthIndex {
        case 0, 3, 5, 6, 7:
            FacehashMouthStrokeShape(variant: identity.mouthIndex)
                .stroke(feature, style: StrokeStyle(lineWidth: strokeWidth, lineCap: .round))
                .frame(width: width, height: height)
        case 8:
            ZStack {
                FacehashMouthStrokeShape(variant: 8)
                    .stroke(feature, style: StrokeStyle(lineWidth: strokeWidth, lineCap: .round))
                FacehashMouthFillShape(variant: 8)
                    .fill(HostingTheme.token(DesignTokens.avatarTongue))
            }
            .frame(width: width, height: height)
        default:
            FacehashMouthFillShape(variant: identity.mouthIndex)
                .fill(feature)
                .frame(width: width, height: height)
        }
    }
}
#endif
