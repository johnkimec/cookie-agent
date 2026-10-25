-- Option-click the status item. The panel reads NSEvent.modifierFlags.
on run
	set cookieProc to my cookieDriveProcess()
	tell application "System Events"
		tell cookieProc
			set statusItem to missing value
			repeat with barIndex from 1 to (count of menu bars)
				if (count of menu bar items of menu bar barIndex) > 0 then
					set statusItem to menu bar item 1 of menu bar barIndex
				end if
			end repeat
			if statusItem is missing value then error "no menu bar item"
		end tell
		key down option
		delay 0.1
		try
			tell cookieProc to click statusItem
			key up option
		on error errText
			try
				key up option
			end try
			error errText
		end try
	end tell
end run
