#if os(iOS) && !SKIP
import Accessibility
import SwiftUI
import UIKit

enum ConclaveTextFieldKind: String, CaseIterable {

    case name

    case code

    case text
}

struct ConclaveTextField: View {
    let prompt: String
    @Binding var text: String
    let kind: ConclaveTextFieldKind
    let isEnabled: Bool
    let identifier: String
    let onSubmit: () -> Void

    init(_ prompt: String, text: Binding<String>, kind: ConclaveTextFieldKind, isEnabled: Bool = true,
         identifier: String, onSubmit: @escaping () -> Void = {}) {
        self.prompt = prompt
        _text = text
        self.kind = kind
        self.isEnabled = isEnabled
        self.identifier = identifier
        self.onSubmit = onSubmit
    }

    var body: some View {
        TextField(prompt, text: $text)
            .textContentType(contentType)
            .keyboardType(kind == .code ? .URL : .default)
            .textInputAutocapitalization(capitalization)
            .autocorrectionDisabled(kind == .code)
            .submitLabel(kind == .code ? .join : .done)
            .onSubmit(onSubmit)
            .disabled(!isEnabled)
            .accessibilityIdentifier(identifier)
    }

    private var contentType: UITextContentType? {
        switch kind {
        case .name: return .name
        case .code: return .URL
        case .text: return nil
        }
    }

    private var capitalization: TextInputAutocapitalization {
        switch kind {
        case .name: return .words
        case .code: return .never
        case .text: return .sentences
        }
    }
}

struct ConclaveFieldError: View {
    let text: String
    let identifier: String

    var body: some View {
        Label {
            Text(text)
                .font(.footnote)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: ConclaveSymbols.exclamationmarkOctagonFill)
                .foregroundStyle(Color(uiColor: .systemRed))
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}

struct ConclaveCharacterCounter: View {
    let count: Int
    let limit: Int
    let visibleFrom: Int
    let identifier: String
    let announcesBands: Bool

    init(count: Int, limit: Int, visibleFrom: Int, identifier: String, announcesBands: Bool = false) {
        self.count = count
        self.limit = limit
        self.visibleFrom = visibleFrom
        self.identifier = identifier
        self.announcesBands = announcesBands
    }

    var body: some View {
        let band = ConclaveComposerCounterPolicy.band(count: count, limit: limit, visibleFrom: visibleFrom)
        if band != .hidden {
            Text(ConclaveStrings.format("Character Counter %lld %lld", count, limit))
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(count > limit ? Color(uiColor: .systemRed) : HostingTheme.secondaryText)
                .accessibilityLabel(ConclaveStrings.format("%lld of %lld Characters", count, limit))
                .accessibilityIdentifier(identifier)
                .modifier(ConclaveCounterBandAnnouncement(isEnabled: announcesBands, band: band, count: count, limit: limit))
        }
    }
}

private struct ConclaveCounterBandAnnouncement: ViewModifier {
    let isEnabled: Bool
    let band: ConclaveCounterBand
    let count: Int
    let limit: Int

    @ViewBuilder
    func body(content: Content) -> some View {
        if isEnabled {
            content.task(id: band) {
                var text = AttributedString(ConclaveCounterText.announcement(band: band, count: count, limit: limit))
                text.accessibilitySpeechAnnouncementPriority = .low
                AccessibilityNotification.Announcement(text).post()
            }
        } else {
            content
        }
    }
}

enum ConclaveCounterText {
    static func announcement(band: ConclaveCounterBand, count: Int, limit: Int) -> String {
        if band == .over {
            return ConclaveStrings.format("%lld characters over the limit",
                                          ConclaveComposerCounterPolicy.overflow(count: count, limit: limit))
        }
        return ConclaveStrings.format("%lld of %lld Characters", count, limit)
    }
}

struct ConclaveComposerInput: View {
    let prompt: String
    @Binding var text: String
    let identifier: String

    init(_ prompt: String, text: Binding<String>, identifier: String) {
        self.prompt = prompt
        _text = text
        self.identifier = identifier
    }

    var body: some View {
        TextField(prompt, text: $text, axis: .vertical)
            .lineLimit(1...6)
            .textInputAutocapitalization(.sentences)
            .accessibilityIdentifier(identifier)
    }
}

struct ConclaveSendButton: View {
    let isEnabled: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ConclaveSendGlyph(isEnabled: isEnabled)
        }
        .buttonStyle(.borderless)
        .disabled(!isEnabled)
        .accessibilityLabel(ConclaveStrings.text("Send"))
        .accessibilityIdentifier(identifier)
    }
}

struct ConclaveComposerSendButton: View {
    let title: String
    let isEnabled: Bool
    let disabledReason: String
    let identifier: String
    let action: () -> Void

    init(title: String, isEnabled: Bool, disabledReason: String = "", identifier: String, action: @escaping () -> Void) {
        self.title = title
        self.isEnabled = isEnabled
        self.disabledReason = disabledReason
        self.identifier = identifier
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            ConclaveSendGlyph(isEnabled: isEnabled)
        }
        .buttonStyle(.borderless)
        .disabled(!isEnabled)
        .accessibilityLabel(title)
        .accessibilityValue(isEnabled ? "" : disabledReason)
        .accessibilityIdentifier(identifier)
    }
}

