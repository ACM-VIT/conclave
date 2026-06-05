import SwiftUI
import Observation

//
//  ContentView.swift
//  Conclave
//
//  Root navigation view with state-based routing
//

#if SKIP
// Carbon → a Compose Material3 Color. So Android's NATIVE Material components
// (DropdownMenu, Switch, ModalBottomSheet, ripples, TextField) read Carbon
// instead of the default Material baseline. r/g/b in 0–255, a in 0–1.
private func acmM3(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1.0) -> androidx.compose.ui.graphics.Color {
    androidx.compose.ui.graphics.Color(
        red: Float(r / 255.0),
        green: Float(g / 255.0),
        blue: Float(b / 255.0),
        alpha: Float(a)
    )
}
#endif

struct ContentView: View {
    @Bindable var appState: AppState
    @State var meetingViewModel = MeetingViewModel()

    var body: some View {
        Group {
            switch meetingViewModel.state.connectionState {
            case .disconnected, .connecting, .connected:
                JoinView(viewModel: meetingViewModel, appState: appState)
                    .transition(.opacity)

            case .joining, .joined, .reconnecting:
                MeetingView(viewModel: meetingViewModel)
                    .transition(.opacity)

            case .waiting:
                WaitingRoomView(viewModel: meetingViewModel)
                    .transition(.opacity)

            case .error:
                ErrorView(
                    message: meetingViewModel.state.errorMessage ?? "An error occurred",
                    onRetry: { meetingViewModel.resetError() }
                )
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: meetingViewModel.state.connectionState)
        .preferredColorScheme(.dark)
        // App-wide brand accent so native controls (switches, pickers, links,
        // text-field carets) use Carbon orange instead of the iOS system blue.
        .tint(ACMColors.primaryOrange)
        // Android: theme every NATIVE Material 3 component (Menu/DropdownMenu,
        // Switch, ModalBottomSheet, ripples, TextField) with the Carbon palette
        // so they're on-brand instead of the default purple Material baseline.
        #if SKIP
        .material3ColorScheme { scheme, _ in
            scheme.copy(
                primary: acmM3(249, 95, 74),
                onPrimary: acmM3(255, 255, 255),
                primaryContainer: acmM3(249, 95, 74),
                onPrimaryContainer: acmM3(255, 255, 255),
                secondary: acmM3(255, 0, 122),
                onSecondary: acmM3(255, 255, 255),
                background: acmM3(10, 10, 11),
                onBackground: acmM3(250, 250, 250),
                surface: acmM3(24, 24, 27),
                onSurface: acmM3(250, 250, 250),
                surfaceVariant: acmM3(35, 35, 39),
                onSurfaceVariant: acmM3(250, 250, 250, 0.74),
                error: acmM3(234, 67, 53),
                onError: acmM3(255, 255, 255),
                outline: acmM3(250, 250, 250, 0.24),
                outlineVariant: acmM3(250, 250, 250, 0.14),
                surfaceContainerLowest: acmM3(10, 10, 11),
                surfaceContainerLow: acmM3(19, 19, 22),
                surfaceContainer: acmM3(24, 24, 27),
                surfaceContainerHigh: acmM3(35, 35, 39),
                surfaceContainerHighest: acmM3(46, 46, 51),
                scrim: acmM3(0, 0, 0)
            )
        }
        #endif
    }
}

// MARK: - Waiting Room View

struct WaitingRoomView: View {
    @Bindable var viewModel: MeetingViewModel

