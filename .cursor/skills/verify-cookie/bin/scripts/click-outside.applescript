-- Click a point on the popup's screen, in the lower fifth, outside the panel.
-- CGWindow bounds and System Events `click at` both use a top-left origin.
use framework "CoreGraphics"
use framework "AppKit"
use scripting additions

on run
	set opts to 1
	set rawWindows to current application's CGWindowListCopyWindowInfo(opts, 0)
	set windowX to 0
	set windowY to 0
	set windowW to 0
	set windowH to 0
	set found to false
	repeat with entry in rawWindows
		set ownerObj to entry's valueForKey:"kCGWindowOwnerName"
		if ownerObj is missing value then
			set ownerName to ""
		else
			set ownerName to ownerObj as string
		end if
		if ownerName is "CookieAgent" then
			set bounds to entry's valueForKey:"kCGWindowBounds"
			set candidateW to (bounds's valueForKey:"Width") as real
			set candidateH to (bounds's valueForKey:"Height") as real
			if candidateW > windowW and candidateH > 40 then
				set windowX to (bounds's valueForKey:"X") as real
				set windowY to (bounds's valueForKey:"Y") as real
				set windowW to candidateW
				set windowH to candidateH
				set found to true
			end if
		end if
	end repeat
	if found is false then error "no CookieAgent window to click outside"
	set screens to current application's NSScreen's screens() as list
	set primaryH to 0
	repeat with screen in screens
		set frame to screen's frame()
		set originX to (frame's origin()'s x()) as real
		set originY to (frame's origin()'s y()) as real
		if originX = 0 and originY = 0 then
			set primaryH to (frame's size()'s height()) as real
		end if
	end repeat
	if primaryH is 0 then error "no primary screen"
	set clickX to 0
	set clickY to 0
	set placed to false
	repeat with screen in screens
		set vis to screen's visibleFrame()
		set vx to (vis's origin()'s x()) as real
		set vy to (vis's origin()'s y()) as real
		set vw to (vis's size()'s width()) as real
		set vh to (vis's size()'s height()) as real
		set cgX to vx
		set cgY to primaryH - vy - vh
		set centerX to windowX + windowW / 2
		set centerY to windowY + windowH / 2
		if centerX ≥ cgX and centerX ≤ cgX + vw and centerY ≥ cgY and centerY ≤ cgY + vh then
			set clickX to cgX + vw / 2
			set clickY to cgY + vh * 0.9
			set placed to true
		end if
	end repeat
	if placed is false then error "popup is not on a screen"
	if clickX ≥ windowX and clickX ≤ windowX + windowW and clickY ≥ windowY and clickY ≤ windowY + windowH then
		error "click point is inside the popup"
	end if
	tell application "System Events" to click at {clickX as integer, clickY as integer}
	return "clicked " & (clickX as integer) & " " & (clickY as integer)
end run
