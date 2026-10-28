#if os(iOS) && !SKIP
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// TRN-2 (S60 6 c): the Transcript panel on iOS (`MeetingPanel.transcript`; PS 6.2 large only, composer panel, system
// appearance). One `PanelShell` (its inline title "Transcript" and its one Close, C02); the trailing toolbar `Menu`
// (Export through `ShareLink`, Copy, Post Recap to Chat, Stop Live Notes…); the view switch, status bar and issue
// banner in the top bar (`conclaveTopBar`: iOS 26 `safeAreaBar`, 17 to 25 `safeAreaInset`); the start card with the
// pinned Start Notes / Resume Notes; the Transcript list on the S40 timeline pieces (lazy stack, bottom anchored,
// follow only while pinned, Jump to Latest); Ask over S40 CL1 bubbles with the CHT-7 markdown renderer and the one
// F00 C19 composer (the Liquid Glass cluster on iOS 26 and later from the one sanctioned composer file, opaque below
// and under Reduce Transparency; owner OQ2, RECONCILE R32); Minutes as an inset grouped list with the recap row. Views
// read the presenter's snapshot and leaves only (F00 P1). Registered by the native call root (HD request B7-T5 R4).

struct TranscriptPanel: View {
    let transcript: TranscriptPresenter
    let panels: PanelCoordinator
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    let onPromoteToLarge: () -> Void
    @Environment(\.conclaveSystemColorScheme) private var systemScheme

    var body: some View {
        PanelShell(title: TranscriptCopy.title, presentation: resolved, hostStyle: resolved.style, systemScheme: systemScheme,
                   onClose: { panels.dismiss(cancelPending: true) }, onPromoteToLarge: onPromoteToLarge) {
            TranscriptPanelContent(transcript: transcript)
        }
        .task(id: presentation.id) {
            transcript.panelDidOpen(destination: presentation.request.destination)
        }
        .onDisappear { transcript.panelDidClose() }
        .onChange(of: panels.destinationRequest) { _, _ in
            // R40-2: a destination for the panel that is already current (the catch-up banner while Transcript is open).
            guard let request = panels.latestDestination(for: presentation.request.presentationID) else { return }
            transcript.panelDidOpen(destination: request.destination)
        }
        .accessibilityIdentifier("transcript.panel")
    }
}

/// The content inside the shell: the body for the phase, the menu, the stop confirmation, Copy feedback and the
/// one-shot announcements.
private struct TranscriptPanelContent: View {
    let transcript: TranscriptPresenter
    @State private var copyCount = 0
    @State private var showsCopied = false

    var body: some View {
        let snapshot = transcript.snapshot
        TranscriptPanelBody(transcript: transcript, snapshot: snapshot, showsCopied: showsCopied)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    TranscriptPanelMenu(transcript: transcript, snapshot: snapshot, onCopy: copy)
                }
            }
            .conclaveGestureFeedback(.linkCopied, trigger: copyCount)
            .task(id: copyCount) {
                // 6 c: "Copied" on the status row for 1.8 s; event driven, never an appearance callback.
                guard copyCount > 0 else { return }
                showsCopied = true
                try? await Task.sleep(nanoseconds: 1_800_000_000)
                if Task.isCancelled { return }
                showsCopied = false
            }
            .confirmationDialog(TranscriptCopy.stopTitle,
                                isPresented: Binding(get: { transcript.snapshot.stop == StopPhase.confirming },
                                                     set: { shown in
                                                         // The button action and this dismissal may arrive in either
                                                         // order: cancel on the next turn, when a confirm has already
                                                         // moved the stop on (cancelStop then does nothing).
                                                         if shown { return }
                                                         Task { @MainActor in transcript.cancelStop() }
                                                     }),
                                titleVisibility: .visible) {
                Button(TranscriptCopy.stopConfirm, role: .destructive) { transcript.confirmStop() }
                    .accessibilityIdentifier("transcript.stopDialog.confirm")
                Button(TranscriptCopy.cancel, role: .cancel) { transcript.cancelStop() }
                    .accessibilityIdentifier("transcript.stopDialog.cancel")
            } message: {
                Text(TranscriptCopy.stopMessage)
            }
            .modifier(TranscriptPanelAnnouncer(transcript: transcript))
    }

    private func copy() {
        let room = transcript.inputs.roomId
        UIPasteboard.general.string = transcript.copyText(labels: TranscriptCopy.exportLabels(roomId: room),
                                                          timeLabel: { TranscriptCopy.clock($0) })
        transcript.noteCopied()
        copyCount += 1
    }
}

/// The body for the phase (6 f).
private struct TranscriptPanelBody: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    let showsCopied: Bool

    var body: some View {
        switch snapshot.body {
        case .loading:
            ConclaveLoadingStatus(label: TranscriptCopy.loading, identifier: "transcript.loading")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unavailable:
            ConclaveErrorStatus(title: TranscriptCopy.unavailableTitle, message: TranscriptCopy.unavailableBody,
                                systemImage: ConclaveSymbols.exclamationmarkTriangleFill, retryTitle: TranscriptCopy.tryAgain,
                                identifier: "transcript.unavailable") {
                transcript.retryConnection()
            }
        case .relayUnavailable:
            ConclaveEmptyStatus(title: TranscriptCopy.relayUnavailableTitle, message: TranscriptCopy.relayUnavailableBody,
                                systemImage: ConclaveSymbols.captionsBubble, identifier: "transcript.relayUnavailable")
        case .startCard:
            TranscriptPanelStartCard(transcript: transcript, snapshot: snapshot)
        case .content:
            TranscriptPanelSession(transcript: transcript, snapshot: snapshot, showsCopied: showsCopied)
        }
    }
}

