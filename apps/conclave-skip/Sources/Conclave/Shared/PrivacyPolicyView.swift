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

/// Full-bleed privacy policy page. Callers supply the back action so this can
/// slot into either the meeting sheet's page navigation or a standalone sheet
/// from the join screen. The "Done" action dismisses the enclosing sheet via
/// the environment, matching the other meeting-sheet pages.
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

            PrivacyPolicyContentView()
                .frame(maxWidth: .infinity)
                #if SKIP
                .frame(height: resolvedAndroidBodyHeight)
                #else
                .frame(maxHeight: .infinity)
                #endif
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .acmColorBackground(ACMColors.bg)
    }
}

private struct PrivacyPolicyContentView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ACMSpacing.md) {
                privacyParagraph("""
                This privacy policy applies to the c0nclav3 app (hereby referred to as "Application") for mobile devices that was created by ACM-VIT (hereby referred to as "Service Provider") as an Open Source service. This service is intended for use "AS IS".
                """)

                privacyHeading("Information Collection and Use")

                privacyParagraph("""
                The Application processes limited information needed to provide real-time communication. Any data transmitted is used only to service your request in real time and is not retained by the Service Provider after the session ends, except as described below.
                """)

                privacyBullet("Basic session data such as room identifiers and display name")
                privacyBullet("Real-time audio/video and chat content sent during a meeting")

                privacyParagraph("The Application does not gather precise information about the location of your mobile device.")

                privacyParagraph("""
                The Service Provider does not use your information for marketing and does not retain session data beyond what is required to provide the service in real time.
                """)

                privacyParagraph("""
                For a better experience, while using the Application, the Service Provider may require you to provide us with certain personally identifiable information, including but not limited to Email. This information is used to identify you during a session and is not stored by the Service Provider beyond the duration of the session.
                """)

                privacyHeading("Third Party Access")

                privacyParagraph("""
                The Service Provider does not share your personal information with third parties except to provide the service in real time. The Service Provider does not use third-party analytics or advertising SDKs to collect data from the Application.
                """)

                privacyBullet("as required by law, such as to comply with a subpoena, or similar legal process;")
                privacyBullet("when they believe in good faith that disclosure is necessary to protect their rights, protect your safety or the safety of others, investigate fraud, or respond to a government request;")
                privacyBullet("with their trusted services providers who work on their behalf, do not have an independent use of the information we disclose to them, and have agreed to adhere to the rules set forth in this privacy statement.")

                privacyHeading("Opt-Out Rights")

                privacyParagraph("""
                You can stop all collection of information by the Application easily by uninstalling it. You may use the standard uninstall processes as may be available as part of your mobile device or via the mobile application marketplace or network.
                """)

                privacyHeading("Data Retention Policy")

                privacyParagraph("""
                The Service Provider does not retain User Provided data. Information processed during a session exists only in memory and is discarded when the session ends. If you have questions about data handling, please contact technicaldirector.acmvit@gmail.com.
                """)

                privacyHeading("Children")

                privacyParagraph("The Service Provider does not use the Application to knowingly solicit data from or market to children under the age of 13.")

                privacyParagraph("""
                The Application does not address anyone under the age of 13. The Service Provider does not knowingly collect personally identifiable information from children under 13 years of age. In the case the Service Provider discover that a child under 13 has provided personal information, the Service Provider will immediately delete this from their servers. If you are a parent or guardian and you are aware that your child has provided us with personal information, please contact the Service Provider (technicaldirector.acmvit@gmail.com) so that they will be able to take the necessary actions.
                """)

                privacyHeading("Security")

                privacyParagraph("""
                The Service Provider is concerned about safeguarding the confidentiality of your information. The Service Provider provides physical, electronic, and procedural safeguards to protect information the Service Provider processes and maintains.
                """)

                privacyHeading("Changes")

                privacyParagraph("""
                This Privacy Policy may be updated from time to time for any reason. The Service Provider will notify you of any changes to the Privacy Policy by updating this page with the new Privacy Policy. You are advised to consult this Privacy Policy regularly for any changes, as continued use is deemed approval of all changes.
                """)

                privacyParagraph("This privacy policy is effective as of 2026-01-28")

                privacyHeading("Your Consent")

                privacyParagraph("""
                By using the Application, you are consenting to the processing of your information as set forth in this Privacy Policy now and as amended by us.
                """)

                privacyHeading("Contact Us")

                privacyParagraph("""
                If you have any questions regarding privacy while using the Application, or have questions about the practices, please contact the Service Provider via email at technicaldirector.acmvit@gmail.com.
                """)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, ACMSpacing.lg)
            .padding(.top, ACMSpacing.lg)
            .padding(.bottom, ACMSpacing.xxl)
        }
        .acmColorBackground(ACMColors.bg)
    }

    private func privacyHeading(_ title: String) -> some View {
        Text(title)
            .font(ACMFont.trial(18, weight: .bold))
            .foregroundStyle(ACMColors.text)
            .padding(.top, ACMSpacing.xs)
            .accessibilityAddTraits(.isHeader)
    }

    private func privacyParagraph(_ text: String) -> some View {
        Text(text)
            .font(ACMFont.trial(15))
            .lineSpacing(4)
            .foregroundStyle(ACMColors.textMuted)
    }

    private func privacyBullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: ACMSpacing.sm) {
            Text("•")
                .font(ACMFont.trial(15, weight: .bold))
                .foregroundStyle(ACMColors.primaryOrange)
                .padding(.top, 1)
            privacyParagraph(text)
        }
    }
}
