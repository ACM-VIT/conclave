//
//  MeetingView.swift
//  Conclave
//
//  Main meeting view matching web app exactly
//

import SwiftUI
import Observation

struct MeetingView: View {
    @Bindable var viewModel: MeetingViewModel
    @State var showParticipantsSheet = false
    @State var showSettingsSheet = false

#if !os(macOS)
    @Environment(\.horizontalSizeClass) var horizontalSizeClass
#endif

    private var isRegularSizeClass: Bool {
#if os(macOS)
        return true
#else
        return horizontalSizeClass == UserInterfaceSizeClass.regular
#endif
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                ACMColors.dark
                    .ignoresSafeArea()

                ZStack {
                    VStack(spacing: 0) {
                        MeetingHeaderView(
                            roomId: viewModel.state.roomId,
                            isRoomLocked: viewModel.state.isRoomLocked,
                            participantCount: viewModel.state.participantCount,
                            onParticipantsPressed: { showParticipantsSheet = true }
                        )

                        if viewModel.state.hasActiveScreenShare {
                            PresentationLayoutView(viewModel: viewModel)
                        } else {
                            GridLayoutView(viewModel: viewModel, containerSize: geometry.size)
                        }

                        Spacer(minLength: 0)
                    }

                    VStack {
                        Spacer()

                        ZStack(alignment: .bottom) {
                            #if SKIP
                            LinearGradient(
                                colors: [acmColor01(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.0), acmColor01(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.95)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                            .frame(height: 120)
                            #else
                            LinearGradient(
                                colors: [acmColor01(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.0), acmColor01(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.95)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                            .frame(height: 120)
                            .allowsHitTesting(false)
                            #endif

                            ControlsBarView(
                                viewModel: viewModel,
                                availableWidth: geometry.size.width - geometry.safeAreaInsets.leading - geometry.safeAreaInsets.trailing,
                                onParticipantsPressed: { showParticipantsSheet = true },
                                onSettingsPressed: { showSettingsSheet = true }
                            )
                            .padding(.bottom, max(12.0, geometry.safeAreaInsets.bottom))
                        }
                        .frame(maxWidth: .infinity)
                    }

                    if viewModel.state.isChatOpen {
                        HStack {
                            Spacer()

                            ChatOverlayView(viewModel: viewModel)
                                .frame(width: isRegularSizeClass ? 380.0 : min(340.0, geometry.size.width * 0.85))
                                .transition(.move(edge: .trailing).combined(with: AnyTransition.opacity))
                        }
                    }

                    ReactionOverlayView(reactions: viewModel.state.activeReactions)
                }
                .padding(.leading, max(6.0, geometry.safeAreaInsets.leading))
                .padding(.trailing, max(6.0, geometry.safeAreaInsets.trailing))
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
        .animation(.easeInOut(duration: 0.25), value: viewModel.state.isChatOpen)
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
                    ACMSystemIcon.image("lock.fill", androidName: "Icons.Filled.Lock")
                        .font(.system(size: 12))
                        .foregroundStyle(ACMColors.primaryOrange)
                }
                
                Text(roomId.uppercased())
                    .font(ACMFont.mono(12))
                    .foregroundStyle(ACMColors.cream)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .acmColorBackground(ACMColors.overlay50)
            .acmMaterialBackground(opacity: 0.3)
            .overlay {
                Capsule()
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.creamFaint)
            }
            .clipShape(Capsule())
            
            Spacer()
            
            Button(action: onParticipantsPressed) {
                HStack(spacing: 4) {
                    ACMSystemIcon.image("person.2.fill", androidName: "Icons.Filled.Person")
                        .font(.system(size: 12))
                    
                    Text("\(participantCount)")
                        .font(ACMFont.mono(12))
                }
                .foregroundStyle(ACMColors.cream)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .acmColorBackground(ACMColors.overlay50)
                .acmMaterialBackground(opacity: 0.3)
                .overlay {
                    Capsule()
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.creamFaint)
                }
                .clipShape(Capsule())
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

// MARK: - Grid Layout

struct GridLayoutView: View {
    @Bindable var viewModel: MeetingViewModel
    let containerSize: CGSize
    
    var columns: [GridItem] {
        let count = viewModel.state.participantCount
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
                    displayName: viewModel.state.displayName,
                    isMuted: viewModel.state.isMuted,
                    isCameraOff: viewModel.state.isCameraOff,
                    isHandRaised: viewModel.state.isHandRaised,
                    isGhost: viewModel.state.isGhostMode,
                    isSpeaking: viewModel.state.activeSpeakerId == viewModel.state.userId,
                    isLocal: true,
                    captureSession: viewModel.webRTCClient.getCaptureSession(),
                    localVideoTrack: viewModel.webRTCClient.getLocalVideoTrack()
                )
                
                ForEach(viewModel.state.sortedParticipants) { participant in
                    VideoGridItem(
                        displayName: viewModel.displayNameForUser(participant.id),
                        isMuted: participant.isMuted,
                        isCameraOff: participant.isCameraOff,
                        isHandRaised: participant.isHandRaised,
                        isGhost: participant.isGhost,
                        isSpeaking: viewModel.state.activeSpeakerId == participant.id,
                        isLocal: false,
                        trackWrapper: viewModel.webRTCClient.remoteVideoTracks[participant.id]
                    )
                    .opacity(participant.isLeaving ? 0.5 : 1.0)
                    .animation(Animation.easeOut(duration: 0.2), value: participant.isLeaving)
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
                        .overlay {
                            Circle()
                                .strokeBorder(lineWidth: 1)
                                .foregroundStyle(ACMColors.creamSubtle)
                        }
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
                    acmColor01(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.4)
                    
                    VStack(spacing: 8) {
                        ACMSystemIcon.image("theatermasks.fill", androidName: "Icons.Filled.Face")
                            .font(.system(size: 48))
                            .foregroundStyle(ACMColors.primaryPink)
                            .shadow(color: ACMColors.primaryPinkSoft, radius: 16.0)
                        
                        Text("GHOST")
                            .font(ACMFont.mono(10))
                            .tracking(2)
                            .foregroundStyle(ACMColors.primaryPink)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 4)
                            .acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: 0.6))
                            .overlay {
                                Capsule()
                                    .strokeBorder(lineWidth: 1)
                                    .foregroundStyle(ACMColors.primaryPinkFaint)
                            }
                            .clipShape(Capsule())
                    }
                }
            }
            
