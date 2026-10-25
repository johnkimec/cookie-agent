-- Print the Ask Cookie window in top-left points, then each screen's
-- visible frame in the same coordinates. Python checks the upper third.
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
			if candidateW > windowW then
				set windowX to (bounds's valueForKey:"X") as real
				set windowY to (bounds's valueForKey:"Y") as real
				set windowW to candidateW
				set windowH to (bounds's valueForKey:"Height") as real
				set found to true
			end if
		end if
	end repeat
	if found is false then error "no CookieAgent window"
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
	set output to "window " & windowX & " " & windowY & " " & windowW & " " & windowH
	repeat with screen in screens
		set vis to screen's visibleFrame()
		set vx to (vis's origin()'s x()) as real
		set vy to (vis's origin()'s y()) as real
		set vw to (vis's size()'s width()) as real
		set vh to (vis's size()'s height()) as real
		set cgY to primaryH - vy - vh
		set output to output & linefeed & "screen " & vx & " " & cgY & " " & vw & " " & vh
	end repeat
	return output
end run
