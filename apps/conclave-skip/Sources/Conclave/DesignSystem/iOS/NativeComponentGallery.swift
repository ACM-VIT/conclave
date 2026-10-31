#if DEBUG && os(iOS) && !SKIP
import SwiftUI
import UIKit

struct NativeComponentGalleryDisclosure: View {
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            if expanded {
                NativeComponentGalleryContent()
            }
        } label: {
            Text(ConclaveStrings.text("Component Gallery"))
                .accessibilityIdentifier(ComponentGalleryCatalog.galleryToggleID)
        }
    }
}

private struct NativeComponentGalleryContent: View {
    @State private var longText = false

    @State private var showLoading = false
    @State private var forceOpaque = false
    @State private var overflow = GalleryOverflowLedger()
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.legibilityWeight) private var legibilityWeight
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    var body: some View {
        let probe = GalleryProbe(ledger: overflow, configuration: [
            String(describing: dynamicTypeSize), legibilityWeight == .bold ? "bold" : "regular",
            longText ? "long" : "short", showLoading ? "loading" : "idle",
            String(describing: horizontalSizeClass), String(describing: verticalSizeClass),
        ].joined(separator: ","))
        Text(ConclaveStrings.text("Inert self-checks for type, haptics and contrast. Nothing here plays, records or connects."))
            .font(.subheadline)
            .foregroundStyle(HostingTheme.secondaryText)
        GalleryEnvironmentReadout(probe: probe, specimenCount: GallerySpecimens.ids(showLoading: showLoading).count)
        Toggle(ConclaveStrings.text("Long Text"), isOn: $longText)
            .accessibilityIdentifier(ComponentGalleryCatalog.longTextToggleID)
        Toggle(ConclaveStrings.text("Show Loading"), isOn: $showLoading)
            .accessibilityIdentifier(ComponentGalleryCatalog.showLoadingToggleID)
        Toggle(ConclaveStrings.text("Force Opaque Controls"), isOn: $forceOpaque)
            .accessibilityIdentifier(ComponentGalleryCatalog.forceOpaqueToggleID)
        GallerySectionDisclosure(section: .typography, title: ConclaveStrings.text("Typography")) {
            TypeSpecimenRows(longText: longText, probe: probe)
        }
        GallerySectionDisclosure(section: .haptics, title: ConclaveStrings.text("Haptics")) {
            HapticSpecimenRows(longText: longText, probe: probe)
        }
        GallerySectionDisclosure(section: .contrast, title: ConclaveStrings.text("Contrast")) {
            ContrastSpecimenRows(longText: longText, probe: probe)
        }
        GallerySectionDisclosure(section: .systemProminent, title: ConclaveStrings.text("System Prominent Chrome")) {
            SystemProminentSpecimens(probe: probe)
        }
        GallerySectionDisclosure(section: .buttons, title: ConclaveStrings.text("Buttons")) {
            ButtonSpecimens(longText: longText, showLoading: showLoading, probe: probe)
        }
        GallerySectionDisclosure(section: .callControls, title: ConclaveStrings.text("Call Controls")) {
            CallControlSpecimens(forceOpaque: forceOpaque, probe: probe)
                .environment(\.conclaveForceOpaqueControls, forceOpaque)
        }
        GallerySectionDisclosure(section: .rows, title: ConclaveStrings.text("Rows")) {
            RowSpecimens(longText: longText, probe: probe)
        }
        GallerySectionDisclosure(section: .banners, title: ConclaveStrings.text("Banners")) {
            BannerSpecimens(longText: longText, showLoading: showLoading, probe: probe)
        }
        GallerySectionDisclosure(section: .status, title: ConclaveStrings.text("Status Views")) {
            StatusSpecimens(longText: longText, showLoading: showLoading, probe: probe)
        }
    }
}

private func galleryText(_ text: String, longText: Bool) -> String {
    longText ? ComponentGalleryCatalog.expanded(text) : text
}

private struct GallerySectionDisclosure<Content: View>: View {
    let section: GallerySection
    let title: String
    @ViewBuilder let content: () -> Content
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            if expanded {
                content()
            }
        } label: {
            Text(title)
                .accessibilityIdentifier(ComponentGalleryCatalog.sectionID(section))
        }
    }
}

private struct GalleryHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.headline)
            .accessibilityAddTraits(.isHeader)
    }
}

@MainActor
@Observable
private final class GalleryOverflowLedger {
    @ObservationIgnored private var shown: [String: CGFloat] = [:]
    @ObservationIgnored private var ideal: [String: CGFloat] = [:]
    @ObservationIgnored private var latestShown: [String: CGFloat] = [:]
    @ObservationIgnored private var latestIdeal: [String: CGFloat] = [:]
    private(set) var truncated: Set<String> = []
    private(set) var measured: Set<String> = []

    func truncatedCount(in configuration: String) -> Int {
        truncated.reduce(0) { $0 + ($1.hasPrefix(configuration + "|") ? 1 : 0) }
    }

    func measuredCount(in configuration: String) -> Int {
        measured.reduce(0) { $0 + ($1.hasPrefix(configuration + "|") ? 1 : 0) }
    }

    func reportShown(_ key: String, id: String, _ height: CGFloat) {
        shown[key] = height
        latestShown[id] = height
        update(key)
    }

    func reportIdeal(_ key: String, id: String, _ height: CGFloat) {
        ideal[key] = height
        latestIdeal[id] = height
        update(key)
    }

    func refile(id: String, to key: String) {
        if shown[key] == nil, let height = latestShown[id] { shown[key] = height }
        if ideal[key] == nil, let height = latestIdeal[id] { ideal[key] = height }
        update(key)
    }

    private func update(_ key: String) {
        guard let visible = shown[key], let needed = ideal[key] else { return }
        if !measured.contains(key) { measured.insert(key) }
        let isTruncated = needed > visible + 0.5
        guard isTruncated != truncated.contains(key) else { return }
        if isTruncated {
            truncated.insert(key)
        } else {
            truncated.remove(key)
        }
    }
}

private struct GalleryProbe {
    let ledger: GalleryOverflowLedger
    let configuration: String

    func key(_ id: String) -> String {
        configuration + "|" + id
    }
}

