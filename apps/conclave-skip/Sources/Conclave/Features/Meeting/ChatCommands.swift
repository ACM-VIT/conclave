//
//  ChatCommands.swift
//  Conclave
//
//  Chat command parsing and execution
//

import Foundation

// MARK: - Chat Command Types

enum ChatCommand: String, CaseIterable {
    case raise = "raise"
    case lower = "lower"
    case mute = "mute"
    case unmute = "unmute"
    case cameraOn = "cameraon"
    case cameraOff = "cameraoff"
    case help = "help"
    case clear = "clear"
    case leave = "leave"

    var displayName: String {
        switch self {
        case .raise: return "Raise Hand"
        case .lower: return "Lower Hand"
        case .mute: return "Mute"
        case .unmute: return "Unmute"
        case .cameraOn: return "Camera On"
        case .cameraOff: return "Camera Off"
        case .help: return "Help"
        case .clear: return "Clear chat"
        case .leave: return "Leave"
        }
    }

    var description: String {
        switch self {
        case .raise: return "Raise your hand"
        case .lower: return "Lower your hand"
        case .mute: return "Mute your microphone"
        case .unmute: return "Unmute your microphone"
        case .cameraOn: return "Turn on your camera"
        case .cameraOff: return "Turn off your camera"
        case .help: return "Show available commands"
        case .clear: return "Clear your local chat"
        case .leave: return "Leave the meeting"
        }
    }

    var icon: String {
        switch self {
        case .raise: return "hand.raised.fill"
        case .lower: return "hand.raised.slash.fill"
        case .mute: return "mic.slash.fill"
        case .unmute: return "mic.fill"
        case .cameraOn: return "video.fill"
        case .cameraOff: return "video.slash.fill"
        case .help: return "questionmark.circle.fill"
        case .clear: return "trash.fill"
        case .leave: return "rectangle.portrait.and.arrow.right.fill"
        }
    }
}

// MARK: - Parsed Command

struct ParsedCommand {
    let command: ChatCommand
    let arguments: [String]
    let originalText: String
}

// MARK: - Command Parser

struct ChatCommandParser {
    
    static func parse(_ text: String) -> ParsedCommand? {
        // Check if text starts with "/"
        guard text.hasPrefix("/") else { return nil }
        
        // Remove the leading "/"
        let withoutSlash = String(text.dropFirst())
        
        // Split by spaces to get command and arguments
        let components = withoutSlash.split(separator: " ", omittingEmptySubsequences: true)
        
        guard let commandPart = components.first else { return nil }
        
        let commandString = String(commandPart).lowercased()
        
        // Match command
        guard let command = ChatCommand(rawValue: commandString) else {
            return nil
        }
        
        // Get arguments (everything after the command)
        let arguments = components.dropFirst().map { String($0) }
        
        return ParsedCommand(
            command: command,
            arguments: arguments,
            originalText: text
        )
    }
    
    static func isCommandPrefix(_ text: String) -> Bool {
        return text.hasPrefix("/") && text.count == 1
    }
    
    static func matchesPartialCommand(_ text: String) -> [ChatCommand] {
        guard text.hasPrefix("/") else { return [] }
        
        let withoutSlash = String(text.dropFirst()).lowercased()
        
        if withoutSlash.isEmpty {
            return ChatCommand.allCases
        }
        
        return ChatCommand.allCases.filter { command in
            command.rawValue.hasPrefix(withoutSlash)
        }
    }
}

// MARK: - System Message

enum SystemMessageType {
    case commandExecuted(command: ChatCommand, userName: String)
    case commandFailed(command: ChatCommand, reason: String)
    case info(String)
}

/// A unified chat-log entry so user messages and system notes (slash-command
/// feedback) render in one timestamp-ordered timeline. Previously the chat view
/// iterated only `chatMessages`, so `systemMessages` (appended by every executed
/// command) were never shown and commands ran with no visible confirmation.
enum ChatTimelineEntry: Identifiable {
    case message(ChatMessage)
    case system(SystemMessage)

    var id: String {
        switch self {
        case .message(let m): return "m_\(m.id)"
        case .system(let s): return "s_\(s.id)"
        }
    }

    var timestamp: Date {
        switch self {
        case .message(let m): return m.timestamp
        case .system(let s): return s.timestamp
        }
    }
}

struct SystemMessage: Identifiable, Equatable {
    let id: String
    let type: SystemMessageType
    let timestamp: Date
    
    init(id: String = UUID().uuidString, type: SystemMessageType, timestamp: Date = Date()) {
        self.id = id
        self.type = type
        self.timestamp = timestamp
    }
    
    var displayText: String {
        switch type {
        case .commandExecuted(let command, let userName):
            return "\(userName) used /\(command.rawValue)"
        case .commandFailed(let command, let reason):
            return "Command /\(command.rawValue) failed: \(reason)"
        case .info(let text):
            return text
        }
    }
    
    static func == (lhs: SystemMessage, rhs: SystemMessage) -> Bool {
        lhs.id == rhs.id &&
        lhs.timestamp == rhs.timestamp &&
        lhs.displayText == rhs.displayText
    }
}
