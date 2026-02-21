//
//  MeetingViewModel.swift
//  Conclave
//
//  Production ViewModel with WebRTC integration
//

import Foundation
import Observation
#if !SKIP
import SkipFuse
#endif
#if canImport(AVFoundation)
import AVFoundation
#endif

@MainActor
@Observable
final class MeetingViewModel {

    var state = MeetingState()

    // MARK: - Reactions

    var reactionLaneCounter = 0

    // MARK: - Managers

    let socketManager = SocketIOManager()
    let webRTCClient = WebRTCClient()
    var lastJoinContext: JoinContext?
    var shouldRejoinAfterReconnect = false
    var isIntentionalLeave = false
    var isRejoinInFlight = false

    func displayNameForUser(_ id: String) -> String {
        state.displayName(for: id)
    }

    struct JoinContext {
        let roomId: String
        let displayName: String
        let isGhost: Bool
        let isHost: Bool
        let user: SfuJoinUser?
    }
    
    // MARK: - Init
    
    init() {
        setupSocketBindings()
        setupWebRTCBindings()
    }
    
    // MARK: - Socket Bindings
    
    func setupSocketBindings() {
        socketManager.onConnected = { [weak self] in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.connectionState = ConnectionState.connected
            }
        }
        
        socketManager.onDisconnected = { [weak self] reason in
            Task { @MainActor in
                guard let self = self else { return }
                if self.isIntentionalLeave {
                    self.state.connectionState = ConnectionState.disconnected
                    return
                }
                self.state.connectionState = ConnectionState.reconnecting
                self.shouldRejoinAfterReconnect = true
                if let reason = reason {
                    self.state.errorMessage = reason
                }
            }
        }
        