private struct TruncationProbe: ViewModifier {
    let id: String
    let probe: GalleryProbe

    func body(content: Content) -> some View {
        let key = probe.key(id)
        let ledger = probe.ledger
        content
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { ledger.reportShown(key, id: id, $0) }
            .background(alignment: .topLeading) {

                content
                    .fixedSize(horizontal: false, vertical: true)
                    .hidden()
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { ledger.reportIdeal(key, id: id, $0) }
            }
            .onChange(of: key) { _, newKey in ledger.refile(id: id, to: newKey) }
    }
}

private struct GalleryEnvironmentReadout: View {
    let probe: GalleryProbe
    let specimenCount: Int
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.legibilityWeight) private var legibilityWeight
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityInvertColors) private var invertColors
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        readout(ConclaveStrings.text("Appearance"),
                colorScheme == .dark ? ConclaveStrings.text("Dark") : ConclaveStrings.text("Light"), "appearance")
        readout(ConclaveStrings.text("Contrast"),
                contrast == .increased ? ConclaveStrings.text("Increased") : ConclaveStrings.text("Standard"), "contrast")
        readout(ConclaveStrings.text("Text Size"), String(describing: dynamicTypeSize), "textSize")
        readout(ConclaveStrings.text("Bold Text"), onOff(legibilityWeight == .bold), "boldText")
        readout(ConclaveStrings.text("Reduce Motion"), onOff(reduceMotion), "reduceMotion")
        readout(ConclaveStrings.text("Reduce Transparency"), onOff(reduceTransparency), "reduceTransparency")
        readout(ConclaveStrings.text("Smart Invert"), onOff(invertColors), "smartInvert")
        readout(ConclaveStrings.text("Layout Direction"),
                layoutDirection == .rightToLeft ? ConclaveStrings.text("Right to Left") : ConclaveStrings.text("Left to Right"),
                "layoutDirection")
        LabeledContent(ConclaveStrings.text("Truncated Text"), value: ConclaveStrings.machineReadable(
            "%lld truncated, %lld of %lld specimens measured",
            probe.ledger.truncatedCount(in: probe.configuration), probe.ledger.measuredCount(in: probe.configuration),
            specimenCount
        ))
        .accessibilityIdentifier(ComponentGalleryCatalog.overflowID)
    }

    private func readout(_ title: String, _ value: String, _ name: String) -> some View {
        LabeledContent(title, value: value)
            .accessibilityIdentifier(ComponentGalleryCatalog.environmentID + "." + name)
    }

    private func onOff(_ value: Bool) -> String {
        value ? ConclaveStrings.text("On") : ConclaveStrings.text("Off")
    }
}

private struct TypeSpecimenRows: View {
    let longText: Bool
    let probe: GalleryProbe

    var body: some View {
        ForEach(ConclaveTextStyle.allCases, id: \.self) { style in
            ForEach(ConclaveTextWeight.allCases, id: \.self) { weight in
                TypeSpecimenRow(style: style, weight: weight, longText: longText, probe: probe)
            }
        }
    }
}

private struct TypeSpecimenRow: View {
    let style: ConclaveTextStyle
    let weight: ConclaveTextWeight
    let longText: Bool
    let probe: GalleryProbe
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let id = ComponentGalleryCatalog.typeSpecimenID(style, weight)
        VStack(alignment: .leading, spacing: 4) {
            Text(galleryText(ConclaveStrings.text("Sample text in this style"), longText: longText))
                .font(style.font(weight))
                .layoutPriority(1)
            Text(galleryText(caption, longText: longText))
                .font(.caption)
                .foregroundStyle(HostingTheme.secondaryText)
        }
        .modifier(TruncationProbe(id: id, probe: probe))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(id)
    }

    private var caption: String {
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
        let now = Double(UIFont.preferredFont(forTextStyle: style.uiTextStyle, compatibleWith: traits).pointSize)
        return ConclaveStrings.format(
            "%@ %@, %@ pt by default, %@ pt now, Android %@",
            style.iosName, weight.displayName, points(style.iosDefaultPoints), points(now), style.androidRole
        )
    }

    private func points(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...1)))
    }
}

private struct HapticRecord {
    var recorded = 0
    var suppressed = 0
    var outcomeRoute = 0
    var silent = 0
    var last: String?

    mutating func add(_ kind: FeedbackKind, _ decision: ConclaveGestureDecision) {
        let word: String
        switch decision {
        case .play:
            recorded += 1
            word = ConclaveStrings.text("recorded")
        case .preferenceOff, .inactive:
            suppressed += 1
            word = ConclaveStrings.text("suppressed")
        case .outcomeRoute:
            outcomeRoute += 1
            word = ConclaveStrings.text("outcome route only")
        case .silent:
            silent += 1
            word = ConclaveStrings.text("silent")
        }
        last = ConclaveStrings.format("%@ tapped, %@", kind.rawValue, word)
    }
}

private struct HapticSpecimenRows: View {
    let longText: Bool
    let probe: GalleryProbe
    @State private var matched: Int?
    @State private var record = HapticRecord()

    private static let gestureKinds = FeedbackKind.allCases.filter { !$0.isAsyncOutcome }
    private static let outcomeKinds = FeedbackKind.allCases.filter { $0.isAsyncOutcome }

    var body: some View {
        Button(ConclaveStrings.text("Verify Table")) { matched = Self.matchCount() }
            .accessibilityIdentifier(ComponentGalleryCatalog.hapticVerifyID)
        LabeledContent(ConclaveStrings.text("Contract Match"), value: matchText)
            .accessibilityIdentifier(ComponentGalleryCatalog.hapticResultID)
        LabeledContent(ConclaveStrings.text("Taps"), value: ConclaveStrings.machineReadable(
            "Recorded %lld, suppressed %lld, outcome route %lld, silent %lld",
            record.recorded, record.suppressed, record.outcomeRoute, record.silent
        ))
        .accessibilityIdentifier(ComponentGalleryCatalog.hapticRecordID)
        LabeledContent(ConclaveStrings.text("Last Tap"), value: record.last ?? ConclaveStrings.text("None"))
        GalleryHeader(title: ConclaveStrings.text("Gesture Route"))
        ForEach(Self.gestureKinds, id: \.self) { kind in
            HapticSpecimenRow(kind: kind, longText: longText, probe: probe) { tap(kind) }
        }
        GalleryHeader(title: ConclaveStrings.text("Outcome Route"))
        ForEach(Self.outcomeKinds, id: \.self) { kind in
            HapticSpecimenRow(kind: kind, longText: longText, probe: probe) { tap(kind) }
        }
    }

