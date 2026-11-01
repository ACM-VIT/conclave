#if os(iOS) && !SKIP
import SwiftUI
import UIKit
import UniformTypeIdentifiers

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

            guard let request = panels.latestDestination(for: presentation.request.presentationID) else { return }
            transcript.panelDidOpen(destination: request.destination)
        }
        .accessibilityIdentifier("transcript.panel")
    }
}

private struct TranscriptPanelContent: View {
    let transcript: TranscriptPresenter
    @State private var copyCount = 0
    @State private var showsCopied = false
    @State private var copyTask: Task<Void, Never>?

    var body: some View {
        let snapshot = transcript.snapshot
        let subtitle = snapshot.body == TranscriptBody.content
            ? TranscriptCopy.statusLine(snapshot.status, host: snapshot.host, name: snapshot.controllerName, showsCopied: showsCopied)
            : ""
        TranscriptPanelBody(transcript: transcript, snapshot: snapshot, subtitle: subtitle)
            .modifier(TranscriptPanelSubtitle(text: subtitle))
            .toolbar {
                if snapshot.body == TranscriptBody.content && snapshot.canPause {
                    ToolbarItem(placement: .topBarTrailing) {
                        TranscriptPanelPauseButton(transcript: transcript, snapshot: snapshot)
                    }
                }
                if TranscriptViewPolicy.menuEnabled(hasContent: snapshot.hasContent, canStop: snapshot.canStop,
                                                    offersRecap: snapshot.offersRecapToChat) {
                    ToolbarItem(placement: .topBarTrailing) {
                        TranscriptPanelMenu(transcript: transcript, snapshot: snapshot, onCopy: copy)
                    }
                }
            }
            .conclaveGestureFeedback(.linkCopied, trigger: copyCount)
            .task(id: copyCount) {

                guard copyCount > 0 else { return }
                showsCopied = true
                try? await Task.sleep(nanoseconds: 1_800_000_000)
                if Task.isCancelled { return }
                showsCopied = false
            }
            .confirmationDialog(TranscriptCopy.stopTitle,
                                isPresented: Binding(get: { transcript.snapshot.stop == StopPhase.confirming },
                                                     set: { shown in

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
            .onDisappear { copyTask?.cancel() }
    }

    private func copy() {
        copyTask?.cancel()
        let callSession = transcript.inputs.callSession
        let snapshot = transcript.exportSnapshot(labels: TranscriptCopy.exportLabels(roomId: transcript.inputs.roomId))
        copyTask = Task { @MainActor in
            let file = await Task.detached(priority: .userInitiated) {
                snapshot.file(timeLabel: { TranscriptCopy.clock($0) })
            }.value
            guard !Task.isCancelled, transcript.inputs.callSession == callSession else { return }
            UIPasteboard.general.string = file.content
            transcript.noteCopied()
            copyCount += 1
        }
    }

}

enum TranscriptPanelPlatform {
    static var usesScrollGeometry: Bool {
        if #available(iOS 18.0, *) { return true }
        return false
    }

    static var usesNavigationSubtitle: Bool {
        if #available(iOS 26.0, *) { return true }
        return false
    }
}

private struct TranscriptPanelSubtitle: ViewModifier {
    let text: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !text.isEmpty {
            content.navigationSubtitle(text)
        } else {
            content
        }
    }
}

private struct TranscriptPanelPauseButton: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot

    var body: some View {
        let paused = snapshot.phase == LiveNotesPhase.paused
        Button {
            if paused { transcript.resume() } else { transcript.pause() }
        } label: {
            Label(paused ? TranscriptCopy.resumeNotes : TranscriptCopy.pauseNotes,
                  systemImage: paused ? ConclaveSymbols.playFill : ConclaveSymbols.pauseFill)
        }
        .disabled(snapshot.controlsDisabled)
        .accessibilityIdentifier("transcript.status.pause")
    }
}

private struct TranscriptPanelBody: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    let subtitle: String

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
            TranscriptPanelSession(transcript: transcript, snapshot: snapshot, subtitle: subtitle)
        }
    }
}

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
                Section {
                    Button(role: .destructive) { transcript.requestStop() } label: {
                        Label(TranscriptCopy.stopMenu, systemImage: ConclaveSymbols.stopFill)
                    }
                        .disabled(snapshot.controlsDisabled)
                        .accessibilityIdentifier("transcript.menu.stop")
                }
            }
            #if DEBUG
            if TranscriptDiagnostics.driver != nil {
                TranscriptPanelFixtureMenu()
            }
            #endif
        } label: {
            Image(systemName: ConclaveSymbols.ellipsis)
                .accessibilityLabel(TranscriptCopy.moreActions)
        }
        .disabled(!TranscriptViewPolicy.menuEnabled(hasContent: snapshot.hasContent, canStop: snapshot.canStop,
                                                    offersRecap: snapshot.offersRecapToChat))
        .accessibilityIdentifier("transcript.menu")
    }
}

