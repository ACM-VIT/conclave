#if os(iOS) && !SKIP
import SwiftUI

// S50 11 c, PL15 (PPL-6): "Answer in Writing" as a push inside the Q&A PanelShell stack (`QaRoute`), because an alert
// hosts only a single-line field with no counter (HIG H-19) and composing surfaces get full height (H-03). A `Form`
// with the question, a multi-line field (`lineLimit(4...12)`), the counter footer from 900 and a `.confirmationAction`
// "Post Answer" (disabled when the trimmed draft is empty, over 1,000 or pending). The draft is view-local, seeded
// from `qa.drafts.answers[id]` and written back on change; on success the presenter clears it and the page pops; on
// failure the inline line shows the mapped copy with Retry and the draft stays.

/// The Q&A stack's one route type (R50-2: a struct in the iOS-only view file, no shared route enum).
struct QaRoute: Hashable {
    let answerQuestionId: String
}

struct QaAnswerPage: View {
    let people: PeoplePresenter
    let questionId: String
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var didSeed = false

    var body: some View {
        let qa = people.qa
        let model = qa.questions.entry(for: questionId).model
        let pending = model.pendingAction == QaHostAction.answerText
        Form {
            Section {
                Text(model.text)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("qa.answer.question")
            }
            Section {
                TextField(ConclaveStrings.text("Your Answer"), text: $draft, axis: .vertical)
                    .lineLimit(4...12)
                    .disabled(pending)
                    .accessibilityIdentifier("qa.answer.field")
                HostInlineFailureLine(people: people, sourceKey: QaFieldID.answer(questionId))
            } footer: {
                if QaComposerPolicy.showsAnswerCounter(draft.count) {
                    ConclaveCharacterCounter(count: draft.count, limit: QaLimits.answerMax, visibleFrom: QaLimits.answerCounterFrom,
                                             identifier: "qa.answer.counter")
                } else {
                    Text(ConclaveStrings.text("Attendees see this under the question."))
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(ConclaveStrings.text("Answer in Writing"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    qa.moderate(id: questionId, action: QaStatus.answered, reopen: false, answerText: draft)
                } label: {
                    if pending {
                        ProgressView()
                    } else {
                        Text(ConclaveStrings.text("Post Answer"))
                    }
                }
                .disabled(!QaComposerPolicy.canPostAnswer(draft, isPending: pending) || !model.isEnabled)
                .accessibilityIdentifier("qa.answer.post")
            }
        }
        .onAppear {
            if !didSeed {
                didSeed = true
                draft = qa.drafts.answers[questionId] ?? ""
            }
        }
        .onChange(of: draft) { _, value in
            qa.drafts.answers[questionId] = value
        }
        .onChange(of: qa.snapshot.answerSerial) { _, _ in
            // The presenter cleared the draft on the acknowledgement; the page pops and the answer shows indented.
            if qa.snapshot.answeredQuestionId == questionId { dismiss() }
        }
        .accessibilityIdentifier("qa.answer.page")
    }
}
#endif
