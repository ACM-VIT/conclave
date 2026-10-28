#if os(iOS) && !SKIP
import SwiftUI

struct QaPanel: View {
    let people: PeoplePresenter
    let shell: MeetingShellPresenter
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    @Environment(\.conclaveSystemColorScheme) private var systemScheme
    @State private var path: [QaRoute] = []

    var body: some View {
        PanelShell(title: ConclaveStrings.text("Q&A"), presentation: resolved, hostStyle: resolved.style,
                   systemScheme: systemScheme, path: $path,
                   onClose: { shell.panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: { adapter.promoteToLarge() }) {
            QaList(people: people, request: presentation.request, onAnswerInWriting: { id in
                path.append(QaRoute(answerQuestionId: id))
            })
            .navigationDestination(for: QaRoute.self) { route in
                QaAnswerPage(people: people, questionId: route.answerQuestionId)
            }
        }

        .task(id: presentation.request.presentationID) {
            people.platform = NoticePlatform.ios
            people.qa.panelDidOpen(presentationID: presentation.request.presentationID)
        }
        .onChange(of: people.qa.snapshot.isHost) { _, isHost in

            if !isHost && !path.isEmpty { path = [] }
        }
        .accessibilityIdentifier("qa.panel")
    }
}

private struct QaList: View {
    let people: PeoplePresenter
    let request: PanelRequest
    let onAnswerInWriting: (String) -> Void

    var body: some View {
        let qa = people.qa
        let snapshot = qa.snapshot
        ScrollViewReader { proxy in
            List {
                if snapshot.isAttendee && snapshot.isEnabled {
                    Section {
                        EmptyView()
                    } footer: {
                        Text(ConclaveStrings.text("Only hosts see your question until they answer it."))
                            .accessibilityIdentifier("qa.privacy")
                    }
                }
                if snapshot.availability == QaAvailability.available {
                    ForEach(snapshot.questionIds, id: \.self) { id in
                        QuestionRow(people: people, entry: qa.questions.entry(for: id), isHost: snapshot.isHost,
                                    onAnswerInWriting: onAnswerInWriting)
                            .id(id)
                    }
                }
            }
            .listStyle(.plain)
            .overlay {
                QaEmptyOrLoading(snapshot: snapshot)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                QaSortBar(qa: qa, snapshot: snapshot)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if snapshot.isAttendee {
                    QaComposer(people: people, snapshot: snapshot)
                }
            }
            .toolbar {
                if snapshot.isHost {
                    ToolbarItem(placement: .topBarLeading) {
                        QaFilterMenu(qa: qa, snapshot: snapshot)
                    }
                }
            }
            .task(id: request.presentationID) {

                if request.destination == PanelDestination.qaQuestion && !request.targetId.isEmpty {
                    proxy.scrollTo(request.targetId, anchor: .top)
                }
            }
            .accessibilityIdentifier("qa.list")
        }
    }
}

private struct QaSortBar: View {
    let qa: WebinarQAPresenter
    let snapshot: QaPanelSnapshot
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if snapshot.availableSorts.count > 1 && snapshot.availability == QaAvailability.available {

            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    sortPicker.pickerStyle(.menu)
                } else {
                    sortPicker.pickerStyle(.segmented)
                }
            }
            .labelsHidden()
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Color(uiColor: .systemBackground))
            .accessibilityIdentifier("qa.sort")
        }
    }

    private var sortPicker: some View {
        Picker(ConclaveStrings.text("Sort"), selection: Binding(get: { snapshot.sort.rawValue },
                                                              set: { qa.setSort(QaSort(rawValue: $0) ?? QaSort.top) })) {
            ForEach(snapshot.availableSorts, id: \.self) { raw in
                Text(QaText.sortTitle(raw)).tag(raw)
            }
        }
    }
}

private struct QaFilterMenu: View {
    let qa: WebinarQAPresenter
    let snapshot: QaPanelSnapshot

    var body: some View {
        Menu {
            Picker(ConclaveStrings.text("Filter"), selection: Binding(get: { snapshot.filter.rawValue },
                                                                    set: { qa.setFilter(QaHostFilter(rawValue: $0) ?? QaHostFilter.openQuestions) })) {
                ForEach(QaHostFilter.allCases, id: \.self) { filter in
                    Text(QaText.filterTitle(filter, count: snapshot.count(filter))).tag(filter.rawValue)
                }
            }
        } label: {
            Text(ConclaveStrings.text("Filter"))
        }
        .accessibilityValue(QaText.filterTitle(snapshot.filter, count: snapshot.count(snapshot.filter)))
        .accessibilityIdentifier("qa.filter")
    }
}

private struct QaEmptyOrLoading: View {
    let snapshot: QaPanelSnapshot