struct TranscriptPanelExportItem: Transferable {
    let presenter: TranscriptPresenter
    let expectedCallSession: Int
    let fileName: String

    @MainActor
    init(presenter: TranscriptPresenter) {
        self.presenter = presenter
        expectedCallSession = presenter.inputs.callSession
        fileName = TranscriptExportPolicy.fileName(roomId: presenter.inputs.roomId)
    }

    static let contentType: UTType = UTType(filenameExtension: "md", conformingTo: .plainText) ?? .plainText

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: TranscriptPanelExportItem.contentType) { item in
            let input = try await MainActor.run {
                guard item.presenter.inputs.callSession == item.expectedCallSession else { throw CancellationError() }
                return (item.presenter.exportSnapshot(labels: TranscriptCopy.exportLabels(roomId: item.presenter.inputs.roomId)),
                 item.presenter.inputs.callSession)
            }
            let prepared = try await Task.detached(priority: .userInitiated) {
                try Task.checkCancellation()
                return input.0.data(timeLabel: { TranscriptCopy.clock($0) })
            }.value
            try Task.checkCancellation()
            return try await MainActor.run {
                try Task.checkCancellation()
                guard item.presenter.inputs.callSession == input.1 else { throw CancellationError() }
                item.presenter.recordExport(byteCount: prepared.count, callSession: input.1)
                return prepared
            }
        }
        .suggestedFileName { $0.fileName }
    }
}

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
            form.conclaveFloatingActionBar { startBar }
        } else {
            form
        }
    }

    private var coverage: KeyCoverage {
        TranscriptKeyPolicy.coverage(provider: provider, keysKnown: snapshot.keysKnown, openAICovered: snapshot.openAICovered,
                                     sarvamCovered: snapshot.sarvamCovered)
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(TranscriptCopy.startTitle(snapshot.startKind))
                        .font(.title2.weight(.semibold))
                        .accessibilityAddTraits(.isHeader)
                    Text(TranscriptCopy.blurb(TranscriptViewPolicy.blurb(kind: snapshot.startKind, coverage: coverage,
                                                                         isViewOnly: snapshot.isViewOnly)))
                        .font(.subheadline)
                        .foregroundStyle(HostingTheme.secondaryText)
                    if snapshot.isViewOnly { TranscriptPanelTag(title: TranscriptCopy.viewOnly) }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("transcript.startCard.header")
                if snapshot.offersStart {
                    VStack(alignment: .leading, spacing: 16) {
                        Picker(TranscriptCopy.provider, selection: $provider) {
                            ForEach(TranscriptConfiguration.providers) { option in
                                Text(TranscriptCopy.providerName(option)).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("transcript.options.provider")
                        if TranscriptKeyPolicy.needsProviderKey(provider: provider, openAICovered: snapshot.openAICovered,
                                                                sarvamCovered: snapshot.sarvamCovered) {
                            SecureField(TranscriptCopy.providerKey(provider), text: $providerKey)
                                .textContentType(.password)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .textFieldStyle(.roundedBorder)
                                .controlSize(.large)
                                .frame(minHeight: 44)
                                .accessibilityIdentifier("transcript.options.providerKey")
                        }
                        if TranscriptKeyPolicy.needsAssistantKey(provider: provider, openAICovered: snapshot.openAICovered) {
                            SecureField(TranscriptCopy.assistantKey, text: $assistantKey)
                                .textContentType(.password)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .textFieldStyle(.roundedBorder)
                                .controlSize(.large)
                                .frame(minHeight: 44)
                                .accessibilityIdentifier("transcript.options.assistantKey")
                        }
                        TranscriptPanelCoverageLine(coverage: coverage)
                            .font(.caption)
                            .foregroundStyle(HostingTheme.secondaryText)
                        DisclosureGroup(TranscriptCopy.options, isExpanded: $optionsExpanded) {
                            Picker(TranscriptCopy.assistant, selection: $assistantModel) {
                                ForEach(TranscriptConfiguration.assistantModels) { model in
                                    Text(verbatim: model.label).tag(model.id)
                                }
                            }
                            .pickerStyle(.menu)
                            .padding(.top, 8)
                            .accessibilityIdentifier("transcript.options.assistant")
                        }
                        .font(.subheadline)
                        .accessibilityIdentifier("transcript.options")
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
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
        return ConclaveFloatingActionButton(title: TranscriptCopy.startButton(snapshot.startKind), isEnabled: ready,
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

private struct TranscriptPanelSession: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    let subtitle: String

    var body: some View {
        if snapshot.status == TranscriptStatusKind.ended && snapshot.offersStart {
            tabs.conclaveFloatingActionBar { TranscriptPanelRestartBar(transcript: transcript, snapshot: snapshot) }
        } else {
            tabs
        }
    }

    private var tabs: some View {
        TranscriptPanelTabContent(transcript: transcript, snapshot: snapshot)
            .conclaveTopBar {
                TranscriptPanelTopBar(transcript: transcript, snapshot: snapshot, subtitle: subtitle)
            }
    }
}

private struct TranscriptPanelRestartBar: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot

    var body: some View {
        let drafts = transcript.drafts
        let ready = TranscriptKeyPolicy.hasRequiredKeys(provider: drafts.provider, keysKnown: snapshot.keysKnown,
                                                        openAICovered: snapshot.openAICovered, sarvamCovered: snapshot.sarvamCovered,
                                                        providerKey: drafts.providerKey, assistantKey: drafts.assistantKey)
        ConclaveFloatingActionButton(title: TranscriptCopy.startButton(TranscriptStartKind.start), isEnabled: ready,
                                     identifier: "transcript.status.start") {
            let current = transcript.drafts
            transcript.start(options: TranscriptKeyPolicy.options(provider: current.provider, assistantModel: current.assistantModel,
                                                                  openAICovered: snapshot.openAICovered,
                                                                  sarvamCovered: snapshot.sarvamCovered,
                                                                  providerKey: current.providerKey, assistantKey: current.assistantKey))
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, CGFloat(DesignTokens.space16))
        .padding(.vertical, CGFloat(DesignTokens.space8))
    }
}

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
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !snapshot.tabs.isEmpty {
                ConclaveViewSwitch(TranscriptCopy.viewSwitchLabel, options: options,
                                   selection: Binding(get: { transcript.tab.rawValue },
                                                      set: { raw in transcript.select(TranscriptTab(rawValue: raw) ?? TranscriptTab.transcript) }),
                                   identifier: "transcript.tabs")
            }
            if !TranscriptPanelPlatform.usesNavigationSubtitle && !subtitle.isEmpty {
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .lineLimit(2)
                    .padding(.horizontal, CGFloat(DesignTokens.space16))
                    .padding(.bottom, CGFloat(DesignTokens.space8))
                    .accessibilityIdentifier("transcript.status")
            }
            TranscriptPanelIssueBanner(transcript: transcript, snapshot: snapshot)
            Divider()
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

private final class TranscriptPanelBottomSentinel {
    var isVisible = true
}

private struct TranscriptPanelFollowKey: Equatable {
    let id: String
    let revision: Int
}

private struct TranscriptPanelFeedList: View {
    let feed: TranscriptFeed
    @State private var isAtLatest = true
    @State private var sentinel = TranscriptPanelBottomSentinel()

    var body: some View {
        let ids = feed.rowIds
        if ids.isEmpty {
            ScrollView {
                TranscriptPanelNote(title: TranscriptCopy.listeningTitle, message: TranscriptCopy.listeningBody)
                    .padding(.horizontal, CGFloat(DesignTokens.space16))
                    .padding(.top, CGFloat(DesignTokens.space8))
            }
            .accessibilityIdentifier("transcript.listening")
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
                    .padding(.top, CGFloat(DesignTokens.space4))
                    .padding(.bottom, CGFloat(DesignTokens.space16))
                }
                .modifier(TranscriptPanelLatestAnchor())
                .modifier(TranscriptPanelLatestProximity(isAtLatest: $isAtLatest))
                .background {
                    TranscriptPanelFollowLeaf(feed: feed, proxy: proxy, isPinned: { pinned })
                }
                .overlay(alignment: .bottom) {
                    let showsJump = TranscriptFollowPolicy.showsJumpToLatest(
                        rowCount: ids.count, distanceFromLatest: isAtLatest ? 0 : TranscriptFollowPolicy.farFromLatest)
                    TranscriptPanelJumpPill {
                        jump(proxy, to: feed.newestId)
                    }
                    .padding(.bottom, CGFloat(DesignTokens.space12))
                    .opacity(showsJump ? 1 : 0)
                    .allowsHitTesting(showsJump)
                    .accessibilityHidden(!showsJump)
                    .animation(.easeOut(duration: 0.15), value: showsJump)
                }
            }
            .accessibilityIdentifier("transcript.list")
        }
    }

    private var pinned: Bool {
        TranscriptPanelPlatform.usesScrollGeometry ? isAtLatest : sentinel.isVisible
    }

    private func setBottomVisible(_ visible: Bool) {
        sentinel.isVisible = visible
        if isAtLatest != visible { isAtLatest = visible }
    }

    private func jump(_ proxy: ScrollViewProxy, to id: String) {
        guard !id.isEmpty else { return }
        withAnimation(.easeOut(duration: 0.25)) {
            proxy.scrollTo(id, anchor: .bottom)
        }
        isAtLatest = true
    }
}

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

private struct TranscriptPanelLatestAnchor: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.bottom, for: .sizeChanges)
                .defaultScrollAnchor(.top, for: .alignment)
        } else {
            content.defaultScrollAnchor(.bottom)
        }
    }
}

