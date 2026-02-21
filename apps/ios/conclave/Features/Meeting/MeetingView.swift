//
//  MeetingView.swift
//  Conclave
//
//  Main meeting view matching web app exactly
//

import SwiftUI

struct MeetingView: View {
    @ObservedObject var viewModel: MeetingViewModel
    @State private var showParticipantsSheet = false
    @State private var showSettingsSheet = false
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                ACMColors.dark
                    .ignoresSafeArea()

                VStack(spacing: 0) {
                    MeetingHeaderView(
                        roomId: viewModel.roomId,
                        isRoomLocked: viewModel.isRoomLocked,
                        participantCount: viewModel.participantCount,
                        onParticipantsPressed: { showParticipantsSheet = true }
                    )

                    if viewModel.hasActiveScreenShare {
                        PresentationLayoutView(viewModel: viewModel)
                    } else {
                        GridLayoutView(viewModel: viewModel, containerSize: geometry.size)
                    }

                    Spacer(minLength: 0)
                }

                VStack {
                    Spacer()

                    ZStack(alignment: .bottom) {
                        LinearGradient(
                            colors: [Color.black.opacity(0.0), Color.black.opacity(0.95)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                        .frame(height: 120)
                        .allowsHitTesting(false)

                        ControlsBarView(
                            viewModel: viewModel,
                            availableWidth: geometry.size.width,
                            onParticipantsPressed: { showParticipantsSheet = true },
                            onSettingsPressed: { showSettingsSheet = true }
                        )
                        .padding(.bottom, max(12, geometry.safeAreaInsets.bottom))
                    }
                    .frame(maxWidth: .infinity)
                }

                if viewModel.isChatOpen {
                    HStack {
                        Spacer()

                        ChatOverlayView(viewModel: viewModel)
                            .frame(width: min(340, geometry.size.width * 0.85))
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                    }
                }

                ReactionOverlayView(reactions: viewModel.activeReactions)
            }
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showParticipantsSheet) {
            ParticipantsSheetView(viewModel: viewModel)
        }
        .sheet(isPresented: $showSettingsSheet) {
            SettingsSheetView(viewModel: viewModel)
        }
        .animation(.easeInOut(duration: 0.25), value: viewModel.isChatOpen)
    }
}

// MARK: - Meeting Header

struct MeetingHeaderView: View {
    let roomId: String
    let isRoomLocked: Bool
    let participantCount: Int
    let onParticipantsPressed: () -> Void
    
    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 6) {
                if isRoomLocked {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(.orange)
                }
                
                Text(roomId.uppercased())
                    .font(ACMFont.mono(12))
                    .foregroundStyle(ACMColors.cream)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.black.opacity(0.5))
            .background(.ultraThinMaterial.opacity(0.3))
            .overlay(
                Capsule().strokeBorder(ACMColors.creamFaint, lineWidth: 1)
            )
            .clipShape(Capsule())
            
            Spacer()
            
            Button(action: onParticipantsPressed) {
                HStack(spacing: 4) {
                    Image(systemName: "person.2.fill")
                        .font(.system(size: 12))
                    
                    Text("\(participantCount)")
                        .font(ACMFont.mono(12))
                }
                .foregroundStyle(ACMColors.cream)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.black.opacity(0.5))
                .background(.ultraThinMaterial.opacity(0.3))
                .overlay(
                    Capsule().strokeBorder(ACMColors.creamFaint, lineWidth: 1)
                )
                .clipShape(Capsule())
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

// MARK: - Grid Layout

struct GridLayoutView: View {
    @ObservedObject var viewModel: MeetingViewModel
    let containerSize: CGSize
    
