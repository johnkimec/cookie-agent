-- Drive cookie.popup.input without keystrokes.
-- argv: set | confirm | cancel | press <action name>
-- set reads the text from the environment variable COOKIE_AX_TEXT.
on run argv
	if (count of argv) < 1 then error "popup-action needs a command"
	set command to item 1 of argv
	set actionName to ""
	if (count of argv) ≥ 2 then set actionName to item 2 of argv
	set fieldText to system attribute "COOKIE_AX_TEXT"
	if fieldText is missing value then set fieldText to ""
	set cookieProc to my cookieDriveProcess()
	tell application "System Events"
		tell cookieProc
			set popupWindow to missing value
			repeat with candidate in windows
				if my windowName(candidate) is "Ask Cookie…" then set popupWindow to candidate
			end repeat
			if popupWindow is missing value then
				repeat with candidate in windows
					if my subroleText(candidate) is "AXSystemDialog" then set popupWindow to candidate
				end repeat
			end if
			if popupWindow is missing value then error "no Ask Cookie window"
			set nodes to entire contents of popupWindow
			set inputElem to missing value
			repeat with elem in nodes
				if my axid(elem) is "cookie.popup.input" then
					set theRole to my roleText(elem)
					if theRole is "AXTextArea" or theRole is "AXTextField" or inputElem is missing value then
						set inputElem to elem
					end if
				end if
			end repeat
			if inputElem is missing value then error "missing cookie.popup.input"
			if command is "set" then
				set value of inputElem to fieldText
				return "set"
			else if command is "confirm" then
				perform action "AXConfirm" of inputElem
				return "confirm"
			else if command is "cancel" then
				perform action "AXCancel" of inputElem
				return "cancel"
			else if command is "press" then
				if actionName is "" then error "press needs an action name"
				try
					perform action actionName of inputElem
					return "press " & actionName
				on error errText
					error errText & " actions: " & my actionNames(inputElem)
				end try
			else
				error "unknown popup-action " & command
			end if
		end tell
	end tell
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

on roleText(elem)
	set rawValue to missing value
	tell application "System Events"
		try
			set rawValue to role of elem
		end try
	end tell
	return my coerceToString(rawValue)
end roleText

on axid(elem)
	tell application "System Events"
		try
			return value of attribute "AXIdentifier" of elem
		on error
			return ""
		end try
	end tell
end axid

on actionNames(elem)
	set namesList to {}
	tell application "System Events"
		try
			set namesList to name of every action of elem
		end try
	end tell
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to ", "
	set joined to namesList as string
	set AppleScript's text item delimiters to oldDelims
	return joined
end actionNames

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
