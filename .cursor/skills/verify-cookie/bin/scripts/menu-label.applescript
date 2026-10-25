-- VoiceOver label of the menu-bar item. Does not open the menu.
on run
	set rawDesc to missing value
	set rawTitle to missing value
	tell application "System Events"
		if not (exists process "CookieAgent") then error "CookieAgent is not running"
		tell process "CookieAgent"
			set statusItem to missing value
			repeat with barIndex from 1 to (count of menu bars)
				if (count of menu bar items of menu bar barIndex) > 0 then
					set statusItem to menu bar item 1 of menu bar barIndex
				end if
			end repeat
			if statusItem is missing value then error "no menu bar item"
			try
				set rawDesc to description of statusItem
			end try
			try
				set rawTitle to value of attribute "AXDescription" of statusItem
			end try
		end tell
	end tell
	set fromDesc to my coerceToString(rawDesc)
	if fromDesc is not "" then return fromDesc
	return my coerceToString(rawTitle)
end run

on coerceToString(rawValue)
	if rawValue is missing value then return ""
	try
		return rawValue as string
	on error
		return ""
	end try
end coerceToString