            if isHandRaised {
                VStack {
                    HStack {
                        ACMSystemIcon.image("hand.raised.fill", androidName: "Icons.Filled.ThumbUp")
                            .font(.system(size: 14))
                            .foregroundStyle(acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.9))
                            .padding(8)
                            .acmColorBackground(acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.2))
                            .overlay {
                                Circle()
                                    .strokeBorder(lineWidth: 1)
                                    .foregroundStyle(acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.4))
                            }
                            .clipShape(Circle())
                            .shadow(color: acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.3), radius: 8.0)
                        
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
                            .foregroundStyle(ACMColors.primaryOrangeDim)
                            .tracking(2)
                        
                        if isMuted {
                            ACMSystemIcon.image("mic.slash.fill", androidName: "Icons.Filled.Close")
                                .font(.system(size: 10))
                                .foregroundStyle(ACMColors.primaryOrange)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: 0.7))
                    .acmMaterialBackground(opacity: 0.3)
                    .overlay {
                        Capsule()
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.creamFaint)
                    }
                    .clipShape(Capsule())
                    
                    Spacer()
                }
                .padding(12)
            }
        }
        .aspectRatio(16.0 / 9.0, contentMode: .fit)
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
                        .overlay {
                            Circle()
                                .strokeBorder(lineWidth: 1)
                                .foregroundStyle(ACMColors.creamSubtle)
                        }
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
                    acmColor01(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.4)
                    
                    VStack(spacing: 8) {
                        ACMSystemIcon.image("theatermasks.fill", androidName: "Icons.Filled.Face")
                            .font(.system(size: 48))
                            .foregroundStyle(ACMColors.primaryPink)
                            .shadow(color: ACMColors.primaryPinkSoft, radius: 16.0)
                        
                        Text("GHOST")
                            .font(ACMFont.mono(10))
                            .tracking(2)
                            .foregroundStyle(ACMColors.primaryPink)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 4)
                            .acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: 0.6))
                            .overlay {
                                Capsule()
                                    .strokeBorder(lineWidth: 1)
                                    .foregroundStyle(ACMColors.primaryPinkFaint)
                            }
                            .clipShape(Capsule())
                    }
                }
            }
            
            if participant.isHandRaised {
                VStack {
                    HStack {
                        ACMSystemIcon.image("hand.raised.fill", androidName: "Icons.Filled.ThumbUp")
                            .font(.system(size: 14))
                            .foregroundStyle(acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.9))
                            .padding(8)
                            .acmColorBackground(acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.2))
                            .overlay {
                                Circle()
                                    .strokeBorder(lineWidth: 1)
                                    .foregroundStyle(acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.4))
                            }
                            .clipShape(Circle())
                            .shadow(color: acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.3), radius: 8.0)
                        
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
                            ACMSystemIcon.image("mic.slash.fill", androidName: "Icons.Filled.Close")
                                .font(.system(size: 10))
                                .foregroundStyle(ACMColors.primaryOrange)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: 0.7))
                    .acmMaterialBackground(opacity: 0.3)
                    .overlay {
                        Capsule()
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.creamFaint)
                    }
                    .clipShape(Capsule())
                    
                    Spacer()
                }
                .padding(12)
            }
        }
        .aspectRatio(16.0 / 9.0, contentMode: .fit)
        .acmVideoTile(isSpeaking: isSpeaking)
        .opacity(participant.isLeaving ? 0.5 : 1.0)
        .animation(Animation.easeOut(duration: 0.2), value: participant.isLeaving)
    }
}

