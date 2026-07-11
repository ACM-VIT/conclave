import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Meeting Header

enum MeetingHeaderLayout {
    static let roomPillMaxWidth: CGFloat = 152.0
    // 32pt pills plus the header's 12pt vertical padding on each edge.
    // Connection notices are positioned from this stable edge as overlays;
    // the stage itself begins here with no permanently reserved banner gap.
    static let barHeight: CGFloat = 56.0
}

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
                .frame(maxWidth: MeetingHeaderLayout.roomPillMaxWidth, alignment: .leading)
                .acmGlassCapsule()

                Spacer(minLength: 0)

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
