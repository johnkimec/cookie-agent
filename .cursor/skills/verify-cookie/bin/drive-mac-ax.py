#!/usr/bin/env python3
"""Pid-targeted AX helpers for drive-mac.

Option-click posts one mouse down and one mouse up to the drive pid with the
Option flag on those events. It does not hold Option down. The popup capture
uses screencapture -l on the Ask Cookie window and never the whole display.
"""

import ctypes
import subprocess
import sys


def cg_point_from_ax(ax_x, ax_y, width, height, screen_height):
    """AX origin is the top left. CoreGraphics origin is the bottom left."""
    if width <= 0 or height <= 0 or screen_height <= 0:
        raise ValueError("size")
    x = float(ax_x) + float(width) / 2.0
    y = float(screen_height) - (float(ax_y) + float(height) / 2.0)
    if x < 0 or y < 0 or y > float(screen_height):
        raise ValueError("off-screen")
    return (x, y)


def window_contains(window, x, y):
    bounds = window.get("bounds")
    if not bounds or len(bounds) != 4:
        return False
    origin_x, origin_y, width, height = bounds
    if width <= 0 or height <= 0:
        return False
    return origin_x <= x < origin_x + width and origin_y <= y < origin_y + height


def owner_at_point(windows, x, y):
    """Front-to-back. The first window whose bounds contain the point."""
    for window in windows:
        if window_contains(window, x, y):
            return window
    return None


def decide_click_point(windows, x, y, drive_pid):
    """desktop, drive, or skip. skip means click nothing."""
    window = owner_at_point(windows, x, y)
    if window is None:
        return "skip"
    if int(window.get("pid", -1)) == int(drive_pid):
        return "drive"
    owner = window.get("owner") or ""
    name = window.get("name") or ""
    if owner == "Window Server" and name in ("", "Desktop", "Desktop Picture", "Wallpaper"):
        return "desktop"
    return "skip"


def select_window(windows, pid, title):
    """The one on-screen window of this pid that includes the title."""
    matches = []
    for window in windows:
        if int(window.get("pid", -1)) != int(pid):
            continue
        name = window.get("name") or ""
        if title not in name:
            continue
        matches.append(window)
    if len(matches) != 1:
        return None
    return int(matches[0]["id"])


def parse_frame(text):
    parts = text.strip().split(",")
    if len(parts) != 4:
        raise ValueError("frame")
    return tuple(int(part) for part in parts)


def _framework(path):
    return ctypes.CDLL(path)


def _screen_height(cg):
    cg.CGMainDisplayID.restype = ctypes.c_uint32
    cg.CGDisplayPixelsHigh.argtypes = [ctypes.c_uint32]
    cg.CGDisplayPixelsHigh.restype = ctypes.c_size_t
    return int(cg.CGDisplayPixelsHigh(cg.CGMainDisplayID()))


