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
    var showsParticipantsButton: Bool = true
    let onParticipantsPressed: () -> Void
    
    var body: some View {
        ACMGlassGroup(spacing: 12) {
            HStack(spacing: 12) {
                HStack(spacing: 6) {
                    if isRoomLocked {
                        ACMSystemIcon.icon("lock.fill", android: "lock", size: 12, tint: "accent")
                            .foregroundStyle(ACMColors.primaryOrange)
                    }

                    Text(roomId)
                        .font(ACMFont.trial(13, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .minimumScaleFactor(0.88)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                .acmGlassCapsule()

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