    private var columns: [GridItem] {
        let count = viewModel.participantCount
        let columnCount: Int
        
        switch count {
        case 1: columnCount = 1
        case 2: columnCount = 2
        case 3: columnCount = 3
        case 4: columnCount = 2
        case 5...6: columnCount = 3
        case 7...9: columnCount = 3
        case 10...12: columnCount = 4
        default: columnCount = 4
        }
        
        return Array(repeating: GridItem(.flexible(), spacing: 12), count: columnCount)
    }
    
    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 12) {
                VideoGridItem(
                    displayName: viewModel.displayName,
                    isMuted: viewModel.isMuted,
                    isCameraOff: viewModel.isCameraOff,
                    isHandRaised: viewModel.isHandRaised,
                    isGhost: viewModel.isGhostMode,
                    isSpeaking: viewModel.activeSpeakerId == viewModel.userId,
                    isLocal: true,
                    captureSession: viewModel.webRTCClient.getCaptureSession(),
                    localVideoTrack: viewModel.webRTCClient.getLocalVideoTrack()
                )
                
                ForEach(viewModel.sortedParticipants) { participant in
                    VideoGridItem(
                        displayName: viewModel.displayName(for: participant.id),
                        isMuted: participant.isMuted,
                        isCameraOff: participant.isCameraOff,
                        isHandRaised: participant.isHandRaised,
                        isGhost: participant.isGhost,
                        isSpeaking: viewModel.activeSpeakerId == participant.id,
                        isLocal: false,
                        trackWrapper: viewModel.webRTCClient.remoteVideoTracks[participant.id]
                    )
                    .opacity(participant.isLeaving ? 0.5 : 1)
                    .animation(.easeOut(duration: 0.2), value: participant.isLeaving)
                }
            }
            .padding(16)
        }
    }
}

// MARK: - Legacy Local Video Tile

struct LocalVideoTileView: View {
    let displayName: String
    let isMuted: Bool
    let isCameraOff: Bool
    let isHandRaised: Bool
    let isGhost: Bool
    let isSpeaking: Bool
    
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16)
                .fill(ACMGradients.cardBackground)
            
            if isCameraOff {
                VStack {
                    Circle()
                        .fill(ACMGradients.avatarBackground)
                        .frame(width: 64, height: 64)
                        .overlay(
                            Circle().strokeBorder(ACMColors.creamSubtle, lineWidth: 1)
                        )
                        .overlay {
                            Text(String(displayName.prefix(1)).uppercased())
                                .font(.system(size: 24, weight: .bold))
                                .foregroundStyle(ACMColors.cream)
                        }
                }
            } else {
                // TODO: Actual local video preview
                Color.black
            }
            
            if isGhost {
                ZStack {
                    Color.black.opacity(0.4)
                    
                    VStack(spacing: 8) {
                        Image(systemName: "theatermasks.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(ACMColors.primaryPink)
                            .shadow(color: ACMColors.primaryPink.opacity(0.5), radius: 16)
                        
                        Text("GHOST")
                            .font(ACMFont.mono(10))
                            .tracking(2)
                            .foregroundStyle(ACMColors.primaryPink)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 4)
                            .background(.black.opacity(0.6))
                            .overlay(
                                Capsule().strokeBorder(ACMColors.primaryPink.opacity(0.3), lineWidth: 1)
                            )
                            .clipShape(Capsule())
                    }
                }
            }
            
            if isHandRaised {
                VStack {
                    HStack {
                        Image(systemName: "hand.raised.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(Color.orange.opacity(0.9))
                            .padding(8)
                            .background(Color.orange.opacity(0.2))
                            .overlay(
                                Circle().strokeBorder(Color.orange.opacity(0.4), lineWidth: 1)
                            )
                            .clipShape(Circle())
                            .shadow(color: Color.orange.opacity(0.3), radius: 8)
                        
                        Spacer()
                    }
                    Spacer()
                }
                .padding(12)
            }
            
            VStack {
                Spacer()
                
                HStack {
                    HStack(spacing: 6) {
                        Text(displayName.uppercased())
                            .font(ACMFont.mono(11))
                            .foregroundStyle(ACMColors.cream)
                            .tracking(1)
                        
                        Text("YOU")
                            .font(ACMFont.mono(9))
                            .foregroundStyle(ACMColors.primaryOrange.opacity(0.6))
                            .tracking(2)
                        
                        if isMuted {
                            Image(systemName: "mic.slash.fill")
                                .font(.system(size: 10))
                                .foregroundStyle(ACMColors.primaryOrange)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.black.opacity(0.7))
                    .background(.ultraThinMaterial.opacity(0.3))
                    .overlay(
                        Capsule().strokeBorder(ACMColors.creamFaint, lineWidth: 1)
                    )
                    .clipShape(Capsule())
                    
                    Spacer()
                }
                .padding(12)
            }
        }
        .aspectRatio(16/9, contentMode: .fit)
        .acmVideoTile(isSpeaking: isSpeaking)
    }
}

