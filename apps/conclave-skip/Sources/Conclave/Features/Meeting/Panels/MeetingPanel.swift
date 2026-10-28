enum MeetingPanel: String, CaseIterable, Equatable {
    case chat, participants, transcript, activities, effects
    case hostControls, settings, webinarQA, meetingInfo, layout
}

enum PanelInvoker: String, Equatable {
    case call, more, settings
}

enum PanelDestination: String, CaseIterable, Equatable {
    case none, peopleWaiting, peopleRaisedHands, hostControlsAccess
    case chatPrivate, chatMessage, chatReply, chatAskAssistant
    case transcriptLive, transcriptMinutes, transcriptAsk
    case settingsAudio, settingsVoice
    case activitiesVote, activitiesApp
    case qaQuestion
}

struct PanelRequest: Equatable {
    let presentationID: Int
    let panel: MeetingPanel
    let invoker: PanelInvoker

    let destination: PanelDestination

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

struct PanelDestinationRequest: Equatable {
    let sequence: Int
    let session: Int
    let presentationID: Int
    let panel: MeetingPanel
    let invoker: PanelInvoker
    let destination: PanelDestination
    let targetId: String
}