    private var matchText: String {
        guard let matched else { return ConclaveStrings.text("Not Run") }
        return ConclaveStrings.machineReadable("%lld of %lld match", matched, FeedbackHapticContract.rows.count)
    }

    private func tap(_ kind: FeedbackKind) {
        record.add(kind, ConclaveGestureFeedback.decision(
            for: kind,
            enabled: ConclaveFeedback.isEnabled(),
            active: UIApplication.shared.applicationState == .active
        ))
    }

    private static func matchCount() -> Int {
        FeedbackHapticContract.rows.filter { ConclaveFeedback.sensoryMapping($0.kind).token == $0.ios }.count
    }
}

private struct HapticSpecimenRow: View {
    let kind: FeedbackKind
    let longText: Bool
    let probe: GalleryProbe
    let onTap: () -> Void

    var body: some View {
        let id = ComponentGalleryCatalog.hapticSpecimenID(kind)
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: kind.rawValue)
                    .layoutPriority(1)
                Text(galleryText(ConclaveStrings.format(
                    "Mapper %@, contract %@",
                    ConclaveFeedback.sensoryMapping(kind).token, FeedbackHapticContract.ios(kind)
                ), longText: longText))
                .font(.caption)
                .foregroundStyle(HostingTheme.secondaryText)
                if FeedbackHapticContract.isSilentOnIPhone(kind) {
                    Text(galleryText(ConclaveStrings.text("Silent on this platform"), longText: longText))
                        .font(.caption)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
            }
            .modifier(TruncationProbe(id: id, probe: probe))
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(id)
    }
}

private enum GalleryColor {

    static func argb(_ color: Color, in environment: EnvironmentValues) -> Int64? {
        let resolved = color.resolve(in: environment)
        let components = [resolved.opacity, resolved.red, resolved.green, resolved.blue]
        guard components.allSatisfy({ $0 >= -0.0005 && $0 <= 1.0005 }) else { return nil }
        return components.reduce(Int64(0)) { $0 * 256 + Int64((min(max($1, 0), 1) * 255).rounded()) }
    }

    static func verdict(_ foreground: Color, on background: Color, in environment: EnvironmentValues,
                        _ requirement: ContrastRequirement) -> String {
        guard let top = argb(foreground, in: environment), let bottom = argb(background, in: environment) else {
            return ConclaveStrings.text("Outside sRGB, no ratio")
        }
        return verdictText(ContrastRatio.wcag(foreground: top, background: bottom), requirement)
    }
}

private func requirementText(_ requirement: ContrastRequirement) -> String {
    switch requirement {
    case .text: return ConclaveStrings.text("Text, needs 4.5")
    case .largeText: return ConclaveStrings.text("Large text, needs 3")
    case .nonText: return ConclaveStrings.text("Non-text, needs 3")
    case .decorative: return ConclaveStrings.text("Decorative")
    case .forbiddenText: return ConclaveStrings.text("Not for text")
    }
}

private func verdictText(_ ratio: Double, _ requirement: ContrastRequirement) -> String {
    let verdict: String
    switch ContrastRatio.verdict(ratio, requirement) {
    case .passes: verdict = ConclaveStrings.text("Passes")
    case .fails: verdict = ConclaveStrings.text("Fails")
    case .decorativeOnly: verdict = ConclaveStrings.text("Decorative Only")
    }
    return ConclaveStrings.format(
        "Ratio %@ against %@: %@",
        ratio.formatted(.number.precision(.fractionLength(2))), requirementText(requirement), verdict
    )
}

private struct ContrastSwatch: View {
    let foreground: Color
    let background: Color
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 44
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Text(verbatim: "Aa")
            .font(.body.weight(.semibold))
            .foregroundStyle(foreground)
            .frame(minWidth: size, minHeight: size)
            .background(background, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(uiColor: .separator), lineWidth: 1 / displayScale))
            .accessibilityHidden(true)
    }
}

private struct ContrastRowLayout<Texts: View>: View {
    let foreground: Color
    let background: Color
    @ViewBuilder let texts: () -> Texts
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            ContrastSwatch(foreground: foreground, background: background)
            VStack(alignment: .leading, spacing: 4, content: texts)
        }
    }
}

private struct ContrastSpecimenRows: View {
    let longText: Bool
    let probe: GalleryProbe

    var body: some View {
        GalleryHeader(title: ConclaveStrings.text("Live, App"))
        LiveContrastRows(inCall: false, longText: longText, probe: probe)
        GalleryHeader(title: ConclaveStrings.text("Live, In Call"))
        LiveContrastRows(inCall: true, longText: longText, probe: probe)
            .environment(\.colorScheme, .dark)
            .listRowBackground(HostingTheme.token(DesignTokens.iosInCallStage))
        GalleryHeader(title: ConclaveStrings.text("Token Pairs"))
        ForEach(ComponentGalleryCatalog.contrastPairs, id: \.id) { pair in
            TokenContrastRow(pair: pair, longText: longText, probe: probe)
        }
    }
}

private struct LiveContrastSpec {
    let name: String
    let caption: String
    let foreground: Color
    let background: Color
    var requirement: ContrastRequirement = .text
}

private struct LiveContrastRows: View {
    let inCall: Bool
    let longText: Bool
    let probe: GalleryProbe