// MARK: Menu (6 c)

private struct TranscriptPanelMenu: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    let onCopy: () -> Void

    var body: some View {
        Menu {
            if snapshot.hasContent {
                ShareLink(item: TranscriptPanelExportItem(presenter: transcript),
                          preview: SharePreview(TranscriptCopy.shareTitle)) {
                    Label(TranscriptCopy.export, systemImage: ConclaveSymbols.squareAndArrowUp)
                }
                .accessibilityIdentifier("transcript.menu.export")
                Button(action: onCopy) {
                    Label(TranscriptCopy.copy, systemImage: ConclaveSymbols.docOnDoc)
                }
                .accessibilityIdentifier("transcript.menu.copy")
            }
            if snapshot.offersRecapToChat {
                Button { transcript.postRecapToChat() } label: {
                    Label(TranscriptCopy.postRecap, systemImage: ConclaveSymbols.sparkles)
                }
                    .disabled(snapshot.recap == RecapPhase.posting)
                    .accessibilityIdentifier("transcript.menu.recap")
            }
            if snapshot.canStop {
                Button(role: .destructive) { transcript.requestStop() } label: {
                    Label(TranscriptCopy.stopMenu, systemImage: ConclaveSymbols.stopFill)
                }
                    .disabled(snapshot.controlsDisabled)
                    .accessibilityIdentifier("transcript.menu.stop")
            }
        } label: {
            Image(systemName: ConclaveSymbols.ellipsis)
                .accessibilityLabel(TranscriptCopy.moreActions)
        }
        .disabled(!TranscriptViewPolicy.menuEnabled(hasContent: snapshot.hasContent, canStop: snapshot.canStop,
                                                    offersRecap: snapshot.offersRecapToChat))
        .accessibilityIdentifier("transcript.menu")
    }
}

/// Export (6 l 3): the finals-only Markdown file `conclave-<room>-transcript.md`, built when the share sheet asks for
/// it (never per body), written into the temporary directory.
struct TranscriptPanelExportItem: Transferable {
    let presenter: TranscriptPresenter

    static let contentType: UTType = UTType(filenameExtension: "md", conformingTo: .plainText) ?? .plainText

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: TranscriptPanelExportItem.contentType) { item in
            let file = await MainActor.run {
                item.presenter.exportFile(labels: TranscriptCopy.exportLabels(roomId: item.presenter.inputs.roomId),
                                          timeLabel: { TranscriptCopy.clock($0) })
            }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(file.fileName)
            try file.content.write(to: url, atomically: true, encoding: .utf8)
            return SentTransferredFile(url)
        }
    }
}

// MARK: Start card (6 c, f)

