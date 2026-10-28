#if os(iOS) && !SKIP
import Accessibility
import SwiftUI
import UIKit

// Text fields, the composer parts, search and segmented controls (F00 C19, C20, C21; S40 6, CL3, R40-6; S60 R6-8).
// Single-line fields live in a `Form` or `List` row and keep the system field look; the error sits in the section
// footer. The composer field row and its two materials live in ConclaveComposerGlass+iOS.swift (the second
// sanctioned material file, owner OQ2); this file holds the parts around it: the text input, Send, the composer
// column with its accessory slots (never glass), the bottom and top bar hosts, search on the system field and the
// segmented picker with its fallbacks. Keystrokes stay in the caller's local state; nothing here reaches a
// presenter until submit (F00 C19 k).

/// What a single-line field holds, which picks its keyboard, content type and capitalization.
enum ConclaveTextFieldKind: String, CaseIterable {
    /// A person's display name: words capitalized, name content type, Done.
    case name
    /// A meeting code or link: URL keyboard, no capitalization or autocorrection, Join.
    case code
    /// Free text such as a rename: sentences capitalized, Done.
    case text
}

/// A single-line field for a Form or List row. The prompt names the field (AX); the caller shows the error as
/// `ConclaveFieldError` in the section footer right after it.
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

/// A field error for the section footer: the octagon glyph in system red with label-colored footnote text, so the
/// meaning never rests on color alone. It follows the field in reading order.
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

/// The near-limit counter ("38/40"), visible from `visibleFrom` characters, with tabular digits and the spoken
/// value "38 of 40 Characters" (F00 C19 f; S10 `DisplayNamePolicy`: cap 40, visible from 30). Composers pass
/// `ConclaveComposerCounterPolicy.visibleFrom(limit:)` (90%), or 0 in voice mode where it always shows.
/// `announcesBands` (opt-in, S40 6 i; T3 borrow P9; only the chat composer and the Q&A question pass true): one polite
/// announcement when the counter appears and at every crossing between near and over, never per character. Every
/// other caller keeps the silent counter.
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

/// The band-change handler of an opted-in counter (T3 borrow P9). `task(id: band)` starts when the counter appears in
/// a band (hidden to near or over) and restarts only when the band changes while it shows (near to over and back), so
/// typing inside a band posts nothing and leaving for hidden posts nothing. The text is fixed at the crossing ("900 of
/// 1000 Characters", "200 characters over the limit"). The handler sits on the visible counter: a host that stayed
/// in the composer column while the counter is hidden would add the column's 8 pt spacing under the field at rest.
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

/// The counter's spoken copy (S40 6 g): near reuses the counter label, over the Send reason's plural.
enum ConclaveCounterText {
    static func announcement(band: ConclaveCounterBand, count: Int, limit: Int) -> String {
        if band == .over {
            return ConclaveStrings.format("%lld characters over the limit",
                                          ConclaveComposerCounterPolicy.overflow(count: count, limit: limit))
        }
        return ConclaveStrings.format("%lld of %lld Characters", count, limit)
    }
}

// MARK: Composer parts (F00 C19; S40 6 c, CL3, R40-6)

/// The composer text input: a vertical field growing to six lines, then scrolling. Return inserts a newline and
/// Send sends (the Messages convention, S40 Q13). Screens that need focus or hardware keys pass their own field to
/// `ConclaveComposerField` instead.
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

/// The Send glyph: solid coralText, never on a material and never a coral tint (F00 C19 c); "Send" for
/// accessibility. No send haptic (Q11).
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

/// Send with a screen's own label ("Ask" for Q&A and Transcript Ask, "Send Voice Message" in voice mode) and the
/// reason Send is disabled as its value ("Type a message", "Uploading photo", S40 6 i).
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

/// The arrow glyph in a 44 pt target: coralText while enabled, secondary while disabled.
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

