import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - More Sheet (phone overflow: reactions / hand / chat / participants / settings)

// A content view hosted inside `MeetingSheetView`. It no longer owns the sheet
// chrome (detents / background / drag indicator live on the container) and the
// Participants / Settings rows swap the container's page IN PLACE instead of
// dismissing and re-presenting — which removes the blank gap between two
// Material sheet animations.

struct MoreSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    let onOpenSettings: () -> Void
    let onOpenParticipants: () -> Void
    @Environment(\.dismiss) private var dismiss

    private let reactions = ["👍", "👏", "❤️", "🎉", "😂", "😮", "😢", "🤔"]

    var body: some View {
        VStack(spacing: 0) {
            MeetingSheetHeader(title: "More", onDone: { dismiss() })

            ScrollView {
                VStack(alignment: .leading, spacing: ACMSpacing.md) {
                    VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                        acmListSectionHeader("Quick reactions")

                        // A plain, evenly-distributed emoji row (no per-emoji box).
                        // Boxing each emoji AND giving it maxWidth:.infinity broke
                        // the Compose layout (only one rendered); a single HStack of
                        // bare emoji distributes correctly and reads more native.
                        HStack(spacing: 0) {
                            ForEach(reactions, id: \.self) { emoji in
                                Button {
                                    viewModel.sendReaction(emoji: emoji)
                                    dismiss()
                                } label: {
                                    Text(emoji)
                                        .font(.system(size: 26))
                                        .frame(maxWidth: .infinity)
                                        .frame(height: 48)
#if !SKIP
                                        .contentShape(Rectangle())
#endif
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                        acmListSectionHeader("Meeting actions")

                        MeetingSheetSectionCard {
                            MoreRow(
                                icon: viewModel.state.isHandRaised ? "hand.raised.fill" : "hand.raised",
                                androidIcon: viewModel.state.isHandRaised ? "raise.hand" : "raise.hand.off",
                                title: viewModel.state.isHandRaised ? "Lower hand" : "Raise hand",
                                tint: viewModel.state.isHandRaised ? ACMColors.handRaised : ACMColors.text,
                                androidTint: viewModel.state.isHandRaised ? "amber" : "text"
                            ) {
                                viewModel.toggleHandRaise()
                                dismiss()
                            }
                            MoreRowDivider()
                            MoreRow(icon: "message.fill", androidIcon: "chat", title: "Chat") {
                                viewModel.toggleChat()
                                dismiss()
                            }
                            MoreRowDivider()
                            // Swaps the sheet's page in place — no dismiss / re-present.
                            MoreRow(icon: "person.2.fill", androidIcon: "participants", title: "Participants", showsChevron: true) {
                                onOpenParticipants()
                            }
                            MoreRowDivider()
                            MoreRow(icon: "doc.on.doc", androidIcon: "copy", title: "Copy meeting code") {
                                #if !SKIP
#if canImport(UIKit)
                                UIPasteboard.general.string = viewModel.state.roomId
#endif
                                HapticManager.shared.trigger(.success)
                                #endif
                                dismiss()
                            }
                            MoreRowDivider()
                            MoreRow(icon: "gearshape.fill", androidIcon: "settings", title: "Settings", showsChevron: true) {
                                onOpenSettings()
                            }
                        }
                    }
                }
                .padding(.horizontal, ACMSpacing.lg)
                .padding(.top, ACMSpacing.md)
                .padding(.bottom, ACMSpacing.lg)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct MoreRow: View {
    let icon: String
    let androidIcon: String
    let title: String
    var tint: Color = ACMColors.text
    var androidTint: String = "text"
    var showsChevron: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: icon,
                    androidIcon: androidIcon,
                    tint: tint,
                    androidTint: androidTint,
                    background: ACMColors.surfaceRaised
                )

                Text(title)
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(tint)
                    .lineLimit(1)

                Spacer()

                if showsChevron {
                    ACMSystemIcon.icon("chevron.right", android: "arrow.forward", size: 16, tint: "faint")
                        .foregroundStyle(ACMColors.textFaint)
                        .frame(width: 24, height: 24)
                }
            }
            .padding(.horizontal, ACMSpacing.sm)
            .frame(height: 52)
            .frame(maxWidth: .infinity, alignment: .leading)
            #if !SKIP
            .contentShape(Rectangle())
            #endif
        }
        .buttonStyle(.plain)
    }
}

/// Hairline divider between MoreRows (inset to align with the label, like a
/// native grouped list).
struct MoreRowDivider: View {
    var body: some View {
        MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
    }
}