private struct TranscriptPanelStartCard: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    @State private var provider = TranscriptProvider.openAI
    @State private var assistantModel = TranscriptConfiguration.defaultAssistantModel
    @State private var providerKey = ""
    @State private var assistantKey = ""
    @State private var optionsExpanded = false
    @State private var didSeed = false

    var body: some View {
        if TranscriptViewPolicy.showsStartBar(body: snapshot.body, offersStart: snapshot.offersStart) {
            form.conclaveComposerBar { startBar }
        } else {
            form
        }
    }

    private var coverage: KeyCoverage {
        TranscriptKeyPolicy.coverage(provider: provider, keysKnown: snapshot.keysKnown, openAICovered: snapshot.openAICovered,
                                     sarvamCovered: snapshot.sarvamCovered)
    }

    private var form: some View {
        Form {
            Section {
                EmptyView()
            } header: {
                VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space8)) {
                    HStack(spacing: CGFloat(DesignTokens.space8)) {
                        Text(TranscriptCopy.kicker)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HostingTheme.coralText)
                        TranscriptPanelTag(title: TranscriptCopy.beta)
                        if snapshot.isViewOnly { TranscriptPanelTag(title: TranscriptCopy.viewOnly) }
                    }
                    Text(TranscriptCopy.startTitle(snapshot.startKind))
                        .font(.title2)
                        .foregroundStyle(Color.primary)
                        .accessibilityAddTraits(.isHeader)
                    Text(TranscriptCopy.blurb(TranscriptViewPolicy.blurb(kind: snapshot.startKind, coverage: coverage,
                                                                         isViewOnly: snapshot.isViewOnly)))
                        .font(.body)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
                .textCase(nil)
                .padding(.bottom, CGFloat(DesignTokens.space8))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("transcript.startCard.header")
            }
            if snapshot.offersStart {
                Section {
                    DisclosureGroup(TranscriptCopy.options, isExpanded: $optionsExpanded) {
                        Picker(TranscriptCopy.provider, selection: $provider) {
                            ForEach(TranscriptConfiguration.providers) { option in
                                Text(TranscriptCopy.providerName(option)).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("transcript.options.provider")
                        Picker(TranscriptCopy.assistant, selection: $assistantModel) {
                            ForEach(TranscriptConfiguration.assistantModels) { model in
                                Text(verbatim: model.label).tag(model.id)
                            }
                        }
                        .pickerStyle(.menu)
                        .accessibilityIdentifier("transcript.options.assistant")
                        if TranscriptKeyPolicy.needsProviderKey(provider: provider, openAICovered: snapshot.openAICovered,
                                                                sarvamCovered: snapshot.sarvamCovered) {
                            SecureField(TranscriptCopy.providerKey(provider), text: $providerKey)
                                .textContentType(.password)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .accessibilityIdentifier("transcript.options.providerKey")
                        }
                        if TranscriptKeyPolicy.needsAssistantKey(provider: provider, openAICovered: snapshot.openAICovered) {
                            SecureField(TranscriptCopy.assistantKey, text: $assistantKey)
                                .textContentType(.password)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .accessibilityIdentifier("transcript.options.assistantKey")
                        }
                    }
                    .accessibilityIdentifier("transcript.options")
                } footer: {
                    TranscriptPanelCoverageLine(coverage: coverage)
                }
            }
        }
        .onAppear(perform: seed)
        .onChange(of: provider) { _, value in transcript.drafts.provider = value }
        .onChange(of: assistantModel) { _, value in transcript.drafts.assistantModel = value }
        .onChange(of: providerKey) { _, value in transcript.drafts.providerKey = value }
        .onChange(of: assistantKey) { _, value in transcript.drafts.assistantKey = value }
        .onChange(of: optionsExpanded) { _, value in transcript.drafts.optionsExpanded = value }
        .accessibilityIdentifier("transcript.startCard")
    }

    private var startBar: some View {
        let ready = TranscriptKeyPolicy.hasRequiredKeys(provider: provider, keysKnown: snapshot.keysKnown,
                                                        openAICovered: snapshot.openAICovered, sarvamCovered: snapshot.sarvamCovered,
                                                        providerKey: providerKey, assistantKey: assistantKey)
        return ConclaveButton(TranscriptCopy.startButton(snapshot.startKind), role: .primary, isEnabled: ready,
                              identifier: "transcript.start") {
            let options = TranscriptKeyPolicy.options(provider: provider, assistantModel: assistantModel,
                                                      openAICovered: snapshot.openAICovered, sarvamCovered: snapshot.sarvamCovered,
                                                      providerKey: providerKey, assistantKey: assistantKey)
            if transcript.start(options: options) {
                providerKey = ""
                assistantKey = ""
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, CGFloat(DesignTokens.space16))
        .padding(.vertical, CGFloat(DesignTokens.space8))
    }

    /// The draft survives a reopen within the call (6 j); the keys come back empty after a close.
    private func seed() {
        if didSeed { return }
        didSeed = true
        let drafts = transcript.drafts
        provider = drafts.provider
        assistantModel = drafts.assistantModel
        providerKey = drafts.providerKey
        assistantKey = drafts.assistantKey
        optionsExpanded = drafts.optionsExpanded
    }
}

private struct TranscriptPanelCoverageLine: View {
    let coverage: KeyCoverage

    var body: some View {
        HStack(spacing: CGFloat(DesignTokens.space8)) {
            if coverage == KeyCoverage.unknown {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: coverage == KeyCoverage.covered ? ConclaveSymbols.checkmark : ConclaveSymbols.infoCircle)
                    .accessibilityHidden(true)
            }
            Text(TranscriptCopy.coverage(coverage))
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("transcript.coverage")
    }
}

/// A neutral tag ("Beta", "View Only"): never coral (C06).
private struct TranscriptPanelTag: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
    }
}

// MARK: Session (tabs, status, lists)

private struct TranscriptPanelSession: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    let showsCopied: Bool

    var body: some View {
        TranscriptPanelTabContent(transcript: transcript, snapshot: snapshot)
            .conclaveTopBar {
                TranscriptPanelTopBar(transcript: transcript, snapshot: snapshot, showsCopied: showsCopied)
            }
    }
}

/// Reads `transcript.tab` alone, so a tab change never re-runs the top bar.
private struct TranscriptPanelTabContent: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot

    var body: some View {
        switch transcript.tab {
        case .transcript:
            TranscriptPanelFeedList(feed: transcript.feed)
        case .ask:
            TranscriptPanelAskView(transcript: transcript, snapshot: snapshot)
        case .minutes:
            TranscriptPanelMinutesList(transcript: transcript, snapshot: snapshot)
        }
    }
}

private struct TranscriptPanelTopBar: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    let showsCopied: Bool

    var body: some View {
        VStack(spacing: 0) {
            if !snapshot.tabs.isEmpty {
                ConclaveViewSwitch(TranscriptCopy.viewSwitchLabel, options: options,
                                   selection: Binding(get: { transcript.tab.rawValue },
                                                      set: { raw in transcript.select(TranscriptTab(rawValue: raw) ?? TranscriptTab.transcript) }),
                                   identifier: "transcript.tabs")
            }
            TranscriptPanelStatusRow(transcript: transcript, snapshot: snapshot, showsCopied: showsCopied)
            TranscriptPanelIssueBanner(transcript: transcript, snapshot: snapshot)
            #if DEBUG
            if TranscriptDiagnostics.driver != nil {
                TranscriptPanelFixtureBar()
            }
            #endif
        }
        .background(Color(uiColor: .systemBackground))
    }

    private var options: [ConclaveSegmentModel] {
        var result: [ConclaveSegmentModel] = []
        for tab in snapshot.tabs {
            result.append(ConclaveSegmentModel(id: tab.rawValue, title: TranscriptCopy.tab(tab), isEnabled: true))
        }
        return result
    }
}

