// swift-tools-version: 5.9
// This is a Skip (https://skip.tools) package.
import PackageDescription

let package = Package(
    name: "Conclave",
    defaultLocalization: "en",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "Conclave", type: .dynamic, targets: ["Conclave"]),
    ],
    dependencies: [
        .package(url: "https://github.com/skiptools/skip.git", from: "1.9.8"),
        .package(url: "https://github.com/skiptools/skip-ui.git", from: "1.59.3"),
        .package(url: "https://github.com/skiptools/skip-fuse.git", from: "1.0.3"),
        .package(url: "https://github.com/skiptools/skip-model.git", from: "1.7.9"),
        .package(url: "https://github.com/skiptools/skip-kit.git", from: "1.1.3"),
        .package(url: "https://github.com/google/GoogleSignIn-iOS", from: "10.0.0"),
        .package(url: "https://github.com/socketio/socket.io-client-swift.git", from: "16.1.1"),
        .package(url: "https://github.com/VLprojects/mediasoup-client-swift", from: "0.13.2")
    ],
    targets: [
        .target(name: "Conclave", dependencies: [
            .product(name: "SkipDrive", package: "skip"),
            .product(name: "SkipUI", package: "skip-ui"),
            .product(name: "SkipFuse", package: "skip-fuse"),
            .product(name: "SkipModel", package: "skip-model"),
            .product(name: "SkipKit", package: "skip-kit"),
            .product(name: "GoogleSignIn", package: "GoogleSignIn-iOS", condition: .when(platforms: [.iOS])),
            .product(name: "SocketIO", package: "socket.io-client-swift", condition: .when(platforms: [.iOS])),
            .product(name: "Mediasoup", package: "mediasoup-client-swift", condition: .when(platforms: [.iOS]))
        ], resources: [.process("Resources")], plugins: [.plugin(name: "skipstone", package: "skip")]),
        .testTarget(name: "ConclaveTests", dependencies: [
            "Conclave",
            .product(name: "SkipTest", package: "skip", condition: .when(platforms: [.macOS, .linux])),
        ], resources: [.process("Resources")], plugins: [.plugin(name: "skipstone", package: "skip")]),
    ]
)
