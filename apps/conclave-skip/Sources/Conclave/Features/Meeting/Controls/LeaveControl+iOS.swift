#if os(iOS) && !SKIP
import SwiftUI

// S30 4 c (CTL-2): the Leave control on the iOS bar. One tap leaves for everyone (Q9 glyph-only red circle, "Leave Call"
// on every composition, Owner OQ3); a host also gets the long-press menu (`Menu(primaryAction:)` with
// `.menuOrder(.priority)`: Leave Call nearest the control, End Call for Everyone… farthest, after a separator, no icons;
// CL5, CL15, RECONCILE R8) and the "End Call for Everyone" accessibility action, so End never depends on a long press.
// The End confirmation is the FND-1 dialog (F00 C18, `conclaveDialog`) attached to this control, so it originates from
// it (a popover on iPad) and belongs to it (R09). The view reads only `controls.leaveState` (4 k). No haptic on Leave,
// on the menu, on Cancel or on success (Q11); `endForEveryonePrompted` plays once per new confirmation (4 h). Never
// glass: the opaque `HostingTheme.inCallLeave` fill (Owner OQ4 high-contrast red under Increase Contrast).

struct LeaveControl: View {
    let controls: CallControlsPresenter
    let diameter: CGFloat
    /// The uncapped accessibility text size from `CallControlBar` (the bar caps its own text at `.xxxLarge`), so this
    /// view reads no environment for it (4 c).
    let isAccessibilityText: Bool
    @State private var promptCounter = 0
    @State private var lastPromptedId = 0
    /// The confirmation this control already closed (a dialog button or a tap outside), so the binding never shows it
    /// again while S1 catches up.
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
                    // A dialog button's action and this dismissal may arrive in either order: cancel on the next turn,
                    // when a confirm has already consumed the id (S1 then ignores the cancel), so a tap outside the iPad
                    // popover still clears the confirmation and Confirm is never lost.
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
        // TRN-2 (S30 4 g recap variant, CC8): the same confirmation shows the recap dialog while the recap is on offer.
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
            // 4 h: once per new confirmation this control presents (menu item, accessibility action or Retry).
            let current = controls.leaveState
            if LeaveControlPolicy.playsPrompt(previousId: lastPromptedId, leave: current, includesMoreInvoker: false) {
                promptCounter += 1
            }
            lastPromptedId = current.confirmationId
        }
        .conclaveGestureFeedback(.endForEveryonePrompted, trigger: promptCounter)
    }
}

/// The glyph-only red circle at the toggles' diameter (F00 C04 c, Q9). While leaving, a white system spinner replaces
/// the glyph (R13: system spinner only).
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

/// The press response of an opaque control (the same 60% dimming as the WP1-2b Leave button); the menu adopts it
/// through `.menuStyle(.button)`.
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

/// iOS copy for Leave and End (S30 4 g, RECONCILE R6; Apple title case). String Catalog keys through `ConclaveStrings`.
enum LeaveControlCopy {
    static var leaveTitle: String { ConclaveStrings.text("Leave Call") }
    /// The accessibility action's name (no ellipsis: it opens the confirmation directly, 4 g).
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

    /// The End confirmation (F00 C18 b, c): the destructive confirm and Cancel only (no extra Leave button; R6).
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