private struct TranscriptPanelLatestProximity: ViewModifier {
    @Binding var isAtLatest: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { geometry in
                let distance = TranscriptFollowPolicy.distanceFromLatest(
                    offset: Double(geometry.contentOffset.y), viewport: Double(geometry.visibleRect.height),
                    content: Double(geometry.contentSize.height), leadingInset: Double(geometry.contentInsets.top),
                    trailingInset: Double(geometry.contentInsets.bottom))
                return TranscriptFollowPolicy.isAtLatest(distanceFromLatest: distance)
            } action: { _, atLatest in
                if isAtLatest != atLatest { isAtLatest = atLatest }
            }
        } else {
            content
        }
    }
}

private struct TranscriptPanelJumpPill: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label {
                Text(TranscriptCopy.jumpToLatest)
            } icon: {
                Image(systemName: ConclaveSymbols.arrowDown).accessibilityHidden(true)
            }
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, CGFloat(DesignTokens.space16))
            .frame(minHeight: 44)
            .background(Color(uiColor: .secondarySystemBackground), in: Capsule())
            .overlay(Capsule().strokeBorder(Color(uiColor: .separator), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("transcript.jumpPill")
    }
}

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
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: CGFloat(DesignTokens.space8)) {
                    Text(name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(time)
                        .font(.caption)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .monospacedDigit()
                        .layoutPriority(1)
                    Spacer(minLength: 0)
                }
                Text(row.text)
                    .font(.body)
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

private struct TranscriptPanelAskView: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    @State private var draft = ""
    @State private var didSeed = false
    @FocusState private var focused: Bool

    var body: some View {
        let showsComposer = TranscriptViewPolicy.showsAskComposer(tab: TranscriptTab.ask, canAsk: snapshot.canAsk, phase: snapshot.phase)
        Group {
            if showsComposer {
                TranscriptPanelAskList(transcript: transcript, onSuggestion: suggest)
                    .conclaveComposerBar {
                        TranscriptPanelAskComposer(transcript: transcript, snapshot: snapshot, draft: $draft, focused: $focused)
                    }
            } else {
                TranscriptPanelAskList(transcript: transcript, onSuggestion: suggest)
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

    private func suggest(_ text: String) {
        draft = text
        focused = true
    }
}

private struct TranscriptPanelAskList: View {
    let transcript: TranscriptPresenter
    let onSuggestion: (String) -> Void
    @State private var isAtLatest = true
    @State private var sentinel = TranscriptPanelBottomSentinel()

    var body: some View {
        let thread = transcript.ask
        let ids = thread.rowIds
        if ids.isEmpty {
            TranscriptPanelAskEmpty(onSuggestion: onSuggestion)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: CGFloat(DesignTokens.space20)) {
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
                    .padding(.top, CGFloat(DesignTokens.space8))
                    .padding(.bottom, CGFloat(DesignTokens.space16))
                }
                .modifier(TranscriptPanelLatestAnchor())
                .modifier(TranscriptPanelLatestProximity(isAtLatest: $isAtLatest))
                .background {
                    TranscriptPanelAskFollowLeaf(thread: thread, proxy: proxy, isPinned: { pinned })
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .accessibilityIdentifier("transcript.ask.list")
        }
    }

    private var pinned: Bool {
        TranscriptPanelPlatform.usesScrollGeometry ? isAtLatest : sentinel.isVisible
    }

    private func setBottomVisible(_ visible: Bool) {
        sentinel.isVisible = visible
        if isAtLatest != visible { isAtLatest = visible }
    }
}

private struct TranscriptPanelAskEmpty: View {
    let onSuggestion: (String) -> Void

    var body: some View {
        let suggestions = TranscriptCopy.askSuggestions
        ScrollView {
            VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space16)) {
                TranscriptPanelNote(title: TranscriptCopy.askEmptyTitle, message: TranscriptCopy.askEmptyBody)
                VStack(alignment: .leading, spacing: 0) {
                    Divider()
                    ForEach(suggestions, id: \.self) { suggestion in
                        Button { onSuggestion(suggestion) } label: {
                            HStack(spacing: CGFloat(DesignTokens.space12)) {
                                Text(suggestion)
                                    .font(.body)
                                    .foregroundStyle(Color.primary)
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: CGFloat(DesignTokens.space8))
                                Image(systemName: ConclaveSymbols.arrowUp)
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(HostingTheme.secondaryText)
                                    .accessibilityHidden(true)
                            }
                            .padding(.vertical, CGFloat(DesignTokens.space12))
                            .frame(minHeight: 48)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("transcript.ask.suggestion")
                        Divider()
                    }
                }
            }
            .padding(.horizontal, CGFloat(DesignTokens.space16))
            .padding(.top, CGFloat(DesignTokens.space8))
            .padding(.bottom, CGFloat(DesignTokens.space16))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("transcript.ask.empty")
    }
}

private struct TranscriptPanelNote: View {
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space4)) {
            Text(title)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(HostingTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

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

private struct TranscriptPanelAskRow: View {
    let row: AskRow
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space12)) {
            HStack {
                Spacer(minLength: 48)
                ConclaveChatBubble(tone: .peer, identifier: "transcript.ask." + row.id + ".question") {
                    Text(row.question)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(TranscriptCopy.youAsked + ", " + row.question)
            }
            answer
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("transcript.ask." + row.id)
    }

    @ViewBuilder
    private var answer: some View {
        switch row.state {
        case .thinking:
            HStack(spacing: CGFloat(DesignTokens.space8)) {
                ProgressView().controlSize(.small)
                Text(TranscriptCopy.thinking)
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.secondaryText)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("transcript.ask." + row.id + ".answer")
        case .streaming, .done:
            AssistantMarkdownView(blocks: row.blocks, identifier: "transcript.ask." + row.id + ".markdown")
                .accessibilityElement(children: .combine)
                .accessibilityLabel(TranscriptCopy.conclaveAnswered)
                .accessibilityIdentifier("transcript.ask." + row.id + ".answer")
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
            VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space4)) {
                Label {
                    Text(TranscriptCopy.askState(row.state, errorText: row.errorText))
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: ConclaveSymbols.exclamationmarkCircleFill)
                        .accessibilityHidden(true)
                }
                .font(.subheadline)
                .foregroundStyle(HostingTheme.secondaryText)
                Button(TranscriptCopy.tryAgain, action: onRetry)
                    .font(.subheadline.weight(.semibold))
                    .buttonStyle(.borderless)
                    .tint(HostingTheme.coralText)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("transcript.ask." + row.id + ".retry")
            }
            .accessibilityIdentifier("transcript.ask." + row.id + ".answer")
        }
    }
}

