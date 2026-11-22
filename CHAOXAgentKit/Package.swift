// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CHAOXAgentKit",
    defaultLocalization: "en",
    platforms: [
        .iOS(.v18),
        .macOS(.v15)
    ],
    products: [
        .library(
            name: "CHAOXAgentKit",
            targets: ["CHAOXAgentKit"]
        )
    ],
    targets: [
        .target(
            name: "CHAOXAgentKit",
            resources: [
                .process("Resources")
            ]
        ),
        .testTarget(
            name: "CHAOXAgentKitTests",
            dependencies: ["CHAOXAgentKit"]
        )
    ]
)