def post_option_click(pid, cg_x, cg_y):
    """One left click at a CoreGraphics point, delivered only to pid."""

    class CGPoint(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

    cg = _framework("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    cf = _framework("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
    cg.CGEventCreateMouseEvent.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        CGPoint,
        ctypes.c_uint32,
    ]
    cg.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
    cg.CGEventPostToPid.argtypes = [ctypes.c_int32, ctypes.c_void_p]
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    point = CGPoint(float(cg_x), float(cg_y))
    # kCGEventFlagMaskAlternate. The flag is on the click, then the events end.
    alternate = 1 << 19
    for event_type in (1, 2):
        event = cg.CGEventCreateMouseEvent(None, event_type, point, 0)
        if not event:
            raise RuntimeError("CGEventCreateMouseEvent failed")
        cg.CGEventSetFlags(event, alternate)
        cg.CGEventPostToPid(int(pid), event)
        cf.CFRelease(event)


def _cfstring(cf, text):
    cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    created = cf.CFStringCreateWithCString(None, text.encode("utf-8"), 0x08000100)
    if not created:
        raise RuntimeError("CFStringCreateWithCString failed")
    return created


def _cfnumber(cf, value):
    raw = ctypes.c_int64(0)
    cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    cf.CFNumberGetValue.restype = ctypes.c_bool
    # kCFNumberSInt64Type. value is a borrowed CFNumberRef.
    if not cf.CFNumberGetValue(value, 4, ctypes.byref(raw)):
        return None
    return int(raw.value)


def _cf_flexible_number(cf, value):
    if not value:
        return None
    cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    cf.CFNumberGetValue.restype = ctypes.c_bool
    raw = ctypes.c_double(0)
    # kCFNumberDoubleType, kCFNumberFloat64Type, kCFNumberCGFloatType.
    for kind in (13, 6, 16):
        if cf.CFNumberGetValue(value, kind, ctypes.byref(raw)):
            return float(raw.value)
    whole = _cfnumber(cf, value)
    if whole is None:
        return None
    return float(whole)


def copy_windows():
    cg = _framework("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    cf = _framework("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
    cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    cf.CFArrayGetCount.restype = ctypes.c_long
    cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
    cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
    cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
    cf.CFDictionaryGetValue.restype = ctypes.c_void_p
    cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    cf.CFGetTypeID.restype = ctypes.c_ulong
    cf.CFGetTypeID.argtypes = [ctypes.c_void_p]
    cf.CFStringGetTypeID.restype = ctypes.c_ulong
    cf.CFNumberGetTypeID.restype = ctypes.c_ulong
    cf.CFDictionaryGetTypeID.restype = ctypes.c_ulong
    cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
    cf.CFStringGetCString.restype = ctypes.c_bool
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    # kCGWindowListOptionOnScreenOnly
    info = cg.CGWindowListCopyWindowInfo(1, 0)
    if not info:
        return []
    keys = {
        "pid": _cfstring(cf, "kCGWindowOwnerPID"),
        "name": _cfstring(cf, "kCGWindowName"),
        "owner": _cfstring(cf, "kCGWindowOwnerName"),
        "id": _cfstring(cf, "kCGWindowNumber"),
        "bounds": _cfstring(cf, "kCGWindowBounds"),
    }
    bound_keys = {name: _cfstring(cf, name) for name in ("X", "Y", "Width", "Height")}
    string_type = cf.CFStringGetTypeID()
    number_type = cf.CFNumberGetTypeID()
    dict_type = cf.CFDictionaryGetTypeID()
    windows = []
    try:
        count = cf.CFArrayGetCount(info)
        for index in range(count):
            entry = cf.CFArrayGetValueAtIndex(info, index)
            window = {}
            for field, key in keys.items():
                value = cf.CFDictionaryGetValue(entry, key)
                if not value:
                    continue
                kind = cf.CFGetTypeID(value)
                if kind == number_type:
                    number = _cfnumber(cf, value)
                    if number is not None:
                        window[field] = number
                elif kind == string_type:
                    buffer = ctypes.create_string_buffer(1024)
                    if cf.CFStringGetCString(value, buffer, len(buffer), 0x08000100):
                        window[field] = buffer.value.decode("utf-8", "replace")
                elif kind == dict_type and field == "bounds":
                    coords = []
                    for name in ("X", "Y", "Width", "Height"):
                        part = cf.CFDictionaryGetValue(value, bound_keys[name])
                        number = _cf_flexible_number(cf, part)
                        if number is None:
                            coords = []
                            break
                        coords.append(number)
                    if len(coords) == 4:
                        window["bounds"] = tuple(coords)
            if "pid" in window and "id" in window:
                windows.append(window)
    finally:
        cf.CFRelease(info)
        for key in keys.values():
            cf.CFRelease(key)
        for key in bound_keys.values():
            cf.CFRelease(key)
    return windows


def capture_window(pid, title, dest):
    window_id = select_window(copy_windows(), pid, title)
    if window_id is None:
        raise RuntimeError("popup window was not found for pid %s" % pid)
    subprocess.run(
        ["screencapture", "-l", str(window_id), "-x", dest],
        check=True,
    )


def option_click(pid, frame_text):
    ax_x, ax_y, width, height = parse_frame(frame_text)
    cg = _framework("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    cg_x, cg_y = cg_point_from_ax(ax_x, ax_y, width, height, _screen_height(cg))
    post_option_click(pid, cg_x, cg_y)


def main(argv):
    if len(argv) < 2:
        return "usage: drive-mac-ax.py option-click|capture-window|window-at ..."
    command = argv[1]
    if command == "window-at":
        if len(argv) != 5:
            return "usage: drive-mac-ax.py window-at PID X Y"
        print(decide_click_point(copy_windows(), float(argv[3]), float(argv[4]), int(argv[2])))
        return None
    if command == "option-click":
        if len(argv) != 4:
            return "usage: drive-mac-ax.py option-click PID x,y,w,h"
        option_click(int(argv[2]), argv[3])
        return None
    if command == "capture-window":
        if len(argv) != 5:
            return "usage: drive-mac-ax.py capture-window PID TITLE DEST"
        capture_window(int(argv[2]), argv[3], argv[4])
        return None
    return "unknown command"


if __name__ == "__main__":
    error = main(sys.argv)
    if error:
        print(error, file=sys.stderr)
        sys.exit(1)
