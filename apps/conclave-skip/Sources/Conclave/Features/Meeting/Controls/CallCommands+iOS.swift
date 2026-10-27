#if os(iOS) && !SKIP
import SwiftUI

// S30 1 g, CL21, CC20 (CTL-5): the hardware keyboard commands as one scene-level `CommandMenu("Call")`, registered by
// the Darwin app scene (`.commands { ConclaveCallCommands() }`, Darwin/Sources/Main.swift). The titles appear in the
// iPadOS 26 menu bar and in the Command-key overlay on iPadOS 17 to 25, whatever composition is on screen and whether or
// not More is open. Items read `controls.commands` (visible and enabled per item; Lock Meeting for hosts only) and call
// the same presenter intents as the bar (`perform(_:)`); keyboard commands play no haptic (S30 1 h). Outside a call the
// focused value is nil and the menu has no items. The bar sets the value with `.focusedSceneValue(controls)`
// (CallControlBar+iOS.swift). `FocusedValue(_:)` over an `@Observable` object and `focusedSceneValue(_:)` are iOS 17.

public struct ConclaveCallCommands: Commands {
    @FocusedValue(CallControlsPresenter.self) private var controls: CallControlsPresenter?

    public init() {}

    public var body: some Commands {
        CommandMenu(Text(CallCommandsCopy.menuTitle)) {
            if let controls {
                CallCommandButtons(controls: controls)
            }
        }
    }
}

/// The g table rows in order; reads only `controls.commands`.
private struct CallCommandButtons: View {
    let controls: CallControlsPresenter

    var body: some View {
        let commands = controls.commands
        ForEach(commands.items) { item in
            if item.isVisible {
                Button(CallCommandsCopy.title(item.command)) {
                    _ = controls.perform(item.command)
                }
                .keyboardShortcut(CallCommandsCopy.key(item.command), modifiers: CallCommandsCopy.modifiers(item.command))
                .disabled(!item.isEnabled)
            }
        }
    }
}

/// S30 1 g: Command-D, Command-E, Option-Command-H, Shift-Command-C, Shift-Command-P, Shift-Command-S and
/// Shift-Command-L, with the discoverability titles (Apple title case).
enum CallCommandsCopy {
    static var menuTitle: String { ConclaveStrings.text("Call") }

    static func title(_ command: CallCommandID) -> String {
        switch command {
        case .microphone: return ConclaveStrings.text("Mute or Unmute")
        case .camera: return ConclaveStrings.text("Turn Camera On or Off")
        case .hand: return ConclaveStrings.text("Raise or Lower Hand")
        case .chat: return ConclaveStrings.text("Show Chat")
        case .participants: return ConclaveStrings.text("Show Participants")
        case .screenShare: return ConclaveStrings.text("Share Screen")
        case .lockMeeting: return ConclaveStrings.text("Lock Meeting")
        }
    }

    static func key(_ command: CallCommandID) -> KeyEquivalent {
        switch command {
        case .microphone: return KeyEquivalent("d")
        case .camera: return KeyEquivalent("e")
        case .hand: return KeyEquivalent("h")
        case .chat: return KeyEquivalent("c")
        case .participants: return KeyEquivalent("p")
        case .screenShare: return KeyEquivalent("s")
        case .lockMeeting: return KeyEquivalent("l")
        }
    }

    static func modifiers(_ command: CallCommandID) -> EventModifiers {
        switch command {
        case .microphone, .camera: return [.command]
        case .hand: return [.command, .option]
        case .chat, .participants, .screenShare, .lockMeeting: return [.command, .shift]
        }
    }
}
#endif
