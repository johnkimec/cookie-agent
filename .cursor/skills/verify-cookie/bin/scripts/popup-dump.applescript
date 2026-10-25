-- One element per line: id, role, value, label, enabled.
-- Newlines in value and label are escaped as \n. A geom line follows
-- when position and size are readable.
-- A handler tells System Events itself. attribute is not in scope otherwise.
on run
	set linesOut to {}
	tell application "System Events"
		if not (exists process "CookieAgent") then error "CookieAgent is not running"
		tell process "CookieAgent"
			set popupWindow to missing value
			repeat with candidate in windows
				if my windowName(candidate) is "Ask Cookie…" or my subroleText(candidate) is "AXSystemDialog" then
					set popupWindow to candidate
				end if
			end repeat
			if popupWindow is missing value then error "no Ask Cookie window"
			set end of linesOut to "meta" & tab & "title" & tab & my escapeValue(my windowName(popupWindow)) & tab & my escapeValue(my subroleText(popupWindow)) & tab & ""
			set windowId to my axid(popupWindow)
			if windowId is not "" then
				set end of linesOut to windowId & tab & "AXWindow" & tab & "" & tab & my axlabel(popupWindow) & tab & ""
				set end of linesOut to "geom" & tab & windowId & tab & my geomOf(popupWindow)
			end if
			set nodes to entire contents of popupWindow
			repeat with elem in nodes
				set theId to my axid(elem)
				if theId is not "" then
					set theRole to ""
					try
						set theRole to role of elem
					end try
					set end of linesOut to theId & tab & my coerceToString(theRole) & tab & my axvalue(elem) & tab & my axlabel(elem) & tab & my axenabled(elem)
					set end of linesOut to "geom" & tab & theId & tab & my geomOf(elem)
				end if
			end repeat
		end tell
	end tell
	if linesOut is {} then error "popup exposed no AXIdentifier"
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to linefeed
	set output to linesOut as string
	set AppleScript's text item delimiters to oldDelims
	return output
end run

on windowName(elem)
	set rawValue to missing value
	tell application "System Events"
		try
			set rawValue to name of elem
		end try
	end tell
	return my coerceToString(rawValue)
end windowName

on subroleText(elem)
	set rawValue to missing value
	tell application "System Events"
		try
			set rawValue to subrole of elem
		end try
	end tell
	return my coerceToString(rawValue)
end subroleText

on axid(elem)
	tell application "System Events"
		try
			return value of attribute "AXIdentifier" of elem
		on error
			return ""
		end try
	end tell
end axid

on axvalue(elem)
	set rawValue to missing value
	tell application "System Events"
		try
			set rawValue to value of elem
		end try
	end tell
	return my escapeValue(my coerceToString(rawValue))
end axvalue

on axlabel(elem)
	set rawDesc to missing value
	set rawHelp to missing value
	tell application "System Events"
		try
			set rawDesc to description of elem
		end try
		try
			set rawHelp to help of elem
		end try
	end tell
	set fromDesc to my coerceToString(rawDesc)
	if fromDesc is not "" then return my escapeValue(fromDesc)
	return my escapeValue(my coerceToString(rawHelp))
end axlabel

on axenabled(elem)
	set rawValue to missing value
	tell application "System Events"
		try
			set rawValue to value of attribute "AXEnabled" of elem
		end try
	end tell
	if rawValue is missing value then return ""
	if rawValue is true then return "true"
	if rawValue is false then return "false"
	return my escapeValue(my coerceToString(rawValue))
end axenabled

on geomOf(elem)
	set rawPos to missing value
	set rawSize to missing value
	tell application "System Events"
		try
			set rawPos to position of elem
		end try
		try
			set rawSize to size of elem
		end try
	end tell
	if class of rawPos is not list then return "missing"
	if class of rawSize is not list then return "missing"
	if (count of rawPos) < 2 then return "missing"
	if (count of rawSize) < 2 then return "missing"
	return (item 1 of rawPos as integer) & " " & (item 2 of rawPos as integer) & " " & (item 1 of rawSize as integer) & " " & (item 2 of rawSize as integer)
end geomOf

on escapeValue(rawText)
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to linefeed
	set parts to text items of rawText
	set AppleScript's text item delimiters to "\\n"
	set escaped to parts as string
	set AppleScript's text item delimiters to tab
	set parts to text items of escaped
	set AppleScript's text item delimiters to " "
	set escaped to parts as string
	set AppleScript's text item delimiters to oldDelims
	return escaped
end escapeValue

on coerceToString(rawValue)
	if rawValue is missing value then return ""
	set oldDelims to AppleScript's text item delimiters
	try
		if class of rawValue is list then
			set AppleScript's text item delimiters to " "
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
