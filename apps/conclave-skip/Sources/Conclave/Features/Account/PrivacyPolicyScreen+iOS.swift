#if os(iOS) && !SKIP
import SwiftUI

struct PrivacyPolicyScreen: View {
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(PrivacyPolicyDocument.blocks) { block in
                    PrivacyPolicyBlockView(block: block)
                }
                PrivacyPolicyWebLink()
                    .padding(.top, 8)
            }
            .frame(maxWidth: 680, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle(ConclaveStrings.text("Privacy Policy"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("privacy.page")
    }
}

private struct PrivacyPolicyBlockView: View {
    let block: PrivacyPolicyBlock

    var body: some View {
        switch block.kind {
        case .heading:
            Text(verbatim: block.text)
                .font(.headline)
                .padding(.top, 8)
                .accessibilityAddTraits(.isHeader)
        case .paragraph:
            Text(verbatim: block.text)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        case .bullet:
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: "\u{2022}")
                    .accessibilityHidden(true)
                Text(verbatim: block.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.body)
        }
    }
}

private struct PrivacyPolicyWebLink: View {
    var body: some View {
        if let url = URL(string: PrivacyPolicyDestination.urlString) {
            Link(ConclaveStrings.text("View on the Web"), destination: url)
                .tint(HostingTheme.coralText)
                .accessibilityIdentifier("privacy.web")
        }
    }
}
#endif