// MARK: - Remote Video Tile

struct RemoteVideoTileView: View {
    let participant: Participant
    let displayName: String
    let isSpeaking: Bool
    
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16)
                .fill(ACMGradients.cardBackground)
            
            if participant.isCameraOff {
                VStack {
                    Circle()
                        .fill(ACMGradients.avatarBackground)
                        .frame(width: 64, height: 64)
                        .overlay(
                            Circle().strokeBorder(ACMColors.creamSubtle, lineWidth: 1)
                        )
                        .overlay {
                            Text(String(displayName.prefix(1)).uppercased())
                                .font(.system(size: 24, weight: .bold))
                                .foregroundStyle(ACMColors.cream)
                        }
                }
            } else {
                // TODO: Actual remote video
                Color.black
            }
            
            if participant.isGhost {
                ZStack {
                    Color.black.opacity(0.4)
                    
                    VStack(spacing: 8) {
                        Image(systemName: "theatermasks.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(ACMColors.primaryPink)
                            .shadow(color: ACMColors.primaryPink.opacity(0.5), radius: 16)
                        
                        Text("GHOST")
                            .font(ACMFont.mono(10))
                            .tracking(2)
                            .foregroundStyle(ACMColors.primaryPink)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 4)
                            .background(.black.opacity(0.6))
                            .overlay(
                                Capsule().strokeBorder(ACMColors.primaryPink.opacity(0.3), lineWidth: 1)
                            )
                            .clipShape(Capsule())
                    }
                }
            }
            
            if participant.isHandRaised {
                VStack {
                    HStack {
                        Image(systemName: "hand.raised.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(Color.orange.opacity(0.9))
                            .padding(8)
                            .background(Color.orange.opacity(0.2))
                            .overlay(
                                Circle().strokeBorder(Color.orange.opacity(0.4), lineWidth: 1)
                            )
                            .clipShape(Circle())
                            .shadow(color: Color.orange.opacity(0.3), radius: 8)
                        
                        Spacer()
                    }
                    Spacer()
                }
                .padding(12)
            }
            
            VStack {
                Spacer()
                
                HStack {
                    HStack(spacing: 6) {
                        Text(displayName.uppercased())
                            .font(ACMFont.mono(11))
                            .foregroundStyle(ACMColors.cream)
                            .tracking(1)
                        
                        if participant.isMuted {
                            Image(systemName: "mic.slash.fill")
                                .font(.system(size: 10))
                                .foregroundStyle(ACMColors.primaryOrange)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.black.opacity(0.7))
                    .background(.ultraThinMaterial.opacity(0.3))
                    .overlay(
                        Capsule().strokeBorder(ACMColors.creamFaint, lineWidth: 1)
                    )
                    .clipShape(Capsule())
                    
                    Spacer()
                }
                .padding(12)
            }
        }
        .aspectRatio(16/9, contentMode: .fit)
        .acmVideoTile(isSpeaking: isSpeaking)
        .opacity(participant.isLeaving ? 0.5 : 1)
        .animation(.easeOut(duration: 0.2), value: participant.isLeaving)
    }
}

// MARK: - Presentation Layout

