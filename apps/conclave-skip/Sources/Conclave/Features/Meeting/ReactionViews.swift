import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

enum MeetingReactionFlightPolicy {
    static let durationSeconds = 3.45

    static func horizontalDrift(for lane: Int) -> CGFloat {
        let drifts: [CGFloat] = [-18.0, 12.0, -8.0, 18.0, 5.0]
        return drifts[max(0, lane) % drifts.count]
    }

    static func verticalTravel(availableHeight: CGFloat) -> CGFloat {
        min(280.0, max(150.0, availableHeight * 0.38))
    }
}

// MARK: - Reaction Picker

struct ReactionPickerView: View {
    let onSelect: (MeetingReactionOption) -> Void
    
    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 2) {
                ForEach(MeetingReactionConstants.emojiReactionOptions) { option in
                    ReactionPickerButton(option: option, onSelect: onSelect)
                }
            }

            HStack(spacing: 4) {
                ForEach(MeetingReactionConstants.assetOptions) { option in
                    ReactionPickerButton(option: option, onSelect: onSelect)
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .acmGlassCapsule()
    }
}

private struct ReactionPickerButton: View {
    let option: MeetingReactionOption
    let onSelect: (MeetingReactionOption) -> Void

    var body: some View {
        Button {
            onSelect(option)
        } label: {
            Group {
                if option.kind == .emoji {
                    Text(option.value)
                        .font(.system(size: 25))
                } else {
                    ReactionAssetThumbnailView(
                        value: option.value,
                        label: option.label,
                        size: 30
                    )
                }
            }
            .frame(width: option.kind == .emoji ? 38.0 : 50.0, height: 38)
#if !SKIP
            .contentShape(Rectangle())
#endif
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Reaction Overlay

struct ReactionOverlayView: View {
    let reactions: [Reaction]
    let displayNameForUser: (String) -> String
    
    var body: some View {
        GeometryReader { geometry in
            ForEach(reactions) { reaction in
                FlyingReactionBubbleView(
                    reaction: reaction,
                    displayName: displayNameForUser(reaction.userId),
                    availableHeight: geometry.size.height
                )
                    .position(
                        x: CGFloat(reaction.lane + 1) * (geometry.size.width / 6.0),
                        y: max(80.0, geometry.size.height - 110.0)
                    )
                    .transition(.asymmetric(
                        insertion: .scale(scale: 0.72).combined(with: AnyTransition.opacity),
                        removal: .scale(scale: 1.08).combined(with: AnyTransition.opacity)
                    ))
            }
        }
        #if !SKIP
        .allowsHitTesting(false)
        #endif
    }
}

private struct FlyingReactionBubbleView: View {
    let reaction: Reaction
    let displayName: String
    let availableHeight: CGFloat
    @State private var isFlying = false

    var body: some View {
        ReactionBubbleView(reaction: reaction, displayName: displayName)
            .offset(
                x: isFlying ? MeetingReactionFlightPolicy.horizontalDrift(for: reaction.lane) : 0.0,
                y: isFlying ? -MeetingReactionFlightPolicy.verticalTravel(availableHeight: availableHeight) : 0.0
            )
            .rotationEffect(.degrees(isFlying ? Double(MeetingReactionFlightPolicy.horizontalDrift(for: reaction.lane) / 5.0) : 0.0))
            .scaleEffect(isFlying ? 1.06 : 0.82)
            .opacity(isFlying ? 0.18 : 1.0)
            .animation(
                Animation.easeOut(duration: MeetingReactionFlightPolicy.durationSeconds),
                value: isFlying
            )
            .onAppear {
                isFlying = true
            }
    }
}

private struct ReactionBubbleView: View {
    let reaction: Reaction
    let displayName: String

    var body: some View {
        VStack(spacing: 5) {
            ZStack {
                Circle()
                    .fill(ACMColors.surface.opacity(0.94))
                    .overlay {
                        Circle()
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.border)
                    }

                if reaction.kind == .emoji {
                    Text(reaction.value)
                        .font(.system(size: 30))
                } else {
                    ReactionAssetThumbnailView(
                        value: reaction.value,
                        label: reaction.label,
                        size: 42
                    )
                }
            }
            .frame(width: 58, height: 58)

            Text(displayName.isEmpty ? "Someone" : displayName)
                .font(ACMFont.trial(11, weight: .medium))
                .foregroundStyle(ACMColors.textMuted)
                .lineLimit(1)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .acmColorBackground(ACMColors.surface.opacity(0.9))
                .clipShape(Capsule())
        }
    }
}

struct ReactionAssetThumbnailView: View {
    let value: String
    let label: String?
    let size: CGFloat

    private var imageURL: URL? {
        MeetingReactionConstants.assetURL(
            value: value,
            baseURL: NativeAuthService.resolveAppBaseURL()
        )
    }

    private var displayLabel: String {
        MeetingReactionConstants.assetLabel(value: value, label: label)
    }

    var body: some View {
        Group {
            if let imageURL {
                #if SKIP
                ComposeView { _ in
                    AnimatedReactionAsset(
                        urlString: imageURL.absoluteString,
                        contentDescription: displayLabel
                    )
                }
                #else
                AsyncImage(url: imageURL) { image in
                    image
                        .resizable()
                        .scaledToFit()
                } placeholder: {
                    fallback
                }
                #endif
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(displayLabel)
    }

    private var fallback: some View {
        VStack(spacing: 1) {
            ACMSystemIcon.icon("sparkles", android: "reactions", size: max(14.0, size * 0.42), tint: "accent")
                .foregroundStyle(ACMColors.primaryOrange)
            Text(displayLabel)
                .font(ACMFont.trial(max(8.0, size * 0.21), weight: .medium))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
        }
    }
}
