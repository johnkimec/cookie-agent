use framework "AppKit"
use scripting additions

on run
	set flag to current application's NSWorkspace's sharedWorkspace's accessibilityDisplayShouldReduceMotion()
	if (flag as integer) is 1 then return "yes"
	return "no"
end run
