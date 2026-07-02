import SwiftUI
// Lottie is linked iOS-only (see Package.swift). Gate on os(iOS), not
// canImport — canImport is true on the macOS transpile host (the module is
// checked out) even though it isn't linked there, which would fail at link.
#if os(iOS)
import Lottie
#endif

/// The branded Conclave lockup animation used by the meeting-entry takeover.
/// iOS uses Lottie's dotLottie support; Android uses LottieFiles'
/// dotlottie-android Compose player.
struct ConclaveLottieView: View {
    var body: some View {
        #if SKIP
        ComposeView { _ in
            ConclaveLottieComposable()
        }
        #elseif os(iOS)
        LottieView {
            try await DotLottieFile.named("conclave-animation", bundle: Bundle.module)
        }
        .looping()
        .animationSpeed(3)
        #else
        Color.black
        #endif
    }
}