    static func specs(inCall: Bool) -> [LiveContrastSpec] {
        let stage = HostingTheme.token(DesignTokens.iosInCallStage)
        let rowBackground = Color(uiColor: .secondarySystemGroupedBackground)
        var specs = [LiveContrastSpec(name: "onCoral", caption: ConclaveStrings.text("On coral label on coral fill"),
                                      foreground: HostingTheme.onCoral, background: HostingTheme.coralFill)]
        if inCall {
            specs.append(LiveContrastSpec(name: "coralText", caption: ConclaveStrings.text("Coral text on the call stage"),
                                          foreground: HostingTheme.coralText, background: stage))
            specs.append(LiveContrastSpec(name: "secondaryText", caption: ConclaveStrings.text("Secondary text on the call stage"),
                                          foreground: HostingTheme.secondaryText, background: stage))
        } else {
            specs.append(LiveContrastSpec(name: "coralText", caption: ConclaveStrings.text("Coral text on the row background"),
                                          foreground: HostingTheme.coralText, background: rowBackground))
            specs.append(LiveContrastSpec(name: "secondaryText", caption: ConclaveStrings.text("Secondary text on the row background"),
                                          foreground: HostingTheme.secondaryText, background: rowBackground))

            specs.append(LiveContrastSpec(name: "secondaryTextGrouped", caption: ConclaveStrings.text("Secondary text on the system grouped background"),
                                          foreground: HostingTheme.secondaryText, background: Color(uiColor: .systemGroupedBackground)))
        }
        if inCall {

            specs.append(LiveContrastSpec(name: "leaveWhite", caption: ConclaveStrings.text("White glyph on the Leave red"),
                                          foreground: HostingTheme.token(DesignTokens.neutralWhite), background: Color(uiColor: .systemRed),
                                          requirement: .nonText))
        }
        specs.append(LiveContrastSpec(name: "accentWhite", caption: ConclaveStrings.text("White label on the accent color"),
                                      foreground: Color.white, background: Color.accentColor))
        return specs
    }

    var body: some View {
        ForEach(Self.specs(inCall: inCall), id: \.name) { spec in
            LiveContrastRow(id: ComponentGalleryCatalog.liveContrastID(spec.name, inCall: inCall), caption: spec.caption,
                            requirement: spec.requirement,
                            foreground: spec.foreground, background: spec.background, longText: longText, probe: probe)
        }
    }
}

private enum GallerySpecimens {
    @MainActor static func ids(showLoading: Bool) -> Set<String> {
        showLoading ? withLoading : idle
    }

    @MainActor private static let idle = base.union(ComponentGalleryCatalog.componentSpecimenIDs(showLoading: false))
    @MainActor private static let withLoading = base.union(ComponentGalleryCatalog.componentSpecimenIDs(showLoading: true))

    @MainActor private static let base: Set<String> = {
        var ids = Set(ComponentGalleryCatalog.contrastPairs.map { $0.id })
        for style in ConclaveTextStyle.allCases {
            for weight in ConclaveTextWeight.allCases { ids.insert(ComponentGalleryCatalog.typeSpecimenID(style, weight)) }
        }
        for kind in FeedbackKind.allCases { ids.insert(ComponentGalleryCatalog.hapticSpecimenID(kind)) }
        var prominent = [ComponentGalleryCatalog.prominentBorderedID, ComponentGalleryCatalog.prominentBorderedOnCoralID]
        if #available(iOS 26.0, *) {
            prominent += [ComponentGalleryCatalog.prominentGlassID, ComponentGalleryCatalog.prominentGlassOnCoralID]
        }
        for inCall in [false, true] {
            for spec in LiveContrastRows.specs(inCall: inCall) { ids.insert(ComponentGalleryCatalog.liveContrastID(spec.name, inCall: inCall)) }
            for id in prominent { ids.insert(ComponentGalleryCatalog.columnID(id, inCall: inCall)) }
        }
        return ids
    }()
}

private struct LiveContrastRow: View {
    let id: String
    let caption: String
    let requirement: ContrastRequirement
    let foreground: Color
    let background: Color
    let longText: Bool
    let probe: GalleryProbe
    @Environment(\.self) private var environment

    var body: some View {
        ContrastRowLayout(foreground: foreground, background: background) {
            Text(galleryText(caption, longText: longText))
                .layoutPriority(1)
            Text(galleryText(GalleryColor.verdict(foreground, on: background, in: environment, requirement), longText: longText))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .modifier(TruncationProbe(id: id, probe: probe))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(id)
    }
}

private struct TokenContrastRow: View {
    let pair: GalleryContrastPair
    let longText: Bool
    let probe: GalleryProbe

    var body: some View {
        ContrastRowLayout(foreground: HostingTheme.token(pair.foreground), background: HostingTheme.token(pair.background)) {
            Text(galleryText(pair.caption, longText: longText))
                .layoutPriority(1)
            Text(galleryText(verdictText(pair.ratio, pair.requirement), longText: longText))
                .font(.caption)
                .foregroundStyle(HostingTheme.secondaryText)
            Text(galleryText(ConclaveStrings.format(
                "Appendix C %@", pair.expectedRatio.formatted(.number.precision(.fractionLength(3)))
            ), longText: longText))
            .font(.caption)
            .foregroundStyle(HostingTheme.secondaryText)
        }
        .modifier(TruncationProbe(id: pair.id, probe: probe))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(pair.id)
    }
}

private struct SystemProminentSpecimens: View {
    let probe: GalleryProbe

    var body: some View {
        ProminentColumn(inCall: false, probe: probe)
        ProminentColumn(inCall: true, probe: probe)
            .environment(\.colorScheme, .dark)
            .listRowBackground(HostingTheme.token(DesignTokens.iosInCallStage))
    }
}

private struct ProminentColumn: View {
    let inCall: Bool
    let probe: GalleryProbe

    var body: some View {
        GalleryHeader(title: inCall ? ConclaveStrings.text("In Call") : ConclaveStrings.text("App"))
        ProminentSpecimen(id: ComponentGalleryCatalog.prominentBorderedID, inCall: inCall, onCoral: false, probe: probe) {
            Button(ConclaveStrings.text("Bordered Prominent")) {}
                .buttonStyle(.borderedProminent)
        }
        ProminentSpecimen(id: ComponentGalleryCatalog.prominentBorderedOnCoralID, inCall: inCall, onCoral: true, probe: probe) {
            Button {} label: {
                Text(ConclaveStrings.text("Bordered Prominent, On Coral"))
                    .foregroundStyle(HostingTheme.onCoral)
            }
            .buttonStyle(.borderedProminent)
            .tint(HostingTheme.coralFill)
        }
        GlassProminentSpecimens(inCall: inCall, probe: probe)
        NavigationLink(ConclaveStrings.text("Confirmation Action")) {
            ConfirmationActionSpecimenPage(inCall: inCall)
        }
        .accessibilityIdentifier(ComponentGalleryCatalog.columnID(ComponentGalleryCatalog.prominentPageLinkID, inCall: inCall))
    }
}

private struct GlassProminentSpecimens: View {
    let inCall: Bool
    let probe: GalleryProbe