// MARK: - Presentation Layout

struct PresentationLayoutView: View {
    @Bindable var viewModel: MeetingViewModel
    
    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.black)
                
                if let screenShareUserId = viewModel.state.activeScreenShareUserId {
                    if let trackWrapper = viewModel.webRTCClient.remoteVideoTracks["\(screenShareUserId)-screen"] {
                        RemoteVideoView(trackWrapper: trackWrapper)
                    } else {
                        VStack(spacing: 8) {
                            ACMSystemIcon.image("rectangle.on.rectangle", androidName: "Icons.Filled.Share")
                                .font(.system(size: 48))
                                .foregroundStyle(ACMColors.creamMuted)
                            
                            Text("\(viewModel.displayNameForUser(screenShareUserId)) is presenting")
                                .font(ACMFont.trial(14))
                                .foregroundStyle(acmColor(red: 254.0, green: 252.0, blue: 217.0, opacity: 0.5))
                        }
                    }
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.creamFaint)
            }
            
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 8) {
                    VideoGridItem(
                        displayName: viewModel.state.displayName,
                        isMuted: viewModel.state.isMuted,
                        isCameraOff: viewModel.state.isCameraOff,
                        isHandRaised: viewModel.state.isHandRaised,
                        isGhost: viewModel.state.isGhostMode,
                        isSpeaking: false,
                        isLocal: true,
                        captureSession: viewModel.webRTCClient.getCaptureSession()
                    )
                    .frame(width: 160, height: 90)
                    
                    ForEach(viewModel.state.sortedParticipants) { participant in
                        VideoGridItem(
                            displayName: viewModel.displayNameForUser(participant.id),
                            isMuted: participant.isMuted,
                            isCameraOff: participant.isCameraOff,
                            isHandRaised: participant.isHandRaised,
                            isGhost: participant.isGhost,
                            isSpeaking: viewModel.state.activeSpeakerId == participant.id,
                            isLocal: false,
                            trackWrapper: viewModel.webRTCClient.remoteVideoTracks[participant.id]
                        )
                        .frame(width: 160, height: 90)
                    }
                }
                .padding(8)
            }
            .frame(width: 176)
            .acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: 0.5))
        }
        .padding(8)
    }
}

// MARK: - Controls Bar

struct ControlsBarView: View {
    @Bindable var viewModel: MeetingViewModel
    let availableWidth: CGFloat
    let onParticipantsPressed: () -> Void
    let onSettingsPressed: () -> Void
    @State var showReactionPicker = false

#if !os(macOS)
    @Environment(\.horizontalSizeClass) var horizontalSizeClass
#endif

