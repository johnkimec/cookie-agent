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
			click statusItem
			delay 0.3
			click menu item "Quit Cookie" of menu 1 of statusItem
		end tell
	end tell
end run
