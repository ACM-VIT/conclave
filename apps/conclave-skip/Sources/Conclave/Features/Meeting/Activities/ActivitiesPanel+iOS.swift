#if os(iOS) && !SKIP
import SwiftUI

struct ActivitiesPage: Hashable {
    let route: ActivitiesRoute
    let id: String
}

struct ActivitiesPanel: View {
    let session: ActivitySession
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    @Environment(\.conclaveSystemColorScheme) private var systemScheme
    @State private var path: [ActivitiesPage] = []

    var body: some View {
        PanelShell(title: ConclaveStrings.text("Activities"), presentation: resolved, hostStyle: resolved.style,
                   systemScheme: systemScheme, path: $path,
                   onClose: { session.shell.panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: { adapter.promoteToLarge() }) {
            ActivitiesRootList(session: session)
                .navigationDestination(for: ActivitiesPage.self) { page in
                    ActivitiesPageView(page: page, session: session)
                }
        }

        .task(id: presentation.request.presentationID) {
            session.activities.refresh()
            land(ActivitiesDestinationPolicy.landing(destination: presentation.request.destination,
                                                     targetId: presentation.request.targetId))
        }
        .background {
            ActivitiesPanelLeaves(session: session, presentationID: presentation.request.presentationID, path: $path)
        }
        .accessibilityIdentifier("activities.panel")
    }

    private func land(_ landing: ActivitiesLanding) {
        if ActivitiesDestinationPolicy.isRenderable(landing.route) && landing.route != .root {
            path = [ActivitiesPage(route: landing.route, id: landing.id)]
        }
    }
}

private struct ActivitiesPanelLeaves: View {
    let session: ActivitySession
    let presentationID: Int
    @Binding var path: [ActivitiesPage]

    var body: some View {
        let destination = session.shell.panels.latestDestination(for: presentationID)
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onChange(of: session.activities.dismissSignal) {
                session.shell.panels.dismiss(cancelPending: true)
            }
            .onChange(of: destination?.sequence ?? 0) {
                guard let request = destination else { return }
                let landing = ActivitiesDestinationPolicy.landing(destination: request.destination, targetId: request.targetId)
                if ActivitiesDestinationPolicy.isRenderable(landing.route) {
                    path = landing.route == .root ? [] : [ActivitiesPage(route: landing.route, id: landing.id)]
                }
            }
    }
}

private struct ActivitiesRootList: View {
    let session: ActivitySession
    @State private var voteCount = 0
    @State private var endTarget: NowPlayingModel? = nil
    @State private var replaceTarget: String? = nil

    var body: some View {
        let s = session.activities.snapshot
        List {
            if !s.nowPlaying.isEmpty {
                Section(ConclaveStrings.text("Now Playing")) {
                    ForEach(s.nowPlaying) { item in
                        NowPlayingRow(item: item, session: session, onEnd: { endTarget = item })
                    }
                }
            }
            if s.isVoteOpen {
                VoteSection(snapshot: s, activities: session.activities, voteCount: $voteCount)
            }
            if s.role == .host || !s.isVoteOpen {
                GamesSection(snapshot: s, activities: session.activities)
            }
            if s.role == .host || !s.isVoteOpen {
                AppsSection(snapshot: s, activities: session.activities, onReplace: { replaceTarget = $0 })
            }
            if (s.browser.isAvailable || s.browser.isActive) && (s.role == .host || !s.isVoteOpen) {
                BrowserSection(snapshot: s, activities: session.activities)
            }
            if let message = ActivitiesCopy.reason(s.inlineError, serverText: s.inlineErrorServerText) {
                Section {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button(ConclaveStrings.text("Dismiss")) { session.activities.dismissInlineError() }
                }
                .accessibilityIdentifier("activities.inlineError")
            }
        }
        .listStyle(.insetGrouped)
        .conclaveGestureFeedback(.voteCast, trigger: voteCount)
        .confirmationDialog(endTarget.map { ActivitiesCopy.endDialogTitle($0) } ?? "", isPresented: endBinding,
                            titleVisibility: .visible, presenting: endTarget) { item in
            Button(ActivitiesCopy.endConfirm(item), role: .destructive) { session.activities.requestEnd(item.id) }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
        } message: { item in
            Text(ActivitiesCopy.endDialogMessage(item))
        }
        .confirmationDialog(replaceTitle(s), isPresented: replaceBinding, titleVisibility: .visible, presenting: replaceTarget) { appId in
            Button(ConclaveStrings.text("Replace"), role: .destructive) { session.activities.openApp(appId) }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
        } message: { _ in
            Text(replaceMessage(s))
        }
    }