    private var isRegularSizeClass: Bool {
#if os(macOS)
        return true
#else
        return horizontalSizeClass == UserInterfaceSizeClass.regular
#endif
    }

    var body: some View {
        let isCompact = !isRegularSizeClass
        let participantsIcon: String = {
            #if SKIP
            return "Icons.Filled.Person"
            #else
            return "person.2.fill"
            #endif
        }()
        let lockIcon: String = {
            #if SKIP
            return viewModel.state.isRoomLocked ? "Icons.Filled.Lock" : "Icons.Outlined.Lock"
            #else
            return viewModel.state.isRoomLocked ? "lock.fill" : "lock.open.fill"
            #endif
        }()
        let micIcon: String = {
            #if SKIP
            return viewModel.state.isMuted ? "Icons.Filled.Close" : "Icons.Filled.Call"
            #else
            return viewModel.state.isMuted ? "mic.slash.fill" : "mic.fill"
            #endif
        }()
        let cameraIcon: String = {
            #if SKIP
            return viewModel.state.isCameraOff ? "Icons.Filled.Close" : "Icons.Filled.PlayArrow"
            #else
            return viewModel.state.isCameraOff ? "video.slash.fill" : "video.fill"
            #endif
        }()
        let screenShareIcon: String = {
            #if SKIP
            return "Icons.Filled.Share"
            #else
            return "rectangle.on.rectangle"
            #endif
        }()
        let handRaiseIcon: String = {
            #if SKIP
            return "Icons.Filled.ThumbUp"
            #else
            return "hand.raised.fill"
            #endif
        }()
        let chatIcon: String = {
            #if SKIP
            return "Icons.Outlined.MailOutline"
            #else
            return "message.fill"
            #endif
        }()
        let reactionIcon: String = {
            #if SKIP
            return "Icons.Outlined.ThumbUp"
            #else
            return "face.smiling"
            #endif
        }()
        let settingsIcon: String = {
            #if SKIP
            return "Icons.Filled.Settings"
            #else
            return "gearshape.fill"
            #endif
        }()

        HStack(spacing: isCompact ? 12.0 : 4.0) {
            if !isCompact {
                ControlButton(
                    icon: participantsIcon,
                    isActive: false,
                    badge: viewModel.state.pendingUsersCount > 0 ? viewModel.state.pendingUsersCount : nil
                ) {
                    onParticipantsPressed()
                }

                if viewModel.state.isAdmin {
                    ControlButton(
                        icon: lockIcon,
                        isActive: viewModel.state.isRoomLocked,
                        activeColor: acmColor01(red: 1.0, green: 1.0, blue: 0.0, opacity: 0.9)
                    ) {
                        viewModel.toggleRoomLock()
                    }
                }
            }
            
            ControlButton(
                icon: micIcon,
                isMuted: viewModel.state.isMuted,
                isGhostDisabled: viewModel.state.isGhostMode
            ) {
                viewModel.toggleMute()
            }
            .disabled(viewModel.state.isGhostMode)
            
            ControlButton(
                icon: cameraIcon,
                isMuted: viewModel.state.isCameraOff,
                isGhostDisabled: viewModel.state.isGhostMode
            ) {
                viewModel.toggleCamera()
            }
            .disabled(viewModel.state.isGhostMode)
            
            if viewModel.state.isScreenShareSupported {
                ControlButton(
                    icon: screenShareIcon,
                    isActive: viewModel.state.isScreenSharing,
                    isGhostDisabled: viewModel.state.isGhostMode
                ) {
                    viewModel.toggleScreenShare()
                }
                .disabled(viewModel.state.isGhostMode)
            }
            
            ControlButton(
                icon: handRaiseIcon,
                isActive: viewModel.state.isHandRaised,
                activeColor: acmColor01(red: 1.0, green: 1.0, blue: 0.0, opacity: 0.9),
                isGhostDisabled: viewModel.state.isGhostMode
            ) {
                viewModel.toggleHandRaise()
            }
            .disabled(viewModel.state.isGhostMode)
            
            ZStack(alignment: .top) {
                ControlButton(
                    icon: reactionIcon,
                    isActive: showReactionPicker,
                    isGhostDisabled: viewModel.state.isGhostMode
                ) {
                    showReactionPicker = !showReactionPicker
                }
                .disabled(viewModel.state.isGhostMode)
                
                if showReactionPicker {
                    ReactionPickerView { emoji in
                        viewModel.sendReaction(emoji: emoji)
                        showReactionPicker = false
                    }
                    .offset(y: -60)
                }
            }
            
            ControlButton(
                icon: chatIcon,
                isActive: viewModel.state.isChatOpen,
                badge: viewModel.state.unreadChatCount > 0 ? viewModel.state.unreadChatCount : nil
            ) {
                viewModel.toggleChat()
            }

            ControlButton(
                icon: settingsIcon,
                isActive: false
            ) {
                onSettingsPressed()
            }
            
            Rectangle()
                .fill(ACMColors.creamFaint)
                .frame(width: 1, height: 24)
                .padding(.horizontal, isCompact ? 2.0 : 4.0)
            
            Button {
                viewModel.leaveRoom()
            } label: {
                    ACMSystemIcon.image("phone.down.fill", androidName: "Icons.Filled.Call")
                    .font(.system(size: 16))
                    .foregroundStyle(acmColor01(red: 1.0, green: 0.0, blue: 0.0, opacity: 0.9))
                    .rotationEffect(.degrees(135))
                    .frame(width: 44, height: 44)
            }
            .acmControlButtonStyle(isDanger: true)
        }
        .frame(maxWidth: isCompact ? min(360.0, availableWidth - 24.0) : availableWidth - 24.0)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: 0.4))
        .acmMaterialBackground(opacity: 0.3)
        .clipShape(Capsule())
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
    var accessibilityLabel: String? = nil
    var accessibilityHint: String? = nil
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                ACMSystemIcon.image(icon, androidName: icon)
                    .font(.system(size: 16))
                
                if let badge = badge {
                    Text(badge > 9 ? "9+" : "\(badge)")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Color.white)
                        .frame(minWidth: 16, minHeight: 16)
                        .acmColorBackground(ACMColors.primaryOrange)
                        .clipShape(Circle())
                        .offset(x: 8, y: -8)
                }
            }
        }
        .acmControlButtonStyle(
            isActive: isActive,
            isMuted: isMuted,
            isGhostDisabled: isGhostDisabled,
            isHandRaised: isActive && activeColor == acmColor01(red: 1.0, green: 1.0, blue: 0.0, opacity: 0.9)
        )
        #if !SKIP
        .accessibilityLabel(accessibilityLabel ?? "")
        .accessibilityHint(accessibilityHint ?? "")
        #endif
    }
}