    var body: some View {
        if #available(iOS 26.0, *) {
            ProminentSpecimen(id: ComponentGalleryCatalog.prominentGlassID, inCall: inCall, onCoral: false, probe: probe) {
                Button(ConclaveStrings.text("Glass Prominent")) {}
                    .buttonStyle(.glassProminent)
            }
            ProminentSpecimen(id: ComponentGalleryCatalog.prominentGlassOnCoralID, inCall: inCall, onCoral: true, probe: probe) {
                Button {} label: {
                    Text(ConclaveStrings.text("Glass Prominent, On Coral"))
                        .foregroundStyle(HostingTheme.onCoral)
                }
                .buttonStyle(.glassProminent)
                .tint(HostingTheme.coralFill)
            }
        } else {
            Text(ConclaveStrings.text("Glass specimens need iOS 26 or later."))
                .foregroundStyle(HostingTheme.secondaryText)
        }
    }
}

private struct ProminentSpecimen<Specimen: View>: View {
    let id: String
    let inCall: Bool
    let onCoral: Bool
    let probe: GalleryProbe
    @ViewBuilder let specimen: () -> Specimen
    @Environment(\.self) private var environment

    var body: some View {
        let columnID = ComponentGalleryCatalog.columnID(id, inCall: inCall)
        VStack(alignment: .leading, spacing: 8) {
            specimen()
                .accessibilityIdentifier(columnID)
                .layoutPriority(1)
            Text(readout)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .modifier(TruncationProbe(id: columnID, probe: probe))
    }

    private var readout: String {
        if onCoral {
            return ConclaveStrings.format("On coral label on coral fill: %@",
                                          GalleryColor.verdict(HostingTheme.onCoral, on: HostingTheme.coralFill, in: environment, .text))
        }
        return ConclaveStrings.format("Assumed white system label on the accent: %@",
                                      GalleryColor.verdict(Color.white, on: Color.accentColor, in: environment, .text))
    }
}

private struct ConfirmationActionSpecimenPage: View {
    let inCall: Bool

    var body: some View {
        List {
            Text(ConclaveStrings.text("The Done button uses the confirmation action placement, which iOS 26 can draw as a white label on the accent fill. It does nothing."))
            ConfirmationActionReadout(inCall: inCall)
        }
        .navigationTitle(ConclaveStrings.text("Confirmation Action"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(ConclaveStrings.text("Done")) {}
                    .accessibilityIdentifier(ComponentGalleryCatalog.columnID(ComponentGalleryCatalog.prominentConfirmationActionID, inCall: inCall))
            }
        }
        .modifier(InCallNavigationBar(enabled: inCall))
    }
}

private struct ConfirmationActionReadout: View {
    let inCall: Bool
    @Environment(\.self) private var environment

    var body: some View {
        Text(ConclaveStrings.format("Assumed white system label on the accent: %@",
                                    GalleryColor.verdict(Color.white, on: Color.accentColor, in: environment, .text)))
            .accessibilityIdentifier(ComponentGalleryCatalog.liveContrastID("confirmationAction", inCall: inCall))
    }
}

private struct InCallNavigationBar: ViewModifier {
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content
                .environment(\.colorScheme, .dark)
                .toolbarColorScheme(.dark, for: .navigationBar)
                .toolbarBackground(HostingTheme.token(DesignTokens.iosInCallStage), for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
        } else {
            content
        }
    }
}

private struct ComponentColumns<Column: View>: View {
    let inCallOnly: Bool
    @ViewBuilder let column: (Bool) -> Column

    var body: some View {
        if !inCallOnly {
            GalleryHeader(title: ConclaveStrings.text("App"))
            column(false)
        }
        Group {
            GalleryHeader(title: ConclaveStrings.text("In Call"))
            column(true)
        }
        .environment(\.colorScheme, .dark)
        .listRowBackground(HostingTheme.token(DesignTokens.iosInCallStage))
    }
}

private struct ComponentSpecimen<Specimen: View>: View {
    let id: String
    let probe: GalleryProbe
    @ViewBuilder let specimen: () -> Specimen

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            specimen()
                .layoutPriority(1)
            Text(verbatim: id)
                .font(.caption)
                .foregroundStyle(HostingTheme.secondaryText)
        }
        .modifier(TruncationProbe(id: id, probe: probe))
    }
}

private struct RowSpecimen<Row: View>: View {
    let id: String
    let probe: GalleryProbe
    @ViewBuilder let row: () -> Row

    var body: some View {
        row()
            .layoutPriority(1)
            .modifier(TruncationProbe(id: id, probe: probe))
    }
}

private struct ButtonSpecimens: View {
    let longText: Bool
    let showLoading: Bool
    let probe: GalleryProbe

    var body: some View {
        ComponentColumns(inCallOnly: false) { inCall in
            ForEach(ComponentGalleryCatalog.specimenIDs(.buttons, showLoading: showLoading), id: \.self) { base in
                let id = ComponentGalleryCatalog.columnID(base, inCall: inCall)
                ComponentSpecimen(id: id, probe: probe) {
                    button(base, id: id)
                }
            }
        }
    }

    @ViewBuilder
    private func button(_ base: String, id: String) -> some View {
        switch base {
        case ComponentGalleryCatalog.buttonTonalID:
            ConclaveButton(galleryText(ConclaveStrings.text("Rejoin"), longText: longText), role: .tonal, identifier: id) {}
        case ComponentGalleryCatalog.buttonTextID:
            ConclaveButton(galleryText(ConclaveStrings.text("Copy Link"), longText: longText), role: .text, identifier: id) {}
        case ComponentGalleryCatalog.buttonDestructiveID:
            ConclaveButton(galleryText(ConclaveStrings.text("Remove From Meeting"), longText: longText), role: .destructive,
                           identifier: id) {}
        case ComponentGalleryCatalog.buttonPendingID:
            ConclaveButton(galleryText(ConclaveStrings.text("Joining"), longText: longText), role: .primary, isPending: true,
                           identifier: id) {}
        default:
            ConclaveButton(galleryText(ConclaveStrings.text("Join Meeting"), longText: longText), role: .primary, identifier: id) {}
        }
    }
}