        socketManager.onError = { [weak self] error in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.errorMessage = error.localizedDescription
                #if !SKIP
                HapticManager.shared.trigger(.error)
                #endif
            }
        }

        socketManager.onReconnecting = { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                if !self.isIntentionalLeave {
                    self.state.connectionState = ConnectionState.reconnecting
                }
            }
        }

        socketManager.onReconnected = { [weak self] in
            Task { [weak self] in
                guard let self = self else { return }
                await self.rejoinIfPossible()
            }
        }

        socketManager.onReconnectFailed = { [weak self] in
            Task { [weak self] in
                guard let self = self else { return }
                await self.forceRejoinWithFreshToken()
            }
        }
        
        socketManager.onJoinedRoom = { [weak self] response in
            Task { @MainActor in
                guard let self = self else { return }
                
                self.state.connectionState = ConnectionState.joined
                self.state.waitingMessage = nil
                
                // Configure WebRTC with server capabilities
                self.webRTCClient.configure(
                    socketManager: self.socketManager,
                    rtpCapabilities: response.rtpCapabilities
                )
                
                // Create transports
                do {
                    try await self.webRTCClient.createTransports()
                    
                    // Start producing if not ghost
                    if !self.state.isGhostMode {
                        await self.startProducing()
                    }
                    
                    // Consume existing producers
                    for producer in response.existingProducers {
                        try await self.webRTCClient.consumeProducer(
                            producerId: producer.producerId,
                            producerUserId: producer.producerUserId
                        )
                        self.handleProducerState(producer)
                    }
                } catch {
                    debugLog("[Meeting] WebRTC setup error: \(error)")
                    self.state.errorMessage = error.localizedDescription
                    #if !SKIP
                    HapticManager.shared.trigger(.error)
                    #endif
                }
            }
        }

        socketManager.onWaitingForAdmission = { [weak self] in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.connectionState = ConnectionState.waiting
            }
        }
        
        socketManager.onWaitingRoomStatus = { [weak self] message in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.waitingMessage = message
            }
        }
        
        socketManager.onJoinApproved = { [weak self] in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.connectionState = ConnectionState.joining
            }
            Task { [weak self] in
                guard let self = self else { return }
                await self.rejoinIfPossible()
            }
        }
        
        socketManager.onJoinRejected = { [weak self] in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.connectionState = ConnectionState.error
                self.state.errorMessage = "The host has denied your request to join."
                #if !SKIP
                HapticManager.shared.trigger(.error)
                #endif
                await self.cleanup()
            }
        }

        socketManager.onHostAssigned = { [weak self] in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.isAdmin = true
            }
        }
        
        socketManager.onKicked = { [weak self] reason in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.connectionState = ConnectionState.disconnected
                self.state.errorMessage = reason ?? "You were removed from the meeting"
                #if !SKIP
                HapticManager.shared.trigger(.error)
                #endif
                await self.cleanup()
            }
        }

        socketManager.onUserJoined = { [weak self] notification in
            Task { @MainActor in
                guard let self = self else { return }
                let userId = notification.userId
                if self.state.participants[userId] == nil {
                    self.state.participants[userId] = Participant(id: userId)
                }
                if let displayName = notification.displayName, !displayName.isEmpty {
                    self.state.displayNames[userId] = displayName
                }
                if let isGhost = notification.isGhost {
                    self.state.participants[userId]?.isGhost = isGhost
                }
            }
        }
        
        socketManager.onUserLeft = { [weak self] userId in
            Task { @MainActor in
                guard let self = self else { return }
                
                // Mark as leaving for animation
                self.state.participants[userId]?.isLeaving = true
                
                // Remove after animation delay
                try? await Task.sleep(nanoseconds: 200_000_000)
                self.state.participants.removeValue(forKey: userId)
                self.state.displayNames.removeValue(forKey: userId)
                
                // Cleanup video track
                self.webRTCClient.closeConsumer(producerId: "", userId: userId)
            }
        }
        
        socketManager.onDisplayNameSnapshot = { [weak self] snapshot in
            Task { @MainActor in
                guard let self = self else { return }
                var next: [String: String] = [:]
                for user in snapshot.users {
                    if let displayName = user.displayName, !displayName.isEmpty {
                        next[user.userId] = displayName
                        if user.userId == self.state.userId {
                            self.state.displayName = displayName
                        }
                    }
                }
                self.state.displayNames = next
            }
        }
        
        socketManager.onDisplayNameUpdated = { [weak self] update in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.displayNames[update.userId] = update.displayName
                if update.userId == self.state.userId {
                    self.state.displayName = update.displayName
                }
            }
        }
        
        socketManager.onNewProducer = { [weak self] producer in
            Task { @MainActor in
                guard let self = self else { return }
                
                self.handleProducerState(producer)
                
                // Consume the new producer
                do {
                    try await self.webRTCClient.consumeProducer(
                        producerId: producer.producerId,
                        producerUserId: producer.producerUserId
                    )
                } catch {
                    debugLog("[Meeting] Failed to consume producer: \(error)")
                }
            }
        }
        
        socketManager.onProducerClosed = { [weak self] notification in
            Task { @MainActor in
                guard let self = self else { return }
                
                let producerId = notification.producerId
                let userId = notification.producerUserId
                
                if let userId {
                    if self.state.activeScreenShareUserId == userId {
                        self.state.activeScreenShareUserId = nil
                    }
                    self.state.participants[userId]?.isScreenSharing = false
                }
                
                self.webRTCClient.closeConsumer(producerId: producerId, userId: userId ?? "")
            }
        }
        
        socketManager.onChatMessage = { [weak self] message in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.chatMessages.append(message)
                if !self.state.isChatOpen {
                    self.state.unreadChatCount += 1
                }
            }
        }
        
        socketManager.onReaction = { [weak self] reaction in
            Task { @MainActor in
                guard let self = self else { return }
                self.handleReaction(reaction)
            }
        }
        
        socketManager.onHandRaised = { [weak self] userId, raised in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.participants[userId]?.isHandRaised = raised
                if userId == self.state.userId {
                    self.state.isHandRaised = raised
                }
            }
        }
        
        socketManager.onHandRaisedSnapshot = { [weak self] snapshot in
            Task { @MainActor in
                guard let self = self else { return }
                for entry in snapshot.users {
                    if entry.userId == self.state.userId {
                        self.state.isHandRaised = entry.raised
                    } else {
                        if self.state.participants[entry.userId] == nil {
                            self.state.participants[entry.userId] = Participant(id: entry.userId)
                        }
                        self.state.participants[entry.userId]?.isHandRaised = entry.raised
                    }
                }
            }
        }
        
        socketManager.onParticipantMuted = { [weak self] notification in
            Task { @MainActor in
                guard let self = self else { return }
                if self.state.participants[notification.userId] == nil {
                    self.state.participants[notification.userId] = Participant(id: notification.userId)
                }
                self.state.participants[notification.userId]?.isMuted = notification.muted
            }
        }

        socketManager.onParticipantCameraOff = { [weak self] notification in
            Task { @MainActor in
                guard let self = self else { return }
                if self.state.participants[notification.userId] == nil {
                    self.state.participants[notification.userId] = Participant(id: notification.userId)
                }
                self.state.participants[notification.userId]?.isCameraOff = notification.cameraOff
            }
        }
        
        socketManager.onRoomLockChanged = { [weak self] locked in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.isRoomLocked = locked
            }
        }

        socketManager.onChatLockChanged = { [weak self] locked in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.isChatLocked = locked
            }
        }
        
        socketManager.onUserRequestedJoin = { [weak self] notification in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.pendingUsers[notification.userId] = notification.displayName
            }
        }
        
        socketManager.onPendingUsersSnapshot = { [weak self] snapshot in
            Task { @MainActor in
                guard let self = self else { return }
                var next: [String: String] = [:]
                for user in snapshot.users {
                    next[user.userId] = user.displayName ?? user.userId
                }
                self.state.pendingUsers = next
            }
        }
        
        socketManager.onPendingUserChanged = { [weak self] notification in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.pendingUsers.removeValue(forKey: notification.userId)
            }
        }
        
        socketManager.onSetVideoQuality = { [weak self] notification in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.videoQuality = notification.quality
                self.webRTCClient.updateVideoQuality(notification.quality)
            }
        }
        
        socketManager.onRedirect = { [weak self] notification in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.connectionState = ConnectionState.error
                self.state.errorMessage = "You were redirected to another room: \(notification.newRoomId)"
                await self.cleanup()
            }
        }
    }
    
    // MARK: - WebRTC Bindings
    
    func setupWebRTCBindings() {
        // Observe local video state changes
        webRTCClient.onLocalVideoEnabledChanged = { [weak self] enabled in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.isCameraOff = !enabled
            }
        }

        webRTCClient.onLocalAudioEnabledChanged = { [weak self] enabled in
            Task { @MainActor in
                guard let self = self else { return }
                self.state.isMuted = !enabled
            }
        }
    }
    
    // MARK: - Helper Methods
    
    func handleProducerState(_ producer: ProducerInfo) {
        // Ensure participant exists
        if state.participants[producer.producerUserId] == nil {
            state.participants[producer.producerUserId] = Participant(id: producer.producerUserId)
        }
        
        if producer.kind == "audio" {
            state.participants[producer.producerUserId]?.isMuted = producer.paused ?? false
        } else if producer.kind == "video" {
            if producer.type == "screen" {
                if let previous = state.activeScreenShareUserId, previous != producer.producerUserId {
                    state.participants[previous]?.isScreenSharing = false
                }
                state.participants[producer.producerUserId]?.isScreenSharing = true
                state.activeScreenShareUserId = producer.producerUserId
            } else {
                state.participants[producer.producerUserId]?.isCameraOff = producer.paused ?? false
            }
        }
    }
    
    func handleReaction(_ reaction: Reaction) {
        var newReaction = reaction
        newReaction.lane = reactionLaneCounter % 5
        reactionLaneCounter += 1
        
        state.activeReactions.append(newReaction)
        
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            await MainActor.run {
                self.state.activeReactions.removeAll { $0.id == reaction.id }
            }
        }
    }
    
    // MARK: - Room Actions
    
    func joinRoom(roomId: String, displayName: String, isGhost: Bool = false, user: SfuJoinUser? = nil, isHost: Bool = false) {
        self.state.roomId = roomId
        self.state.displayName = displayName
        self.state.isGhostMode = isGhost
        self.state.isAdmin = isHost
        self.state.waitingMessage = nil
        self.isIntentionalLeave = false
        self.shouldRejoinAfterReconnect = false
        
        let userPayload = user
        let userKey = user?.email ?? user?.id ?? "guest-\(state.sessionId)"
        self.state.userId = "\(userKey)#\(state.sessionId)"
        self.lastJoinContext = JoinContext(
            roomId: roomId,
            displayName: displayName,
            isGhost: isGhost,
            isHost: isHost,
            user: userPayload
        )
        
        state.connectionState = ConnectionState.connecting
        
        Task {
            do {
                let clientId = SfuJoinService.resolveClientId()
                let joinInfo = try await SfuJoinService.fetchJoinInfo(
                    roomId: roomId,
                    sessionId: state.sessionId,
                    user: userPayload,
                    isHost: isHost,
                    clientId: clientId
                )
                let sfuUrl = joinInfo.sfuUrl
                let token = joinInfo.token

                try await socketManager.connect(sfuURL: sfuUrl, token: token)
                
                let response = try await socketManager.joinRoom(
                    roomId: roomId,
                    sessionId: state.sessionId,
                    displayName: state.displayName,
                    isGhost: isGhost
                )
                
                if response.status == "waiting" {
                    state.connectionState = ConnectionState.waiting
                }
                // If status is nil or "joined", the onJoinedRoom callback handles it
                
            } catch {
                state.connectionState = ConnectionState.error
                state.errorMessage = error.localizedDescription
                #if !SKIP
                HapticManager.shared.trigger(.error)
                #endif
            }
        }
    }

    func rejoinIfPossible() async {
        guard let context = lastJoinContext, shouldRejoinAfterReconnect, !isIntentionalLeave else { return }
        if isRejoinInFlight { return }
        isRejoinInFlight = true
        shouldRejoinAfterReconnect = false
        await MainActor.run {
            self.state.connectionState = ConnectionState.joining
        }
        joinRoom(
            roomId: context.roomId,
            displayName: context.displayName,
            isGhost: context.isGhost,
            user: context.user,
            isHost: context.isHost
        )
        isRejoinInFlight = false
    }

    func forceRejoinWithFreshToken() async {
        guard !isIntentionalLeave else { return }
        shouldRejoinAfterReconnect = true
        socketManager.disconnect()
        await rejoinIfPossible()
    }
    
    func startProducing() async {
        // Start audio first (usually faster)
        if !state.isMuted {
            do {
                try await webRTCClient.startProducingAudio()
            } catch {
                debugLog("[Meeting] Failed to start audio: \(error)")
            }
        }
        
        // Start video if enabled
        if !state.isCameraOff {
            do {
                try await webRTCClient.startProducingVideo()
            } catch {
                debugLog("[Meeting] Failed to start video: \(error)")
            }
        }
    }
    
    func leaveRoom() {
        #if !SKIP
        HapticManager.shared.trigger(.light)
        #endif
        Task {
            isIntentionalLeave = true
            shouldRejoinAfterReconnect = false
            await cleanup()
            socketManager.disconnect()
            state.connectionState = ConnectionState.disconnected
        }
    }
    
    func cleanup() async {
        #if canImport(ReplayKit) && !SKIP
        await ScreenCaptureManager.shared.stopCapture()
        #endif
        await webRTCClient.cleanup()
        
        state.participants.removeAll()
        state.displayNames.removeAll()
        state.pendingUsers.removeAll()
        state.chatMessages.removeAll()
        state.activeReactions.removeAll()
        state.isHandRaised = false
        state.isScreenSharing = false
        state.activeScreenShareUserId = nil
        state.activeSpeakerId = nil
        state.unreadChatCount = 0
        state.waitingMessage = nil
        state.isAdmin = false
        lastJoinContext = nil
    }
    
    func resetError() {
        state.connectionState = ConnectionState.disconnected
        state.errorMessage = nil
        state.waitingMessage = nil
    }
    
    // MARK: - Media Controls
    
    func toggleMute() {
        let newState = !state.isMuted
        state.isMuted = newState
        #if !SKIP
        HapticManager.shared.trigger(.light)
        #endif
        Task {
            if newState {
                // Muting - just pause the producer
                await webRTCClient.setAudioEnabled(false)
            } else {
                // Unmuting
                if webRTCClient.localAudioEnabled {
                    await webRTCClient.setAudioEnabled(true)
                } else {
                    // Start producing audio for the first time
                    do {
                        try await webRTCClient.startProducingAudio()
                    } catch {
                        state.isMuted = true // Revert on failure
                        state.errorMessage = error.localizedDescription
                    }
                }
            }
        }
    }
    
    func toggleCamera() {
        let newState = !state.isCameraOff
        state.isCameraOff = newState
        #if !SKIP
        HapticManager.shared.trigger(.light)
        #endif
        Task {
            if newState {
                // Turning off camera
                await webRTCClient.setVideoEnabled(false)
            } else {
                // Turning on camera
                if webRTCClient.localVideoEnabled {
                    await webRTCClient.setVideoEnabled(true)
                } else {
                    // Start producing video for the first time
                    do {
                        try await webRTCClient.startProducingVideo()
                    } catch {
                        state.isCameraOff = true // Revert on failure
                        state.errorMessage = error.localizedDescription
                    }
                }
            }
        }
    }
    
    func toggleScreenShare() {
        #if canImport(UIKit) && !SKIP
        Task {
            do {
                if state.isScreenSharing {
                    // Stop screen sharing
                    await ScreenCaptureManager.shared.stopCapture()
                    await webRTCClient.stopScreenSharing()
                    state.isScreenSharing = false
                    if state.activeScreenShareUserId == state.userId {
                        state.activeScreenShareUserId = nil
                    }
                    debugLog("[Meeting] Screen sharing stopped")
                } else {
                    try await webRTCClient.startScreenSharing()
                    // Start screen sharing
                    try await ScreenCaptureManager.shared.startCapture(webRTCClient: webRTCClient)
                    state.isScreenSharing = true
                    state.activeScreenShareUserId = state.userId
                    debugLog("[Meeting] Screen sharing started")
                }
            } catch {
                await ScreenCaptureManager.shared.stopCapture()
                await webRTCClient.stopScreenSharing()
                state.isScreenSharing = false
                state.activeScreenShareUserId = nil
                state.errorMessage = "Failed to toggle screen sharing: \(error.localizedDescription)"
                debugLog("[Meeting] Screen sharing error: \(error)")
            }
        }
        #else
        debugLog("[Meeting] Screen sharing not supported on this platform")
        #endif
    }
    
    func toggleHandRaise() {
        let newState = !state.isHandRaised
        #if !SKIP
        HapticManager.shared.trigger(.medium)
        #endif
        Task {
            do {
                try await socketManager.setHandRaised(newState)
                state.isHandRaised = newState
            } catch {
                state.errorMessage = error.localizedDescription
            }
        }
    }
    
    func setVideoQuality(_ quality: VideoQuality) {
        state.videoQuality = quality
        webRTCClient.updateVideoQuality(quality)
    }
    
    // MARK: - Chat Commands
    
    func executeChatCommand(_ parsedCommand: ParsedCommand) {
        #if !SKIP
        HapticManager.shared.trigger(.medium)
        #endif
        
        Task {
            do {
                switch parsedCommand.command {
                case .raise:
                    if !state.isHandRaised {
                        try await socketManager.setHandRaised(true)
                        state.isHandRaised = true
                        addSystemMessage(.commandExecuted(command: .raise, userName: state.displayName))
                    }
                    
                case .lower:
                    if state.isHandRaised {
                        try await socketManager.setHandRaised(false)
                        state.isHandRaised = false
                        addSystemMessage(.commandExecuted(command: .lower, userName: state.displayName))
                    }
                    
                case .mute:
                    if !state.isMuted {
                        await setMuted(true)
                        addSystemMessage(.commandExecuted(command: .mute, userName: state.displayName))
                    }
                    
                case .unmute:
                    if state.isMuted {
                        await setMuted(false)
                        addSystemMessage(.commandExecuted(command: .unmute, userName: state.displayName))
                    }
                    
                case .cameraOn:
                    if state.isCameraOff {
                        await setCameraOff(false)
                        addSystemMessage(.commandExecuted(command: .cameraOn, userName: state.displayName))
                    }
                    
                case .cameraOff:
                    if !state.isCameraOff {
                        await setCameraOff(true)
                        addSystemMessage(.commandExecuted(command: .cameraOff, userName: state.displayName))
                    }
                }
            } catch {
                addSystemMessage(.commandFailed(command: parsedCommand.command, reason: error.localizedDescription))
            }
        }
    }
    
    private func addSystemMessage(_ type: SystemMessageType) {
        let message = SystemMessage(type: type)
        state.systemMessages.append(message)
    }
    
    private func setMuted(_ muted: Bool) async {
        state.isMuted = muted
        if muted {
            await webRTCClient.setAudioEnabled(false)
        } else {
            if webRTCClient.localAudioEnabled {
                await webRTCClient.setAudioEnabled(true)
            } else {
                do {
                    try await webRTCClient.startProducingAudio()
                } catch {
                    state.isMuted = true
                    state.errorMessage = error.localizedDescription
                }
            }
        }
    }
    
    private func setCameraOff(_ cameraOff: Bool) async {
        state.isCameraOff = cameraOff
        if cameraOff {
            await webRTCClient.setVideoEnabled(false)
        } else {
            if webRTCClient.localVideoEnabled {
                await webRTCClient.setVideoEnabled(true)
            } else {
                do {
                    try await webRTCClient.startProducingVideo()
                } catch {
                    state.isCameraOff = true
                    state.errorMessage = error.localizedDescription
                }
            }
        }
    }
    
    // MARK: - Chat
    
    func sendChatMessage(_ content: String) {
        guard !content.isEmpty else { return }
        if state.isChatLocked && !state.isAdmin {
            state.errorMessage = "Chat is locked by the host."
            return
        }
        
        // Check if it's a command
        if let parsedCommand = ChatCommandParser.parse(content) {
            executeChatCommand(parsedCommand)
            return
        }
        
        #if !SKIP
        HapticManager.shared.trigger(.light)
        #endif
        Task {
            do {
                try await socketManager.sendChat(content: content)

                // Add locally for immediate feedback
                let message = ChatMessage(
                    userId: state.userId,
                    displayName: state.displayName.isEmpty ? "You" : state.displayName,
                    content: content
                )
                state.chatMessages.append(message)

            } catch {
                state.errorMessage = "Failed to send message"
            }
        }
    }
    
    func toggleChat() {
        state.isChatOpen = !state.isChatOpen
        if state.isChatOpen {
            state.unreadChatCount = 0
        }
    }
    
    // MARK: - Reactions
    
    func sendReaction(emoji: String) {
        #if !SKIP
        HapticManager.shared.trigger(.medium)
        #endif
        Task {
            do {
                try await socketManager.sendReaction(emoji: emoji, kind: "emoji", value: emoji, label: nil)

                let reaction = Reaction(userId: state.userId, kind: .emoji, value: emoji)
                handleReaction(reaction)

            } catch {
            }
        }
    }
    
    // MARK: - Admin Actions
    
    func updateDisplayName(_ name: String) {
        guard state.isAdmin else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        
        Task {
            do {
                try await socketManager.updateDisplayName(trimmed)
                state.displayName = trimmed
            } catch {
                state.errorMessage = error.localizedDescription
            }
        }
    }

    func toggleRoomLock() {
        guard state.isAdmin else { return }
        
        Task {
            do {
                let nextLocked = !state.isRoomLocked
                try await socketManager.lockRoom(nextLocked)
                state.isRoomLocked = nextLocked
            } catch {
                state.errorMessage = error.localizedDescription
            }
        }
    }

    func toggleChatLock() {
        guard state.isAdmin else { return }

        Task {
            do {
                let nextLocked = !state.isChatLocked
                try await socketManager.lockChat(nextLocked)
                state.isChatLocked = nextLocked
            } catch {
                state.errorMessage = error.localizedDescription
            }
        }
    }
    
    func admitUser(userId: String) {
        guard state.isAdmin else { return }
        
        Task {
            do {
                try await socketManager.admitUser(userId: userId)
                state.pendingUsers.removeValue(forKey: userId)
            } catch {
                state.errorMessage = error.localizedDescription
            }
        }
    }
    
    func removeUser(userId: String) {
        guard state.isAdmin else { return }
        
        Task {
            do {
                if state.pendingUsers[userId] != nil {
                    state.pendingUsers.removeValue(forKey: userId)
                    try await socketManager.rejectUser(userId: userId)
                } else {
                    try await socketManager.kickUser(userId: userId)
                }
            } catch {
                state.errorMessage = error.localizedDescription
            }
        }
    }
}

#if !SKIP
extension MeetingViewModel: ObservableObject {}
#endif