// MARK: - Reaction Picker

struct ReactionPickerView: View {
    let onSelect: (String) -> Void
    
    let reactions = ["👍", "👏", "❤️", "🎉", "😂", "😮", "😢", "🤔"]
    
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
        .acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: 0.9))
        .acmMaterialBackground()
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
                        x: CGFloat(reaction.lane + 1) * (geometry.size.width / 6.0),
                        y: geometry.size.height - 150
                    )
                    .transition(.asymmetric(
                        insertion: .scale(scale: 0.8).combined(with: AnyTransition.opacity),
                        removal: .move(edge: .top).combined(with: AnyTransition.opacity)
                    ))
            }
        }
        #if !SKIP
        .allowsHitTesting(false)
        #endif
        .animation(Animation.easeOut(duration: 0.3), value: reactions.count)
    }
}

// MARK: - Chat Overlay

struct ChatOverlayView: View {
    @Bindable var viewModel: MeetingViewModel
    @State var messageText = ""
    @FocusState var isInputFocused: Bool
    
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Chat")
                    .font(ACMFont.trial(16, weight: .semibold))
                    .foregroundStyle(ACMColors.cream)
                
                Spacer()
                
                Button {
                    viewModel.toggleChat()
                } label: {
                    ACMSystemIcon.image("xmark", androidName: "Icons.Filled.Close")
                        .font(.system(size: 14))
                        .foregroundStyle(acmColor(red: 254.0, green: 252.0, blue: 217.0, opacity: 0.5))
                }
            }
            .padding()
            .acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: 0.8))
            
            ScrollViewReader { proxy in
                ScrollView {
                    if viewModel.state.chatMessages.isEmpty {
                        ChatEmptyStateView()
                    } else {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(viewModel.state.chatMessages) { message in
                                ChatBubbleView(
                                    message: message,
                                    isFromCurrentUser: message.userId == viewModel.state.userId
                                )
                                .id(message.id)
                            }
                        }
                        .padding()
                    }
                }
                .onChange(of: viewModel.state.chatMessages.count) { _, _ in
                    if let lastMessage = viewModel.state.chatMessages.last {
                        withAnimation(Animation.easeOut(duration: 0.2)) {
                            proxy.scrollTo(lastMessage.id, anchor: .bottom)
                        }
                    }
                }
            }
            
            HStack(spacing: 12) {
                TextField("Type a message...", text: $messageText)
                    .textFieldStyle(.plain)
                    .font(ACMFont.trial(14))
                    .foregroundStyle(ACMColors.cream)
                    .padding(12)
                    .acmColorBackground(ACMColors.surface)
                    .clipShape(Capsule())
#if !SKIP
                    .focused($isInputFocused)
#endif
                    .submitLabel(SubmitLabel.send)
                    .onSubmit {
                        sendMessage()
                    }
                
                Button {
                    sendMessage()
                } label: {
                    ACMSystemIcon.image("paperplane.fill", androidName: "Icons.Filled.Send")
                        .font(.system(size: 28))
                        .foregroundStyle(messageText.isEmpty ? ACMColors.creamMuted : ACMColors.primaryOrange)
                }
                .disabled(messageText.isEmpty)
            }
            .padding()
            .acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: 0.8))
        }
        .acmColorBackground(Color(red: 20.0 / 255.0, green: 20.0 / 255.0, blue: 20.0 / 255.0))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.creamFaint)
        }
        .shadow(color: acmColor01(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.5), radius: 20.0)
        .padding()
    }
    
    func sendMessage() {
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
                .foregroundStyle(isFromCurrentUser ? Color.white : ACMColors.cream)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .acmColorBackground(isFromCurrentUser ? ACMColors.primaryOrange : ACMColors.surface)
                .clipShape(RoundedRectangle(cornerRadius: 16))
            
            Text(message.timestamp, style: .time)
                .font(ACMFont.mono(9))
                .foregroundStyle(ACMColors.creamMuted)
        }
        .frame(maxWidth: .infinity, alignment: isFromCurrentUser ? .trailing : .leading)
    }
}

