import Foundation

// ENT-7 (S10 5 c, d; RECONCILE OQ9, S10 Q13): the privacy policy text for the native Privacy Policy pages, verbatim
// from the legacy `PrivacyPolicyContentView` (S/Shared/PrivacyPolicyView.swift) in the same order. The owner deferred
// the legal update (OQ9): keep it verbatim, product name included, until the legal copy arrives; the update replaces
// it here and in the legacy view together (T/ENT7AccountTests.swift checks the two match). Shared Swift data, so both
// platforms render one source; legal text is not translated (shared presenter strings stay in Swift, owner Q14).

enum PrivacyPolicyBlockKind: String, CaseIterable, Equatable {
    case heading, paragraph, bullet
}

struct PrivacyPolicyBlock: Equatable, Identifiable {
    let id: Int
    let kind: PrivacyPolicyBlockKind
    let text: String
}

enum PrivacyPolicyDocument {
    static let blocks: [PrivacyPolicyBlock] = [
        PrivacyPolicyBlock(id: 0, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "This privacy policy applies to the c0nclav3 app (hereby referred to as \"Application\") for mobile devices that was created by ACM-VIT (hereby referred to as \"Service Provider\") as an Open Source service. This service is intended for use \"AS IS\"."),
        PrivacyPolicyBlock(id: 1, kind: PrivacyPolicyBlockKind.heading,
                           text: "Information Collection and Use"),
        PrivacyPolicyBlock(id: 2, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "The Application processes limited information needed to provide real-time communication. Any data transmitted is used only to service your request in real time and is not retained by the Service Provider after the session ends, except as described below."),
        PrivacyPolicyBlock(id: 3, kind: PrivacyPolicyBlockKind.bullet,
                           text: "Basic session data such as room identifiers and display name"),
        PrivacyPolicyBlock(id: 4, kind: PrivacyPolicyBlockKind.bullet,
                           text: "Real-time audio/video and chat content sent during a meeting"),
        PrivacyPolicyBlock(id: 5, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "The Application does not gather precise information about the location of your mobile device."),
        PrivacyPolicyBlock(id: 6, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "The Service Provider does not use your information for marketing and does not retain session data beyond what is required to provide the service in real time."),
        PrivacyPolicyBlock(id: 7, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "For a better experience, while using the Application, the Service Provider may require you to provide us with certain personally identifiable information, including but not limited to Email. This information is used to identify you during a session and is not stored by the Service Provider beyond the duration of the session."),
        PrivacyPolicyBlock(id: 8, kind: PrivacyPolicyBlockKind.heading,
                           text: "Third Party Access"),
        PrivacyPolicyBlock(id: 9, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "The Service Provider does not share your personal information with third parties except to provide the service in real time. The Service Provider does not use third-party analytics or advertising SDKs to collect data from the Application."),
        PrivacyPolicyBlock(id: 10, kind: PrivacyPolicyBlockKind.bullet,
                           text: "as required by law, such as to comply with a subpoena, or similar legal process;"),
        PrivacyPolicyBlock(id: 11, kind: PrivacyPolicyBlockKind.bullet,
                           text: "when they believe in good faith that disclosure is necessary to protect their rights, protect your safety or the safety of others, investigate fraud, or respond to a government request;"),
        PrivacyPolicyBlock(id: 12, kind: PrivacyPolicyBlockKind.bullet,
                           text: "with their trusted services providers who work on their behalf, do not have an independent use of the information we disclose to them, and have agreed to adhere to the rules set forth in this privacy statement."),
        PrivacyPolicyBlock(id: 13, kind: PrivacyPolicyBlockKind.heading,
                           text: "Opt-Out Rights"),
        PrivacyPolicyBlock(id: 14, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "You can stop all collection of information by the Application easily by uninstalling it. You may use the standard uninstall processes as may be available as part of your mobile device or via the mobile application marketplace or network."),
        PrivacyPolicyBlock(id: 15, kind: PrivacyPolicyBlockKind.heading,
                           text: "Data Retention Policy"),
        PrivacyPolicyBlock(id: 16, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "The Service Provider does not retain User Provided data. Information processed during a session exists only in memory and is discarded when the session ends. If you have questions about data handling, please contact technicaldirector.acmvit@gmail.com."),
        PrivacyPolicyBlock(id: 17, kind: PrivacyPolicyBlockKind.heading,
                           text: "Children"),
        PrivacyPolicyBlock(id: 18, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "The Service Provider does not use the Application to knowingly solicit data from or market to children under the age of 13."),
        PrivacyPolicyBlock(id: 19, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "The Application does not address anyone under the age of 13. The Service Provider does not knowingly collect personally identifiable information from children under 13 years of age. In the case the Service Provider discover that a child under 13 has provided personal information, the Service Provider will immediately delete this from their servers. If you are a parent or guardian and you are aware that your child has provided us with personal information, please contact the Service Provider (technicaldirector.acmvit@gmail.com) so that they will be able to take the necessary actions."),
        PrivacyPolicyBlock(id: 20, kind: PrivacyPolicyBlockKind.heading,
                           text: "Security"),
        PrivacyPolicyBlock(id: 21, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "The Service Provider is concerned about safeguarding the confidentiality of your information. The Service Provider provides physical, electronic, and procedural safeguards to protect information the Service Provider processes and maintains."),
        PrivacyPolicyBlock(id: 22, kind: PrivacyPolicyBlockKind.heading,
                           text: "Changes"),
        PrivacyPolicyBlock(id: 23, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "This Privacy Policy may be updated from time to time for any reason. The Service Provider will notify you of any changes to the Privacy Policy by updating this page with the new Privacy Policy. You are advised to consult this Privacy Policy regularly for any changes, as continued use is deemed approval of all changes."),
        PrivacyPolicyBlock(id: 24, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "This privacy policy is effective as of 2026-01-28"),
        PrivacyPolicyBlock(id: 25, kind: PrivacyPolicyBlockKind.heading,
                           text: "Your Consent"),
        PrivacyPolicyBlock(id: 26, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "By using the Application, you are consenting to the processing of your information as set forth in this Privacy Policy now and as amended by us."),
        PrivacyPolicyBlock(id: 27, kind: PrivacyPolicyBlockKind.heading,
                           text: "Contact Us"),
        PrivacyPolicyBlock(id: 28, kind: PrivacyPolicyBlockKind.paragraph,
                           text: "If you have any questions regarding privacy while using the Application, or have questions about the practices, please contact the Service Provider via email at technicaldirector.acmvit@gmail.com.")
    ]
}
