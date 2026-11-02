#if os(iOS) && !SKIP
import EventKit
import EventKitUI
import SwiftUI

struct WebinarCalendarDraft: Identifiable, Equatable {
    let id: Int
    let title: String
    let startsAt: Date
    let endsAt: Date
    let link: String
}

struct EventEditView: UIViewControllerRepresentable {
    let draft: WebinarCalendarDraft

    let onFinish: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let store = context.coordinator.store
        let event = EKEvent(eventStore: store)
        event.title = draft.title
        event.startDate = draft.startsAt
        event.endDate = draft.endsAt
        if let url = URL(string: draft.link), !draft.link.isEmpty {
            event.url = url
            event.notes = draft.link
        }
        let controller = EKEventEditViewController()
        controller.eventStore = store
        controller.event = event
        controller.editViewDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: EKEventEditViewController, context: Context) {
        context.coordinator.onFinish = onFinish
    }

    final class Coordinator: NSObject, EKEventEditViewDelegate {
        let store = EKEventStore()
        var onFinish: () -> Void

        init(onFinish: @escaping () -> Void) {
            self.onFinish = onFinish
        }

        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            onFinish()
        }
    }
}
#endif
