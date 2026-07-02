import SwiftUI

/// Full-screen branded takeover shown the instant a meeting is created or joined
/// (mirrors the web's `MeetingEnterOverlay`). It stays up — over both the join
/// screen and the meeting — until `MeetingViewModel` reports the meeting fully
/// ready, so the entry feels instant and the post-join device-init hiccups are
/// hidden. Errors clear the takeover and hand off to the existing `ErrorView`.
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