/// Phase with its glyph or spinner, the host line (or "Copied" for 1.8 s), and the controller's Pause or Resume and
/// Stop… (44 pt minimum height, 6 c).
private struct TranscriptPanelStatusRow: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    let showsCopied: Bool

    var body: some View {
        HStack(spacing: CGFloat(DesignTokens.space8)) {
            HStack(spacing: CGFloat(DesignTokens.space8)) {
                TranscriptPanelStatusGlyph(status: snapshot.status)
                Text(TranscriptCopy.status(snapshot.status))
                    .font(.subheadline.weight(.semibold))
                let detail = showsCopied ? TranscriptCopy.copied : TranscriptCopy.host(snapshot.host, name: snapshot.controllerName)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .lineLimit(2)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("transcript.status")
            Spacer(minLength: CGFloat(DesignTokens.space8))
            if snapshot.status == TranscriptStatusKind.ended && snapshot.offersStart {
                ConclaveButton(TranscriptCopy.startButton(TranscriptStartKind.start), role: .primary,
                               isEnabled: endedStartReady, identifier: "transcript.status.start") {
                    transcript.start(options: endedStartOptions)
                }
            }
            if snapshot.canPause {
                Button(snapshot.phase == LiveNotesPhase.paused ? TranscriptCopy.resume : TranscriptCopy.pause) {
                    if snapshot.phase == LiveNotesPhase.paused { transcript.resume() } else { transcript.pause() }
                }
                .buttonStyle(.bordered)
                .tint(Color.primary)
                .disabled(snapshot.controlsDisabled)
                .frame(minHeight: 44)
                .accessibilityIdentifier("transcript.status.pause")
            }
            if snapshot.canStop {
                Button(TranscriptCopy.stop, role: .destructive) { transcript.requestStop() }
                    .buttonStyle(.bordered)
                    .disabled(snapshot.controlsDisabled)
                    .frame(minHeight: 44)
                    .accessibilityLabel(TranscriptCopy.stopConfirm)
                    .accessibilityIdentifier("transcript.status.stop")
            }
        }
        .frame(minHeight: 44)
        .padding(.horizontal, CGFloat(DesignTokens.space16))
        .padding(.vertical, CGFloat(DesignTokens.space4))
    }

    /// Ended: Start Notes on the status bar uses the Options draft (the keys it needs must be filled on the start card).
    private var endedStartOptions: TranscriptStartOptions {
        let drafts = transcript.drafts
        return TranscriptKeyPolicy.options(provider: drafts.provider, assistantModel: drafts.assistantModel,
                                           openAICovered: snapshot.openAICovered, sarvamCovered: snapshot.sarvamCovered,
                                           providerKey: drafts.providerKey, assistantKey: drafts.assistantKey)
    }

    private var endedStartReady: Bool {
        let drafts = transcript.drafts
        return TranscriptKeyPolicy.hasRequiredKeys(provider: drafts.provider, keysKnown: snapshot.keysKnown,
                                                   openAICovered: snapshot.openAICovered, sarvamCovered: snapshot.sarvamCovered,
                                                   providerKey: drafts.providerKey, assistantKey: drafts.assistantKey)
    }
}

/// A static dot for Live (statusLive, with the text twin) and Paused (statusWarning); the system spinner while
/// starting, stopping or reconnecting; nothing once ended. No pulse (R13).
private struct TranscriptPanelStatusGlyph: View {
    let status: TranscriptStatusKind

    var body: some View {
        switch status {
        case .live:
            Circle().fill(HostingTheme.statusLive).frame(width: 8, height: 8).accessibilityHidden(true)
        case .paused:
            Circle().fill(HostingTheme.statusWarning).frame(width: 8, height: 8).accessibilityHidden(true)
        case .starting, .stopping, .reconnecting:
            ProgressView().controlSize(.small).accessibilityHidden(true)
        case .none, .ended:
            EmptyView()
        }
    }
}

/// The issue row (F00 C12, system palette): no permission, controls reconnecting, relay failed with Try Again, server
/// text verbatim; and the stop failure with Try Again.
private struct TranscriptPanelIssueBanner: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot

    var body: some View {
        VStack(spacing: CGFloat(DesignTokens.space8)) {
            if snapshot.stop == StopPhase.failed {
                ConclaveBanner(kind: .error, text: TranscriptCopy.stopFailed, surface: .app,
                               actions: [ConclaveBannerAction(title: TranscriptCopy.tryAgain, identifier: "transcript.stopFailed.retry",
                                                              action: { transcript.confirmStop() })],
                               identifier: "transcript.stopFailed")
            } else if snapshot.issue != TranscriptIssue.none {
                let text = TranscriptCopy.issue(snapshot.issue, serverText: snapshot.issueServerText)
                if !text.isEmpty {
                    ConclaveBanner(kind: snapshot.issue == TranscriptIssue.controlsReconnecting ? .reconnecting : .warning, text: text,
                                   surface: .app, actions: actions, lineLimit: 4, identifier: "transcript.issue")
                }
            }
        }
        .padding(.horizontal, CGFloat(DesignTokens.space16))
        .padding(.bottom, snapshot.issue != TranscriptIssue.none || snapshot.stop == StopPhase.failed ? CGFloat(DesignTokens.space8) : 0)
    }

    private var actions: [ConclaveBannerAction] {
        if snapshot.issue != TranscriptIssue.relayFailed { return [] }
        return [ConclaveBannerAction(title: TranscriptCopy.tryAgain, identifier: "transcript.issue.retry",
                                     action: { transcript.retryConnection() })]
    }
}