    private var endBinding: Binding<Bool> {
        Binding(get: { endTarget != nil }, set: { if !$0 { endTarget = nil } })
    }

    private var replaceBinding: Binding<Bool> {
        Binding(get: { replaceTarget != nil }, set: { if !$0 { replaceTarget = nil } })
    }

    private func openAppName(_ s: ActivitiesSnapshot) -> String {
        ActivitiesCopy.appName(s.nowPlayingItem(kind: .app)?.appId ?? "")
    }

    private func replaceTitle(_ s: ActivitiesSnapshot) -> String {
        ConclaveStrings.format("Replace %@?", openAppName(s))
    }

    private func replaceMessage(_ s: ActivitiesSnapshot) -> String {
        if s.nowPlayingItem(kind: .app)?.appId == "whiteboard" {
            return ConclaveStrings.format("The %@ board clears for everyone.", openAppName(s))
        }
        return ConclaveStrings.text("Everyone returns to the meeting.")
    }
}

private struct NowPlayingRow: View {
    let item: NowPlayingModel
    let session: ActivitySession
    let onEnd: () -> Void

    var body: some View {
        Button {
            if !item.isOnStage {
                session.shell.panels.dismiss(cancelPending: true)
                session.stage.showActivity(kind: item.id)
            }
        } label: {
            LabeledContent {
                if !item.isOnStage { Text(ConclaveStrings.text("Show")) }
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ActivitiesCopy.nowPlayingTitle(item))
                        Text(ActivitiesCopy.nowPlayingStatus(item))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: ActivityStageCopy.symbol(kind: item.id, appId: item.appId))
                }
            }
        }
        .foregroundStyle(.primary)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("activities.nowPlaying." + item.id)
        if item.canEnd || item.endPending {
            Button(ActivitiesCopy.endTitle(item), role: .destructive, action: onEnd)
                .disabled(item.endPending)
                .accessibilityValue(item.endPending ? ConclaveStrings.text("In Progress") : "")
                .accessibilityIdentifier("activities.end." + item.id)
        }
        if item.endFailed {
            HStack {
                Text(ActivitiesCopy.reason(.endFailed) ?? "")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(ConclaveStrings.text("Try Again"), action: onEnd)
            }
            .task(id: item.endFailed) {
                AccessibilityNotification.Announcement(ActivitiesCopy.reason(.endFailed) ?? "").post()
            }
        }
    }
}

private struct VoteSection: View {
    let snapshot: ActivitiesSnapshot
    let activities: ActivitiesPresenter
    @Binding var voteCount: Int

