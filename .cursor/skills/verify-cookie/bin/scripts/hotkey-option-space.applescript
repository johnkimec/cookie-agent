-- Synthetic ⌥Space. Carbon RegisterEventHotKey may ignore it.
-- key code 49 is the space bar.
on run
	tell application "System Events"
		key code 49 using option down
	end tell
end run
