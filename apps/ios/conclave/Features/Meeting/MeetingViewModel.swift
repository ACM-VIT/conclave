//
//  MeetingViewModel.swift
//  Conclave
//
//  Production ViewModel with WebRTC integration
//

import Foundation
import Combine
import AVFoundation

@MainActor
final class MeetingViewModel: ObservableObject {
    
    // MARK: - Connection State
    
    @Published var connectionState: ConnectionState = .disconnected
    @Published var errorMessage: String?
    @Published var waitingMessage: String?
    
    // MARK: - Room State
    
    @Published var roomId: String = ""
    @Published var isRoomLocked: Bool = false
    @Published var isChatLocked: Bool = false
    
    // MARK: - User State
    
    @Published var userId: String
    @Published var sessionId: String
    @Published var displayName: String = ""
    @Published var isAdmin: Bool = false
    @Published var isGhostMode: Bool = false
    
    // MARK: - Participants
    
    @Published private(set) var participants: [String: Participant] = [:]
    @Published private(set) var displayNames: [String: String] = [:]
    @Published private(set) var pendingUsers: [String: String] = [:]
    
    // MARK: - Media State
    
    @Published var isMuted: Bool = true
    @Published var isCameraOff: Bool = true
    @Published var isScreenSharing: Bool = false
    @Published var isHandRaised: Bool = false
    @Published var videoQuality: VideoQuality = .standard
    
    // MARK: - Active States
    
    @Published var activeScreenShareUserId: String?
    @Published var activeSpeakerId: String?
    
    // MARK: - Chat
    
    @Published private(set) var chatMessages: [ChatMessage] = []
    @Published var unreadChatCount: Int = 0
    @Published var isChatOpen: Bool = false
    
    // MARK: - Reactions
    
    @Published private(set) var activeReactions: [Reaction] = []
    private var reactionLaneCounter = 0
    
    // MARK: - Managers
    
    private let socketManager = SocketIOManager()
    let webRTCClient = WebRTCClient()
    private var cancellables = Set<AnyCancellable>()
    private var lastJoinContext: JoinContext?
    private var shouldRejoinAfterReconnect = false
    private var isIntentionalLeave = false
    private var isRejoinInFlight = false

    private struct JoinContext {
        let roomId: String
        let displayName: String
        let isGhost: Bool
        let isHost: Bool
        let user: SfuJoinUser?
    }
    
    // MARK: - Computed Properties
    
    var sortedParticipants: [Participant] {
        participants.values.sorted { p1, p2 in
            if p1.isHandRaised != p2.isHandRaised {
                return p1.isHandRaised
            }
            return p1.id < p2.id
        }
    }
    
    var participantCount: Int {
        participants.count + 1
    }
    
    var pendingUsersCount: Int {
        pendingUsers.count
    }
    
    var hasActiveScreenShare: Bool {
        activeScreenShareUserId != nil
    }

    var isScreenShareSupported: Bool {
        false
    }
    
    func displayName(for id: String) -> String {
        if id == userId {
            return displayName.isEmpty ? "You" : displayName
        }
        return displayNames[id] ?? "Guest"
    }
    
    // MARK: - Init
    
    init() {
        self.userId = UUID().uuidString
        self.sessionId = UUID().uuidString
        setupSocketBindings()
        setupWebRTCBindings()
    }
    
    // MARK: - Socket Bindings
    
    private func setupSocketBindings() {
        socketManager.onConnected = { [weak self] in
            Task { @MainActor in
                self?.connectionState = .connected
            }
        }
        
        socketManager.onDisconnected = { [weak self] reason in
            Task { @MainActor in
                guard let self = self else { return }
                if self.isIntentionalLeave {
                    self.connectionState = .disconnected
                    return
                }
                self.connectionState = .reconnecting
                self.shouldRejoinAfterReconnect = true
                if let reason = reason {
                    self.errorMessage = reason
                }
            }
        }
        
        socketManager.onError = { [weak self] error in
            Task { @MainActor in
                self?.errorMessage = error.localizedDescription
            }
        }

        socketManager.onReconnecting = { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                if !self.isIntentionalLeave {
                    self.connectionState = .reconnecting
                }
            }
        }