struct PresentationLayoutView: View {
    @ObservedObject var viewModel: MeetingViewModel
    
    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.black)
                
                if let screenShareUserId = viewModel.activeScreenShareUserId {
                    if let trackWrapper = viewModel.webRTCClient.remoteVideoTracks["\(screenShareUserId)-screen"] {
                        RemoteVideoView(trackWrapper: trackWrapper)
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "rectangle.on.rectangle")
                                .font(.system(size: 48))
                                .foregroundStyle(ACMColors.cream.opacity(0.3))
                            
                            Text("\(viewModel.displayName(for: screenShareUserId)) is presenting")
                                .font(ACMFont.trial(14))
                                .foregroundStyle(ACMColors.cream.opacity(0.5))
                        }
                    }
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(ACMColors.creamFaint, lineWidth: 1)
            )
            
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 8) {
                    VideoGridItem(
                        displayName: viewModel.displayName,
                        isMuted: viewModel.isMuted,
                        isCameraOff: viewModel.isCameraOff,
                        isHandRaised: viewModel.isHandRaised,
                        isGhost: viewModel.isGhostMode,
                        isSpeaking: false,
                        isLocal: true,
                        captureSession: viewModel.webRTCClient.getCaptureSession()
                    )
                    .frame(width: 160, height: 90)
                    
                    ForEach(viewModel.sortedParticipants) { participant in
                        VideoGridItem(
                            displayName: viewModel.displayName(for: participant.id),
                            isMuted: participant.isMuted,
                            isCameraOff: participant.isCameraOff,
                            isHandRaised: participant.isHandRaised,
                            isGhost: participant.isGhost,
                            isSpeaking: viewModel.activeSpeakerId == participant.id,
                            isLocal: false,
                            trackWrapper: viewModel.webRTCClient.remoteVideoTracks[participant.id]
                        )
                        .frame(width: 160, height: 90)
                    }
                }
                .padding(8)
            }
            .frame(width: 176)
            .background(Color.black.opacity(0.5))
        }
        .padding(8)
    }
}

// MARK: - Controls Bar

struct ControlsBarView: View {
    @ObservedObject var viewModel: MeetingViewModel
    let availableWidth: CGFloat
    let onParticipantsPressed: () -> Void
    let onSettingsPressed: () -> Void
    @State private var showReactionPicker = false
    
    var body: some View {
        let isCompact = availableWidth < 420

        HStack(spacing: isCompact ? 12 : 4) {
            if !isCompact {
                ControlButton(
                    icon: "person.2.fill",
                    isActive: false,
                    badge: viewModel.pendingUsersCount > 0 ? viewModel.pendingUsersCount : nil
                ) {
                    onParticipantsPressed()
                }

                if viewModel.isAdmin {
                    ControlButton(
                        icon: viewModel.isRoomLocked ? "lock.fill" : "lock.open.fill",
                        isActive: viewModel.isRoomLocked,
                        activeColor: .yellow.opacity(0.9)
                    ) {
                        viewModel.toggleRoomLock()
                    }
                }
            }
            
            ControlButton(
                icon: viewModel.isMuted ? "mic.slash.fill" : "mic.fill",
                isMuted: viewModel.isMuted,
                isGhostDisabled: viewModel.isGhostMode
            ) {
                viewModel.toggleMute()
            }
            .disabled(viewModel.isGhostMode)
            
            ControlButton(
                icon: viewModel.isCameraOff ? "video.slash.fill" : "video.fill",
                isMuted: viewModel.isCameraOff,
                isGhostDisabled: viewModel.isGhostMode
            ) {
                viewModel.toggleCamera()
            }
            .disabled(viewModel.isGhostMode)
            
            if viewModel.isScreenShareSupported {
                ControlButton(
                    icon: "rectangle.on.rectangle",
                    isActive: viewModel.isScreenSharing,
                    isGhostDisabled: viewModel.isGhostMode
                ) {
                    viewModel.toggleScreenShare()
                }
                .disabled(viewModel.isGhostMode)
            }
            
            ControlButton(
                icon: "hand.raised.fill",
                isActive: viewModel.isHandRaised,
                activeColor: .yellow.opacity(0.9),
                isGhostDisabled: viewModel.isGhostMode
            ) {
                viewModel.toggleHandRaise()
            }
            .disabled(viewModel.isGhostMode)
            
            ZStack(alignment: .top) {
                ControlButton(
                    icon: "face.smiling",
                    isActive: showReactionPicker,
                    isGhostDisabled: viewModel.isGhostMode
                ) {
                    showReactionPicker.toggle()
                }
                .disabled(viewModel.isGhostMode)
                
                if showReactionPicker {
                    ReactionPickerView { emoji in
                        viewModel.sendReaction(emoji: emoji)
                        showReactionPicker = false
                    }
                    .offset(y: -60)
                }
            }
            
            ControlButton(
                icon: "message.fill",
                isActive: viewModel.isChatOpen,
                badge: viewModel.unreadChatCount > 0 ? viewModel.unreadChatCount : nil
            ) {
                viewModel.toggleChat()
            }

            ControlButton(
                icon: "gearshape.fill",
                isActive: false
            ) {
                onSettingsPressed()
            }
            
            Rectangle()
                .fill(ACMColors.creamFaint)
                .frame(width: 1, height: 24)
                .padding(.horizontal, isCompact ? 2 : 4)
            
            Button {
                viewModel.leaveRoom()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(.red.opacity(0.9))
                    .rotationEffect(.degrees(135))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(ACMControlButtonStyle(isDanger: true))
        }
        .frame(maxWidth: isCompact ? min(360, availableWidth - 24) : availableWidth - 24)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.black.opacity(0.4))
        .background(.ultraThinMaterial.opacity(0.3))
        .clipShape(Capsule())
        .padding(.horizontal)
    }
}

