enum MeetingPanel: String, CaseIterable, Equatable {
    case chat, participants, transcript, activities, effects
    case hostControls, settings, webinarQA, meetingInfo, layout
}

/// The origin is retained with the request, including while its native presentation closes.
enum PanelInvoker: String, Equatable {
    case call, more, settings
}

/// Where a panel opens (S20 0.5 and SR7, RECONCILE R11): the single definition every panel and presenter cites.
/// `none` opens the panel's root. It lives with the panel contract so no panel slice waits for the stage presenter.
enum PanelDestination: String, CaseIterable, Equatable {
    case none, peopleWaiting, peopleRaisedHands, hostControlsAccess // S50 R50-3
    case chatPrivate, chatMessage, chatReply, chatAskAssistant // S40 R40-2
    case transcriptLive, transcriptMinutes, transcriptAsk // S60 R6-5
    case settingsAudio, settingsVoice // S30 CC6, S60 R6-5
    case activitiesVote, activitiesApp // S60 R6-5
    case qaQuestion // S50 R50-3
}

struct PanelRequest: Equatable {
    let presentationID: Int
    let panel: MeetingPanel
    let invoker: PanelInvoker
    /// Where the panel opens (SR7). The panel reads it once on open; a replacement keeps its own destination.
    let destination: PanelDestination
    /// The one id the destination names: a user for `chatPrivate`, a message for the other chat destinations, a
    /// question for `qaQuestion`, an app for `activitiesApp`; empty when the destination names none.
    let targetId: String

    init(presentationID: Int, panel: MeetingPanel, invoker: PanelInvoker,
         destination: PanelDestination = PanelDestination.none, targetId: String = "") {
        self.presentationID = presentationID
        self.panel = panel
        self.invoker = invoker
        self.destination = destination
        self.targetId = targetId
    }
}

struct PanelSnapshot: Equatable {
    let session: Int
    let current: PanelRequest?
    let pending: PanelRequest?
    let isDismissing: Bool
}

/// A destination for the panel that is already current (SR7, S40 R40-2): published without a new presentation, so
/// the shown panel moves to the destination in place (for example the tile's "Send Private Message" while Chat is
/// open in the inspector or the side pane). `sequence` grows with every request and never resets, so a repeated
/// request for the same destination still reads as a change. A panel acts only on a request naming its own session
/// and presentation (`PanelCoordinator.latestDestination(for:)`).
struct PanelDestinationRequest: Equatable {
    let sequence: Int
    let session: Int
    let presentationID: Int
    let panel: MeetingPanel
    let invoker: PanelInvoker
    let destination: PanelDestination
    let targetId: String
}