private struct CallControlSpecimens: View {
    let forceOpaque: Bool
    let probe: GalleryProbe
    @State private var record = HapticRecord()

    var body: some View {
        ComponentColumns(inCallOnly: true) { _ in
            LabeledContent(ConclaveStrings.text("Control Taps"), value: ConclaveStrings.machineReadable(
                "Recorded %lld, suppressed %lld, outcome route %lld, silent %lld",
                record.recorded, record.suppressed, record.outcomeRoute, record.silent
            ))
            .accessibilityIdentifier(ComponentGalleryCatalog.controlRecordID)
            toggles
            leave
            badge
            bar
            NavigationLink(ConclaveStrings.text("Full Width Bar")) {
                CompactBarProbePage(forceOpaque: forceOpaque, route: route)
            }
            .accessibilityIdentifier(ComponentGalleryCatalog.compactBarProbeID)
        }
    }

    private var route: ConclaveGestureRoute {
        .recordOnly { kind in
            record.add(kind, ConclaveGestureFeedback.decision(
                for: kind,
                enabled: ConclaveFeedback.isEnabled(),
                active: UIApplication.shared.applicationState == .active
            ))
        }
    }

    private var toggles: some View {
        let id = ComponentGalleryCatalog.columnID(ComponentGalleryCatalog.toggleCallID, inCall: true)
        return ComponentSpecimen(id: id, probe: probe) {
            HStack(spacing: CGFloat(DesignTokens.space12)) {
                ConclaveCallToggle(title: ConclaveStrings.text("Microphone"), value: ConclaveStrings.text("Muted"),
                                   systemImage: ConclaveSymbols.micSlashFill, state: .off,
                                   inputLabels: [ConclaveStrings.text("Unmute"), ConclaveStrings.text("Microphone")],
                                   feedback: .micOn, gestureRoute: route, identifier: id + ".off") {}
                ConclaveCallToggle(title: ConclaveStrings.text("Microphone"), value: ConclaveStrings.text("On"),
                                   systemImage: ConclaveSymbols.micFill, state: .on,
                                   inputLabels: [ConclaveStrings.text("Mute"), ConclaveStrings.text("Microphone")],
                                   feedback: .micOff, gestureRoute: route, identifier: id + ".on") {}
                ConclaveCallToggle(title: ConclaveStrings.text("Share Screen"), value: ConclaveStrings.text("Sharing"),
                                   systemImage: ConclaveSymbols.rectangleInsetFilledOnRectangle, state: .engaged,
                                   gestureRoute: route, identifier: id + ".engaged") {}
                ConclaveCallToggle(title: ConclaveStrings.text("Camera"), value: ConclaveStrings.text("On"),
                                   systemImage: ConclaveSymbols.videoFill, state: .on, isEnabled: false,
                                   feedback: .cameraOff, gestureRoute: route, identifier: id + ".disabled") {}
            }
        }
    }

    private var leave: some View {
        let id = ComponentGalleryCatalog.columnID(ComponentGalleryCatalog.leaveID, inCall: true)
        return ComponentSpecimen(id: id, probe: probe) {
            ConclaveLeaveButton(identifier: id) {}
        }
    }

    private var badge: some View {
        let id = ComponentGalleryCatalog.columnID(ComponentGalleryCatalog.badgeCountID, inCall: true)
        return ComponentSpecimen(id: id, probe: probe) {
            HStack(spacing: CGFloat(DesignTokens.space12)) {
                ConclaveCallInvoker(title: ConclaveStrings.text("Chat"), systemImage: ConclaveSymbols.message, badgeCount: 3,
                                    identifier: id + ".count") {}
                ConclaveCallInvoker(title: ConclaveStrings.text("Chat"), systemImage: ConclaveSymbols.message, badgeCount: 120,
                                    identifier: id + ".overflow") {}
                ConclaveCallInvoker(title: ConclaveStrings.text("Chat"), systemImage: ConclaveSymbols.messageFill, isEngaged: true,
                                    badgeCount: 3, identifier: id + ".open") {}
            }
        }
    }

    private var bar: some View {
        let id = ComponentGalleryCatalog.columnID(ComponentGalleryCatalog.compactBarID, inCall: true)
        return ComponentSpecimen(id: id, probe: probe) {
            FittedCompactBar(identifier: id, movedID: ComponentGalleryCatalog.columnID(ComponentGalleryCatalog.compactBarMovedID, inCall: true),
                             route: route)
        }
    }
}

private struct FittedCompactBar: View {
    let identifier: String
    let movedID: String
    let route: ConclaveGestureRoute
    @State private var available: CGFloat = 0

    var body: some View {
        ConclaveScaledControlDiameter { scaled in
            let plan = compactBarPlan(scaled: scaled, available: available)
            VStack(alignment: .leading, spacing: 8) {
                CompactBarComposition(plan: plan, scaled: scaled, route: route, identifier: identifier)
                LabeledContent(ConclaveStrings.text("Moved to More"), value: movedText(plan))
                    .accessibilityIdentifier(movedID)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            if width != available { available = width }
        }
    }
}

private func compactBarPlan(scaled: CGFloat, available: CGFloat) -> CompactBarPlan? {
    guard available > 0 else { return nil }
    return CompactBarFit.iosPlan(controlIDs: ComponentGalleryCatalog.compactBarControls + [CompactBarFit.leaveControlID],
                                 moveOrder: ComponentGalleryCatalog.compactBarMoveOrder,
                                 scaledDiameter: Double(scaled), available: Double(available))
}

private func movedText(_ plan: CompactBarPlan?) -> String {
    let moved = plan?.moved ?? []
    guard !moved.isEmpty else { return ConclaveStrings.text("None") }
    return moved.map { compactBarControlName($0) }.joined(separator: ", ")
}

private func compactBarControlName(_ id: String) -> String {
    switch id {
    case ComponentGalleryCatalog.compactBarMicrophone: return ConclaveStrings.text("Microphone")
    case ComponentGalleryCatalog.compactBarCamera: return ConclaveStrings.text("Camera")
    case ComponentGalleryCatalog.compactBarShareScreen: return ConclaveStrings.text("Share Screen")
    case ComponentGalleryCatalog.compactBarChat: return ConclaveStrings.text("Chat")
    case ComponentGalleryCatalog.compactBarMore: return ConclaveStrings.text("More")
    default: return id
    }
}

private struct CompactBarComposition: View {
    let plan: CompactBarPlan?
    let scaled: CGFloat
    let route: ConclaveGestureRoute
    let identifier: String