private struct TranscriptPanelAskComposer: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot
    @Binding var draft: String
    var focused: FocusState<Bool>.Binding

    var body: some View {
        let canSend = AskRowPolicy.canSend(draft, canAsk: snapshot.canAsk, phase: snapshot.phase, link: snapshot.link)
        ConclaveComposerStack(identifier: "transcript.ask.composer") {
            ConclaveComposerStatusLine(text: TranscriptCopy.askPrivate, identifier: "transcript.ask.private")
        } field: {
            ConclaveComposerField(identifier: "transcript.ask.composer.cluster") {
                TextField(TranscriptCopy.askPlaceholder, text: $draft, axis: .vertical)
                    .lineLimit(1...ConclaveComposerMetrics.maximumLines)
                    .textInputAutocapitalization(.sentences)
                    .focused(focused)
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

private struct TranscriptPanelMinutesList: View {
    let transcript: TranscriptPresenter
    let snapshot: TranscriptSnapshot

    var body: some View {
        let minutes = transcript.minutes
        let empty = MinutesPolicy.emptyKind(phase: snapshot.phase, hasContent: minutes.hasContent)
        let showsRecap = snapshot.offersRecapToChat || snapshot.recap != RecapPhase.idle
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                TranscriptPanelMinutesStatus(transcript: transcript, updating: snapshot.minutesUpdating,
                                             updatedAtMillis: snapshot.minutesUpdatedAtMillis, hasContent: minutes.hasContent,
                                             canRefresh: snapshot.canRefreshMinutes)
                if empty != MinutesEmptyKind.none {
                    TranscriptPanelNote(title: TranscriptCopy.emptyTitle(empty), message: TranscriptCopy.emptyBody(empty))
                        .padding(.top, CGFloat(DesignTokens.space8))
                        .accessibilityIdentifier("transcript.minutes.empty")
                }
                if !minutes.summary.isEmpty {
                    TranscriptPanelMinutesHeading(title: TranscriptCopy.section(MinutesSection.summary))
                    Text(minutes.summary)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("transcript.minutes.summary")
                }
                ForEach(minutes.sections) { section in
                    TranscriptPanelMinutesHeading(title: TranscriptCopy.section(section.section))
                    ForEach(section.entries) { entry in
                        TranscriptPanelMinutesEntryRow(entry: entry)
                    }
                }
                if showsRecap {
                    TranscriptPanelRecapBlock(transcript: transcript, recap: snapshot.recap, offersRecap: snapshot.offersRecapToChat)
                }
            }
            .padding(.horizontal, CGFloat(DesignTokens.space16))
            .padding(.top, CGFloat(DesignTokens.space4))
            .padding(.bottom, CGFloat(DesignTokens.space24))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("transcript.minutes")
    }
}

private struct TranscriptPanelMinutesHeading: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.headline)
            .padding(.top, CGFloat(DesignTokens.space20))
            .padding(.bottom, CGFloat(DesignTokens.space4))
            .accessibilityAddTraits(.isHeader)
    }
}

