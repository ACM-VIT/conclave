enum MeetingPanel: String, CaseIterable, Equatable {
    case chat, participants, transcript, activities, effects
    case hostControls, settings, webinarQA, meetingInfo, layout
}

/// The origin is retained with the request, including while its native presentation closes.
enum PanelInvoker: String, Equatable {
    case call, more, settings
}

struct PanelRequest: Equatable {
    let presentationID: Int
    let panel: MeetingPanel
    let invoker: PanelInvoker
}

struct PanelSnapshot: Equatable {
    let session: Int
    let current: PanelRequest?
    let pending: PanelRequest?
    let isDismissing: Bool
}