// MARK: Transcript list (6 c, L6-4)

/// The iOS 17 sentinel's reference box: mutating it never invalidates a body (AGENTS appearance-callback rule).
private final class TranscriptPanelBottomSentinel {
    var isVisible = true
}

private struct TranscriptPanelFollowKey: Equatable {
    let id: String
    let revision: Int
}

private struct TranscriptPanelFeedList: View {
    let feed: TranscriptFeed
    @State private var isAtBottom = true
    @State private var sentinel = TranscriptPanelBottomSentinel()

    var body: some View {
        let ids = feed.rowIds
        if ids.isEmpty {
            ConclaveEmptyStatus(title: TranscriptCopy.listeningTitle, message: TranscriptCopy.listeningBody,
                                systemImage: ConclaveSymbols.captionsBubble, identifier: "transcript.listening")
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(ids, id: \.self) { id in
                            TranscriptPanelRowView(row: feed.row(id))
                                .id(id)
                        }
                        if !TranscriptPanelPlatform.usesScrollGeometry {
                            Color.clear
                                .frame(height: 1)
                                .accessibilityHidden(true)
                                .onAppear { setBottomVisible(true) }
                                .onDisappear { setBottomVisible(false) }
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, CGFloat(DesignTokens.space16))
                    .padding(.vertical, CGFloat(DesignTokens.space12))
                }
                .defaultScrollAnchor(.bottom)
                .modifier(TranscriptPanelSizeChangeAnchor())
                .modifier(TranscriptPanelBottomProximity(isAtBottom: $isAtBottom))
                .background {
                    TranscriptPanelFollowLeaf(feed: feed, proxy: proxy, isPinned: { pinned })
                }
                .overlay(alignment: .bottom) {
                    // 6 h: the pill fades in 120 ms (opacity only), scoped to the pill so no list content animates.
                    TranscriptPanelJumpPill {
                        jump(proxy, to: feed.newestId)
                    }
                    .padding(.bottom, CGFloat(DesignTokens.space8))
                    .opacity(isAtBottom ? 0 : 1)
                    .allowsHitTesting(!isAtBottom)
                    .accessibilityHidden(isAtBottom)
                    .animation(.easeOut(duration: 0.12), value: isAtBottom)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .accessibilityIdentifier("transcript.list")
        }
    }

    private var pinned: Bool {
        TranscriptPanelPlatform.usesScrollGeometry ? isAtBottom : sentinel.isVisible
    }

    /// Value guarded: the sentinel's callbacks re-fire with body re-runs.
    private func setBottomVisible(_ visible: Bool) {
        sentinel.isVisible = visible
        if isAtBottom != visible { isAtBottom = visible }
    }

    private func jump(_ proxy: ScrollViewProxy, to id: String) {
        guard !id.isEmpty else { return }
        proxy.scrollTo(id, anchor: .bottom)
        isAtBottom = true
    }
}

/// The follow rule (6 c): an event handler on the newest row id plus its revision, so growth inside the live row is
/// followed while pinned and never otherwise. A zero-size leaf: it alone reads the newest revision.
private struct TranscriptPanelFollowLeaf: View {
    let feed: TranscriptFeed
    let proxy: ScrollViewProxy
    let isPinned: () -> Bool

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onChange(of: TranscriptPanelFollowKey(id: feed.newestId, revision: feed.newestRevision)) { _, key in
                guard isPinned(), !key.id.isEmpty else { return }
                proxy.scrollTo(key.id, anchor: .bottom)
            }
    }
}

enum TranscriptPanelPlatform {
    static var usesScrollGeometry: Bool {
        if #available(iOS 18.0, *) { return true }
        return false
    }
}

/// iOS 18: keep a growing live row pinned (S40 `SizeChangeBottomAnchor`).
private struct TranscriptPanelSizeChangeAnchor: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.defaultScrollAnchor(.bottom, for: .sizeChanges)
        } else {
            content
        }
    }
}

/// iOS 18: at the bottom within 24 pt, from scroll geometry (S40 `BottomProximity`).
private struct TranscriptPanelBottomProximity: ViewModifier {
    @Binding var isAtBottom: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 24
            } action: { _, atBottom in
                if isAtBottom != atBottom { isAtBottom = atBottom }
            }
        } else {
            content
        }
    }
}

/// S40 CL5: neutral latest affordance with canonical decorative artwork.
private struct TranscriptPanelJumpPill: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label {
                Text(TranscriptCopy.jumpToLatest)
            } icon: {
                Image(systemName: ConclaveSymbols.arrowDown).accessibilityHidden(true)
            }
        }
        .buttonStyle(.bordered)
        .tint(.primary)
        .controlSize(.small)
        .frame(minHeight: 44)
        .background(Color(uiColor: .systemBackground), in: Capsule())
        .accessibilityIdentifier("transcript.jumpPill")
    }
}

/// One row (L6-4 `TranscriptGroupRow` or `PauseMarkerRow`); reads only its own model.
private struct TranscriptPanelRowView: View {
    let row: TranscriptRowModel

