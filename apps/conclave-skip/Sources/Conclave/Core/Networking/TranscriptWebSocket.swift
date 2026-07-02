import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Minimal cross-platform text WebSocket used for the transcript worker stream.
/// iOS/macOS use `URLSessionWebSocketTask`; Android routes through an OkHttp
/// bridge (`TranscriptWebSocketBridge`). Only one connection is active at a time,
/// which is all the transcript feature needs.
@MainActor
final class TranscriptWebSocket {
    var onOpen: (() -> Void)?
    var onMessage: ((String) -> Void)?
    var onClosed: ((String?) -> Void)?

    #if SKIP
    func connect(urlString: String) {
        TranscriptWebSocketBridge.connect(url: urlString) { event, payload in
            Task { @MainActor in
                switch event {
                case "open":
                    self.onOpen?()
                case "message":
                    if let payload { self.onMessage?(payload) }
                case "closed", "error":
                    self.onClosed?(payload)
                default:
                    break
                }
            }
        }
    }

    func send(_ text: String) {
        TranscriptWebSocketBridge.send(text: text)
    }

    func close() {
        TranscriptWebSocketBridge.close()
    }
    #else
    private var task: URLSessionWebSocketTask?
    private var isActive = false

    func connect(urlString: String) {
        guard let url = URL(string: urlString) else {
            onClosed?("Invalid transcript worker URL.")
            return
        }
        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: url)
        self.task = task
        isActive = true
        task.resume()
        // URLSessionWebSocketTask buffers sends until the socket opens, so it's
        // safe to signal readiness now; a genuine failure surfaces via receive().
        onOpen?()
        receiveNext()
    }

    private func receiveNext() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.isActive else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        self.onMessage?(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.onMessage?(text)
                        }
                    @unknown default:
                        break
                    }
                    if self.isActive {
                        self.receiveNext()
                    }
                case .failure(let error):
                    self.isActive = false
                    self.onClosed?(error.localizedDescription)
                }
            }
        }
    }

    func send(_ text: String) {
        task?.send(.string(text)) { _ in }
    }

    func close() {
        isActive = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }
    #endif
}
