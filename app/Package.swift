// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CookieAgentApp",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "CookieProtocol", targets: ["CookieProtocol"]),
        .library(name: "CookieCore", targets: ["CookieCore"]),
        .executable(name: "CookieAgent", targets: ["CookieAgent"])
    ],
    targets: [
        .target(name: "CookieProtocol"),
        .target(
            name: "CookieCore",
            dependencies: ["CookieProtocol"]
        ),
        .executableTarget(
            name: "CookieAgent",
            dependencies: ["CookieProtocol", "CookieCore"]
        ),
        .testTarget(
            name: "CookieProtocolTests",
            dependencies: ["CookieProtocol"]
        ),
        .testTarget(
            name: "CookieCoreTests",
            dependencies: ["CookieCore", "CookieProtocol"]
        )
    ]
)
