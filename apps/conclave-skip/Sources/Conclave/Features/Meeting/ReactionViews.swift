import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Reaction Picker

struct ReactionPickerView: View {
    let onSelect: (String) -> Void
    
    let reactions = ["👍", "👏", "❤️", "🎉", "😂", "😮", "😢", "🤔"]
    
    var body: some View {
        HStack(spacing: 2) {
            ForEach(reactions, id: \.self) { emoji in
                Button {
                    onSelect(emoji)
                } label: {
                    Text(emoji)
                        .font(.system(size: 26))
                        .frame(width: 40, height: 40)
#if !SKIP
                        .contentShape(Rectangle())
#endif
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .acmGlassCapsule()
    }
}

// MARK: - Reaction Overlay

struct ReactionOverlayView: View {
    let reactions: [Reaction]
    
    var body: some View {
        GeometryReader { geometry in
            ForEach(reactions) { reaction in
                Text(reaction.value)
                    .font(.system(size: 32))
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

