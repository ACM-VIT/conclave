//
//  JoinView.swift
//  Conclave
//
//  Join screen
//

import SwiftUI
import AVFoundation
import Foundation

struct JoinView: View {
    @ObservedObject var viewModel: MeetingViewModel
    @EnvironmentObject var appState: AppState
    
    @State private var phase: JoinPhase = .welcome
    @State private var roomCode = ""
    @State private var guestName = ""
    @State private var displayNameInput = ""
    @State private var isGhostMode = false
    @State private var activeTab: JoinTab = .new
    @State private var isCameraOn = false
    @State private var isMicOn = false
    @State private var isSigningIn = false
    @State private var captureSession: AVCaptureSession?
    
    enum JoinPhase {
        case welcome, auth, join
    }
    
    enum JoinTab {
        case new, join
    }

    private var isGoogleSignInEnabled: Bool {
        let env = ProcessInfo.processInfo.environment
        if let value = env["GOOGLE_SIGN_IN_ENABLED"]?.lowercased() {
            return value == "1" || value == "true" || value == "yes"
        }
        if let plistBool = Bundle.main.object(forInfoDictionaryKey: "GOOGLE_SIGN_IN_ENABLED") as? Bool {
            return plistBool
        }
        if let plistString = Bundle.main.object(forInfoDictionaryKey: "GOOGLE_SIGN_IN_ENABLED") as? String {
            let normalized = plistString.lowercased()
            return normalized == "1" || normalized == "true" || normalized == "yes"
        }
        return false
    }
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                ACMColors.darkAlt
                    .ignoresSafeArea()
                
                dotGridPattern
                    .ignoresSafeArea()
                
