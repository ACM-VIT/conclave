#if os(iOS) && !SKIP
import EventKit
import EventKitUI
import SwiftUI

// ENT-9 (S10 12 a, c; PLAN-screens ENT-9 "Add to calendar opens the system editor and is cancelled"): the system event
// editor, prefilled with the webinar's title, times and link. `EKEventEditViewController` through
// `UIViewControllerRepresentable`; the app never reads or writes calendars itself, so no calendar permission is
// requested here (iOS 17 runs the editor out of process; S10 marks the no-prompt behavior [Unverified], a runtime cell).

/// One prefilled event. `id` is the landing revision that asked for it, so a second tap opens a fresh editor.
struct WebinarCalendarDraft: Identifiable, Equatable {
    let id: Int
    let title: String
    let startsAt: Date
    let endsAt: Date
    let link: String
}

struct EventEditView: UIViewControllerRepresentable {
    let draft: WebinarCalendarDraft
    /// Saved, cancelled or deleted: the sheet closes.
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