    var body: some View {
        #if DEBUG
        let _ = TranscriptDiagnostics.counters?.bump("transcript.row." + row.id + ".recompose")
        #endif
        if row.isPauseMarker {
            HStack(spacing: CGFloat(DesignTokens.space8)) {
                Rectangle().fill(Color(uiColor: .separator)).frame(height: 1)
                Text(TranscriptCopy.resumedAt(row.startMillis))
                    .font(.caption)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .layoutPriority(1)
                Rectangle().fill(Color(uiColor: .separator)).frame(height: 1)
            }
            .padding(.vertical, CGFloat(DesignTokens.space12))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("transcript.row." + row.id)
        } else {
            let name = TranscriptCopy.speaker(row.speakerName, isYou: row.isYou)
            let time = TranscriptCopy.clock(row.startMillis)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(name)
                        .font(.subheadline.weight(.semibold))
                    Spacer(minLength: CGFloat(DesignTokens.space8))
                    Text(time)
                        .font(.caption)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .monospacedDigit()
                }
                Text(row.text)
                    .font(.body)
                    .foregroundStyle(row.isFinal ? Color.primary : HostingTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, CGFloat(DesignTokens.space8))
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(name + ", " + time + ", " + row.text)
            .accessibilityValue(row.isFinal ? "" : TranscriptCopy.stillSpeaking)
            .accessibilityIdentifier("transcript.row." + row.id)
        }
    }
}

// MARK: Ask (6 c)

private struct TranscriptPanelAskView: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    @State private var draft = ""
    @State private var didSeed = false

    var body: some View {
        let showsComposer = TranscriptViewPolicy.showsAskComposer(tab: TranscriptTab.ask, canAsk: snapshot.canAsk, phase: snapshot.phase)
        Group {
            if showsComposer {
                TranscriptPanelAskList(transcript: transcript, onSuggestion: { draft = $0 })
                    .conclaveComposerBar {
                        TranscriptPanelAskComposer(transcript: transcript, snapshot: snapshot, draft: $draft)
                    }
            } else {
                TranscriptPanelAskList(transcript: transcript, onSuggestion: { draft = $0 })
            }
        }
        .onAppear {
            if !didSeed {
                didSeed = true
                draft = transcript.drafts.ask
            }
        }
        .onChange(of: draft) { _, value in transcript.drafts.ask = value }
    }
}

private struct TranscriptPanelAskList: View {
    let transcript: TranscriptPresenter
    let onSuggestion: (String) -> Void
    @State private var isAtBottom = true
    @State private var sentinel = TranscriptPanelBottomSentinel()

    var body: some View {
        let thread = transcript.ask
        let ids = thread.rowIds
        if ids.isEmpty {
            ContentUnavailableView {
                Label(TranscriptCopy.askEmptyTitle, systemImage: ConclaveSymbols.sparkles)
                    .accessibilityAddTraits(.isHeader)
            } description: {
                Text(TranscriptCopy.askEmptyBody)
            } actions: {
                VStack(spacing: CGFloat(DesignTokens.space8)) {
                    ForEach(TranscriptCopy.askSuggestions, id: \.self) { suggestion in
                        // Fills the field, never sends; tonal so the coral prominent action stays the only coral one.
                        Button(suggestion) { onSuggestion(suggestion) }
                            .buttonStyle(.bordered)
                            .tint(.primary)
                    }
                }
            }
            .accessibilityIdentifier("transcript.ask.empty")
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: CGFloat(DesignTokens.space12)) {
                        ForEach(ids, id: \.self) { id in
                            TranscriptPanelAskRow(row: thread.row(id), onRetry: { transcript.retryAsk(rowId: id) })
                                .id(id)
                        }
                        if !TranscriptPanelPlatform.usesScrollGeometry {
                            Color.clear
                                .frame(height: 1)
                                .accessibilityHidden(true)
                                .onAppear { setBottomVisible(true) }
                                .onDisappear { setBottomVisible(false) }
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, CGFloat(DesignTokens.space16))
                    .padding(.vertical, CGFloat(DesignTokens.space12))
                }
                .defaultScrollAnchor(.bottom)
                .modifier(TranscriptPanelSizeChangeAnchor())
                .modifier(TranscriptPanelBottomProximity(isAtBottom: $isAtBottom))
                .background {
                    TranscriptPanelAskFollowLeaf(thread: thread, proxy: proxy, isPinned: { pinned })
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .accessibilityIdentifier("transcript.ask.list")
        }
    }

    private var pinned: Bool {
        TranscriptPanelPlatform.usesScrollGeometry ? isAtBottom : sentinel.isVisible
    }

    private func setBottomVisible(_ visible: Bool) {
        sentinel.isVisible = visible
        if isAtBottom != visible { isAtBottom = visible }
    }
}

/// A new question scrolls to it; a streaming answer's growth is followed only while pinned (S40 `StreamingFollow17`).
private struct TranscriptPanelAskFollowLeaf: View {
    let thread: AskThread
    let proxy: ScrollViewProxy
    let isPinned: () -> Bool

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onChange(of: thread.rowIds) { _, ids in
                if let last = ids.last { proxy.scrollTo(last, anchor: .bottom) }
            }
            .onChange(of: thread.tailGrowth) { _, _ in
                guard isPinned(), let last = thread.rowIds.last else { return }
                proxy.scrollTo(last, anchor: .bottom)
            }
    }
}