private struct ConclaveSendGlyph: View {
    let isEnabled: Bool

    var body: some View {
        Image(systemName: ConclaveSymbols.arrowUpCircleFill)
            .font(.title2)
            .foregroundStyle(isEnabled ? AnyShapeStyle(HostingTheme.coralText) : AnyShapeStyle(.secondary))
            .frame(minWidth: ConclaveButtonMetrics.minimumHeight, minHeight: ConclaveButtonMetrics.minimumHeight)
            .contentShape(Rectangle())
            .accessibilityHidden(true)
    }
}

struct ConclaveComposerStack<Accessories: View, FieldRow: View, Footer: View>: View {
    let identifier: String
    let accessories: Accessories
    let fieldRow: FieldRow
    let footer: Footer

    init(identifier: String, @ViewBuilder accessories: () -> Accessories, @ViewBuilder field: () -> FieldRow,
         @ViewBuilder footer: () -> Footer) {
        self.identifier = identifier
        self.accessories = accessories()
        self.fieldRow = field()
        self.footer = footer()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(ConclaveComposerMetrics.stackSpacing)) {
            accessories
            fieldRow
            footer
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, CGFloat(ConclaveComposerMetrics.stackHorizontalPadding))
        .padding(.vertical, CGFloat(ConclaveComposerMetrics.stackVerticalPadding))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

extension ConclaveComposerStack where Footer == EmptyView {
    init(identifier: String, @ViewBuilder accessories: () -> Accessories, @ViewBuilder field: () -> FieldRow) {
        self.identifier = identifier
        self.accessories = accessories()
        self.fieldRow = field()
        self.footer = EmptyView()
    }
}

struct ConclaveComposerReplyBar: View {
    let title: String
    let preview: String
    let cancelTitle: String
    let identifier: String
    let onCancel: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            HStack(spacing: 8) {
                Rectangle()
                    .fill(HostingTheme.coralText)
                    .frame(width: CGFloat(ConclaveComposerMetrics.replyBarWidth))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.primary)
                    if !preview.isEmpty {
                        Text(preview)
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.secondaryText)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
            ConclaveComposerDismissButton(title: cancelTitle, identifier: identifier + ".cancel", action: onCancel)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

struct ConclaveComposerAttachmentChip<Thumbnail: View>: View {
    let title: String
    let status: String
    let phase: ConclaveAttachmentPhase
    let progress: Double?
    let removeTitle: String
    let identifier: String
    let thumbnail: Thumbnail
    let onRemove: () -> Void
    let onRetry: () -> Void

    init(title: String, status: String, phase: ConclaveAttachmentPhase, progress: Double? = nil, removeTitle: String,
         identifier: String, @ViewBuilder thumbnail: () -> Thumbnail, onRemove: @escaping () -> Void,
         onRetry: @escaping () -> Void = {}) {
        self.title = title
        self.status = status
        self.phase = phase
        self.progress = progress
        self.removeTitle = removeTitle
        self.identifier = identifier
        self.thumbnail = thumbnail()
        self.onRemove = onRemove
        self.onRetry = onRetry
    }

    var body: some View {
        HStack(spacing: 12) {
            thumbnail
                .frame(width: CGFloat(ConclaveComposerMetrics.attachmentThumbnail),
                       height: CGFloat(ConclaveComposerMetrics.attachmentThumbnail))
                .clipShape(RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if phase == .failed {
                        Image(systemName: ConclaveSymbols.exclamationmarkOctagonFill)
                            .foregroundStyle(Color(uiColor: .systemRed))
                            .accessibilityHidden(true)
                    }
                    Text(status)
                        .font(.footnote)
                        .foregroundStyle(phase == .failed ? AnyShapeStyle(.primary) : AnyShapeStyle(HostingTheme.secondaryText))
                        .fixedSize(horizontal: false, vertical: true)
                }
                if phase.showsProgress {
                    if let progress {
                        ProgressView(value: progress)
                    } else {
                        ProgressView()
                            .progressViewStyle(.linear)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            if phase.offersRetry {
                Button(ConclaveStrings.text("Try Again"), action: onRetry)
                    .buttonStyle(.borderless)
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: ConclaveButtonMetrics.minimumHeight)
                    .accessibilityIdentifier(identifier + ".retry")
            }
            ConclaveComposerDismissButton(title: removeTitle, identifier: identifier + ".remove", action: onRemove)
        }
        .padding(8)
        .background(Color(uiColor: .secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

struct ConclaveComposerStatusLine: View {
    let text: String
    let identifier: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(HostingTheme.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier(identifier)
    }
}

struct ConclaveComposerDismissButton: View {
    let title: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: ConclaveSymbols.xmark)
                .font(.body.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(minWidth: ConclaveButtonMetrics.minimumHeight, minHeight: ConclaveButtonMetrics.minimumHeight)
                .contentShape(Rectangle())
                .accessibilityHidden(true)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(title)
        .accessibilityIdentifier(identifier)
    }
}

extension View {

    func conclaveComposerBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(ConclaveBottomBarHost(bar: bar()))
    }

    func conclaveTopBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(ConclaveTopBarHost(bar: bar()))
    }
}

private struct ConclaveBottomBarHost<Bar: View>: ViewModifier {
    let bar: Bar

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.safeAreaBar(edge: .bottom) { bar }
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    Divider()
                    bar
                }
                .background(Color(uiColor: .systemBackground))
            }
        }
    }
}

