-- Read the Local-only check mark. The mark is state, not the item name.
-- argv 1, when set, is a screencapture path taken while the menu is open.
on run argv
	set shot to ""
	if (count of argv) ≥ 1 then set shot to item 1 of argv
	set foundId to ""
	set foundName to missing value
	set foundMark to ""
	set foundValue to ""
	set nameList to {}
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
			click statusItem
			delay 0.5
			set itemCount to 0
			try
				set itemCount to count of menu items of menu 1 of statusItem
			end try
			if itemCount is 0 then
				click statusItem
				delay 0.5
			end if
			set menuItems to menu items of menu 1 of statusItem
			repeat with menuItem in menuItems
				set rawName to missing value
				try
					set rawName to name of menuItem
				end try
				set end of nameList to my coerceToString(rawName)
				if my axid(menuItem) is "cookie.menu.local-only" then
					set foundId to "cookie.menu.local-only"
					set foundName to rawName
					set foundMark to my markChar(menuItem)
					set foundValue to my itemValue(menuItem)
				end if
			end repeat
			if shot is not "" then
				do shell script "screencapture -x " & quoted form of shot
			end if
			click statusItem
		end tell
	end tell
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to " | "
	set namesLine to nameList as string
	set AppleScript's text item delimiters to oldDelims
	return "id " & foundId & linefeed & "name " & my coerceToString(foundName) & linefeed & "mark " & foundMark & linefeed & "value " & foundValue & linefeed & "items " & my coerceToString(namesLine)
end run

on axid(elem)
	tell application "System Events"
		try
			return value of attribute "AXIdentifier" of elem
		on error
			return ""
		end try
	end tell
end axid

on markChar(elem)
	set rawValue to missing value
	tell application "System Events"
		try
			set rawValue to value of attribute "AXMenuItemMarkChar" of elem
		end try
	end tell
	return my coerceToString(rawValue)
end markChar

on itemValue(elem)
	set rawValue to missing value
	tell application "System Events"
		try
			set rawValue to value of elem
		end try
	end tell
	return my coerceToString(rawValue)
end itemValue

on coerceToString(rawValue)
	if rawValue is missing value then return ""
	set oldDelims to AppleScript's text item delimiters
	try
		if class of rawValue is list then
			set AppleScript's text item delimiters to ""
			set joined to rawValue as string
			set AppleScript's text item delimiters to oldDelims
			return joined
		end if
		set AppleScript's text item delimiters to oldDelims
		return rawValue as string
	on error
		set AppleScript's text item delimiters to oldDelims
		return ""
	end try
end coerceToString
