//
//  MeetingBannerOverlay.swift
//  Conclave
//
//  In-flow under the header because top-aligned overlays can make Skip duplicate
//  Compose-backed icons at the top of the stage.
//

import SwiftUI
import Observation

struct MeetingBannerOverlay: View {
    @Bindable var viewModel: MeetingViewModel
    let onShowParticipants: () -> Void

    private var isReconnecting: Bool {
        viewModel.state.connectionState == ConnectionState.reconnecting
    }
    private var isOffline: Bool {
        viewModel.state.isNetworkOffline
    }
    private var hasPending: Bool {
        viewModel.state.isAdmin && viewModel.state.pendingUsersCount > 0
    }
    private var hasServerRestartNotice: Bool {
        viewModel.state.serverRestartNotice != nil
    }
    private var hasAdminNotice: Bool {
        viewModel.state.adminNoticeMessage != nil
    }
    private var pendingText: String {
        let n = viewModel.state.pendingUsersCount
        return n == 1 ? "1 person waiting to join" : "\(n) people waiting to join"
    }

    var body: some View {
        if isOffline || isReconnecting || hasServerRestartNotice || hasAdminNotice || hasPending || viewModel.state.errorMessage != nil {
            VStack(spacing: ACMSpacing.xs) {
                if isOffline {
                    MeetingBanner(
                        iosIcon: "wifi.slash",
                        androidIcon: "warning",
                        iconTint: "danger",
                        iconColor: ACMColors.error,
                        text: "You're offline. Reconnect your internet to restore call audio and video.",
                        background: ACMColors.error.opacity(0.14),
                        border: ACMColors.error.opacity(0.34)
                    )
                } else if isReconnecting {
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

                if !isOffline, let restartNotice = viewModel.state.serverRestartNotice {
                    MeetingBanner(
                        iosIcon: "arrow.triangle.2.circlepath",
                        androidIcon: "warning",
                        iconTint: "amber",
                        iconColor: ACMColors.primaryOrange,
                        text: restartNotice,
                        background: ACMColors.primaryOrange.opacity(0.14),
                        border: ACMColors.primaryOrange.opacity(0.34)
                    )
                }

                if let adminNotice = viewModel.state.adminNoticeMessage {
                    MeetingBanner(
                        iosIcon: adminNoticeIOSIcon,
                        androidIcon: adminNoticeAndroidIcon,
                        iconTint: adminNoticeAndroidTint,
                        iconColor: adminNoticeColor,
                        text: adminNotice,
                        background: adminNoticeBackground,
                        border: adminNoticeBorder,
                        onClose: { viewModel.dismissAdminNotice() }
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

    private var adminNoticeIOSIcon: String {
        switch viewModel.state.adminNoticeLevel {
        case .info:
            return "info.circle.fill"
        case .warning:
            return "exclamationmark.triangle.fill"
        case .error:
            return "exclamationmark.triangle.fill"
        }
    }

    private var adminNoticeAndroidIcon: String {
        switch viewModel.state.adminNoticeLevel {
        case .info:
            return "info"
        case .warning, .error:
            return "warning"
        }
    }

    private var adminNoticeAndroidTint: String {
        switch viewModel.state.adminNoticeLevel {
        case .info, .warning:
            return "accent"
        case .error:
            return "danger"
        }
    }

    private var adminNoticeColor: Color {
        switch viewModel.state.adminNoticeLevel {
        case .info, .warning:
            return ACMColors.primaryOrange
        case .error:
            return ACMColors.error
        }
    }

    private var adminNoticeBackground: Color {
        switch viewModel.state.adminNoticeLevel {
        case .info:
            return ACMColors.surfaceRaised
        case .warning:
            return ACMColors.primaryOrange.opacity(0.14)
        case .error:
            return ACMColors.error.opacity(0.14)
        }
    }

    private var adminNoticeBorder: Color {
        switch viewModel.state.adminNoticeLevel {
        case .info:
            return ACMColors.border
        case .warning:
            return ACMColors.primaryOrange.opacity(0.34)
        case .error:
            return ACMColors.error.opacity(0.34)
        }
    }
}

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