    var body: some View {
        Section {
            ForEach(snapshot.vote) { candidate in
                Button {
                    if activities.castVote(candidate.id) == .dispatched { voteCount += 1 }
                } label: {
                    LabeledContent {
                        Text(candidate.count.formatted(.number)).monospacedDigit()
                    } label: {
                        HStack(spacing: 8) {
                            Text(candidate.name)
                            if candidate.isMine {
                                Image(systemName: ConclaveSymbols.checkmark)
                                    .foregroundStyle(HostingTheme.coralText)
                                    .accessibilityHidden(true)
                            }
                            if candidate.isLeader {
                                Text(ConclaveStrings.text("Leading"))
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
                            }
                        }
                    }
                }
                .foregroundStyle(.primary)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(candidate.name + ", " + ActivitiesCopy.voteCountLabel(candidate.count))
                .accessibilityValue(candidate.isLeader ? ConclaveStrings.text("Leading") : "")
                .accessibilityAddTraits(candidate.isMine ? [.isButton, .isSelected] : .isButton)
                .accessibilityIdentifier("activities.vote." + candidate.id)
            }
            if snapshot.role == .host {
                Button(ActivitiesCopy.startLeaderTitle(snapshot)) { activities.startLeader() }
                    .buttonStyle(.borderedProminent)
                    .tint(HostingTheme.coralFill)
                    .foregroundStyle(HostingTheme.onCoral)
                    .disabled(!snapshot.canStartLeader)
                    .accessibilityIdentifier("activities.vote.startLeader")
                if snapshot.leaderVotes == 0, let reason = ActivitiesCopy.reason(.noVotes) {
                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                }
                Button(ConclaveStrings.text("Cancel Vote")) { activities.cancelVote() }
                    .disabled(!snapshot.canCancelVote)
                    .accessibilityIdentifier("activities.vote.cancel")
            }
        } header: {
            HStack {
                Text(ConclaveStrings.text("Vote for a Game"))
                Spacer()
                Text(ActivitiesCopy.voteCount(cast: snapshot.voteCast, players: snapshot.votePlayers)).monospacedDigit()
            }
        } footer: {
            Text(snapshot.role == .host ? ConclaveStrings.text("Vote too, then start the winner.") : ConclaveStrings.text("Tap the game you want."))
        }
    }
}

private struct GamesSection: View {
    let snapshot: ActivitiesSnapshot
    let activities: ActivitiesPresenter

    var body: some View {
        Section {
            if snapshot.role == .host {
                if snapshot.catalogLoading {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(ConclaveStrings.text("Loading Games")).foregroundStyle(.secondary)
                    }
                } else if snapshot.games.isEmpty {
                    Text(ConclaveStrings.text("No games are available right now.")).foregroundStyle(.secondary)
                }
                ForEach(snapshot.games) { row in
                    NavigationLink(value: ActivitiesPage(route: .setup, id: row.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.name)
                            Text(row.detail).font(.subheadline).foregroundStyle(.secondary)
                            Text(ActivitiesCopy.playerRange(row.minPlayers, row.maxPlayers))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .disabled(!row.isPlayable)
                    .accessibilityHint(ActivitiesCopy.reason(row.reason) ?? "")
                    .accessibilityIdentifier("activities.game." + row.id)
                }
                if snapshot.canOpenVote {
                    Button(ConclaveStrings.text("Put It to a Vote")) { activities.openVote() }
                        .accessibilityIdentifier("activities.openVote")
                }
            } else {
                Text(ConclaveStrings.text("The host is picking a game.")).foregroundStyle(.secondary)
            }
        } header: {
            Text(ConclaveStrings.text("Games"))
        } footer: {
            if let reason = ActivitiesCopy.reason(snapshot.catalogReason) {
                Text(reason)
            } else if snapshot.role == .host {
                Text(ConclaveStrings.text("Pick a game, or let the room vote."))
            }
        }
    }
}

private struct AppsSection: View {
    let snapshot: ActivitiesSnapshot
    let activities: ActivitiesPresenter
    let onReplace: (String) -> Void

    var body: some View {
        Section {
            ForEach(snapshot.apps) { app in
                AppRow(app: app, snapshot: snapshot, activities: activities, onReplace: onReplace)
            }
            if snapshot.canLockApps {
                Toggle(ConclaveStrings.text("Lock App Editing"), isOn: Binding(
                    get: { snapshot.appsLocked },
                    set: { activities.setAppsLocked($0) }))
                    .disabled(snapshot.appsReason == .noAppOpen || snapshot.appsLockPending || snapshot.isRecovering)
                    .accessibilityIdentifier("activities.lockApps")
            }
        } header: {
            Text(ConclaveStrings.text("Apps"))
        } footer: {
            Text(appsFooter)
        }
    }