                VStack(spacing: 0) {
                    switch phase {
                    case .welcome:
                        welcomePhase
                            .transition(.opacity)
                        
                    case .auth:
                        authPhase
                            .transition(.asymmetric(
                                insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .opacity
                            ))
                        
                    case .join:
                        joinPhase(geometry: geometry)
                            .transition(.opacity)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                
                if viewModel.connectionState == .connecting || viewModel.connectionState == .joining {
                    loadingOverlay
                }
            }
        }
        .animation(.easeOut(duration: 0.4), value: phase)
        .onAppear {
            if let user = appState.currentUser, !user.id.hasPrefix("guest-") {
                phase = .join
            }
        }
    }
    
    // MARK: - Welcome Phase
    
    private var welcomePhase: some View {
        VStack(spacing: 0) {
            Spacer()
            
            Text("welcome to")
                .font(ACMFont.wide(24))
                .foregroundStyle(ACMColors.cream.opacity(0.4))
                .tracking(2)
                .padding(.bottom, 8)
            
            HStack(spacing: 0) {
                Text("[")
                    .font(ACMFont.mono(36))
                    .foregroundStyle(ACMColors.primaryOrange.opacity(0.4))
                
                Text("c0nclav3")
                    .font(ACMFont.wide(48))
                    .foregroundStyle(ACMColors.cream)
                    .tracking(-1)
                
                Text("]")
                    .font(ACMFont.mono(36))
                    .foregroundStyle(ACMColors.primaryOrange.opacity(0.4))
            }
            
            Text("ACM-VIT's in-house video conferencing platform")
                .font(ACMFont.trial(14))
                .foregroundStyle(ACMColors.cream.opacity(0.3))
                .padding(.top, 16)
                .padding(.bottom, 48)
            
            Button {
                phase = .auth
            } label: {
                HStack(spacing: 12) {
                    Text("LET'S GO")
                        .font(ACMFont.mono(12))
                        .tracking(3)
                    
                    Image(systemName: "arrow.right")
                        .font(.system(size: 14, weight: .medium))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 32)
                .padding(.vertical, 14)
                .background(ACMColors.primaryOrange)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            
            Spacer()
        }
    }
        
    private var authPhase: some View {
        VStack(spacing: 0) {
            Spacer()
            
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Text("Join")
                        .font(ACMFont.wide(28))
                        .foregroundStyle(ACMColors.cream)
                    
                    Text("CHOOSE HOW TO CONTINUE")
                        .font(ACMFont.mono(10))
                        .tracking(2)
                        .foregroundStyle(ACMColors.cream.opacity(0.4))
                }
                .padding(.bottom, 16)
                
                if isGoogleSignInEnabled {
                    Button {
                        handleGoogleSignIn()
                    } label: {
                        HStack(spacing: 12) {
                            if isSigningIn {
                                ProgressView()
                                    .progressViewStyle(CircularProgressViewStyle(tint: ACMColors.cream))
                                    .scaleEffect(0.8)
                            } else {
                                Image(systemName: "globe")
                                    .font(.system(size: 16))
                            }

                            Text("Continue with Google")
                                .font(ACMFont.trial(14))
                        }
                        .foregroundStyle(ACMColors.cream)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(ACMColors.surface)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .strokeBorder(ACMColors.creamFaint, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .disabled(isSigningIn)

                    HStack(spacing: 16) {
                        Rectangle()
                            .fill(ACMColors.creamFaint)
                            .frame(height: 1)

                        Text("OR")
                            .font(ACMFont.mono(10))
                            .tracking(2)
                            .foregroundStyle(ACMColors.cream.opacity(0.3))

                        Rectangle()
                            .fill(ACMColors.creamFaint)
                            .frame(height: 1)
                    }
                    .padding(.vertical, 8)
                }
                
                VStack(alignment: .leading, spacing: 8) {
                    Text("GUEST NAME")
                        .font(ACMFont.mono(10))
                        .tracking(2)
                        .foregroundStyle(ACMColors.cream.opacity(0.4))
                    
                    TextField("", text: $guestName, prompt: Text("Enter your name").foregroundStyle(ACMColors.cream.opacity(0.25)))
                        .textFieldStyle(.plain)
                        .font(ACMFont.trial(14))
                        .foregroundStyle(ACMColors.cream)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 12)
                        .background(ACMColors.surface)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .strokeBorder(ACMColors.creamFaint, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .submitLabel(.continue)
                        .onSubmit {
                            if !guestName.trimmingCharacters(in: .whitespaces).isEmpty {
                                handleGuest()
                            }
                        }
                    
                    Button {
                        handleGuest()
                    } label: {
                        Text("Continue as Guest")
                            .font(ACMFont.trial(14))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(ACMColors.primaryOrange)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .disabled(guestName.trimmingCharacters(in: .whitespaces).isEmpty)
                    .opacity(guestName.trimmingCharacters(in: .whitespaces).isEmpty ? 0.3 : 1)
                }
                
                Button {
                    phase = .welcome
                } label: {
                    Text("← BACK")
                        .font(ACMFont.mono(11))
                        .tracking(2)
                        .foregroundStyle(ACMColors.cream.opacity(0.3))
                }
                .padding(.top, 16)
            }
            .frame(maxWidth: 360)
            .padding(.horizontal, 24)
            
            Spacer()
        }
    }
    
    // MARK: - Join Phase (Camera preview + Form)
    
    private func joinPhase(geometry: GeometryProxy) -> some View {
        let isWide = geometry.size.width > 700
        
        return Group {
            if isWide {
                HStack(alignment: .top, spacing: 40) {
                    cameraPreviewSection
                        .frame(maxWidth: 600)
                    
                    joinFormSection
                        .frame(maxWidth: 400)
                }
                .padding(.horizontal, 40)
                .padding(.vertical, 24)
            } else {
                ZStack(alignment: .bottom) {
                    cameraPreviewSection
                        .padding(.horizontal, 16)
                        .padding(.top, 16)
                        .padding(.bottom, 180)
                    
                    joinFormSection
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                }
            }
        }
    }
    
    // MARK: - Camera Preview Section
    
    private var cameraPreviewSection: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 28)
                .fill(ACMColors.surface)
            
            // Camera feed or avatar
            if isCameraOn, let session = captureSession {
                CameraPreviewRepresentable(session: session)
                    .clipShape(RoundedRectangle(cornerRadius: 28))
                    .scaleEffect(x: -1, y: 1) // Mirror
            } else {
                // Avatar when camera off
                VStack {
                    Circle()
                        .fill(ACMGradients.avatarBackground)
                        .frame(width: 80, height: 80)
                        .overlay(
                            Circle()
                                .strokeBorder(ACMColors.creamSubtle, lineWidth: 1)
                        )
                        .overlay {
                            Text(userInitial)
                                .font(.system(size: 32, weight: .bold))
                                .foregroundStyle(ACMColors.cream)
                        }
                }
            }
            
            // User email badge (top left)
            VStack {
                HStack {
                    Text(userEmail)
                        .font(ACMFont.mono(11))
                        .foregroundStyle(ACMColors.cream.opacity(0.7))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.black.opacity(0.5))
                        .background(.ultraThinMaterial.opacity(0.3))
                        .clipShape(Capsule())
                    
                    Spacer()
                }
                .padding(12)
                
                Spacer()
                
                // Media controls (bottom center)
                HStack(spacing: 8) {
                    // Mic toggle
                    Button {
                        toggleMic()
                    } label: {
                        Image(systemName: isMicOn ? "mic.fill" : "mic.slash.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(isMicOn ? .white.opacity(0.1) : .red)
                            .clipShape(Circle())
                    }
                    
                    // Camera toggle
                    Button {
                        toggleCamera()
                    } label: {
                        Image(systemName: isCameraOn ? "video.fill" : "video.slash.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(isCameraOn ? .white.opacity(0.1) : .red)
                            .clipShape(Circle())
                    }
                }
                .padding(8)
                .background(.black.opacity(0.5))
                .background(.ultraThinMaterial.opacity(0.3))
                .clipShape(Capsule())
                .padding(.bottom, 12)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: 28)
                .strokeBorder(ACMColors.creamFaint, lineWidth: 1)
        )
    }
    
    // MARK: - Join Form Section
    
    private var joinFormSection: some View {
        VStack(spacing: 0) {
            // Tab switcher (New Meeting / Join)
            HStack(spacing: 0) {
                Button {
                    activeTab = .new
                } label: {
                    Text("NEW MEETING")
                        .font(ACMFont.mono(11))
                        .tracking(1)
                        .foregroundStyle(activeTab == .new ? .white : ACMColors.cream.opacity(0.5))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(activeTab == .new ? ACMColors.primaryOrange : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                
                Button {
                    activeTab = .join
                } label: {
                    Text("JOIN")
                        .font(ACMFont.mono(11))
                        .tracking(1)
                        .foregroundStyle(activeTab == .join ? .white : ACMColors.cream.opacity(0.5))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(activeTab == .join ? ACMColors.primaryOrange : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }
            .padding(4)
            .background(ACMColors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(.bottom, 24)
            
            // Form content based on tab
            if activeTab == .new {
                // New Meeting form
                VStack(spacing: 16) {
                    // Display name input
                    VStack(alignment: .leading, spacing: 8) {
                        Text("DISPLAY NAME")
                            .font(ACMFont.mono(10))
                            .tracking(2)
                            .foregroundStyle(ACMColors.cream.opacity(0.4))
                        
                        TextField("", text: $displayNameInput, prompt: Text("Your name").foregroundStyle(ACMColors.cream.opacity(0.3)))
                            .textFieldStyle(.plain)
                            .font(ACMFont.trial(14))
                            .foregroundStyle(ACMColors.cream)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 12)
                            .background(ACMColors.surface)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .strokeBorder(ACMColors.creamFaint, lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    
                    // Start Meeting button
                    Button {
                        handleCreateRoom()
                    } label: {
                        HStack(spacing: 8) {
                            if viewModel.connectionState == .connecting {
                                ProgressView()
                                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                    .scaleEffect(0.8)
                            } else {
                                Image(systemName: "plus")
                                    .font(.system(size: 14, weight: .medium))
                            }
                            
                            Text("Start Meeting")
                                .font(ACMFont.trial(14))
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(ACMColors.primaryOrange)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .disabled(viewModel.connectionState == .connecting)
                }
            } else {
                // Join Meeting form
                VStack(spacing: 16) {
                    // Room name input
                    VStack(alignment: .leading, spacing: 8) {
                        Text("ROOM NAME")
                            .font(ACMFont.mono(10))
                            .tracking(2)
                            .foregroundStyle(ACMColors.cream.opacity(0.4))
                        
                        TextField("", text: $roomCode, prompt: Text("Paste room link or code").foregroundStyle(ACMColors.cream.opacity(0.3)))
                            .textFieldStyle(.plain)
                            .font(ACMFont.trial(14))
                            .foregroundStyle(.white)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .onChange(of: roomCode) { newValue in
                                if newValue.contains("/") || newValue.contains(":") {
                                    return
                                }
                                let sanitized = sanitizeRoomCodeInput(newValue)
                                if sanitized != newValue {
                                    roomCode = sanitized
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 12)
                            .background(ACMColors.surface)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .strokeBorder(ACMColors.creamFaint, lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .submitLabel(.join)
                            .onSubmit {
                                if !roomCode.isEmpty {
                                    handleJoinRoom()
                                }
                            }
                    }
                    
                    // Display name input
                    VStack(alignment: .leading, spacing: 8) {
                        Text("DISPLAY NAME")
                            .font(ACMFont.mono(10))
                            .tracking(2)
                            .foregroundStyle(ACMColors.cream.opacity(0.4))
                        
                        TextField("", text: $displayNameInput, prompt: Text("Your name").foregroundStyle(ACMColors.cream.opacity(0.3)))
                            .textFieldStyle(.plain)
                            .font(ACMFont.trial(14))
                            .foregroundStyle(ACMColors.cream)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 12)
                            .background(ACMColors.surface)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .strokeBorder(ACMColors.creamFaint, lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    
                    // Join button
                    Button {
                        handleJoinRoom()
                    } label: {
                        HStack(spacing: 8) {
                            if viewModel.connectionState == .connecting {
                                ProgressView()
                                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                    .scaleEffect(0.8)
                            } else {
                                Image(systemName: "arrow.right")
                                    .font(.system(size: 14, weight: .medium))
                            }
                            
                            Text("Join Meeting")
                                .font(ACMFont.trial(14))
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(ACMColors.primaryOrange)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .disabled(roomCode.isEmpty || viewModel.connectionState == .connecting)
                    .opacity(roomCode.isEmpty ? 0.3 : 1)
                }
            }
        }
        .padding(20)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(ACMColors.surface.opacity(0.92))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(ACMColors.creamFaint, lineWidth: 1)
        )
    }
    
    // MARK: - Loading Overlay
    
    private var loadingOverlay: some View {
        ZStack {
            Color.black.opacity(0.8)
                .ignoresSafeArea()
            
            VStack(spacing: 12) {
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: ACMColors.primaryOrange))
                    .scaleEffect(1.5)
                
                Text(viewModel.connectionState == .reconnecting ? "RECONNECTING..." : "JOINING...")
                    .font(ACMFont.mono(12))
                    .tracking(2)
                    .foregroundStyle(ACMColors.cream.opacity(0.6))
            }
        }
    }
    
    // MARK: - Background Pattern
    
    private var dotGridPattern: some View {
        GeometryReader { geometry in
            Canvas { context, size in
                let spacing: CGFloat = 30
                let dotSize: CGFloat = 1.5
                
                for x in stride(from: 0, to: size.width, by: spacing) {
                    for y in stride(from: 0, to: size.height, by: spacing) {
                        let rect = CGRect(
                            x: x - dotSize/2,
                            y: y - dotSize/2,
                            width: dotSize,
                            height: dotSize
                        )
                        context.fill(
                            Path(ellipseIn: rect),
                            with: .color(ACMColors.cream.opacity(0.035))
                        )
                    }
                }
            }
        }
    }
    
    // MARK: - Computed Properties
    
    private var userEmail: String {
        appState.currentUser?.email ?? guestName
    }
    
    private var userInitial: String {
        String((appState.currentUser?.name ?? guestName).prefix(1)).uppercased()
    }
    
    // MARK: - Actions
    
    private func handleGoogleSignIn() {
        isSigningIn = true
        // In production, implement proper OAuth flow
        // For now, simulate sign-in
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            isSigningIn = false
            // TODO: Implement actual Google Sign-In
        }
    }
    
    private func handleGuest() {
        let trimmedName = guestName.trimmingCharacters(in: .whitespaces)
        guard !trimmedName.isEmpty else { return }
        
        appState.currentUser = AppState.User(
            id: "guest-\(Int(Date().timeIntervalSince1970 * 1000))",
            name: trimmedName,
            email: "\(trimmedName)@guest.local"
        )
        displayNameInput = trimmedName
        phase = .join
    }
    
    private func handleCreateRoom() {
        viewModel.isAdmin = true
        let roomId = generateRoomCode()
        viewModel.displayName = displayNameInput.isEmpty ? (appState.currentUser?.name ?? "Host") : displayNameInput
        viewModel.isMuted = !isMicOn
        viewModel.isCameraOff = !isCameraOn
        let userPayload = SfuJoinUser(
            id: appState.currentUser?.id,
            email: appState.currentUser?.email,
            name: appState.currentUser?.name
        )
        viewModel.joinRoom(
            roomId: roomId,
            displayName: viewModel.displayName,
            isGhost: isGhostMode,
            user: userPayload,
            isHost: true
        )
    }
    
    private func handleJoinRoom() {
        let extractedCode = extractRoomCode(from: roomCode)
        guard !extractedCode.isEmpty else { return }
        if extractedCode != roomCode {
            roomCode = extractedCode
        }
        viewModel.isAdmin = false
        viewModel.displayName = displayNameInput.isEmpty ? (appState.currentUser?.name ?? "Guest") : displayNameInput
        viewModel.isMuted = !isMicOn
        viewModel.isCameraOff = !isCameraOn
        let userPayload = SfuJoinUser(
            id: appState.currentUser?.id,
            email: appState.currentUser?.email,
            name: appState.currentUser?.name
        )
        viewModel.joinRoom(
            roomId: extractedCode,
            displayName: viewModel.displayName,
            isGhost: isGhostMode,
            user: userPayload,
            isHost: false
        )
    }
    
    private func generateRoomCode() -> String {
        let words = (0..<roomWordsPerCode).compactMap { _ in roomWords.randomElement() }
        return words.joined(separator: roomWordSeparator)
    }

    private func sanitizeRoomCode(_ value: String) -> String {
        let normalized = value
            .lowercased()
            .replacingOccurrences(of: "[^a-z]+", with: roomWordSeparator, options: .regularExpression)
            .replacingOccurrences(of: "-+", with: roomWordSeparator, options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: roomWordSeparator))
        guard !normalized.isEmpty else { return "" }
        let words = normalized
            .split(separator: roomWordSeparator, omittingEmptySubsequences: true)
            .prefix(roomWordsPerCode)
            .map { String($0.prefix(roomWordMaxLength)) }
        return words.joined(separator: roomWordSeparator)
    }

    private func sanitizeRoomCodeInput(_ value: String) -> String {
        value
            .lowercased()
            .replacingOccurrences(of: "[^a-z]+", with: roomWordSeparator, options: .regularExpression)
            .replacingOccurrences(of: "-+", with: roomWordSeparator, options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: roomWordSeparator))
    }

    private func extractRoomCode(from input: String) -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }

        if let url = URL(string: trimmed), let last = url.pathComponents.last {
            return sanitizeRoomCode(last)
        }

        if trimmed.contains("/") {
            let last = trimmed.split(separator: "/").last.map(String.init) ?? ""
            return sanitizeRoomCode(last)
        }

        return sanitizeRoomCode(trimmed)
    }

    private let roomWords = [
        "aloe", "aster", "bloom", "canna", "cedar", "clove", "dahl", "daisy", "erica", "flora",
        "hazel", "iris", "lilac", "lily", "lotus", "maple", "myrrh", "olive", "pansy", "peony",
        "poppy", "rose", "sorel", "tansy", "thyme", "tulip", "yucca", "zinn", "akane", "akira",
        "asuna", "eren", "gohan", "goku", "gojo", "kanao", "kira", "levi", "luffy", "maki",
        "misa", "nami", "riku", "sokka", "saber", "senku", "shoto", "soma", "sora", "tanji",
        "taki", "toji", "todo", "toph", "yami", "yuki", "yato", "zoro"
    ]

    private let roomWordsPerCode = 3
    private let roomWordSeparator = "-"
    private var roomWordMaxLength: Int {
        roomWords.map(\.count).max() ?? 0
    }
    
    private func toggleCamera() {
        if isCameraOn {
            captureSession?.stopRunning()
            captureSession = nil
            isCameraOn = false
        } else {
            setupCamera()
        }
    }
    
    private func toggleMic() {
        isMicOn.toggle()
        // Audio session will be configured when joining
    }
    
    private func setupCamera() {
        AVCaptureDevice.requestAccess(for: .video) { granted in
            guard granted else { return }
            
            DispatchQueue.main.async {
                let session = AVCaptureSession()
                session.sessionPreset = .medium
                
                guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
                      let input = try? AVCaptureDeviceInput(device: device),
                      session.canAddInput(input) else {
                    return
                }
                
                session.addInput(input)
                
                DispatchQueue.global(qos: .userInitiated).async {
                    session.startRunning()
                }
                
                self.captureSession = session
                self.isCameraOn = true
            }
        }
    }
}

// MARK: - Camera Preview UIViewRepresentable

struct CameraPreviewRepresentable: UIViewRepresentable {
    let session: AVCaptureSession
    
    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.backgroundColor = .black
        
        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(previewLayer)
        
        context.coordinator.previewLayer = previewLayer
        
        return view
    }
    
    func updateUIView(_ uiView: UIView, context: Context) {
        DispatchQueue.main.async {
            context.coordinator.previewLayer?.frame = uiView.bounds
        }
    }
    
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }
    
    class Coordinator {
        var previewLayer: AVCaptureVideoPreviewLayer?
    }
}

#Preview {
    JoinView(viewModel: MeetingViewModel())
        .environmentObject(AppState())
}