// MARK: - Chat Empty State

struct ChatEmptyStateView: View {
    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            
            ACMSystemIcon.image("bubble.left", androidName: "Icons.Outlined.ChatBubble")
                .font(.system(size: 48))
                .foregroundStyle(ACMColors.creamMuted)
            
            VStack(spacing: 8) {
                Text("No messages yet")
                    .font(ACMFont.trial(16, weight: .medium))
                    .foregroundStyle(ACMColors.cream)
                
                Text("Start the conversation...")
                    .font(ACMFont.trial(14))
                    .foregroundStyle(ACMColors.creamMuted)
            }
            
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}

// MARK: - Participants Sheet

struct ParticipantsSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    @Environment(\.dismiss) var dismiss
    
    var body: some View {
        NavigationStack {
            List {
                if viewModel.state.isAdmin && viewModel.state.pendingUsersCount > 0 {
                    Section("Waiting to join") {
                        ForEach(viewModel.state.pendingUsers.sorted(by: { $0.value < $1.value }), id: \.key) { userId, name in
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
                                .tint(Color.red)
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
                                Text(String(viewModel.state.displayName.prefix(1)).uppercased())
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(Color.white)
                            }
                        
                        VStack(alignment: .leading) {
                            HStack(spacing: 4) {
                                Text(viewModel.state.displayName)
                                    .font(ACMFont.trial(14, weight: .medium))
                                
                                Text("(You)")
                                    .font(ACMFont.trial(12))
                                    .foregroundStyle(ACMColors.creamMuted)
                            }
                            
                            if viewModel.state.isAdmin {
                                Text("Host")
                                    .font(ACMFont.mono(10))
                                    .foregroundStyle(ACMColors.primaryOrange)
                            }
                        }
                        
                        Spacer()
                        
                        if viewModel.state.isHandRaised {
                            Text("✋")
                                .font(.system(size: 16))
                        }
                        
                        if viewModel.state.isMuted {
                            ACMSystemIcon.image("mic.slash.fill", androidName: "Icons.Filled.Close")
                                .font(.system(size: 12))
                                .foregroundStyle(Color.red)
                        }
                    }
                    
                    ForEach(viewModel.state.sortedParticipants) { participant in
                        HStack {
                            Circle()
                                .fill(ACMGradients.avatarBackground)
                                .frame(width: 40, height: 40)
                                .overlay {
                                    Text(String(viewModel.displayNameForUser(participant.id).prefix(1)).uppercased())
                                        .font(.system(size: 16, weight: .semibold))
                                        .foregroundStyle(Color.white)
                                }
                            
                            Text(viewModel.displayNameForUser(participant.id))
                                .font(ACMFont.trial(14, weight: .medium))
                            
                            if participant.isGhost {
                                ACMSystemIcon.image("theatermasks.fill", androidName: "Icons.Filled.Face")
                                    .font(.system(size: 12))
                                    .foregroundStyle(ACMColors.primaryPink)
                            }
                            
                            Spacer()
                            
                            if participant.isHandRaised {
                                Text("✋")
                                    .font(.system(size: 16))
                            }
                            
                            if participant.isMuted {
                                ACMSystemIcon.image("mic.slash.fill", androidName: "Icons.Filled.Close")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Color.red)
                            }
                        }
                    }
                } header: {
                    Text("In this meeting (\(viewModel.state.participantCount))")
                }
            }
            .navigationTitle("Participants")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
                #else
                ToolbarItem(placement: .automatic) {
                    Button("Done") { dismiss() }
                }
                #endif
            }
        }
    }
}

