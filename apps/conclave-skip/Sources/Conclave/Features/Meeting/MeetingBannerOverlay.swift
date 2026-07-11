//  Transient meeting notices rendered above the stage. This view deliberately
//  owns no in-flow spacer: banners must not move/recompose video tiles, and an
//  empty banner state must not leave a dead strip below the meeting header.

import SwiftUI
import Observation

struct QualityBannerInfo {
    let iosIcon: String
    let androidIcon: String
    let iconTint: String
    let iconColor: Color
    let text: String
    let background: Color
    let border: Color
}

enum MeetingBannerSlotLayout {
    static let overlayHeight: CGFloat = 58.0
}

enum MeetingQualityBannerPolicy {
    static func severity(_ quality: ConnectionQuality) -> Int {
        switch quality {
        case .fair: return 0
        case .poor: return 2
        case .emergency: return 3
        case .good, .unknown: return 0
        }
    }

    static func shouldResetDismissal(for quality: ConnectionQuality) -> Bool {
        quality == .good
    }
}

struct MeetingBannerOverlay: View {
    @Bindable var viewModel: MeetingViewModel
    let onShowParticipants: () -> Void

    // Highest quality-degradation severity the user has dismissed. The banner
    // only re-appears if the connection worsens beyond this, and it resets once
    // the connection has genuinely recovered to good.
    @State private var dismissedQualitySeverity: Int = 0

    private var isRecovering: Bool {
        viewModel.state.isRecoveringConnection ||
            viewModel.state.connectionState == ConnectionState.reconnecting
    }
    private var isOffline: Bool {
        viewModel.state.isNetworkOffline
    }
    private var hasPending: Bool {
        viewModel.state.isAdmin && viewModel.state.pendingUsersCount > 0
    }
    private var pendingText: String {
        let n = viewModel.state.pendingUsersCount
        return n == 1 ? "1 person waiting to join" : "\(n) people waiting to join"
    }

    private var currentQualitySeverity: Int {
        MeetingQualityBannerPolicy.severity(viewModel.state.connectionQuality)
    }

    // Offline/reconnecting banners take priority and already explain the outage,
    // so quality warnings stay suppressed while either is showing.
    private var shouldShowQualityBanner: Bool {
        guard !isOffline, !isRecovering else { return false }
        guard viewModel.state.connectionState == .joined else { return false }
        return currentQualitySeverity > 0 && currentQualitySeverity > dismissedQualitySeverity
    }

    private var qualityBannerInfo: QualityBannerInfo? {
        switch viewModel.state.connectionQuality {
        case .emergency:
            return QualityBannerInfo(
                iosIcon: "wifi.exclamationmark", androidIcon: "warning", iconTint: "danger",
                iconColor: ACMColors.error,
                text: "Very poor connection. Audio may cut out.",
                background: ACMColors.error.opacity(0.14), border: ACMColors.error.opacity(0.34)
            )
        case .poor:
            return QualityBannerInfo(
                iosIcon: "wifi.exclamationmark", androidIcon: "warning", iconTint: "accent",
                iconColor: ACMColors.primaryOrange,
                text: "Poor connection quality. Video may be limited.",
                background: ACMColors.primaryOrange.opacity(0.14), border: ACMColors.primaryOrange.opacity(0.34)
            )
        case .fair, .good, .unknown:
            return nil
        }
    }

    var body: some View {
        ZStack(alignment: .top) {
            Group {
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
                } else if isRecovering {
                    MeetingBanner(
                        iosIcon: "wifi",
                        androidIcon: "warning",
                        iconTint: "amber",
                        iconColor: ACMColors.primaryOrange,
                        text: viewModel.state.serverRestartNotice ??
                            "Connection interrupted. Restoring audio and video — mic and camera changes will be applied.",
                        background: ACMColors.surfaceRaised,
                        border: ACMColors.border,
                        showSpinner: true
                    )
                } else if let restartNotice = viewModel.state.serverRestartNotice {
                    MeetingBanner(
                        iosIcon: "arrow.triangle.2.circlepath",
                        androidIcon: "warning",
                        iconTint: "amber",
                        iconColor: ACMColors.primaryOrange,
                        text: restartNotice,
                        background: ACMColors.primaryOrange.opacity(0.14),
                        border: ACMColors.primaryOrange.opacity(0.34)
                    )
                } else if let error = viewModel.state.errorMessage {
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
                } else if let adminNotice = viewModel.state.adminNoticeMessage {
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
                } else if hasPending {
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
                } else if shouldShowQualityBanner, let info = qualityBannerInfo {
                    MeetingBanner(
                        iosIcon: info.iosIcon,
                        androidIcon: info.androidIcon,
                        iconTint: info.iconTint,
                        iconColor: info.iconColor,
                        text: info.text,
                        background: info.background,
                        border: info.border,
                        onClose: { dismissedQualitySeverity = currentQualitySeverity }
                    )
                }
            }
            .padding(.horizontal, ACMSpacing.sm)
            .padding(.top, ACMSpacing.xs)
        }
        .frame(height: MeetingBannerSlotLayout.overlayHeight, alignment: .top)
        #if SKIP
        .onChange(of: "\(currentQualitySeverity)") {
            if MeetingQualityBannerPolicy.shouldResetDismissal(
                for: viewModel.state.connectionQuality
            ) {
                dismissedQualitySeverity = 0
            }
        }
        #else
        .onChange(of: viewModel.state.connectionQuality) { _, newValue in
            if MeetingQualityBannerPolicy.shouldResetDismissal(for: newValue) {
                dismissedQualitySeverity = 0
            }
        }
        #endif
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