        socketManager.onReconnected = { [weak self] in
            Task { [weak self] in
                await self?.rejoinIfPossible()
            }
        }

        socketManager.onReconnectFailed = { [weak self] in
            Task { [weak self] in
                await self?.forceRejoinWithFreshToken()
            }
        }
        
        socketManager.onJoinedRoom = { [weak self] response in
            Task { @MainActor in
                guard let self = self else { return }
                
                self.connectionState = .joined
                self.waitingMessage = nil
                
                // Configure WebRTC with server capabilities
                self.webRTCClient.configure(
                    socketManager: self.socketManager,
                    rtpCapabilities: response.rtpCapabilities
                )
                
                // Create transports
                do {
                    try await self.webRTCClient.createTransports()
                    
                    // Start producing if not ghost
                    if !self.isGhostMode {
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
                    self.errorMessage = error.localizedDescription
                }
            }
        }
        
        socketManager.onWaitingForAdmission = { [weak self] in
            Task { @MainActor in
                self?.connectionState = .waiting
            }
        }
        
        socketManager.onWaitingRoomStatus = { [weak self] message in
            Task { @MainActor in
                self?.waitingMessage = message
            }
        }
        
        socketManager.onJoinApproved = { [weak self] in
            Task { @MainActor in
                self?.connectionState = .joining
            }
            Task { [weak self] in
                await self?.rejoinIfPossible()
            }
        }
        
        socketManager.onJoinRejected = { [weak self] in
            Task { @MainActor in
                self?.connectionState = .error
                self?.errorMessage = "The host has denied your request to join."
                await self?.cleanup()
            }
        }
        
        socketManager.onHostAssigned = { [weak self] in
            Task { @MainActor in
                self?.isAdmin = true
            }
        }
        
        socketManager.onKicked = { [weak self] reason in
            Task { @MainActor in
                self?.connectionState = .disconnected
                self?.errorMessage = reason ?? "You were removed from the meeting"
                await self?.cleanup()
            }
        }
        
        socketManager.onUserJoined = { [weak self] notification in
            Task { @MainActor in
                guard let self = self else { return }
                let userId = notification.userId
                if self.participants[userId] == nil {
                    self.participants[userId] = Participant(id: userId)
                }
                if let displayName = notification.displayName, !displayName.isEmpty {
                    self.displayNames[userId] = displayName
                }
                if let isGhost = notification.isGhost {
                    self.participants[userId]?.isGhost = isGhost
                }
            }
        }
        
        socketManager.onUserLeft = { [weak self] userId in
            Task { @MainActor in
                guard let self = self else { return }
                
                // Mark as leaving for animation
                self.participants[userId]?.isLeaving = true
                
                // Remove after animation delay
                try? await Task.sleep(nanoseconds: 200_000_000)
                self.participants.removeValue(forKey: userId)
                self.displayNames.removeValue(forKey: userId)
                
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
                        if user.userId == self.userId {
                            self.displayName = displayName
                        }
                    }
                }
                self.displayNames = next
            }
        }
        
        socketManager.onDisplayNameUpdated = { [weak self] update in
            Task { @MainActor in
                self?.displayNames[update.userId] = update.displayName
                if update.userId == self?.userId {
                    self?.displayName = update.displayName
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
                
                if let userId, self.activeScreenShareUserId == userId {
                    self.activeScreenShareUserId = nil
                }
                
                self.webRTCClient.closeConsumer(producerId: producerId, userId: userId ?? "")
            }
        }
        
        socketManager.onChatMessage = { [weak self] message in
            Task { @MainActor in
                self?.chatMessages.append(message)
                if !(self?.isChatOpen ?? false) {
                    self?.unreadChatCount += 1
                }
            }
        }
        
        socketManager.onReaction = { [weak self] reaction in
            Task { @MainActor in
                self?.handleReaction(reaction)
            }
        }
        
        socketManager.onHandRaised = { [weak self] userId, raised in
            Task { @MainActor in
                self?.participants[userId]?.isHandRaised = raised
                if userId == self?.userId {
                    self?.isHandRaised = raised
                }
            }
        }
        
        socketManager.onHandRaisedSnapshot = { [weak self] snapshot in
            Task { @MainActor in
                guard let self = self else { return }
                for entry in snapshot.users {
                    if entry.userId == self.userId {
                        self.isHandRaised = entry.raised
                    } else {
                        if self.participants[entry.userId] == nil {
                            self.participants[entry.userId] = Participant(id: entry.userId)
                        }
                        self.participants[entry.userId]?.isHandRaised = entry.raised
                    }
                }
            }
        }
        
        socketManager.onParticipantMuted = { [weak self] notification in
            Task { @MainActor in
                guard let self = self else { return }
                if self.participants[notification.userId] == nil {
                    self.participants[notification.userId] = Participant(id: notification.userId)
                }
                self.participants[notification.userId]?.isMuted = notification.muted
            }
        }

        socketManager.onParticipantCameraOff = { [weak self] notification in
            Task { @MainActor in
                guard let self = self else { return }
                if self.participants[notification.userId] == nil {
                    self.participants[notification.userId] = Participant(id: notification.userId)
                }
                self.participants[notification.userId]?.isCameraOff = notification.cameraOff
            }
        }
        
        socketManager.onRoomLockChanged = { [weak self] locked in
            Task { @MainActor in
                self?.isRoomLocked = locked
            }
        }

        socketManager.onChatLockChanged = { [weak self] locked in
            Task { @MainActor in
                self?.isChatLocked = locked
            }
        }
        
        socketManager.onUserRequestedJoin = { [weak self] notification in
            Task { @MainActor in
                self?.pendingUsers[notification.userId] = notification.displayName
            }
        }
        
        socketManager.onPendingUsersSnapshot = { [weak self] snapshot in
            Task { @MainActor in
                guard let self = self else { return }
                var next: [String: String] = [:]
                for user in snapshot.users {
                    next[user.userId] = user.displayName ?? user.userId
                }
                self.pendingUsers = next
            }
        }
        
        socketManager.onPendingUserChanged = { [weak self] notification in
            Task { @MainActor in
                self?.pendingUsers.removeValue(forKey: notification.userId)
            }
        }
        
        socketManager.onSetVideoQuality = { [weak self] notification in
            Task { @MainActor in
                self?.videoQuality = notification.quality
                self?.webRTCClient.updateVideoQuality(notification.quality)
            }
        }
        
        socketManager.onRedirect = { [weak self] notification in
            Task { @MainActor in
                self?.connectionState = .error
                self?.errorMessage = "You were redirected to another room: \(notification.newRoomId)"
                await self?.cleanup()
            }
        }
    }
    
    // MARK: - WebRTC Bindings
    
    private func setupWebRTCBindings() {
        // Observe local video state changes
        webRTCClient.$localVideoEnabled
            .receive(on: DispatchQueue.main)
            .sink { [weak self] enabled in
                self?.isCameraOff = !enabled
            }
            .store(in: &cancellables)
        
        webRTCClient.$localAudioEnabled
            .receive(on: DispatchQueue.main)
            .sink { [weak self] enabled in
                self?.isMuted = !enabled
            }
            .store(in: &cancellables)
    }
    
    // MARK: - Helper Methods
    
    private func handleProducerState(_ producer: ProducerInfo) {
        // Ensure participant exists
        if participants[producer.producerUserId] == nil {
            participants[producer.producerUserId] = Participant(id: producer.producerUserId)
        }
        
        if producer.kind == "audio" {
            participants[producer.producerUserId]?.isMuted = producer.paused ?? false
        } else if producer.kind == "video" {
            if producer.type == "screen" {
                participants[producer.producerUserId]?.isScreenSharing = true
                activeScreenShareUserId = producer.producerUserId
            } else {
                participants[producer.producerUserId]?.isCameraOff = producer.paused ?? false
            }
        }
    }
    
    private func handleReaction(_ reaction: Reaction) {
        var newReaction = reaction
        newReaction.lane = reactionLaneCounter % 5
        reactionLaneCounter += 1
        
        activeReactions.append(newReaction)
        
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            await MainActor.run {
                self.activeReactions.removeAll { $0.id == reaction.id }
            }
        }
    }
    
    // MARK: - Room Actions
    
    func joinRoom(roomId: String, displayName: String, isGhost: Bool = false, user: SfuJoinUser? = nil, isHost: Bool = false) {
        self.roomId = roomId
        self.displayName = displayName
        self.isGhostMode = isGhost
        self.isAdmin = isHost
        self.waitingMessage = nil
        self.isIntentionalLeave = false
        self.shouldRejoinAfterReconnect = false
        
        let userPayload = user
        let userKey = user?.email ?? user?.id ?? "guest-\(sessionId)"
        self.userId = "\(userKey)#\(sessionId)"
        self.lastJoinContext = JoinContext(
            roomId: roomId,
            displayName: displayName,
            isGhost: isGhost,
            isHost: isHost,
            user: userPayload
        )
        
        connectionState = .connecting
        
        Task {
            do {
                let clientId = SfuJoinService.resolveClientId()
                let joinInfo = try await SfuJoinService.fetchJoinInfo(
                    roomId: roomId,
                    sessionId: sessionId,
                    user: userPayload,
                    isHost: isHost,
                    clientId: clientId
                )
                let sfuUrl = joinInfo.sfuUrl
                let token = joinInfo.token

                try await socketManager.connect(sfuURL: sfuUrl, token: token)
                
                let response = try await socketManager.joinRoom(
                    roomId: roomId,
                    sessionId: sessionId,
                    displayName: displayName,
                    isGhost: isGhost
                )
                
                if response.status == "waiting" {
                    connectionState = .waiting
                }
                // If status is nil or "joined", the onJoinedRoom callback handles it
                
            } catch {
                connectionState = .error
                errorMessage = error.localizedDescription
            }
        }
    }

    private func rejoinIfPossible() async {
        guard let context = lastJoinContext, shouldRejoinAfterReconnect, !isIntentionalLeave else { return }
        if isRejoinInFlight { return }
        isRejoinInFlight = true
        shouldRejoinAfterReconnect = false
        await MainActor.run {
            self.connectionState = .joining
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

    private func forceRejoinWithFreshToken() async {
        guard !isIntentionalLeave else { return }
        shouldRejoinAfterReconnect = true
        socketManager.disconnect()
        await rejoinIfPossible()
    }
    
    private func startProducing() async {
        // Start audio first (usually faster)
        if !isMuted {
            do {
                try await webRTCClient.startProducingAudio()
            } catch {
                debugLog("[Meeting] Failed to start audio: \(error)")
            }
        }
        
        // Start video if enabled
        if !isCameraOff {
            do {
                try await webRTCClient.startProducingVideo()
            } catch {
                debugLog("[Meeting] Failed to start video: \(error)")
            }
        }
    }
    
    func leaveRoom() {
        Task {
            isIntentionalLeave = true
            shouldRejoinAfterReconnect = false
            await cleanup()
            socketManager.disconnect()
            connectionState = .disconnected
        }
    }
    
    private func cleanup() async {
        await webRTCClient.cleanup()
        
        participants.removeAll()
        displayNames.removeAll()
        pendingUsers.removeAll()
        chatMessages.removeAll()
        activeReactions.removeAll()
        isHandRaised = false
        isScreenSharing = false
        activeScreenShareUserId = nil
        activeSpeakerId = nil
        unreadChatCount = 0
        waitingMessage = nil
        isAdmin = false
        lastJoinContext = nil
    }
    
    func resetError() {
        connectionState = .disconnected
        errorMessage = nil
        waitingMessage = nil
    }
    
    // MARK: - Media Controls
    
    func toggleMute() {
        let newState = !isMuted
        isMuted = newState
        
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
                        isMuted = true // Revert on failure
                        errorMessage = error.localizedDescription
                    }
                }
            }
        }
    }
    
    func toggleCamera() {
        let newState = !isCameraOff
        isCameraOff = newState
        
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
                        isCameraOff = true // Revert on failure
                        errorMessage = error.localizedDescription
                    }
                }
            }
        }
    }
    
    func toggleScreenShare() {
        // iOS screen sharing requires ReplayKit Broadcast Extension
        // This is a significant feature that requires:
        // 1. A separate Broadcast Upload Extension target
        // 2. App Groups for communication between app and extension
        // 3. ReplayKit permission handling
        debugLog("[Meeting] Screen sharing requires ReplayKit Broadcast Extension - not yet implemented")
    }
    
    func toggleHandRaise() {
        let newState = !isHandRaised
        
        Task {
            do {
                try await socketManager.setHandRaised(newState)
                isHandRaised = newState
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    func setVideoQuality(_ quality: VideoQuality) {
        videoQuality = quality
        webRTCClient.updateVideoQuality(quality)
    }
    
    // MARK: - Chat
    
    func sendChatMessage(_ content: String) {
        guard !content.isEmpty else { return }
        if isChatLocked && !isAdmin {
            errorMessage = "Chat is locked by the host."
            return
        }
        
        Task {
            do {
                try await socketManager.sendChat(content: content)
                
                // Add locally for immediate feedback
                let message = ChatMessage(
                    userId: userId,
                    displayName: displayName.isEmpty ? "You" : displayName,
                    content: content
                )
                chatMessages.append(message)
                
            } catch {
                errorMessage = "Failed to send message"
            }
        }
    }
    
    func toggleChat() {
        isChatOpen.toggle()
        if isChatOpen {
            unreadChatCount = 0
        }
    }
    
    // MARK: - Reactions
    
    func sendReaction(emoji: String) {
        Task {
            do {
                try await socketManager.sendReaction(emoji: emoji, kind: "emoji", value: emoji, label: nil)
                
                let reaction = Reaction(userId: userId, kind: .emoji, value: emoji)
                handleReaction(reaction)
                
            } catch {
            }
        }
    }
    
    // MARK: - Admin Actions
    
    func updateDisplayName(_ name: String) {
        guard isAdmin else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        
        Task {
            do {
                try await socketManager.updateDisplayName(trimmed)
                displayName = trimmed
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func toggleRoomLock() {
        guard isAdmin else { return }
        
        Task {
            do {
                let nextLocked = !isRoomLocked
                try await socketManager.lockRoom(nextLocked)
                isRoomLocked = nextLocked
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func toggleChatLock() {
        guard isAdmin else { return }

        Task {
            do {
                let nextLocked = !isChatLocked
                try await socketManager.lockChat(nextLocked)
                isChatLocked = nextLocked
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    func admitUser(userId: String) {
        guard isAdmin else { return }
        
        Task {
            do {
                try await socketManager.admitUser(userId: userId)
                pendingUsers.removeValue(forKey: userId)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    func removeUser(userId: String) {
        guard isAdmin else { return }
        
        Task {
            do {
                if pendingUsers[userId] != nil {
                    pendingUsers.removeValue(forKey: userId)
                    try await socketManager.rejectUser(userId: userId)
                } else {
                    try await socketManager.kickUser(userId: userId)
                }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