    private var appsFooter: String {
        switch snapshot.appsReason {
        case .hostOnly: return ConclaveStrings.text("Only hosts can open apps.")
        case .noAppOpen: return ConclaveStrings.text("Open an app to lock editing.")
        default: return ConclaveStrings.text("Participants watch only.")
        }
    }
}

private struct AppRow: View {
    let app: AppRowModel
    let snapshot: ActivitiesSnapshot
    let activities: ActivitiesPresenter
    let onReplace: (String) -> Void

    var body: some View {
        let content = LabeledContent {
            if app.isPending {
                ProgressView()
            } else if app.isOpen {
                Text(ConclaveStrings.text("Open"))
            }
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ActivitiesCopy.appName(app.id))
                    Text(ActivitiesCopy.appDetail(app.id)).font(.subheadline).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: ActivityStageCopy.symbol(kind: ActivityKind.app.rawValue, appId: app.id))
            }
        }
        if app.canOpen {
            Button {
                if snapshot.nowPlayingItem(kind: .app) != nil { onReplace(app.id) } else { activities.openApp(app.id) }
            } label: { content }
                .foregroundStyle(.primary)
                .accessibilityIdentifier("activities.app." + app.id)
        } else {
            content
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("activities.app." + app.id)
        }
    }
}

private struct BrowserSection: View {
    let snapshot: ActivitiesSnapshot
    let activities: ActivitiesPresenter

    var body: some View {
        Section(ConclaveStrings.text("Shared Browser")) {
            if snapshot.role == .host {
                NavigationLink(value: ActivitiesPage(route: .browser, id: "")) {
                    LabeledContent {
                        Text(snapshot.browser.isActive ? snapshot.browser.hostLabel : "")
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ConclaveStrings.text("Shared Browser"))
                            Text(ConclaveStrings.text("Show a website to everyone")).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
                .disabled(!snapshot.browser.isAvailable)
                .accessibilityHint(ActivitiesCopy.reason(snapshot.browser.reason) ?? "")
                .accessibilityIdentifier("activities.browser")
            }
            if snapshot.browser.hasAudio {
                Toggle(ConclaveStrings.text("Play Browser Audio"), isOn: Binding(
                    get: { !snapshot.browser.isAudioMuted },
                    set: { _ in activities.toggleBrowserAudio() }))
                    .accessibilityIdentifier("activities.browserAudio")
            }
        }
    }
}

private struct ActivitiesPageView: View {
    let page: ActivitiesPage
    let session: ActivitySession

    var body: some View {
        switch page.route {
        case .setup:
            GameSetupPage(gameId: page.id, activities: session.activities)
        case .browser:
            BrowserLauncherPage(activities: session.activities)
        case .wheel:

            AppWheelPage(host: session.appHost)
        case .watch:
            AppWatchPage(host: session.appHost)
        case .root:
            EmptyView()
        }
    }
}

private struct GameSetupPage: View {
    let gameId: String
    let activities: ActivitiesPresenter