// MARK: - Control Button

struct ControlButton: View {
    let icon: String
    var isActive: Bool = false
    var isMuted: Bool = false
    var activeColor: Color = ACMColors.primaryOrange
    var isGhostDisabled: Bool = false
    var badge: Int? = nil
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                
                if let badge = badge {
                    Text(badge > 9 ? "9+" : "\(badge)")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(minWidth: 16, minHeight: 16)
                        .background(ACMColors.primaryOrange)
                        .clipShape(Circle())
                        .offset(x: 8, y: -8)
                }
            }
        }
        .buttonStyle(ACMControlButtonStyle(
            isActive: isActive,
            isMuted: isMuted,
            isGhostDisabled: isGhostDisabled,
            isHandRaised: activeColor == .yellow.opacity(0.9) && isActive
        ))
    }
}

// MARK: - Reaction Picker

struct ReactionPickerView: View {
    let onSelect: (String) -> Void
    
    private let reactions = ["👍", "👏", "❤️", "🎉", "😂", "😮", "😢", "🤔"]
    
    var body: some View {
        HStack(spacing: 4) {
            ForEach(reactions, id: \.self) { emoji in
                Button {
                    onSelect(emoji)
                } label: {
                    Text(emoji)
                        .font(.system(size: 20))
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.black.opacity(0.9))
        .background(.ultraThinMaterial)
        .clipShape(Capsule())
    }
}

// MARK: - Reaction Overlay

struct ReactionOverlayView: View {
    let reactions: [Reaction]
    
    var body: some View {
        GeometryReader { geometry in
            ForEach(reactions) { reaction in
                Text(reaction.value)
                    .font(.system(size: 32))
                    .position(
                        x: CGFloat(reaction.lane + 1) * (geometry.size.width / 6),
                        y: geometry.size.height - 150
                    )
                    .transition(.asymmetric(
                        insertion: .scale(scale: 0.8).combined(with: .opacity),
                        removal: .move(edge: .top).combined(with: .opacity)
                    ))
            }
        }
        .allowsHitTesting(false)
        .animation(.easeOut(duration: 0.3), value: reactions.count)
    }
}

// MARK: - Chat Overlay

struct ChatOverlayView: View {
    @ObservedObject var viewModel: MeetingViewModel
    @State private var messageText = ""
    @FocusState private var isInputFocused: Bool
    
    var body: some View {
        let isChatDisabled = viewModel.isChatLocked && !viewModel.isAdmin
        VStack(spacing: 0) {
            HStack {
                Text("Chat")
                    .font(ACMFont.trial(16, weight: .semibold))
                    .foregroundStyle(ACMColors.cream)
                
                Spacer()
                
                Button {
                    viewModel.toggleChat()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14))
                        .foregroundStyle(ACMColors.cream.opacity(0.5))
                }
            }
            .padding()
            .background(Color.black.opacity(0.8))
            
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(viewModel.chatMessages) { message in
                            ChatBubbleView(
                                message: message,
                                isFromCurrentUser: message.userId == viewModel.userId
                            )
                            .id(message.id)
                        }
                    }
                    .padding()
                }
                .onChange(of: viewModel.chatMessages.count) { _, _ in
                    if let lastMessage = viewModel.chatMessages.last {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(lastMessage.id, anchor: .bottom)
                        }
                    }
                }
            }
            
            HStack(spacing: 12) {
                TextField(isChatDisabled ? "Chat locked by host" : "Type a message...", text: $messageText)
                    .textFieldStyle(.plain)
                    .font(ACMFont.trial(14))
                    .foregroundStyle(ACMColors.cream)
                    .padding(12)
                    .background(ACMColors.surface)
                    .clipShape(Capsule())
                    .focused($isInputFocused)
                    .submitLabel(.send)
                    .onSubmit {
                        sendMessage()
                    }
                    .disabled(isChatDisabled)
                
                Button {
                    sendMessage()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(messageText.isEmpty ? ACMColors.cream.opacity(0.3) : ACMColors.primaryOrange)
                }
                .disabled(messageText.isEmpty || isChatDisabled)
            }
            .padding()
            .background(Color.black.opacity(0.8))
        }
        .background(Color(hex: "#141414"))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(ACMColors.creamFaint, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.5), radius: 20)
        .padding()
    }
    
    private func sendMessage() {
        let trimmed = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        viewModel.sendChatMessage(trimmed)
        messageText = ""
    }
}

