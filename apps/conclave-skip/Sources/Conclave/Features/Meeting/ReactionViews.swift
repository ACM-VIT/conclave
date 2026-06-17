import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

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
                    Text(option.label)
                        .font(ACMFont.trial(10, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
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
                ReactionBubbleView(
                    reaction: reaction,
                    displayName: displayNameForUser(reaction.userId)
                )
                    .position(
                        x: CGFloat(reaction.lane + 1) * (geometry.size.width / 6.0),
                        y: geometry.size.height - 180.0
                    )
                    .transition(.asymmetric(
                        insertion: .scale(scale: 0.8).combined(with: AnyTransition.opacity),
                        removal: .move(edge: .top).combined(with: AnyTransition.opacity)
                    ))
            }
        }
        #if !SKIP
        .allowsHitTesting(false)
        #endif
        .animation(Animation.easeOut(duration: 0.3), value: reactions.count)
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
                    VStack(spacing: 1) {
                        ACMSystemIcon.icon("sparkles", android: "reactions", size: 17, tint: "accent")
                            .foregroundStyle(ACMColors.primaryOrange)
                        Text(MeetingReactionConstants.assetLabel(value: reaction.value, label: reaction.label))
                            .font(ACMFont.trial(9, weight: .medium))
                            .foregroundStyle(ACMColors.text)
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                    }
                    .padding(.horizontal, 5)
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