    var body: some View {
        if snapshot.availability == QaAvailability.needsRejoin {
            ConclaveEmptyStatus(title: ConclaveStrings.text("Questions Unavailable"),
                                message: ConclaveStrings.text("Questions show up here the next time you join."),
                                systemImage: ConclaveSymbols.questionmarkBubble, identifier: "qa.unavailable")
        } else if !snapshot.isLoaded {
            ConclaveLoadingStatus(label: ConclaveStrings.text("Loading Questions"), identifier: "qa.loading")
        } else if snapshot.questionIds.isEmpty, let message = QaPanelText.emptyMessage(snapshot) {
            ConclaveEmptyStatus(title: QaPanelText.emptyTitle(snapshot), message: message,
                                systemImage: ConclaveSymbols.questionmarkBubble, identifier: "qa.empty")
        }
    }
}

enum QaPanelText {

    static func emptyTitle(_ snapshot: QaPanelSnapshot) -> String {
        ConclaveStrings.text("No Questions Yet")
    }

    static func emptyMessage(_ snapshot: QaPanelSnapshot) -> String? {
        if snapshot.isHost {
            switch snapshot.filter {
            case .openQuestions: return ConclaveStrings.text("Attendee questions land here for you to answer live or dismiss.")
            case .answered: return ConclaveStrings.text("No answered questions.")
            case .dismissed: return ConclaveStrings.text("No dismissed questions.")
            }
        }
        if snapshot.isAttendee {
            if snapshot.sort == QaSort.mine { return ConclaveStrings.text("You haven\u{2019}t asked anything yet.") }
            return ConclaveStrings.text("Ask the first one.")
        }
        return nil
    }

    static func composerReason(_ raw: String) -> String? {
        if raw == QaComposerReason.offline { return HostText.reason(PeopleActionReason.offline) }
        if raw == QaComposerReason.reconnecting { return HostText.reason(PeopleActionReason.reconnecting) }
        return nil
    }
}

private struct QaComposer: View {
    let people: PeoplePresenter
    let snapshot: QaPanelSnapshot
    @State private var text = ""
    @State private var didSeed = false

    var body: some View {
        let qa = people.qa
        let sending = snapshot.submitPhase == QaSubmitPhase.sending
        Group {
            if snapshot.composerReason == QaComposerReason.qaOff {
                Text(ConclaveStrings.text("The host turned Q&A off for this webinar."))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .accessibilityIdentifier("qa.composer.off")
            } else {
                ConclaveComposerStack(identifier: "qa.composer") {
                    if QaComposerPolicy.isTooShort(text) {
                        Text(ConclaveStrings.text("Ask a longer question."))
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.secondaryText)
                            .accessibilityIdentifier("qa.composer.short")
                    }
                    if let reason = QaPanelText.composerReason(snapshot.composerReason) {
                        Text(reason)
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.secondaryText)
                    }
                    HostInlineFailureLine(people: people, sourceKey: QaFieldID.composer)
                } field: {
                    ConclaveComposerField(identifier: "qa.composer.cluster") {
                        TextField(ConclaveStrings.text("Ask the host a question"), text: $text, axis: .vertical)
                            .lineLimit(1...5)
                            .textInputAutocapitalization(.sentences)
                            .disabled(sending || !snapshot.composerEnabled)
                            .accessibilityLabel(ConclaveStrings.text("Ask the host a question"))
                            .accessibilityIdentifier("qa.composer.field")
                    } send: {
                        if sending {
                            ProgressView()
                                .frame(minWidth: ConclaveButtonMetrics.minimumHeight, minHeight: ConclaveButtonMetrics.minimumHeight)
                                .accessibilityLabel(ConclaveStrings.text("Ask"))
                        } else {
                            ConclaveComposerSendButton(title: ConclaveStrings.text("Ask"),
                                                       isEnabled: QaComposerPolicy.canSubmit(text, composerEnabled: snapshot.composerEnabled,
                                                                                             isSending: sending),
                                                       identifier: "qa.composer.send") {
                                qa.submit(text)
                            }
                        }
                    }
                } footer: {
                    ConclaveCharacterCounter(count: text.count, limit: QaLimits.questionMax,
                                             visibleFrom: QaLimits.questionCounterFrom, identifier: "qa.composer.counter",
                                             announcesBands: true)
                }
            }
        }
        .background(Color(uiColor: .systemBackground))
        .onAppear {
            if !didSeed {
                didSeed = true
                text = qa.drafts.question
            }
        }
        .onChange(of: text) { _, value in
            qa.drafts.question = value
        }
        .onChange(of: snapshot.submitSerial) { _, _ in
            text = qa.drafts.question
        }
    }
}
#endif