    var body: some View {
        ZStack {
            ACMColors.dark
                .ignoresSafeArea()

            GeometryReader { geometry in
#if !SKIP
                Canvas { context, size in
                    let spacing: CGFloat = 30
                    let dotSize: CGFloat = 1.5

                    for x in stride(from: 0, to: size.width, by: spacing) {
                        for y in stride(from: 0, to: size.height, by: spacing) {
                            let rect = CGRect(
                                x: x - dotSize / 2,
                                y: y - dotSize / 2,
                                width: dotSize,
                                height: dotSize
                            )
                            context.fill(
                                Path(ellipseIn: rect),
                                with: GraphicsContext.Shading.color(ACMColors.creamGhost)
                            )
                        }
                    }
                }
#else
                Color.clear
#endif
            }
            .ignoresSafeArea()

            VStack(spacing: ACMSpacing.xl) {
                ZStack {
                    Circle()
                        .stroke(ACMColors.primaryOrangeGhost, lineWidth: 3.0)
                        .frame(width: 80.0, height: 80.0)

#if SKIP
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(ACMColors.primaryOrange)
#else
                    Circle()
                        .trim(from: 0.0, to: 0.7)
                        .stroke(ACMColors.primaryOrange, style: StrokeStyle(lineWidth: 3.0, lineCap: .round))
                        .frame(width: 80.0, height: 80.0)
                        .rotationEffect(Angle.degrees(-90))
                        .modifier(RotatingModifier())
#endif
                }

                VStack(spacing: ACMSpacing.xs) {
                    Text("Waiting for host")
                        .font(ACMFont.trial(24, weight: .bold))
                        .foregroundStyle(ACMColors.text)
                        .tracking(-0.4)

                    Text(viewModel.state.waitingMessage ?? "You'll join as soon as the host lets you in")
                        .font(ACMFont.trial(14))
                        .foregroundStyle(ACMColors.textMuted)
                        .multilineTextAlignment(.center)
                }

                Text(viewModel.state.roomId)
                    .font(ACMFont.trial(14, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .padding(.horizontal, ACMSpacing.md)
                    .padding(.vertical, 10)
                    .acmColorBackground(ACMColors.surface)
                    .overlay {
                        RoundedRectangle(cornerRadius: ACMRadius.sm)
                            .strokeBorder(ACMColors.border, lineWidth: 1.0)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))

                Button {
                    viewModel.leaveRoom()
                } label: {
                    Text("Cancel")
                        .font(ACMFont.trial(16, weight: .medium))
                        .foregroundStyle(ACMColors.textMuted)
                        .frame(maxWidth: .infinity)
                        .frame(height: 54.0)
                        .overlay {
                            RoundedRectangle(cornerRadius: ACMRadius.lg)
                                .strokeBorder(ACMColors.border, lineWidth: 1.0)
                        }
                }
                .frame(maxWidth: 280)
                .padding(.top, ACMSpacing.xs)
            }
            .padding(ACMSpacing.xl)
        }
    }
}

struct RotatingModifier: ViewModifier {
    @State var isRotating = false

    func body(content: Content) -> some View {
        content
            .rotationEffect(.degrees(isRotating ? 360.0 : 0.0))
            .animation(.linear(duration: 1).repeatForever(autoreverses: false), value: isRotating)
            .onAppear {
                isRotating = true
            }
    }
}

// MARK: - Error View

struct ErrorView: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        ZStack {
            ACMColors.dark
                .ignoresSafeArea()

            VStack(spacing: ACMSpacing.xl) {
                ZStack {
                    Circle()
                        .fill(ACMColors.error.opacity(0.12))
                        .frame(width: 80.0, height: 80.0)

                    ACMSystemIcon.icon("exclamationmark.triangle.fill", android: "warning", size: 32, tint: "danger")
                        .foregroundStyle(ACMColors.error)
                }

                VStack(spacing: ACMSpacing.xs) {
                    Text("Something went wrong")
                        .font(ACMFont.trial(22, weight: .bold))
                        .foregroundStyle(ACMColors.text)
                        .tracking(-0.4)

                    Text(message)
                        .font(ACMFont.trial(14))
                        .foregroundStyle(ACMColors.textMuted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 280)
                }

                Button(action: onRetry) {
                    Text("Try again")
                        .font(ACMFont.trial(16, weight: .medium))
                        .foregroundStyle(Color.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 54.0)
                        .acmColorBackground(ACMColors.primaryOrange)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                }
                .frame(maxWidth: 280)
            }
            .padding(ACMSpacing.xl)
        }
    }
}

#Preview {
    ContentView(appState: AppState())
}