// MARK: - Chat Bubble

struct ChatBubbleView: View {
    let message: ChatMessage
    let isFromCurrentUser: Bool
    
    var body: some View {
        VStack(alignment: isFromCurrentUser ? .trailing : .leading, spacing: 4) {
            if !isFromCurrentUser {
                Text(message.displayName)
                    .font(ACMFont.mono(10))
                    .foregroundStyle(ACMColors.primaryOrange)
                    .tracking(1)
            }
            
            Text(message.content)
                .font(ACMFont.trial(14))
                .foregroundStyle(isFromCurrentUser ? .white : ACMColors.cream)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    isFromCurrentUser
                        ? ACMColors.primaryOrange
                        : ACMColors.surface
                )
                .clipShape(RoundedRectangle(cornerRadius: 16))
            
            Text(message.timestamp, style: .time)
                .font(ACMFont.mono(9))
                .foregroundStyle(ACMColors.cream.opacity(0.3))
        }
        .frame(maxWidth: .infinity, alignment: isFromCurrentUser ? .trailing : .leading)
    }
}

// MARK: - Participants Sheet

struct ParticipantsSheetView: View {
    @ObservedObject var viewModel: MeetingViewModel
    @Environment(\.dismiss) var dismiss
    
    var body: some View {
        NavigationStack {
            List {
                if viewModel.isAdmin && viewModel.pendingUsersCount > 0 {
                    Section("Waiting to join") {
                        ForEach(viewModel.pendingUsers.sorted(by: { $0.value < $1.value }), id: \.key) { userId, name in
                            HStack {
                                Text(name)
                                    .font(ACMFont.trial(14, weight: .medium))
                                
                                Spacer()
                                
                                Button("Admit") {
                                    viewModel.admitUser(userId: userId)
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(ACMColors.primaryOrange)
                                
                                Button("Deny") {
                                    viewModel.removeUser(userId: userId)
                                }
                                .buttonStyle(.bordered)
                                .tint(.red)
                            }
                        }
                    }
                }
                
                Section {
                    HStack {
                        Circle()
                            .fill(ACMGradients.avatarBackground)
                            .frame(width: 40, height: 40)
                            .overlay {
                                Text(String(viewModel.displayName.prefix(1)).uppercased())
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(.white)
                            }
                        
                        VStack(alignment: .leading) {
                            HStack(spacing: 4) {
                                Text(viewModel.displayName)
                                    .font(ACMFont.trial(14, weight: .medium))
                                
                                Text("(You)")
                                    .font(ACMFont.trial(12))
                                    .foregroundStyle(.secondary)
                            }
                            
                            if viewModel.isAdmin {
                                Text("Host")
                                    .font(ACMFont.mono(10))
                                    .foregroundStyle(ACMColors.primaryOrange)
                            }
                        }
                        
                        Spacer()
                        
                        if viewModel.isHandRaised {
                            Text("✋")
                                .font(.system(size: 16))
                        }
                        
                        if viewModel.isMuted {
                            Image(systemName: "mic.slash.fill")
                                .font(.system(size: 12))
                                .foregroundStyle(.red)
                        }
                    }
                    
                    ForEach(viewModel.sortedParticipants) { participant in
                        HStack {
                            Circle()
                                .fill(ACMGradients.avatarBackground)
                                .frame(width: 40, height: 40)
                                .overlay {
                                    Text(String(viewModel.displayName(for: participant.id).prefix(1)).uppercased())
                                        .font(.system(size: 16, weight: .semibold))
                                        .foregroundStyle(.white)
                                }
                            
                            Text(viewModel.displayName(for: participant.id))
                                .font(ACMFont.trial(14, weight: .medium))
                            
                            if participant.isGhost {
                                Image(systemName: "theatermasks.fill")
                                    .font(.system(size: 12))
                                    .foregroundStyle(ACMColors.primaryPink)
                            }
                            
                            Spacer()
                            
                            if participant.isHandRaised {
                                Text("✋")
                                    .font(.system(size: 16))
                            }
                            
                            if participant.isMuted {
                                Image(systemName: "mic.slash.fill")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.red)
                            }
                        }
                    }
                } header: {
                    Text("In this meeting (\(viewModel.participantCount))")
                }
            }
            .navigationTitle("Participants")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Settings Sheet

struct SettingsSheetView: View {
    @ObservedObject var viewModel: MeetingViewModel
    @Environment(\.dismiss) var dismiss
    @State private var displayNameInput = ""
    
    var body: some View {
        NavigationStack {
            List {
                if viewModel.isAdmin {
                    Section("Room") {
                        Toggle("Lock room", isOn: Binding(
                            get: { viewModel.isRoomLocked },
                            set: { next in
                                if next != viewModel.isRoomLocked {
                                    viewModel.toggleRoomLock()
                                }
                            }
                        ))
                        Toggle("Lock chat", isOn: Binding(
                            get: { viewModel.isChatLocked },
                            set: { next in
                                if next != viewModel.isChatLocked {
                                    viewModel.toggleChatLock()
                                }
                            }
                        ))
                    }
                }

                if viewModel.isAdmin {
                    Section("Profile") {
                        TextField("Display name", text: $displayNameInput)
                            .textInputAutocapitalization(.words)
                            .disableAutocorrection(true)
                            .onAppear {
                                displayNameInput = viewModel.displayName
                            }
                        
                        Button("Update Display Name") {
                            viewModel.updateDisplayName(displayNameInput)
                        }
                        .disabled(displayNameInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                
                Section("Video") {
                    Picker("Quality", selection: $viewModel.videoQuality) {
                        Text("Standard").tag(VideoQuality.standard)
                        Text("Low (Save data)").tag(VideoQuality.low)
                    }
                }
                
                Section("Audio") {
                    Text("Audio output settings")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

#Preview {
    MeetingView(viewModel: MeetingViewModel())
}
