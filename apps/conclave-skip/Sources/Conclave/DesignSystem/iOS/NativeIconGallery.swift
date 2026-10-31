#if DEBUG && os(iOS) && !SKIP
import SwiftUI
import UIKit

struct NativeSymbolSpecimen: Identifiable {
    let id: String
    let caption: String
    let detail: String
    let symbol: String?
}

struct NativeIconGalleryDisclosure: View {
    @State private var expanded = false
    @State private var microphoneOn = true
    @State private var captionsOn = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            if expanded {
                Text("Inert symbols. Sample controls do not access devices or send feedback.")
                    .font(.subheadline)
                microphoneSample
                captionsSample
                NativeCloseSample()

                ForEach(NativeSymbolCatalog.rows) { specimen in
                    NativeSymbolGalleryRow(specimen: specimen)
                }
            }
        } label: {

            Text("Icon Gallery")
                .accessibilityIdentifier("icons.gallery.toggle")
        }
    }

    private var microphoneSample: some View {
        Button { microphoneOn.toggle() } label: {
            Label {
                Text("Microphone")
            } icon: {
                Image(systemName: microphoneOn ? ConclaveSymbols.micFill : ConclaveSymbols.micSlashFill)
                    .symbolRenderingMode(.monochrome)
                    .modifier(NativeIconFlatRendering())
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 44)
        }
        .accessibilityLabel("Microphone")
        .accessibilityValue(microphoneOn ? "On" : "Muted")
        .accessibilityAddTraits(.isToggle)
        .accessibilityIdentifier("icons.sample.microphone")
    }

    private var captionsSample: some View {
        Toggle(isOn: $captionsOn) {
            Label {
                Text("Captions")
            } icon: {
                Image(systemName: captionsOn ? ConclaveSymbols.captionsBubbleFill : ConclaveSymbols.captionsBubble)
                    .symbolRenderingMode(.monochrome)
                    .modifier(NativeIconFlatRendering())
                    .accessibilityHidden(true)
            }
        }
        .accessibilityValue(captionsOn ? "On" : "Off")
        .accessibilityIdentifier("icons.sample.captions")
    }
}

private struct NativeCloseSample: View {
    var body: some View {
        HStack(spacing: 12) {
            Text("Close sample, inert")
            Spacer()
            if #available(iOS 26.0, *) {
                Button(role: .close) {}
                    .accessibilityIdentifier("icons.sample.close")
            } else {
                Button {} label: {
                    Image(systemName: ConclaveSymbols.xmark)
                        .symbolRenderingMode(.monochrome)
                        .accessibilityHidden(true)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("Close")
                .accessibilityIdentifier("icons.sample.close")
            }
        }
    }
}

private struct NativeSymbolGalleryRow: View {
    let specimen: NativeSymbolSpecimen

    var body: some View {
        HStack(spacing: 12) {
            if let symbol = specimen.symbol {
                Image(systemName: symbol)
                    .symbolRenderingMode(.monochrome)
                    .modifier(NativeIconFlatRendering())
                    .font(.title2)
                    .frame(minWidth: 32, minHeight: 44)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(specimen.caption)

                Text(specimen.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                if let symbol = specimen.symbol {
                    Text(UIImage(systemName: symbol) == nil ? "Symbol unavailable on this OS" : "System symbol available")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("icons.symbol.\(specimen.id)")
    }
}

private struct NativeIconFlatRendering: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.symbolColorRenderingMode(.flat)
        } else {
            content
        }
    }
}
#endif