    var body: some View {
        let setup = activities.setup
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let setup = setup, setup.gameId == gameId {
                    VStack(alignment: .leading, spacing: 6) {
                        if !setup.detail.isEmpty { Text(setup.detail).font(.subheadline) }
                        Text(ActivitiesCopy.playerRange(setup.minPlayers, setup.maxPlayers))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(setup.options) { option in
                        if option.isVisible {
                            GameSetupOptionRow(option: option, activities: activities,
                                               isEnabled: setup.phase != .starting && setup.phase != .slow)
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(setup?.name ?? "")
        .task(id: gameId) { activities.beginSetup(gameId) }
        .conclaveFloatingActionBar {
            SetupStartBar(activities: activities)
        }
        .accessibilityIdentifier("activities.setup")
    }
}

private struct GameSetupOptionRow: View {
    let option: GameOptionModel
    let activities: ActivitiesPresenter
    let isEnabled: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize && option.kind != GameOptionModel.textKind {
            LargeTextGameChoiceControl(option: option, isEnabled: isEnabled,
                                       onSelect: { activities.setOption(option.id, value: $0) })
        } else {
            GameOptionControl(option: option, initialText: activities.draftText(option.id), isEnabled: isEnabled,
                              onSelect: { activities.setOption(option.id, value: $0) },
                              onText: { activities.setText(option.id, text: $0) })
        }
    }
}

private struct LargeTextGameChoiceControl: View {
    let option: GameOptionModel
    let isEnabled: Bool
    let onSelect: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(option.label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if option.choices.count <= ActivitiesCatalogPolicy.maxSegments {
                ViewThatFits(in: .horizontal) {
                    picker.pickerStyle(.segmented)
                    menu
                }
            } else {
                menu
            }
        }
        .padding(.vertical, 2)
        .disabled(!isEnabled)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("activities.option." + option.id)
    }

    private var selectedLabel: String {
        option.choices.first { $0.id == option.value }?.label ?? ""
    }

    private var picker: some View {
        Picker(option.label, selection: Binding(get: { option.value }, set: { onSelect($0) })) {
            ForEach(option.choices) { choice in
                Text(choice.label).tag(choice.id)
            }
        }
        .labelsHidden()
    }

    private var menu: some View {
        Menu {
            picker.pickerStyle(.inline)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(selectedLabel)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Image(systemName: ConclaveSymbols.chevronDown)
                    .imageScale(.small)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: ConclaveRowMetrics.minimumHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.hidden)
        .accessibilityLabel(option.label)
        .accessibilityValue(selectedLabel)
        .accessibilityIdentifier("activities.option." + option.id + ".value")
    }
}

private struct SetupStartBar: View {
    let activities: ActivitiesPresenter

    var body: some View {
        if let setup = activities.setup {
            VStack(spacing: 6) {
                ConclaveFloatingActionButton(title: ActivitiesCopy.startTitle(setup), isEnabled: setup.canStart,
                                             isPending: setup.phase == .starting || setup.phase == .slow,
                                             identifier: "activities.setup.start") {
                    activities.startGame()
                }
                if let footer = ActivitiesCopy.setupFooter(setup) {
                    Text(footer)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("activities.setup.footer")
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }
}

private struct BrowserLauncherPage: View {
    let activities: ActivitiesPresenter
    @State private var url = ""
    @FocusState private var focused: Bool
    @Environment(\.panelPromoteToLargeDetent) private var promoteToLarge

    var body: some View {
        let browser = activities.snapshot.browser
        Form {
            Section {
                TextField(ConclaveStrings.text("Website"), text: $url)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($focused)
                    .onSubmit { activities.submitBrowserURL(url) }
                    .onChange(of: url) { activities.clearBrowserValidation() }
                    .onChange(of: focused) { _, isFocused in if isFocused { promoteToLarge() } }
                    .accessibilityIdentifier("activities.browser.url")
            } footer: {
                if let message = ActivitiesCopy.validation(browser.validation) ?? ActivitiesCopy.failure(browser.failure) {
                    Label(message, systemImage: ConclaveSymbols.exclamationmarkOctagonFill)
                        .accessibilityIdentifier("activities.browser.validation")
                }
            }
            if browser.isActive {
                Section {
                    LabeledContent(ConclaveStrings.text("Session"), value: ActivitiesCopy.providerTitle(browser.provider))
                }
            }
        }
        .navigationTitle(ConclaveStrings.text("Shared Browser"))
        .conclaveFloatingActionBar {
            ConclaveFloatingActionButton(title: ActivitiesCopy.browserPrimary(browser), isEnabled: browser.isAvailable,
                                         isPending: browser.phase != .idle, identifier: "activities.browser.primary") {
                activities.submitBrowserURL(url)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }
}

#endif