// MARK: - Settings Sheet

struct SettingsSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    @Environment(\.dismiss) var dismiss
    @State var displayNameInput = ""
    
    var body: some View {
        NavigationStack {
            List {
                if viewModel.state.isAdmin {
                    Section("Room") {
                        Toggle("Lock room", isOn: Binding(
                            get: { viewModel.state.isRoomLocked },
                            set: { next in
                                if next != viewModel.state.isRoomLocked {
                                    viewModel.toggleRoomLock()
                                }
                            }
                        ))
                    }
                }

                Section("Profile") {
                    TextField("Display name", text: $displayNameInput)
                        #if os(iOS)
                        .textInputAutocapitalization(.words)
                        #endif
                        .autocorrectionDisabled(true)
                        .onAppear {
                            displayNameInput = viewModel.state.displayName
                        }
                    
                    Button("Update Display Name") {
                        viewModel.updateDisplayName(displayNameInput)
                    }
                    .disabled(displayNameInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                Section("Audio & Video") {
                    Toggle("Microphone", isOn: Binding(
                        get: { !viewModel.state.isMuted },
                        set: { next in
                            let shouldMute = !next
                            if shouldMute != viewModel.state.isMuted {
                                viewModel.toggleMute()
                            }
                        }
                    ))
                    .disabled(viewModel.state.isGhostMode)

                    Toggle("Camera", isOn: Binding(
                        get: { !viewModel.state.isCameraOff },
                        set: { next in
                            let shouldDisable = !next
                            if shouldDisable != viewModel.state.isCameraOff {
                                viewModel.toggleCamera()
                            }
                        }
                    ))
                    .disabled(viewModel.state.isGhostMode)
                }
                
                Section("Video") {
                    Picker("Quality", selection: Binding(
                        get: { viewModel.state.videoQuality },
                        set: { next in
                            viewModel.setVideoQuality(next)
                        }
                    )) {
                        Text("Standard").tag(VideoQuality.standard)
                        Text("Low (Save data)").tag(VideoQuality.low)
                    }
                }
            }
            .navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
                #else
                ToolbarItem(placement: .automatic) {
                    Button("Done") { dismiss() }
                }
                #endif
            }
        }
    }
}

#Preview {
    MeetingView(viewModel: MeetingViewModel())
}
