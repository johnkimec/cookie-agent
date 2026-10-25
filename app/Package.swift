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
    dependencies: [
        // Tag v0.7.0. A version requirement cannot resolve: that tag pins
        // highlightswift and iosMath by revision, and SwiftPM rejects a
        // stable-version package that depends on an unstable one.
        .package(
            url: "https://github.com/microsoft/SwiftStreamingMarkdown",
            revision: "5f7c04e0558df6146f90d482edb62cb456986bda"
        )
    ],
    targets: [
        .target(name: "CookieProtocol"),
        .target(
            name: "CookieCore",
            dependencies: ["CookieProtocol"]
        ),
        .executableTarget(
            name: "CookieAgent",
            dependencies: [
                "CookieProtocol",
                "CookieCore",
                .product(name: "SwiftStreamingMarkdown", package: "SwiftStreamingMarkdown"),
            ]
        ),
        .testTarget(
            name: "CookieProtocolTests",
            dependencies: ["CookieProtocol"]
        ),
        .testTarget(
            name: "CookieCoreTests",
            dependencies: ["CookieCore", "CookieProtocol"]
        ),
        .testTarget(
            name: "CookieAgentTests",
            dependencies: ["CookieAgent", "CookieCore", "CookieProtocol"]
        )
    ]
)
