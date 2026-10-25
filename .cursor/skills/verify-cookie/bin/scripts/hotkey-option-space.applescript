-- Option-space is sent by send_key_code in drive-mac, which checks the
-- frontmost pid, process name, and bundle id. This file does not send a key.
on run
	error "call send_key_code 49 option"
end run
