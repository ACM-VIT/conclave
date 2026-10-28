#if os(iOS) && !SKIP
import SwiftUI

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

            if qa.snapshot.answeredQuestionId == questionId { dismiss() }
        }
        .accessibilityIdentifier("qa.answer.page")
    }
}
#endif
