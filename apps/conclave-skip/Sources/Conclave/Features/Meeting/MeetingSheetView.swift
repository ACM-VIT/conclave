//
//  MeetingSheetView.swift
//  Conclave
//
//  A single bottom sheet that swaps its content in place (More / Participants /
//  Settings) instead of dismissing one sheet and presenting another. On Skip
//  every `.sheet` is a native Material `ModalBottomSheet`; presenting a second
//  sheet only after the first finishes dismissing (the old `onDismiss` chain)
//  produced a visible ~half-second blank gap between two animations. Swapping
//  content inside one persistent sheet removes that presentation gap while the
//  page content handles its own push/pop transition.
//

import SwiftUI
import Observation

enum MeetingSheetPage: Equatable {
    case more
    case participants
    case settings
}

private enum MeetingSheetNavigationDirection {
    case push
    case pop

    var transition: AnyTransition {
        switch self {
        case .push:
            return .asymmetric(
                insertion: .move(edge: .trailing),
                removal: .move(edge: .leading)
            )
        case .pop:
            return .asymmetric(
                insertion: .move(edge: .leading),
                removal: .move(edge: .trailing)
            )
        }
    }
}

struct MeetingSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    @Binding var page: MeetingSheetPage
    @State private var navigationDirection: MeetingSheetNavigationDirection = .push

    private static let pageAnimation = Animation.easeInOut(duration: 0.18)

    private func navigate(to nextPage: MeetingSheetPage) {
        guard page != nextPage else { return }

        navigationDirection = nextPage == .more ? .pop : .push
        withAnimation(Self.pageAnimation) {
            page = nextPage
        }
    }

    var body: some View {
        ZStack(alignment: .top) {
            switch page {
            case .more:
                MoreSheetView(
                    viewModel: viewModel,
                    onOpenSettings: { navigate(to: .settings) },
                    onOpenParticipants: { navigate(to: .participants) }
                )
                .transition(navigationDirection.transition)
            case .participants:
                ParticipantsSheetView(viewModel: viewModel, onBack: { navigate(to: .more) })
                    .transition(navigationDirection.transition)
            case .settings:
                SettingsSheetView(viewModel: viewModel, onBack: { navigate(to: .more) })
                    .transition(navigationDirection.transition)
            }
        }
        .animation(Self.pageAnimation, value: page)
        .clipped()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // The sheet base is the app's darkest surface so the lighter rows /
        // cards inside each page keep their contrast (More's surfaceRaised card,
        // the participants/settings surface rows).
        .acmColorBackground(ACMColors.bg)
        .preferredColorScheme(.dark)
        // Brand the native Material controls (switches, picker, caret) with the
        // Carbon accent instead of iOS blue/green.
        .tint(ACMColors.primaryOrange)
        // One fixed detent for every page so the Material sheet never re-measures
        // / re-settles when the content swaps — a single clean spring reads as
        // instant. ~62% leaves the scrollable lists room while keeping More from
        // opening near-full.
        .presentationDetents([.fraction(0.62)])
        #if !SKIP
        .presentationDragIndicator(.visible)
        #endif
    }
}

/// Shared pinned header for the in-sheet pages. Replaces the per-sheet
/// `NavigationStack` + `.toolbar`, which Skip lowered into a full
/// `NavHost + Scaffold + CenterAlignedTopAppBar` on every open (pure overhead,
/// and an un-native iOS-style app bar inside an Android bottom sheet). A plain
/// `HStack` row is cheap and reads correctly on both platforms.
struct MeetingSheetHeader: View {
    let title: String
    var onBack: (() -> Void)? = nil
    let onDone: () -> Void

    var body: some View {
        // Plain native chrome: a bare back chevron and bare "Done" text — no
        // boxed/bordered buttons (those read as un-native on a bottom sheet).
        HStack(spacing: ACMSpacing.xs) {
            if let onBack {
                Button(action: onBack) {
                    ACMSystemIcon.icon("chevron.left", android: "back", size: 24, tint: "text")
                        .foregroundStyle(ACMColors.text)
                        .frame(width: 36, height: 36)
                        #if !SKIP
                        .contentShape(Rectangle())
                        #endif
                }
                .buttonStyle(.plain)
            }

            Text(title)
                .font(ACMFont.trial(18, weight: .semibold))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)

            Spacer()

            Button(action: onDone) {
                Text("Done")
                    .font(ACMFont.trial(16, weight: .medium))
                    .foregroundStyle(ACMColors.primaryOrange)
                    .frame(height: 36)
                    #if !SKIP
                    .contentShape(Rectangle())
                    #endif
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.top, ACMSpacing.md)
        .padding(.bottom, ACMSpacing.sm)
    }
}

struct MeetingSheetSectionCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .acmColorBackground(ACMColors.surface)
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.sm)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.border)
        }
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
    }
}

struct MeetingSheetRowDivider: View {
    var inset: CGFloat = 0

    var body: some View {
        Rectangle()
            .fill(ACMColors.border)
            .frame(height: 1)
            .padding(.leading, inset)
    }
}

struct MeetingSheetIconBox: View {
    let icon: String
    let androidIcon: String
    var tint: Color = ACMColors.textMuted
    var androidTint: String = "muted"
    // Kept for call-site compatibility; no longer drawn as a box. A bordered box
    // around every list icon reads as un-native — a plain tinted glyph in a fixed
    // frame (so the row dividers still align) is the native list anatomy.
    var background: Color = ACMColors.surfaceRaised

    var body: some View {
        ACMSystemIcon.icon(icon, android: androidIcon, size: 22, tint: androidTint)
            .foregroundStyle(tint)
            .frame(width: 32, height: 32)
    }
}

struct MeetingSheetStatusPill: View {
    let title: String
    var tint: Color = ACMColors.textMuted
    var background: Color = ACMColors.surfaceRaised
    var border: Color = ACMColors.border

    init(_ title: String, tint: Color = ACMColors.textMuted, background: Color = ACMColors.surfaceRaised, border: Color = ACMColors.border) {
        self.title = title
        self.tint = tint
        self.background = background
        self.border = border
    }

    var body: some View {
        Text(title)
            .font(ACMFont.trial(11, weight: .medium))
            .foregroundStyle(tint)
            .padding(.horizontal, ACMSpacing.xs)
            .padding(.vertical, 3)
            .acmColorBackground(background)
            .overlay {
                Capsule()
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(border)
            }
            .clipShape(Capsule())
    }
}
