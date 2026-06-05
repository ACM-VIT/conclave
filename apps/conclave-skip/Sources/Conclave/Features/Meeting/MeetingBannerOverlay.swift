//
//  MeetingBannerOverlay.swift
//  Conclave
//
//  In-call banner strip shown under the header: a reconnecting indicator, an
//  ambient "waiting to join" host cue (the phone pill has no pending badge), and
//  transient recoverable errors. Before this, `.reconnecting` showed nothing and
//  the ~dozen mid-call `errorMessage` assignments (failed mute / camera /
//  screen-share / chat) were written to state but read by no view while joined,
//  so they were silently dropped.
//
//  Rendered IN-FLOW under the header (not a `ZStack(.top)` / `.overlay(.top)`)
//  because Skip re-hosts a top-aligned ComposeView's icons as a ghost at the top
//  of the stage — in-flow placement renders the glyphs once, cleanly.
//

import SwiftUI
import Observation

struct MeetingBannerOverlay: View {
    @Bindable var viewModel: MeetingViewModel
    let onShowParticipants: () -> Void

    private var isReconnecting: Bool {
        viewModel.state.connectionState == ConnectionState.reconnecting
    }
    private var hasPending: Bool {
        viewModel.state.isAdmin && viewModel.state.pendingUsersCount > 0
    }
    private var pendingText: String {
        let n = viewModel.state.pendingUsersCount
        return n == 1 ? "1 person waiting to join" : "\(n) people waiting to join"
    }

    var body: some View {
        if isReconnecting || hasPending || viewModel.state.errorMessage != nil {
            VStack(spacing: ACMSpacing.xs) {
                if isReconnecting {
                    MeetingBanner(
                        iosIcon: "wifi",
                        androidIcon: "warning",
                        iconTint: "amber",
                        iconColor: ACMColors.primaryOrange,
                        text: "Reconnecting…",
                        background: ACMColors.surfaceRaised,
                        border: ACMColors.border,
                        showSpinner: true
                    )
                }

                if hasPending {
                    Button {
                        onShowParticipants()
                    } label: {
                        MeetingBanner(
                            iosIcon: "person.crop.circle.badge.clock",
                            androidIcon: "account",
                            iconTint: "accent",
                            iconColor: ACMColors.primaryOrange,
                            text: pendingText,
                            background: ACMColors.primaryOrange.opacity(0.14),
                            border: ACMColors.primaryOrange.opacity(0.34),
                            trailingChevron: true
                        )
                    }
                    .buttonStyle(.plain)
                }

                if let error = viewModel.state.errorMessage {
                    MeetingBanner(
                        iosIcon: "exclamationmark.triangle.fill",
                        androidIcon: "warning",
                        iconTint: "danger",
                        iconColor: ACMColors.error,
                        text: error,
                        background: ACMColors.error.opacity(0.14),
                        border: ACMColors.error.opacity(0.34),
                        onClose: { viewModel.dismissError() }
                    )
                }
            }
            .padding(.horizontal, ACMSpacing.sm)
            .padding(.top, ACMSpacing.xs)
        }
    }
}

/// A single flat banner row: leading status glyph (or spinner), message, and an
/// optional trailing chevron (tappable banners) or close button (errors).
struct MeetingBanner: View {
    let iosIcon: String
    let androidIcon: String
    let iconTint: String
    let iconColor: Color
    let text: String
    let background: Color
    let border: Color
    var showSpinner: Bool = false
    var trailingChevron: Bool = false
    var onClose: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: ACMSpacing.sm) {
            if showSpinner {
                ProgressView()
                    #if SKIP
                    .progressViewStyle(.circular)
                    #endif
                    .tint(ACMColors.primaryOrange)
                    .frame(width: 18, height: 18)
            } else {
                ACMSystemIcon.icon(iosIcon, android: androidIcon, size: 16, tint: iconTint)
                    .foregroundStyle(iconColor)
                    .frame(width: 20, height: 20)
            }

            Text(text)
                .font(ACMFont.trial(13, weight: .medium))
                .foregroundStyle(ACMColors.text)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            if trailingChevron {
                ACMSystemIcon.icon("chevron.right", android: "arrow.forward", size: 14, tint: "muted")
                    .foregroundStyle(ACMColors.textMuted)
                    .frame(width: 18, height: 18)
            }

            if let onClose {
                Button(action: onClose) {
                    ACMSystemIcon.icon("xmark", android: "close", size: 14, tint: "muted")
                        .foregroundStyle(ACMColors.textMuted)
                        .frame(width: 24, height: 24)
                        #if !SKIP
                        .contentShape(Rectangle())
                        #endif
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, ACMSpacing.md)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .acmColorBackground(background)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.md)
                .strokeBorder(border, lineWidth: 1)
        }
    }
}
