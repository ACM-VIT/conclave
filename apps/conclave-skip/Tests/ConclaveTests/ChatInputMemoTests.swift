#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ChatInputMemoTests {
    typealias Chat = ChatPoliciesTests

    private func joinedViewModel() -> MeetingViewModel {
        let viewModel = isolatedViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.participants = ["remote@example.com#w": Participant(id: "remote@example.com#w", displayName: "Remote")]
        viewModel.state.chatMessages = [ChatMessage(id: "m-0", userId: "remote@example.com#w", displayName: "Remote",
                                                    content: "earlier", roomId: "room-a")]
        _ = viewModel.chat.timeline
        readChat(viewModel)
        return viewModel
    }

    private func readChat(_ viewModel: MeetingViewModel) {
        let panels = viewModel.shell.panels
        panels.present(.chat, from: .call)
        panels.panelDidAppear(session: panels.snapshot.session, presentationID: panels.snapshot.current?.presentationID ?? 0)
        panels.dismiss(cancelPending: true)
        panels.didDismiss(session: panels.snapshot.session, presentationID: panels.snapshot.current?.presentationID ?? 0)
    }

    @Test func chatClosesWhileTheCallSurfaceIsHiddenAndShowsTheDividerWhenItReturns() {
        let shell = MeetingShellPresenter(defaults: IsolatedDefaults.make())
        let chat = shell.chat
        chat.now = { Chat.base + 600_000 }
        var messages = [Chat.peer("h-0", "earlier", at: 0)]
        chat.apply(Chat.inputs(messages), change: .messages)
        shell.panels.present(.chat, from: .call)
        #expect(chat.isOpen)

        shell.setCallSurfaceVisible(false)
        #expect(!chat.isOpen)
        let built = chat.rebuildCount
        messages.append(Chat.peer("n-0", "while hidden", at: 100, history: false))
        chat.apply(Chat.inputs(messages), change: .messages)
        #expect(chat.rebuildCount == built)
        #expect(chat.pendingUnreadCount == 1)

        shell.setCallSurfaceVisible(true)
        #expect(chat.isOpen)
        let rowIds = chat.timeline.rowIds
        #expect(rowIds.firstIndex(of: "unread").map { rowIds[$0 + 1] } == "n-0")
    }

    @Test func pictureInPictureHidesTheCallUIOnlyWhereItReplacesIt() {
        #expect(!CallSurfaceVisibilityPolicy.isVisible(isForeground: true, isInPictureInPicture: true,
                                                       pictureInPictureReplacesCallUI: true))
        #expect(CallSurfaceVisibilityPolicy.isVisible(isForeground: true, isInPictureInPicture: true,
                                                      pictureInPictureReplacesCallUI: false))
        #expect(!CallSurfaceVisibilityPolicy.isVisible(isForeground: false, isInPictureInPicture: false,
                                                       pictureInPictureReplacesCallUI: false))
        #expect(CallSurfaceVisibilityPolicy.isVisible(isForeground: true, isInPictureInPicture: false,
                                                      pictureInPictureReplacesCallUI: true))
    }

    @Test func anOpenCancelledBeforeTheChatAppearsLeavesTheUnreadMessagesUnread() {
        let viewModel = joinedViewModel()
        viewModel.state.chatMessages.append(ChatMessage(id: "m-a", userId: "remote@example.com#w", displayName: "Remote",
                                                        content: "first unseen", roomId: "room-a"))
        viewModel.shell.panels.toggle(.chat, from: .call)
        viewModel.shell.panels.toggle(.chat, from: .call)
        let dismissing = viewModel.shell.panels.snapshot
        viewModel.shell.panels.didDismiss(session: dismissing.session, presentationID: dismissing.current?.presentationID ?? 0)
        viewModel.state.chatMessages.append(ChatMessage(id: "m-b", userId: "remote@example.com#w", displayName: "Remote",
                                                        content: "second unseen", roomId: "room-a"))
        #expect(viewModel.chat.pendingUnreadCount == 2)

        viewModel.shell.panels.toggle(.chat, from: .call)
        let rowIds = viewModel.chat.timeline.rowIds
        #expect(rowIds.firstIndex(of: "unread").map { rowIds[$0 + 1] } == "m-a")
    }

    @Test func aMessageThatArrivesBeforeTheChatAppearsStaysUnreadWhenItIsCancelled() {
        let viewModel = joinedViewModel()
        viewModel.shell.panels.toggle(.chat, from: .call)
        #expect(viewModel.chat.isOpen && !viewModel.chat.isShown)
        viewModel.state.chatMessages.append(ChatMessage(id: "m-p", userId: "remote@example.com#w", displayName: "Remote",
                                                        content: "before the sheet mounted", roomId: "room-a"))
        viewModel.shell.panels.toggle(.chat, from: .call)
        let dismissing = viewModel.shell.panels.snapshot
        viewModel.shell.panels.didDismiss(session: dismissing.session, presentationID: dismissing.current?.presentationID ?? 0)
        #expect(viewModel.chat.pendingUnreadCount == 1)

        viewModel.shell.panels.toggle(.chat, from: .call)
        let rowIds = viewModel.chat.timeline.rowIds
        #expect(rowIds.firstIndex(of: "unread").map { rowIds[$0 + 1] } == "m-p")
    }

    @Test func aChatThatAppearedConsumesItsUnreadAnchor() {
        let viewModel = joinedViewModel()
        viewModel.state.chatMessages.append(ChatMessage(id: "m-a", userId: "remote@example.com#w", displayName: "Remote",
                                                        content: "seen", roomId: "room-a"))
        viewModel.shell.panels.toggle(.chat, from: .call)
        let shown = viewModel.shell.panels.snapshot
        viewModel.shell.panels.panelDidAppear(session: shown.session, presentationID: shown.current?.presentationID ?? 0)
        #expect(viewModel.chat.isShown)
        viewModel.shell.panels.toggle(.chat, from: .call)
        let dismissing = viewModel.shell.panels.snapshot
        viewModel.shell.panels.didDismiss(session: dismissing.session, presentationID: dismissing.current?.presentationID ?? 0)
        viewModel.state.chatMessages.append(ChatMessage(id: "m-b", userId: "remote@example.com#w", displayName: "Remote",
                                                        content: "new", roomId: "room-a"))
        #expect(viewModel.chat.pendingUnreadCount == 1)

        viewModel.shell.panels.toggle(.chat, from: .call)
        let rowIds = viewModel.chat.timeline.rowIds
        #expect(rowIds.firstIndex(of: "unread").map { rowIds[$0 + 1] } == "m-b")
    }

    @Test func aChatShownBeforeBackgroundingIsShownAgainWhenTheAppReturns() {
        let viewModel = joinedViewModel()
        viewModel.shell.panels.present(.chat, from: .call)
        let shown = viewModel.shell.panels.snapshot
        viewModel.shell.panels.panelDidAppear(session: shown.session, presentationID: shown.current?.presentationID ?? 0)
        viewModel.handleAppEnteredBackground()
        #expect(!viewModel.chat.isShown)
        viewModel.handleAppBecameActive()
        #expect(viewModel.chat.isShown)
    }

    @Test func onlyALiveAppearanceOfTheCurrentViewShowsChat() {
        let shell = MeetingShellPresenter(defaults: IsolatedDefaults.make())
        let chat = shell.chat
        chat.now = { Chat.base + 600_000 }
        var messages = [Chat.peer("h-0", "earlier", at: 0)]
        chat.apply(Chat.inputs(messages), change: .messages)
        let panels = shell.panels
        panels.present(.chat, from: .call)
        let mounted = panels.panelDidAppear(session: panels.snapshot.session, presentationID: panels.snapshot.current?.presentationID ?? 0)
        #expect(chat.isShown)

        panels.panelDidDisappear(token: mounted)
        #expect(!chat.isShown)
        messages.append(Chat.peer("transition", "while the panel leaves", at: 50, history: false))
        chat.apply(Chat.inputs(messages), change: .messages)
        #expect(chat.pendingUnreadCount == 1)

        shell.setCallSurfaceVisible(false)
        for index in 0..<500 {
            messages.append(Chat.peer("hidden-" + String(index), "hidden " + String(index), at: 100.0 + Double(index), history: false))
            chat.apply(Chat.inputs(messages), change: .messages)
        }
        shell.setCallSurfaceVisible(true)
        #expect(!chat.isShown)
        #expect(chat.pendingUnreadCount == 501)

        shell.setCallSurfaceVisible(false)
        shell.setCallSurfaceVisible(true)
        panels.panelDidAppear(session: panels.snapshot.session, presentationID: panels.snapshot.current?.presentationID ?? 0)
        #expect(chat.isShown)
        let rowIds = chat.timeline.rowIds
        #expect(rowIds.firstIndex(of: "unread").map { rowIds[$0 + 1] } == "transition")
    }

    @Test func theBadgeClearsOnlyWhenChatIsShown() {
        let viewModel = joinedViewModel()
        viewModel.state.unreadChatCount = 2
        viewModel.shell.panels.toggle(.chat, from: .call)
        #expect(!viewModel.state.isChatOpen, "new messages keep counting until chat appears")
        #expect(viewModel.state.unreadChatCount == 2)
        viewModel.shell.panels.toggle(.chat, from: .call)
        let dismissing = viewModel.shell.panels.snapshot
        viewModel.shell.panels.didDismiss(session: dismissing.session, presentationID: dismissing.current?.presentationID ?? 0)
        #expect(viewModel.state.unreadChatCount == 2)

        viewModel.shell.panels.toggle(.chat, from: .call)
        let shown = viewModel.shell.panels.snapshot
        viewModel.shell.panels.panelDidAppear(session: shown.session, presentationID: shown.current?.presentationID ?? 0)
        #expect(viewModel.state.isChatOpen)
        #expect(viewModel.state.unreadChatCount == 0)
    }

    @Test func backgroundingTheAppClosesChatUntilItComesBack() {
        let viewModel = joinedViewModel()
        viewModel.shell.panels.present(.chat, from: .call)
        #expect(viewModel.chat.isOpen)

        viewModel.handleAppEnteredBackground()
        #expect(!viewModel.chat.isOpen)
        let built = viewModel.chat.rebuildCount
        viewModel.state.chatMessages.append(ChatMessage(id: "m-1", userId: "remote@example.com#w", displayName: "Remote",
                                                        content: "while backgrounded", roomId: "room-a"))
        #expect(viewModel.chat.rebuildCount == built)
        #expect(viewModel.chat.pendingUnreadCount == 1)

        viewModel.handleAppBecameActive()
        #expect(viewModel.chat.isOpen)
        let rowIds = viewModel.chat.timeline.rowIds
        #expect(rowIds.firstIndex(of: "unread").map { rowIds[$0 + 1] } == "m-1")
    }

    @Test func theViewModelConvertsOnlyTheNewMessage() {
        let viewModel = isolatedViewModel()
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

    @Test func theStageFixtureSessionOpensAndClosesChatWithThePanel() {
        let session = StageFixtureSession(state: .chatPreviewsMixed3)
        let chat = session.shell.chat
        #expect(!chat.isOpen)
        session.shell.panels.present(.chat, from: .call)
        #expect(chat.isOpen)
        session.shell.panels.dismiss(cancelPending: true)
        #expect(!chat.isOpen)
    }

    @Test func cancellingChatBeforeItMountsLeavesThePresenterClosed() {
        let viewModel = isolatedViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.participants = ["remote@example.com#w": Participant(id: "remote@example.com#w", displayName: "Remote")]
        viewModel.state.chatMessages = [ChatMessage(id: "m-0", userId: "remote@example.com#w", displayName: "Remote",
                                                    content: "earlier", roomId: "room-a")]
        _ = viewModel.chat.timeline
        readChat(viewModel)
        viewModel.shell.panels.toggle(.chat, from: .call)
        viewModel.shell.panels.toggle(.chat, from: .call)
        #expect(!viewModel.state.isChatOpen)
        #expect(!viewModel.chat.isOpen)

        let built = viewModel.chat.rebuildCount
        for index in 1...10 {
            viewModel.state.chatMessages.append(ChatMessage(id: "m-" + String(index), userId: "remote@example.com#w",
                                                            displayName: "Remote", content: "while closed", roomId: "room-a"))
        }
        #expect(viewModel.chat.rebuildCount == built)
        #expect(viewModel.chat.pendingUnreadCount == 10)
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