private struct ConclaveTopBarHost<Bar: View>: ViewModifier {
    let bar: Bar

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.safeAreaBar(edge: .top) { bar }
        } else {
            content.safeAreaInset(edge: .top, spacing: 0) {
                bar.background(Color(uiColor: .systemBackground))
            }
        }
    }
}

extension View {

    func conclaveSearchable(text: Binding<String>, prompt: String? = nil) -> some View {
        searchable(text: text, placement: .navigationBarDrawer(displayMode: .automatic),
                   prompt: Text(prompt ?? ConclaveStrings.text("Search")))
    }

    func conclaveSearchable(text: Binding<String>, isPresented: Binding<Bool>, prompt: String? = nil) -> some View {
        searchable(text: text, isPresented: isPresented, placement: .navigationBarDrawer(displayMode: .automatic),
                   prompt: Text(prompt ?? ConclaveStrings.text("Search")))
    }

    func conclaveSearchAnnouncement(query: String, resultCount: Int) -> some View {
        modifier(ConclaveSearchAnnouncement(query: query, resultCount: resultCount))
    }
}

private struct ConclaveSearchAnnouncementKey: Equatable {
    let query: String
    let resultCount: Int
}

private struct ConclaveSearchAnnouncement: ViewModifier {
    let query: String
    let resultCount: Int

    func body(content: Content) -> some View {
        content.task(id: ConclaveSearchAnnouncementKey(query: query, resultCount: resultCount)) {
            guard ConclaveSearchPolicy.isSearching(query) else { return }
            try? await Task.sleep(for: .milliseconds(ConclaveSearchPolicy.announcementDelayMillis))
            guard !Task.isCancelled else { return }
            var text = AttributedString(ConclaveSearchText.resultCount(resultCount))
            text.accessibilitySpeechAnnouncementPriority = .low
            AccessibilityNotification.Announcement(text).post()
        }
    }
}

enum ConclaveSearchText {
    static func resultCount(_ count: Int) -> String {
        if count == 0 { return ConclaveStrings.text("No Results") }
        return ConclaveStrings.format("%lld Results", count)
    }
}

struct ConclaveSearchEmptyState: View {
    let query: String
    let identifier: String

    var body: some View {
        ContentUnavailableView.search(text: query)
            .accessibilityIdentifier(identifier)
    }
}

struct ConclaveSegmentedPicker: View {
    let title: String
    let options: [ConclaveSegmentModel]
    @Binding var selection: String
    let fallback: ConclaveSegmentedFallback
    let identifier: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(_ title: String, options: [ConclaveSegmentModel], selection: Binding<String>,
         fallback: ConclaveSegmentedFallback = .rows, identifier: String) {
        self.title = title
        self.options = options
        _selection = selection
        self.fallback = fallback
        self.identifier = identifier
    }

    var body: some View {
        switch fallback {
        case .rows:
            if ConclaveSegmentedPolicy.iosUsesRows(isAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
                                                  segmentCount: options.count) {
                rows
            } else {
                segmented
            }
        case .menu:
            ViewThatFits(in: .horizontal) {
                segmented
                menu
            }
        }
    }

    private var segmented: some View {
        Picker(title, selection: $selection) {
            ForEach(options) { option in
                Text(option.title)
                    .tag(option.id)
                    .disabled(!option.isEnabled)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .accessibilityIdentifier(identifier)
    }

    private var menu: some View {
        Picker(title, selection: $selection) {
            ForEach(options) { option in
                Text(option.title)
                    .tag(option.id)
                    .disabled(!option.isEnabled)
            }
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier(identifier)
    }

    private var rows: some View {
        VStack(spacing: 0) {
            ForEach(options) { option in
                ConclaveSelectableRow(title: option.title, isSelected: option.id == selection,
                                      identifier: identifier + "." + option.id) {
                    selection = option.id
                }
                .disabled(!option.isEnabled)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

struct ConclaveViewSwitch: View {
    let title: String
    let options: [ConclaveSegmentModel]
    @Binding var selection: String
    let identifier: String

    init(_ title: String, options: [ConclaveSegmentModel], selection: Binding<String>, identifier: String) {
        self.title = title
        self.options = options
        _selection = selection
        self.identifier = identifier
    }

    var body: some View {
        ConclaveSegmentedPicker(title, options: options, selection: $selection, fallback: .menu, identifier: identifier)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, CGFloat(DesignTokens.space16))
            .padding(.vertical, CGFloat(DesignTokens.space8))
    }
}
#endif