private struct TranscriptPanelMinutesStatus: View {
    let transcript: TranscriptPresenter
    let updating: Bool
    let updatedAtMillis: Double
    let hasContent: Bool
    let canRefresh: Bool

    var body: some View {
        let kind = MinutesPolicy.statusKind(updating: updating, updatedAtMillis: updatedAtMillis)
        if MinutesPolicy.showsStatusText(kind, hasContent: hasContent) || canRefresh {
            row(kind)
        }
    }

    private func row(_ kind: MinutesStatusKind) -> some View {
        HStack(spacing: CGFloat(DesignTokens.space8)) {
            if MinutesPolicy.showsStatusText(kind, hasContent: hasContent) {
                status(kind)
            }
            Spacer(minLength: CGFloat(DesignTokens.space8))
            if canRefresh {
                Button { transcript.refreshMinutes() } label: {
                    Label(TranscriptCopy.refresh, systemImage: ConclaveSymbols.arrowClockwise)
                        .font(.footnote.weight(.semibold))
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .tint(HostingTheme.coralText)
                .disabled(updating)
                .accessibilityLabel(TranscriptCopy.refreshMinutes)
                .accessibilityIdentifier("transcript.minutes.refresh")
            }
        }
        .frame(minHeight: 44)
    }

    private func status(_ kind: MinutesStatusKind) -> some View {
        HStack(spacing: CGFloat(DesignTokens.space8)) {
            if kind == MinutesStatusKind.updating {
                ProgressView().controlSize(.small)
            }
            if kind == MinutesStatusKind.updated {
                TimelineView(.periodic(from: Date(), by: MinutesAgePolicy.tickMillis / 1000.0)) { context in
                    Text(TranscriptCopy.minutesStatus(kind, updatedAtMillis: updatedAtMillis,
                                                      nowMillis: context.date.timeIntervalSince1970 * 1000.0))
                }
            } else {
                Text(TranscriptCopy.minutesStatus(kind, updatedAtMillis: updatedAtMillis, nowMillis: 0))
            }
        }
        .font(.footnote)
        .foregroundStyle(HostingTheme.secondaryText)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("transcript.minutes.status")
    }
}

private struct TranscriptPanelRecapBlock: View {
    let transcript: TranscriptPresenter
    let recap: RecapPhase
    let offersRecap: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space8)) {
            Divider()
                .padding(.bottom, CGFloat(DesignTokens.space16))
            Button {
                transcript.postRecapToChat()
            } label: {
                HStack(spacing: CGFloat(DesignTokens.space8)) {
                    if recap == RecapPhase.posting {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: recap == RecapPhase.posted ? ConclaveSymbols.checkmark : ConclaveSymbols.sparkles)
                            .accessibilityHidden(true)
                    }
                    Text(TranscriptCopy.postRecap)
                }
                .frame(minHeight: 32)
            }
            .buttonStyle(.bordered)
            .tint(Color.primary)
            .disabled(!offersRecap || recap == RecapPhase.posting)
            .accessibilityValue(TranscriptCopy.recapValue(recap))
            .accessibilityIdentifier("transcript.minutes.recap")
            if recap == RecapPhase.failed {
                HStack(spacing: CGFloat(DesignTokens.space8)) {
                    Text(TranscriptCopy.recapValue(RecapPhase.failed))
                        .font(.footnote)
                        .foregroundStyle(Color(uiColor: .systemRed))
                    Button(TranscriptCopy.tryAgain) { transcript.postRecapToChat() }
                        .font(.footnote.weight(.semibold))
                        .buttonStyle(.borderless)
                        .tint(HostingTheme.coralText)
                        .frame(minHeight: 44)
                        .disabled(!offersRecap)
                        .accessibilityIdentifier("transcript.minutes.recap.retry")
                }
            } else {
                Text(recap == RecapPhase.posted ? TranscriptCopy.recapValue(RecapPhase.posted) : TranscriptCopy.recapDetail)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, CGFloat(DesignTokens.space24))
    }
}

private struct TranscriptPanelMinutesEntryRow: View {
    let entry: MinutesEntryModel

    var body: some View {
        let detail = TranscriptCopy.entryDetail(owner: entry.owner, due: entry.due)
        HStack(alignment: .firstTextBaseline, spacing: CGFloat(DesignTokens.space8)) {
            Text(verbatim: "\u{2022}")
                .font(.body)
                .foregroundStyle(HostingTheme.secondaryText)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.text)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, CGFloat(DesignTokens.space4))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("transcript.minutes.entry." + entry.id)
    }
}

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

#if DEBUG
private struct TranscriptPanelFixtureMenu: View {
    var body: some View {
        Section {
            ForEach(TranscriptFixtureScriptName.allCases, id: \.self) { script in
                Button {
                    TranscriptDiagnostics.driver?.run(script)
                } label: {
                    Text(verbatim: script.rawValue)
                }
                .accessibilityIdentifier("transcript.fixture." + script.rawValue)
            }
        } header: {
            Text(verbatim: TranscriptDiagnostics.readout())
                .accessibilityIdentifier("transcript.calls")
        }
    }
}
#endif
#endif
