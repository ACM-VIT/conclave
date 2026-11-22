#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ChatInputMemoTests {

    @Test func theViewModelConvertsOnlyTheNewMessage() {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.participants = ["remote@example.com#w": Participant(id: "remote@example.com#w", displayName: "Remote")]
        var messages: [ChatMessage] = []
        for index in 0..<200 {
            messages.append(ChatMessage(id: "m-" + String(index), userId: "remote@example.com#w", displayName: "Remote",
                                        content: "x" + String(index), roomId: "room-a"))
        }
        viewModel.state.chatMessages = messages
        let before = viewModel.chatMessageInputBuildCount
        viewModel.state.chatMessages.append(ChatMessage(id: "m-new", userId: "remote@example.com#w", displayName: "Remote",
                                                        content: "fresh", roomId: "room-a"))
        #expect(viewModel.chatMessageInputBuildCount == before + 1)
        #expect(viewModel.chat.timeline.rowIds.contains("m-new"))

        viewModel.state.chatMessages.append(ChatMessage(id: "m-pending", userId: "remote@example.com#w", displayName: "Remote",
                                                        content: "while closed", roomId: "room-a"))
        #expect(viewModel.chat.hasDeferredRows)
        viewModel.shell.panels.present(.chat, from: .call)
        #expect(!viewModel.chat.hasDeferredRows, "rows are current before the panel's first frame")
        #expect(viewModel.chat.currentTimeline.rowIds.contains("m-pending"))
        viewModel.shell.panels.dismiss(cancelPending: true)

        viewModel.state.displayNames = ["remote@example.com#w": "Remote Person"]
        #expect(viewModel.chatMessageInputBuildCount >= before + 1 + 202)
        #expect(viewModel.chat.rows.entry(for: "m-0").row.senderName == "Remote Person")
    }

    @Test func cancellingChatBeforeItMountsLeavesThePresenterClosed() {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.participants = ["remote@example.com#w": Participant(id: "remote@example.com#w", displayName: "Remote")]
        viewModel.state.chatMessages = [ChatMessage(id: "m-0", userId: "remote@example.com#w", displayName: "Remote",
                                                    content: "earlier", roomId: "room-a")]
        _ = viewModel.chat.timeline
        viewModel.shell.panels.toggle(.chat, from: .call)
        viewModel.shell.panels.toggle(.chat, from: .call)
        #expect(!viewModel.state.isChatOpen)
        #expect(!viewModel.chat.isOpen)

        viewModel.state.chatMessages.append(ChatMessage(id: "m-1", userId: "remote@example.com#w", displayName: "Remote",
                                                        content: "while closed", roomId: "room-a"))
        #expect(viewModel.chat.hasDeferredRows)
        let dismissing = viewModel.shell.panels.snapshot
        viewModel.shell.panels.didDismiss(session: dismissing.session, presentationID: dismissing.current?.presentationID ?? 0)
        viewModel.shell.panels.toggle(.chat, from: .call)
        #expect(viewModel.chat.isOpen)
        let rowIds = viewModel.chat.timeline.rowIds
        let divider = rowIds.firstIndex(of: "unread")
        #expect(divider.map { rowIds[$0 + 1] } == "m-1")
    }
}
#endif
