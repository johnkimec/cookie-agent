# assets

Rive files and static poses for Cookie live here.

`cookie-mascot.png` is a square crop of John's photo of Cookie. The popup and the menu bar draw the path mascot in `CookieMark.swift`. The app target symlinks `app/Sources/CookieAgent/Resources/cookie-mascot.png` at this file so SwiftPM can bundle the photo. Reduced to its alpha at 18 px the photo is a solid blob, and a template image has to stay legible when macOS tints it.

Cookie is a white maltipoo (Maltese × poodle), flat and low-detail, animated with Rive. The character has nine states: Idle, Listening, Thinking, Talking, Happy, Needs you, Sleeping, Error, and Offline. Reduce Motion uses the static pose of each state. The menu bar uses static template images, not a live Rive view. Widgets use exported static poses.

Until `cookie.riv` exists, the popup and the menu bar use that path drawing. Rive is still the animation plan.

Cookie's name and this art are **not** covered by the Apache-2.0 code license. See [BRAND.md](../BRAND.md). Forks rename the product and supply their own mascot.