    var body: some View {
        let moved = plan?.moved ?? []
        let diameter = plan.map { CGFloat($0.targetWidth) } ?? scaled
        let spacing = plan.map { CGFloat($0.spacing) } ?? CGFloat(DesignTokens.space12)
        ConclaveControlBar(spacing: spacing, identifier: identifier) {
            if !moved.contains(ComponentGalleryCatalog.compactBarMicrophone) {
                ConclaveCallToggle(title: ConclaveStrings.text("Microphone"), value: ConclaveStrings.text("On"),
                                   systemImage: ConclaveSymbols.micFill, state: .on, diameter: diameter,
                                   inputLabels: [ConclaveStrings.text("Mute"), ConclaveStrings.text("Microphone")],
                                   feedback: .micOff, gestureRoute: route, identifier: identifier + ".microphone") {}
            }
            if !moved.contains(ComponentGalleryCatalog.compactBarCamera) {
                ConclaveCallToggle(title: ConclaveStrings.text("Camera"), value: ConclaveStrings.text("Off"),
                                   systemImage: ConclaveSymbols.videoSlashFill, state: .off, diameter: diameter,
                                   feedback: .cameraOn, gestureRoute: route, identifier: identifier + ".camera") {}
            }
            if !moved.contains(ComponentGalleryCatalog.compactBarShareScreen) {

                ConclaveCallToggle(title: ConclaveStrings.text("Share Screen"), value: ConclaveStrings.text("Off"),
                                   systemImage: ConclaveSymbols.rectangleOnRectangle, state: .on, diameter: diameter,
                                   gestureRoute: route, identifier: identifier + ".shareScreen") {}
            }
            if !moved.contains(ComponentGalleryCatalog.compactBarChat) {
                ConclaveCallInvoker(title: ConclaveStrings.text("Chat"), systemImage: ConclaveSymbols.message, badgeCount: 3,
                                    diameter: diameter, identifier: identifier + ".chat") {}
            }
            if !moved.contains(ComponentGalleryCatalog.compactBarMore) {
                ConclaveCallInvoker(title: ConclaveStrings.text("More"), systemImage: ConclaveSymbols.ellipsis,
                                    diameter: diameter, identifier: identifier + ".more") {}
            }
            ConclaveLeaveButton(diameter: diameter, identifier: identifier + ".leave") {}
        }
    }
}

private struct CompactBarProbePage: View {
    let forceOpaque: Bool
    let route: ConclaveGestureRoute
    @State private var available: CGFloat = 0
    @State private var barWidth: CGFloat = 0

    var body: some View {
        ZStack(alignment: .top) {
            HostingTheme.token(DesignTokens.iosInCallStage)
                .ignoresSafeArea()
            ConclaveScaledControlDiameter { scaled in
                let plan = compactBarPlan(scaled: scaled, available: available)
                VStack(spacing: CGFloat(DesignTokens.space16)) {
                    CompactBarComposition(plan: plan, scaled: scaled, route: route, identifier: ComponentGalleryCatalog.compactBarID)
                        .fixedSize()
                        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                            if width != barWidth { barWidth = width }
                        }
                    LabeledContent(ConclaveStrings.text("Bar Width"), value: ConclaveStrings.machineReadable(
                        "Bar %.1f pt of %.1f pt", Double(barWidth), Double(available)
                    ))
                    .accessibilityIdentifier(ComponentGalleryCatalog.compactBarReadoutID)
                    LabeledContent(ConclaveStrings.text("Moved to More"), value: movedText(plan))
                        .accessibilityIdentifier(ComponentGalleryCatalog.compactBarMovedID)
                }
                .padding(.vertical, CGFloat(DesignTokens.space16))
            }
            .frame(maxWidth: .infinity)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                if width != available { available = width }
            }
        }
        .environment(\.conclaveForceOpaqueControls, forceOpaque)
        .navigationTitle(ConclaveStrings.text("Full Width Bar"))
        .navigationBarTitleDisplayMode(.inline)
        .modifier(InCallNavigationBar(enabled: true))
    }
}

private struct RowSpecimens: View {
    let longText: Bool
    let probe: GalleryProbe
    @State private var noiseSuppression = true
    @State private var route = "speaker"