/// One question (trailing, coral with onCoral ink) and its answer (leading, neutral), S40 CL1. Thinking is static
/// "Thinking" plus the system spinner (R13); answers render the CHT-7 markdown renderer; failures carry Try Again.
private struct TranscriptPanelAskRow: View {
    let row: AskRow
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space8)) {
            HStack {
                Spacer(minLength: 48)
                ConclaveChatBubble(tone: .own, identifier: "transcript.ask." + row.id + ".question") {
                    Text(row.question)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(TranscriptCopy.youAsked + ", " + row.question)
            }
            HStack {
                answer
                Spacer(minLength: 48)
            }
        }
        .accessibilityIdentifier("transcript.ask." + row.id)
    }

    @ViewBuilder
    private var answer: some View {
        switch row.state {
        case .thinking:
            ConclaveChatBubble(tone: .answer, identifier: "transcript.ask." + row.id + ".answer") {
                HStack(spacing: CGFloat(DesignTokens.space8)) {
                    ProgressView().controlSize(.small)
                    Text(TranscriptCopy.thinking)
                }
            }
            .accessibilityElement(children: .combine)
        case .streaming, .done:
            ConclaveChatBubble(tone: .answer, identifier: "transcript.ask." + row.id + ".answer") {
                AssistantMarkdownView(blocks: row.blocks, identifier: "transcript.ask." + row.id + ".markdown")
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(TranscriptCopy.conclaveAnswered)
            .contextMenu {
                if row.state == AskRowState.done {
                    Button {
                        UIPasteboard.general.string = row.answerText
                    } label: {
                        Label(TranscriptCopy.copyAnswer, systemImage: ConclaveSymbols.docOnDoc)
                    }
                }
            }
        case .error, .notSent, .timedOut:
            ConclaveChatBubble(tone: .answer, identifier: "transcript.ask." + row.id + ".answer") {
                VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space8)) {
                    Text(TranscriptCopy.askState(row.state, errorText: row.errorText))
                        .font(.body)
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(TranscriptCopy.tryAgain, action: onRetry)
                        .buttonStyle(.borderless)
                        .tint(HostingTheme.coralText)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("transcript.ask." + row.id + ".retry")
                }
            }
        }
    }
}

/// The one F00 C19 composer (no attach control for Ask): the Liquid Glass cluster on iOS 26 and later, the opaque
/// bordered field below and under Reduce Transparency (owner OQ2). The footnote sits above the field.
private struct TranscriptPanelAskComposer: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    @Binding var draft: String
    @FocusState private var focused: Bool

    var body: some View {
        let canSend = AskRowPolicy.canSend(draft, canAsk: snapshot.canAsk, phase: snapshot.phase, link: snapshot.link)
        ConclaveComposerStack(identifier: "transcript.ask.composer") {
            ConclaveComposerStatusLine(text: TranscriptCopy.askPrivate, identifier: "transcript.ask.private")
        } field: {
            ConclaveComposerField(identifier: "transcript.ask.composer.cluster") {
                TextField(TranscriptCopy.askPlaceholder, text: $draft, axis: .vertical)
                    .lineLimit(1...ConclaveComposerMetrics.maximumLines)
                    .textInputAutocapitalization(.sentences)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .accessibilityLabel(TranscriptCopy.askPlaceholder)
                    .accessibilityIdentifier("transcript.ask.field")
            } send: {
                ConclaveComposerSendButton(title: TranscriptCopy.askSend, isEnabled: canSend,
                                           identifier: "transcript.ask.send", action: send)
            }
        }
    }

    private func send() {
        if transcript.askQuestion(draft) { draft = "" }
    }
}

// MARK: Minutes (6 c)

