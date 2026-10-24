// swift-tools-version: 6.0

import PackageDescription

// Compile stub for the future non-sandboxed SwiftUI shell.
// No app target, entitlements, or macOS integrations yet.
let package = Package(
    name: "CookieAgentApp",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "CookieAgentApp", targets: ["CookieAgentApp"])
    ],
    targets: [
        .target(name: "CookieAgentApp")
    ]
)
