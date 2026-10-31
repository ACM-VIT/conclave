#if os(iOS) && !SKIP
import SwiftUI

struct LeaveControl: View {
    let controls: CallControlsPresenter
    let diameter: CGFloat

    let isAccessibilityText: Bool
    @State private var promptCounter = 0
    @State private var lastPromptedId = 0

    @State private var closedConfirmationId = 0

    var body: some View {
        let leave = controls.leaveState
        let isLeaving = leave.leavePhase == LeavePhase.leaving
        let confirmationId = leave.confirmationId
        Group {
            if LeaveControlPolicy.showsHostMenu(leave, isAccessibilityText: isAccessibilityText) {
                Menu {
                    ConclaveMenuContent(sections: LeaveControlPolicy.menuSections(leave, titles: LeaveControlCopy.menuTitles(), endOnTop: false),
                                        symbol: { _ in nil },
                                        onSelect: { item in _ = controls.selectLeaveMenuItem(item.id) })
                } label: {
                    LeaveGlyph(diameter: diameter, isLeaving: isLeaving)
                } primaryAction: {
                    _ = controls.leave()
                }
                .menuOrder(.priority)
                .menuIndicator(.hidden)
                .menuStyle(.button)
            } else {
                Button {
                    _ = controls.leave()
                } label: {
                    LeaveGlyph(diameter: diameter, isLeaving: isLeaving)
                }
            }
        }
        .buttonStyle(LeaveControlButtonStyle())
        .disabled(isLeaving)
        .accessibilityLabel(LeaveControlCopy.leaveTitle)
        .modifier(LeaveControlValue(text: isLeaving ? ConclaveStrings.text("Leaving") : nil))
        .accessibilityActions {
            if LeaveControlPolicy.offersEndAction(leave) {
                Button(LeaveControlCopy.endActionTitle) {
                    controls.requestEndForEveryone(from: MeetingConfirmationInvoker.call)
                }
            }
        }
        .accessibilityShowsLargeContentViewer {
            Label(LeaveControlCopy.leaveTitle, systemImage: ConclaveSymbols.phoneDownFill)
        }
        .help(LeaveControlCopy.leaveTitle)
        .accessibilityIdentifier(LeaveControlPolicy.controlIdentifier)
        .conclaveDialog(
            LeaveControlCopy.endDialog(),
            isPresented: Binding(
                get: {
                    confirmationId != closedConfirmationId
                        && LeaveControlPolicy.presentsDialog(leave, includesMoreInvoker: false)
                        && !leave.offersRecap
                },
                set: { shown in
                    if shown || confirmationId == 0 { return }
                    closedConfirmationId = confirmationId

                    Task { @MainActor in
                        if controls.leaveState.confirmationId == confirmationId {
                            controls.cancelEnd(id: confirmationId)
                        }
                    }
                }
            ),
            identifier: LeaveControlPolicy.dialogIdentifier,
            onConfirm: { _ = controls.confirmEndForEveryone(id: confirmationId, postRecap: false) },
            onCancel: { controls.cancelEnd(id: confirmationId) }
        )

        .recapEndDialog(
            controls: controls,
            confirmationId: confirmationId,
            isPresented: Binding(
                get: {
                    confirmationId != closedConfirmationId
                        && LeaveControlPolicy.presentsDialog(leave, includesMoreInvoker: false)
                        && leave.offersRecap
                },
                set: { shown in
                    if shown || confirmationId == 0 { return }
                    closedConfirmationId = confirmationId
                    Task { @MainActor in
                        if controls.leaveState.confirmationId == confirmationId {
                            controls.cancelEnd(id: confirmationId)
                        }
                    }
                }
            ),
            identifier: LeaveControlPolicy.dialogIdentifier + ".recap",
            onCancel: { controls.cancelEnd(id: confirmationId) }
        )
        .onChange(of: confirmationId) { _, _ in

            let current = controls.leaveState
            if LeaveControlPolicy.playsPrompt(previousId: lastPromptedId, leave: current, includesMoreInvoker: false) {
                promptCounter += 1
            }
            lastPromptedId = current.confirmationId
        }
        .conclaveGestureFeedback(.endForEveryonePrompted, trigger: promptCounter)
    }
}

private struct LeaveGlyph: View {
    let diameter: CGFloat
    let isLeaving: Bool

    var body: some View {
        ZStack {
            if isLeaving {
                ProgressView()
                    .controlSize(.small)
                    .tint(HostingTheme.token(DesignTokens.neutralWhite))
                    .accessibilityHidden(true)
            } else {
                Image(systemName: ConclaveSymbols.phoneDownFill)
                    .font(.title3)
                    .imageScale(.medium)
                    .accessibilityHidden(true)
            }
        }
        .foregroundStyle(HostingTheme.token(DesignTokens.neutralWhite))
        .frame(width: diameter, height: diameter)
        .background(HostingTheme.inCallLeave, in: Circle())
        .contentShape(Circle())
    }
}

private struct LeaveControlButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? CallControlsCopy.pressedOpacity : 1)
    }
}

private struct LeaveControlValue: ViewModifier {
    let text: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let text {
            content.accessibilityValue(text)
        } else {
            content
        }
    }
}

enum LeaveControlCopy {
    static var leaveTitle: String { ConclaveStrings.text("Leave Call") }

    static var endActionTitle: String { ConclaveStrings.text("End Call for Everyone") }

    static func menuTitles() -> LeaveMenuTitles {
        LeaveMenuTitles(
            leave: ConclaveStrings.text("Leave Call"),
            endForEveryone: ConclaveStrings.text("End Call for Everyone…"),
            reconnecting: ConclaveStrings.text("Available after reconnecting"),
            offline: ConclaveStrings.text("Available when you’re back online"),
            ending: ConclaveStrings.text("Ending…")
        )
    }

    static func endDialog() -> ConclaveDialogModel {
        ConclaveDialogModel(
            kind: ConclaveDialogKind.confirmation,
            title: ConclaveStrings.text("End Call for Everyone?"),
            message: ConclaveStrings.text("Everyone, including people waiting to join, will be disconnected."),
            confirmTitle: ConclaveStrings.text("End Call for Everyone"),
            confirmRole: ConclaveDialogRole.destructive
        )
    }
}
#endif