private struct TranscriptPanelMinutesList: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot

    var body: some View {
        let minutes = transcript.minutes
        let empty = MinutesPolicy.emptyKind(phase: snapshot.phase, hasContent: minutes.hasContent)
        List {
            Section {
                TranscriptPanelMinutesStatus(updating: snapshot.minutesUpdating, updatedAtMillis: snapshot.minutesUpdatedAtMillis)
                if snapshot.canRefreshMinutes {
                    Button(TranscriptCopy.refreshMinutes) { transcript.refreshMinutes() }
                        .disabled(snapshot.minutesUpdating)
                        .accessibilityIdentifier("transcript.minutes.refresh")
                }
                if snapshot.offersRecapToChat || snapshot.recap != RecapPhase.idle {
                    TranscriptPanelRecapRow(transcript: transcript, recap: snapshot.recap, offersRecap: snapshot.offersRecapToChat)
                }
            }
            if !minutes.summary.isEmpty {
                Section {
                    Text(minutes.summary)
                        .fixedSize(horizontal: false, vertical: true)
                } header: {
                    Text(TranscriptCopy.section(MinutesSection.summary))
                        .accessibilityAddTraits(.isHeader)
                }
            }
            ForEach(minutes.sections) { section in
                Section {
                    ForEach(section.entries) { entry in
                        TranscriptPanelMinutesEntryRow(entry: entry)
                    }
                } header: {
                    Text(TranscriptCopy.section(section.section))
                        .accessibilityAddTraits(.isHeader)
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if empty != MinutesEmptyKind.none {
                ConclaveEmptyStatus(title: TranscriptCopy.emptyTitle(empty), message: TranscriptCopy.emptyBody(empty),
                                    systemImage: ConclaveSymbols.listBulletClipboard, identifier: "transcript.minutes.empty")
                    .padding(.top, 120)
            }
        }
        .accessibilityIdentifier("transcript.minutes")
    }
}

/// The status row; the relative time refreshes once a minute while Minutes is visible (6 k, the only timer).
private struct TranscriptPanelMinutesStatus: View {
    let updating: Bool
    let updatedAtMillis: Double

    var body: some View {
        let kind = MinutesPolicy.statusKind(updating: updating, updatedAtMillis: updatedAtMillis)
        HStack(spacing: CGFloat(DesignTokens.space8)) {
            if kind == MinutesStatusKind.updating {
                ProgressView().controlSize(.small)
            }
            if kind == MinutesStatusKind.updated {
                TimelineView(.periodic(from: Date(), by: 60)) { context in
                    Text(TranscriptCopy.minutesStatus(kind, updatedAtMillis: updatedAtMillis,
                                                      nowMillis: context.date.timeIntervalSince1970 * 1000.0))
                }
            } else {
                Text(TranscriptCopy.minutesStatus(kind, updatedAtMillis: updatedAtMillis, nowMillis: 0))
            }
        }
        .foregroundStyle(HostingTheme.secondaryText)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("transcript.minutes.status")
    }
}

/// D23: "Post Recap to Chat" with its detail; value "Posting" with a spinner, then "Posted"; a failure line with Try
/// Again under it. The announcements come from the presenter (one per change).
private struct TranscriptPanelRecapRow: View {
    let transcript: TranscriptPresenter
    let recap: RecapPhase
    let offersRecap: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space4)) {
            Button {
                transcript.postRecapToChat()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(TranscriptCopy.postRecap)
                        Text(TranscriptCopy.recapDetail)
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.secondaryText)
                    }
                    Spacer(minLength: CGFloat(DesignTokens.space8))
                    if recap == RecapPhase.posting {
                        ProgressView().controlSize(.small)
                    }
                    if recap == RecapPhase.posting || recap == RecapPhase.posted {
                        Text(TranscriptCopy.recapValue(recap))
                            .foregroundStyle(HostingTheme.secondaryText)
                    }
                }
            }
            .disabled(!offersRecap || recap == RecapPhase.posting)
            .accessibilityIdentifier("transcript.minutes.recap")
            if recap == RecapPhase.failed {
                Text(TranscriptCopy.recapValue(RecapPhase.failed))
                    .font(.footnote)
                    .foregroundStyle(Color(uiColor: .systemRed))
                Button(TranscriptCopy.tryAgain) { transcript.postRecapToChat() }
                    .buttonStyle(.borderless)
                    .tint(HostingTheme.coralText)
                    .disabled(!offersRecap)
                    .accessibilityIdentifier("transcript.minutes.recap.retry")
            }
        }
    }
}

private struct TranscriptPanelMinutesEntryRow: View {
    let entry: MinutesEntryModel

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space4)) {
            Text(entry.text)
                .fixedSize(horizontal: false, vertical: true)
            if !entry.owner.isEmpty {
                Text(TranscriptCopy.owner(entry.owner))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
            }
            if !entry.due.isEmpty {
                Text(TranscriptCopy.due(entry.due))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: Announcements (6 i)

/// Speaks the presenter's one-shot announcements politely, and with VoiceOver on and the Transcript tab visible each
/// newly finalized line at most once every 2 s (never partials).
private struct TranscriptPanelAnnouncer: ViewModifier {
    let transcript: TranscriptPresenter
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled

    func body(content: Content) -> some View {
        content
            .onChange(of: transcript.announcement) { _, announcement in
                guard let announcement else { return }
                AccessibilityNotification.Announcement(TranscriptCopy.announcement(announcement.kind)).post()
            }
            .background {
                if voiceOverEnabled && transcript.tab == TranscriptTab.transcript {
                    TranscriptPanelFinalizedAnnouncer(feed: transcript.feed)
                }
            }
    }
}

private struct TranscriptPanelFinalizedAnnouncer: View {
    let feed: TranscriptFeed
    @State private var lastSpokenAt = Date.distantPast

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .task(id: feed.finalized.serial) {
                let line = feed.finalized
                guard line.serial > 0, !line.text.isEmpty else { return }
                let wait = 2.0 - Date().timeIntervalSince(lastSpokenAt)
                if wait > 0 {
                    // A newer line restarts this task, so only the latest of a burst is spoken.
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                    if Task.isCancelled { return }
                }
                lastSpokenAt = Date()
                var text = AttributedString(TranscriptCopy.speaker(line.speakerName, isYou: false) + ": " + line.text)
                text.accessibilitySpeechAnnouncementPriority = .low
                AccessibilityNotification.Announcement(text).post()
            }
    }
}

// MARK: Debug fixture bar (L6-12)

#if DEBUG
private struct TranscriptPanelFixtureBar: View {
    @State private var refresh = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ScrollView(.horizontal) {
                HStack(spacing: CGFloat(DesignTokens.space8)) {
                    ForEach(TranscriptFixtureScriptName.allCases, id: \.self) { script in
                        Button {
                            TranscriptDiagnostics.driver?.run(script)
                            refresh += 1
                        } label: {
                            Text(verbatim: script.rawValue)
                                .font(.caption)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("transcript.fixture." + script.rawValue)
                    }
                }
            }
            Text(verbatim: TranscriptDiagnostics.readout() + (refresh >= 0 ? "" : ""))
                .font(.caption2.monospaced())
                .foregroundStyle(HostingTheme.secondaryText)
                .accessibilityIdentifier("transcript.calls")
        }
        .padding(.horizontal, CGFloat(DesignTokens.space16))
        .padding(.bottom, CGFloat(DesignTokens.space4))
    }
}
#endif
#endif