    var body: some View {
        ComponentColumns(inCallOnly: false) { inCall in
            ForEach(ComponentGalleryCatalog.specimenIDs(.rows, showLoading: false), id: \.self) { base in
                let id = ComponentGalleryCatalog.columnID(base, inCall: inCall)
                RowSpecimen(id: id, probe: probe) {
                    row(base, id: id)
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ base: String, id: String) -> some View {
        switch base {
        case ComponentGalleryCatalog.rowNavigationID:
            ConclaveNavigationRow(title: galleryText(ConclaveStrings.text("Notifications"), longText: longText), identifier: id) {
                RowDestinationPage()
            }
        case ComponentGalleryCatalog.rowDestructiveID:
            ConclaveDestructiveRow(title: galleryText(ConclaveStrings.text("Delete Account"), longText: longText), identifier: id) {}
        case ComponentGalleryCatalog.rowSelectableID:
            VStack(spacing: 0) {
                ConclaveSelectableRow(title: galleryText(ConclaveStrings.text("Speaker"), longText: longText),
                                      isSelected: route == "speaker", identifier: id + ".speaker") { route = "speaker" }
                ConclaveSelectableRow(title: galleryText(ConclaveStrings.text("Headphones"), longText: longText),
                                      isSelected: route == "headphones", identifier: id + ".headphones") { route = "headphones" }
            }
        case ComponentGalleryCatalog.toggleRowID:
            ConclaveToggleRow(title: galleryText(ConclaveStrings.text("Noise Suppression"), longText: longText),
                              isOn: $noiseSuppression, identifier: id)
        case ComponentGalleryCatalog.rowPersonID:

            ConclavePersonRow(name: galleryText(ConclaveStrings.text("Avery"), longText: longText),
                              detail: galleryText(ConclaveStrings.text("Presenting"), longText: longText),
                              statusValue: ConclaveStrings.text("Muted, Hand Raised"),
                              statusSymbols: [ConclaveSymbols.micSlashFill, ConclaveSymbols.handRaisedFill],
                              avatarPaletteIndex: 7, identifier: id)
        case ComponentGalleryCatalog.rowPersonWaitingID:
            ConclaveWaitingPersonRow(name: galleryText(ConclaveStrings.text("Sam"), longText: longText), avatarPaletteIndex: 9,
                                     identifier: id, onDeny: {}, onAdmit: {})
        default:
            ConclaveValueRow(title: galleryText(ConclaveStrings.text("Room"), longText: longText),
                             value: ComponentGalleryCatalog.sampleRoomCode, identifier: id)
        }
    }
}

private struct RowDestinationPage: View {
    var body: some View {
        List {
            Text(ConclaveStrings.text("This page is a specimen. It does nothing."))
        }
        .navigationTitle(ConclaveStrings.text("Notifications"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct BannerSpecimens: View {
    let longText: Bool
    let showLoading: Bool
    let probe: GalleryProbe
    @State private var showsBanner = false

    var body: some View {
        ComponentColumns(inCallOnly: false) { inCall in
            ForEach(ComponentGalleryCatalog.specimenIDs(.banners, showLoading: showLoading), id: \.self) { base in
                let id = ComponentGalleryCatalog.columnID(base, inCall: inCall)
                ComponentSpecimen(id: id, probe: probe) {
                    banner(base, id: id, inCall: inCall)
                }
            }
        }
        Group {
            Toggle(ConclaveStrings.text("Show Banner"), isOn: $showsBanner)
                .accessibilityIdentifier(ComponentGalleryCatalog.bannerMotionToggleID)
            LabeledContent(ConclaveStrings.text("Would Announce"),
                           value: showsBanner ? motionText : ConclaveStrings.text("None"))
                .accessibilityIdentifier(ComponentGalleryCatalog.bannerAnnouncementID)
            ConclaveBannerPresence(isPresented: showsBanner) {
                ConclaveBanner(kind: .info, text: motionText, surface: .inCall, announces: false,
                               identifier: ComponentGalleryCatalog.bannerMotionID)
            }
        }
        .environment(\.colorScheme, .dark)
        .listRowBackground(HostingTheme.token(DesignTokens.iosInCallStage))
    }

    private var motionText: String {
        galleryText(ConclaveStrings.text("Live captions are on."), longText: longText)
    }

    private func banner(_ base: String, id: String, inCall: Bool) -> some View {
        let surface: ConclaveBannerSurface = inCall ? .inCall : .app
        switch base {
        case ComponentGalleryCatalog.bannerWarningID:
            return ConclaveBanner(kind: .warning, text: galleryText(ConclaveStrings.text("Very poor connection. Audio may cut out."), longText: longText),
                                  surface: surface,
                                  actions: [ConclaveBannerAction(title: ConclaveStrings.text("Use Audio Only"), identifier: id + ".action", action: {})],
                                  announces: false, identifier: id)
        case ComponentGalleryCatalog.bannerErrorID:
            return ConclaveBanner(kind: .error, text: galleryText(ConclaveStrings.text("Could not share your screen."), longText: longText),
                                  surface: surface, onDismiss: {}, announces: false, identifier: id)
        case ComponentGalleryCatalog.bannerSuccessID:
            return ConclaveBanner(kind: .success, text: galleryText(ConclaveStrings.text("Your notes were saved."), longText: longText),
                                  surface: surface, announces: false, identifier: id)
        case ComponentGalleryCatalog.bannerReconnectingID:
            return ConclaveBanner(kind: .reconnecting, text: galleryText(ConclaveStrings.text("Reconnecting to the call."), longText: longText),
                                  surface: surface, announces: false, identifier: id)
        default:
            return ConclaveBanner(kind: .info, text: motionText, surface: surface, announces: false, identifier: id)
        }
    }
}

private struct StatusSpecimens: View {
    let longText: Bool
    let showLoading: Bool
    let probe: GalleryProbe

    var body: some View {
        ComponentColumns(inCallOnly: false) { inCall in
            ForEach(ComponentGalleryCatalog.specimenIDs(.status, showLoading: showLoading), id: \.self) { base in
                let id = ComponentGalleryCatalog.columnID(base, inCall: inCall)
                ComponentSpecimen(id: id, probe: probe) {
                    status(base, id: id)
                }
            }
        }
    }

    @ViewBuilder
    private func status(_ base: String, id: String) -> some View {
        switch base {
        case ComponentGalleryCatalog.statusLoadingID:
            ConclaveLoadingStatus(label: galleryText(ConclaveStrings.text("Loading Participants"), longText: longText), identifier: id)
        case ComponentGalleryCatalog.statusEmptyID:
            ConclaveEmptyStatus(title: galleryText(ConclaveStrings.text("No Messages Yet"), longText: longText),
                                message: galleryText(ConclaveStrings.text("Messages are visible to everyone in this call."), longText: longText),
                                systemImage: ConclaveSymbols.message, identifier: id)
        case ComponentGalleryCatalog.statusOfflineID:
            ConclaveOfflineStatus(identifier: id, onRetry: {})
        default:
            ConclaveErrorStatus(title: galleryText(ConclaveStrings.text("Could Not Load"), longText: longText),
                                message: galleryText(ConclaveStrings.text("Check your connection and try again."), longText: longText),
                                systemImage: ConclaveSymbols.exclamationmarkTriangleFill, identifier: id, onRetry: {})
        }
    }
}
#endif
