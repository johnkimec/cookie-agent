# app

Swift app shell for Cookie. Not implemented.

The shell will be a non-sandboxed Swift 6 / SwiftUI app: `MenuBarExtra`, a non-activating `NSPanel` on ⌥Space, a sandboxed WidgetKit extension, App Intents, notifications, and a supervisor for `llama-server`. It is the only process that holds macOS permissions and runs Mac tools. Minimum system: macOS 14.

Today this directory is a Swift package with one library target, so macOS CI can `swift build` it. There is no application target and no feature code.

## Planned layout

The UI spec sketches this under `apps/mac/`. It lives here as `app/` until the project doc is approved and the two trees are reconciled.

```text
app/
├── Package.swift                 SwiftPM manifest (library stub, Swift tools 6.0)
├── Sources/CookieAgentApp/       compile stub only
├── App/                          planned: MenuBarExtra, popup, settings
├── Widget/                       planned: WidgetKit extension (sandboxed)
├── Intents/                      planned: App Intents for the widget and Shortcuts
└── Resources/                    planned: default persona.md, asset catalog
```

An Xcode project can wrap this package later. Signing, entitlements, the widget, and the DMG are milestone work, not this skeleton.

## Build

On a Mac, from the repository root:

```bash
swift build --package-path app
```

Linux does not build this package. Core tests do not link it. See [AGENTS.md](../AGENTS.md).
