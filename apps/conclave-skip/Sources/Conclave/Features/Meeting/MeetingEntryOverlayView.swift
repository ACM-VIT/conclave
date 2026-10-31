import SwiftUI

struct MeetingEntryOverlayView: View {
    let action: MeetingEntryAction?
    let showsAnimation: Bool

    init(action: MeetingEntryAction?, showsAnimation: Bool = true) {
        self.action = action
        self.showsAnimation = showsAnimation
    }

    private var caption: String {
        action == .new
            ? "Starting your meeting"
            : "Joining the meeting"
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if showsAnimation {
                ConclaveLottieView()
                    .ignoresSafeArea()
            }

            VStack(spacing: 0) {
                Spacer()
                Text(caption)
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.textMuted)
                    .padding(.bottom, 76)
            }
        }
        .onAppear {
            EntrySound.playEntryLock()
        }
    }
}
