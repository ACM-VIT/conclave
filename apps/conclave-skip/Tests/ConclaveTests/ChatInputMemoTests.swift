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
        viewModel.chat.panelDidClose()

        viewModel.state.displayNames = ["remote@example.com#w": "Remote Person"]
        #expect(viewModel.chatMessageInputBuildCount >= before + 1 + 202)
        #expect(viewModel.chat.rows.entry(for: "m-0").row.senderName == "Remote Person")
    }
}
#endif
