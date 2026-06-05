import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Meeting Header

struct MeetingHeaderView: View {
    let roomId: String
    let isRoomLocked: Bool
    let participantCount: Int
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
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .acmGlassCapsule()

                Spacer()

                Button(action: onParticipantsPressed) {
                    HStack(spacing: 6) {
                        ACMSystemIcon.icon("person.2.fill", android: "participants", size: 13)

                        Text("\(participantCount)")
                            .font(ACMFont.trial(13, weight: .medium))
                    }
                    .foregroundStyle(ACMColors.text)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .acmGlassCapsule(interactive: true)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