/// The composer column (S40 6 c): the accessory rows above the field row (suggestions, reply bar, attachment chip,
/// link preview, mode row, notice line; never on a material), the field row, then the footer (the counter, trailing).
/// 16 by 8 padding, 8 between rows. Rows appear and leave without animation (S40 6 h).
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

/// The reply bar (S40 6 c, CL3): a 3 pt coralText rule, the title ("Replying to Avery Lee") and a two-line preview,
/// then a Cancel button. The text reads as one element; Cancel is its own button.
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

/// The attachment chip (S40 6 c, CL3): a thumbnail the caller draws, the title ("Photo"), a status line
/// ("Uploading 42%", "Ready to send" or the failure reason with the error glyph), the system linear indicator while
/// preparing or uploading, Try Again after a failure, and Remove. Flat raised fill, no border.
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

/// One status or notice line above the field (a blocked-send reason, a gate, "Will be sent privately to Avery"):
/// sentence case footnote in secondary text. The screen announces it once when it appears (S40 6 i).
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

/// The xmark in a 44 pt target with the caller's label (Cancel Reply, Remove Photo, Exit Voice Message).
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
    /// Pins a composer to the bottom of the panel content (S40 6 c, 0.6): iOS 26 `safeAreaBar(edge: .bottom)` so the
    /// timeline gets the scroll edge effect under it; iOS 17 to 25 `safeAreaInset(edge: .bottom)` on the system
    /// background with a top divider.
    func conclaveComposerBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(ConclaveBottomBarHost(bar: bar()))
    }

    /// A bar under the inline title for a view switch (F00 C21 c, S60 R6-8, S50 Q&A sort): iOS 26
    /// `safeAreaBar(edge: .top)`, iOS 17 to 25 `safeAreaInset(edge: .top)` on the system background.
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

// MARK: Search (F00 C20)

extension View {
    /// The system search field in the panel's navigation bar drawer (inside the panel's NavigationStack). Filter
    /// the cached snapshot with `ConclaveSearchPolicy` as people type; show `ConclaveSearchEmptyState` for no results.
    func conclaveSearchable(text: Binding<String>, prompt: String? = nil) -> some View {
        searchable(text: text, placement: .navigationBarDrawer(displayMode: .automatic),
                   prompt: Text(prompt ?? ConclaveStrings.text("Search")))
    }

    /// The same with the presentation bound, for screens that open search programmatically.
    func conclaveSearchable(text: Binding<String>, isPresented: Binding<Bool>, prompt: String? = nil) -> some View {
        searchable(text: text, isPresented: isPresented, placement: .navigationBarDrawer(displayMode: .automatic),
                   prompt: Text(prompt ?? ConclaveStrings.text("Search")))
    }

    /// Announces the result count politely once typing pauses (F00 C20 i): one cancellable task per query and count,
    /// nothing while the query is empty.
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

/// The intrinsic search copy (F00 C20 g).
enum ConclaveSearchText {
    static func resultCount(_ count: Int) -> String {
        if count == 0 { return ConclaveStrings.text("No Results") }
        return ConclaveStrings.format("%lld Results", count)
    }
}

/// No results: the system search empty view (C14 empty, F00 C20 c).
struct ConclaveSearchEmptyState: View {
    let query: String
    let identifier: String

    var body: some View {
        ContentUnavailableView.search(text: query)
            .accessibilityIdentifier(identifier)
    }
}

// MARK: Segmented control (F00 C21; S60 R6-8)

/// Two to four mutually exclusive options that change a view in place, with system styling (no coral thumb). The
/// system plays its own selection feedback. Fallbacks: `.rows` switches to C09 selectable rows at accessibility
/// sizes; `.menu` keeps setup and settings rows on one line with `ViewThatFits` and a menu picker.
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

/// A view switch at the top of a panel (the Transcript view switch, the Q&A sort; S60 R6-8): a full-width segmented
/// picker with the menu fallback, padded for `conclaveTopBar`.
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
