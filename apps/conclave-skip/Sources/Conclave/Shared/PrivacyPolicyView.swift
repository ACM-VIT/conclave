import SwiftUI

/// Resolves the in-app privacy policy URL, preferring the runtime-configured
/// app host so dev builds point at the same backend the app is talking to.
enum PrivacyPolicyDestination {
    static let fallbackURLString = "https://conclave.acmvit.in/privacy"

    static var urlString: String {
        guard let base = NativeAuthService.resolveAppBaseURL(),
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return fallbackURLString
        }
        components.path = "/privacy"
        components.query = nil
        components.fragment = nil
        return components.url?.absoluteString ?? fallbackURLString
    }
}

/// Full-bleed privacy policy page rendered inside an in-app web view. Callers
/// supply the back action so this can slot into either the meeting sheet's
/// page navigation or a standalone sheet from the join screen. The "Done"
/// action dismisses the enclosing sheet via the environment, matching the
/// other meeting-sheet pages.
struct PrivacyPolicyPageView: View {
    var onBack: (() -> Void)? = nil
    var onDone: (() -> Void)? = nil
    var androidBodyHeight: CGFloat? = nil
    @Environment(\.dismiss) private var dismiss

    #if SKIP
    private var resolvedAndroidBodyHeight: CGFloat {
        max(260.0, androidBodyHeight ?? 520.0)
    }
    #endif

    var body: some View {
        VStack(spacing: 0) {
            MeetingSheetHeader(
                title: "Privacy Policy",
                onBack: onBack,
                onDone: { (onDone ?? { dismiss() })() }
            )

            #if SKIP
            NativeWebView(urlString: PrivacyPolicyDestination.urlString)
                .frame(maxWidth: .infinity)
                .frame(height: resolvedAndroidBodyHeight)
            #else
            NativeWebView(urlString: PrivacyPolicyDestination.urlString)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            #endif
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
