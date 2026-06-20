import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Meeting Header

struct MeetingHeaderView: View {
    let roomId: String
    let isRoomLocked: Bool
    let connectionQuality: ConnectionQuality
    let participantCount: Int
    var showsParticipantsButton: Bool = true
    let onParticipantsPressed: () -> Void
    
    var body: some View {
        ACMGlassGroup(spacing: 12) {
            HStack(spacing: 12) {
                HStack(spacing: 6) {
                    if isRoomLocked {
                        ACMSystemIcon.icon("lock.fill", android: "lock", size: 12, tint: "orange")
                            .foregroundStyle(ACMColors.primaryOrange)
                    }

                    Text(roomId)
                        .font(ACMFont.trial(13, weight: .medium))
                        .foregroundStyle(ACMColors.text)

                    if connectionQuality != .unknown {
                        ConnectionQualityDot(quality: connectionQuality)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .acmGlassCapsule()

                Spacer()

                if showsParticipantsButton {
                    Button(action: onParticipantsPressed) {
                        ZStack {
                            HStack(spacing: 6) {
                                ACMSystemIcon.icon("person.2.fill", android: "participants", size: 13)

                                Text("\(participantCount)")
                                    .font(ACMFont.trial(13, weight: .medium))
                            }
                            .foregroundStyle(ACMColors.text)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .acmGlassCapsule(interactive: true)
#if SKIP
                            ACMAndroidSemanticText("Participants, \(participantCount)")
#endif
                        }
                    }
                    .accessibilityLabel("Participants, \(participantCount)")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

private struct ConnectionQualityDot: View {
    let quality: ConnectionQuality

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .accessibilityLabel(label)
    }

    private var color: Color {
        switch quality {
        case .emergency:
            return ACMColors.error
        case .good:
            return ACMColors.success
        case .fair:
            return ACMColors.handRaised
        case .poor:
            return ACMColors.error
        case .unknown:
            return ACMColors.textMuted
        }
    }

    private var label: String {
        switch quality {
        case .emergency:
            return "Very poor connection"
        case .good:
            return "Good connection"
        case .fair:
            return "Fair connection"
        case .poor:
            return "Poor connection"
        case .unknown:
            return "Measuring connection"
        }
    }
}
