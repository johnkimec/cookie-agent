-- Prepended by osascript_run. Callers use `my cookieDriveProcess()`.
-- The pid, process name, and bundle id are set only for this osascript.
-- A mismatch on any of the three is an error. The product name and bundle id never match.
on cookieDriveProcess()
  set rawPid to system attribute "COOKIE_DRIVE_PID"
  if rawPid is missing value or rawPid is "" then error "COOKIE_DRIVE_PID is not set"
  try
    set drivePid to rawPid as integer
  on error
    error "COOKIE_DRIVE_PID is not an integer"
  end try
  if drivePid is less than 2 then error "COOKIE_DRIVE_PID is not a drive pid"
  set expectedName to system attribute "COOKIE_DRIVE_PROCESS_NAME"
  if expectedName is missing value or expectedName is "" then error "COOKIE_DRIVE_PROCESS_NAME is not set"
  set expectedBundle to system attribute "COOKIE_DRIVE_BUNDLE_ID"
  if expectedBundle is missing value or expectedBundle is "" then error "COOKIE_DRIVE_BUNDLE_ID is not set"
  if expectedName is "CookieAgent" then error "refusing the product process name"
  if expectedBundle is "com.johnkimec.cookie-agent" then error "refusing the installed bundle id"
  tell application "System Events"
    set matches to every process whose unix id is drivePid
    if (count of matches) is not 1 then error "expected exactly one process for drive pid " & drivePid & ", found " & (count of matches)
    set driveProc to item 1 of matches
    if name of driveProc is not expectedName then error "drive pid " & drivePid & " process name does not match the launched executable"
    if bundle identifier of driveProc is not expectedBundle then error "drive pid " & drivePid & " bundle id does not match the launched app"
    return driveProc
  end tell
end cookieDriveProcess
