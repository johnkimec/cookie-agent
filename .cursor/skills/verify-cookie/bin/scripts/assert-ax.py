#!/usr/bin/env python3
"""Assertions for drive-mac recipes. Reads AX dumps. No UI."""

from __future__ import annotations

import pathlib
import sys


def unescape(value: str) -> str:
    return value.replace("\\n", "\n")


def parse_ax(text: str) -> tuple[dict[str, dict[str, str]], dict[str, str], dict[str, str]]:
    elems: dict[str, dict[str, str]] = {}
    counts: dict[str, int] = {}
    geoms: dict[str, str] = {}
    meta: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split("\t")
        if not parts or parts == [""]:
            continue
        if parts[0] == "geom" and len(parts) >= 3:
            geoms[parts[1]] = parts[2]
            continue
        if parts[0] == "meta" and len(parts) >= 4 and parts[1] == "title":
            meta["title"] = unescape(parts[2])
            meta["subrole"] = unescape(parts[3])
            continue
        if parts[0] in ("geom", "meta"):
            continue
        counts[parts[0]] = counts.get(parts[0], 0) + 1
        elems[parts[0]] = {
            "role": parts[1] if len(parts) > 1 else "",
            "value": unescape(parts[2] if len(parts) > 2 else ""),
            "label": unescape(parts[3] if len(parts) > 3 else ""),
            "enabled": parts[4] if len(parts) > 4 else "",
        }
    dupes = sorted(ident for ident, count in counts.items() if count > 1)
    if dupes:
        raise SystemExit("duplicate AX identifiers: " + ", ".join(dupes))
    return elems, geoms, meta


def row(text: str, ident: str) -> dict[str, str] | None:
    elems, _, _ = parse_ax(text)
    return elems.get(ident)


def geom(text: str, ident: str) -> list[float] | None:
    _, geoms, _ = parse_ax(text)
    raw = geoms.get(ident)
    if raw is None or raw == "missing":
        return None
    nums = raw.split()
    if len(nums) != 4:
        return None
    return [float(num) for num in nums]


def mark_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if " " in line:
            key, value = line.split(" ", 1)
            fields[key] = value
        elif line:
            fields[line] = ""
    return fields


def cmd_mark(path: str) -> None:
    fields = mark_fields(pathlib.Path(path).read_text())
    if fields.get("id") != "cookie.menu.local-only":
        raise SystemExit("id " + fields.get("id", ""))
    if fields.get("name") != "Local-only mode":
        raise SystemExit("name " + fields.get("name", ""))
    mark = fields.get("mark", "").strip()
    if mark in ("", "missing value", "0", "false"):
        raise SystemExit("unchecked mark=" + mark + " value=" + fields.get("value", ""))
    print("checked " + mark)


def cmd_field_label(path: str, expected: str) -> None:
    field = row(pathlib.Path(path).read_text(), "cookie.popup.input")
    if field is None:
        raise SystemExit("missing cookie.popup.input")
    if field["label"] != expected:
        raise SystemExit("label " + field["label"])
    print("label " + expected)


def cmd_panel(path: str) -> None:
    text = pathlib.Path(path).read_text()
    elems, _, meta = parse_ax(text)
    if meta.get("title") != "Ask Cookie…":
        raise SystemExit("title " + meta.get("title", ""))
    if meta.get("subrole") != "AXSystemDialog":
        raise SystemExit("subrole " + meta.get("subrole", ""))
    if "cookie.popup.input" not in elems or "cookie.popup" not in elems:
        raise SystemExit("missing popup identifiers")
    print("panel Ask Cookie… AXSystemDialog")


def cmd_layout(frames_path: str, ax_path: str) -> None:
    window = None
    screens: list[list[float]] = []
    for line in pathlib.Path(frames_path).read_text().splitlines():
        parts = line.split()
        if len(parts) == 5 and parts[0] == "window":
            window = [float(part) for part in parts[1:]]
        elif len(parts) == 5 and parts[0] == "screen":
            screens.append([float(part) for part in parts[1:]])
    if window is None or not screens:
        raise SystemExit("missing frames")
    x, y, width, height = window
    if abs(width - 560) > 2:
        raise SystemExit(f"width {width}")
    cx, cy = x + width / 2, y + height / 2
    host = None
    for sx, sy, sw, sh in screens:
        if sx - 4 <= cx <= sx + sw + 4 and sy - 4 <= cy <= sy + sh + 4:
            host = (sx, sy, sw, sh)
            break
    if host is None:
        raise SystemExit(f"window centre {cx},{cy} is not on a screen")
    sx, sy, sw, sh = host
    if abs(cx - (sx + sw / 2)) > 16:
        raise SystemExit(f"not centred {cx} vs {sx + sw / 2}")
    band = sy + sh / 6
    if abs(cy - band) > 24:
        raise SystemExit(f"not upper-third centre {cy} vs {band}")
    ax = pathlib.Path(ax_path).read_text()
    mascot = geom(ax, "cookie.popup.mascot")
    field = geom(ax, "cookie.popup.input")
    if mascot is None or field is None:
        raise SystemExit("missing mascot or input geometry")
    mx, my, mw, mh = mascot
    ix, iy, _iw, ih = field
    if abs(mw - 40) > 4 or abs(mh - 40) > 4:
        raise SystemExit(f"mascot size {mw}x{mh}")
    if not (mx < ix and mx + mw <= ix + 8):
        raise SystemExit(f"mascot x {mx} is not left of input x {ix}")
    if not (my < iy + ih and iy < my + mh):
        raise SystemExit("mascot does not sit on the input row")
    print(f"layout {width:.0f} wide, mascot {mw:.0f}")


def cmd_input_equals(path: str, expected: str, forbid_you: bool) -> None:
    text = pathlib.Path(path).read_text()
    field = row(text, "cookie.popup.input")
    if field is None or field["value"] != expected:
        raise SystemExit(repr(None if field is None else field["value"]))
    if forbid_you and row(text, "cookie.turn.you.0") is not None:
        raise SystemExit("field change submitted")
    print("input ok")


def cmd_line_cap(five_path: str, capped_path: str) -> None:
    five = row(pathlib.Path(five_path).read_text(), "cookie.popup.input")
    capped_text = pathlib.Path(capped_path).read_text()
    capped = row(capped_text, "cookie.popup.input")
    if five is None or five["value"].count("\n") + 1 != 5:
        raise SystemExit("lines " + repr(None if five is None else five["value"]))
    if capped is None or capped["value"] != five["value"]:
        raise SystemExit("sixth line changed the field")
    if row(capped_text, "cookie.turn.you.0") is not None:
        raise SystemExit("extra Shift-Return submitted")
    print("capped at 5")


def cmd_you_turn(path: str, expected: str) -> None:
    you = row(pathlib.Path(path).read_text(), "cookie.turn.you.0")
    if you is None or you["value"] != expected or you["label"] != "you":
        raise SystemExit(repr(you))
    print("sent")


def cmd_recall(path: str, expected: str) -> None:
    text = pathlib.Path(path).read_text()
    field = row(text, "cookie.popup.input")
    you = row(text, "cookie.turn.you.0")
    if field is None or field["value"] != expected:
        raise SystemExit("draft " + repr(None if field is None else field["value"]))
    if you is None or you["value"] != expected:
        raise SystemExit("you turn changed")
    print("recalled")


def cmd_loading(path: str, line_text: str, draft: str) -> None:
    text = pathlib.Path(path).read_text()
    elems, _, _ = parse_ax(text)
    send = elems.get("cookie.popup.send")
    line = elems.get("cookie.popup.loading")
    field = elems.get("cookie.popup.input")
    if send is None or send["enabled"].strip().lower() not in ("false", "0", "no"):
        raise SystemExit("send " + repr(None if send is None else send["enabled"]))
    if line is None or line["value"] != line_text:
        raise SystemExit("loading " + repr(None if line is None else line["value"]))
    if "cookie.popup.refusal" in elems:
        raise SystemExit("refusal was visible")
    if any(ident.startswith("cookie.turn.") for ident in elems):
        raise SystemExit("a turn was added")
    if field is None or field["value"] != draft:
        raise SystemExit("draft " + repr(None if field is None else field["value"]))
    print("loading line, send disabled, draft kept")


def cmd_down(path: str, refusal_text: str, draft: str) -> None:
    text = pathlib.Path(path).read_text()
    elems, _, _ = parse_ax(text)
    field = elems.get("cookie.popup.input")
    refusal = elems.get("cookie.popup.refusal")
    if any(ident.startswith("cookie.turn.cookie.") for ident in elems):
        raise SystemExit("cookie turn was added")
    if field is None or field["value"] != draft:
        raise SystemExit("draft " + repr(None if field is None else field["value"]))
    if refusal is None or refusal["value"] != refusal_text:
        raise SystemExit("refusal " + repr(None if refusal is None else refusal["value"]))
    for ident, item in elems.items():
        if ident.startswith("cookie.badge.") and item["value"] == "cloud":
            raise SystemExit("cloud badge")
    print("no cookie turn, draft kept, not ready")


def cmd_offline(path: str, expected: str) -> None:
    text = pathlib.Path(path).read_text()
    cookie = row(text, "cookie.turn.cookie.0")
    you = row(text, "cookie.turn.you.0")
    badge = row(text, "cookie.badge.on-device")
    if cookie is None or cookie["value"] != expected:
        raise SystemExit("reply " + repr(None if cookie is None else cookie["value"]))
    if you is None or you["label"] != "you":
        raise SystemExit("you label")
    if badge is None or badge["value"] != "on-device" or badge["label"] != "on-device":
        raise SystemExit("badge " + repr(badge))
    print("local reply on-device")


def cmd_sample_line(label_path: str, ax_path: str, full: str) -> None:
    label = pathlib.Path(label_path).read_text().strip()
    text = pathlib.Path(ax_path).read_text() if pathlib.Path(ax_path).is_file() else ""
    try:
        cookie = row(text, "cookie.turn.cookie.0") if text else None
        you = row(text, "cookie.turn.you.0") if text else None
        mascot = row(text, "cookie.popup.mascot") if text else None
        badge = row(text, "cookie.badge.on-device") if text else None
    except SystemExit:
        cookie = you = mascot = badge = None
    cookie_value = "" if cookie is None else cookie["value"]
    if cookie_value and cookie_value != full and full.startswith(cookie_value):
        state = "prefix"
    elif cookie_value == full:
        state = "full"
    else:
        state = "wait"
    print(
        "\t".join(
            [
                state,
                label,
                cookie_value,
                "" if you is None else you["value"],
                "" if you is None else you["label"],
                "" if mascot is None else mascot["label"],
                "" if badge is None else badge["value"],
            ]
        )
    )


def load_samples(path: str) -> list[list[str]]:
    return [line.split("\t") for line in pathlib.Path(path).read_text().splitlines() if line]


def cmd_thinking(path: str) -> None:
    rows = load_samples(path)
    prefix = [item for item in rows if item and item[0] == "prefix"]
    full = [item for item in rows if item and item[0] == "full"]
    if not prefix:
        raise SystemExit("no partial chunk")
    if prefix[0][1] != "Cookie, thinking":
        raise SystemExit("during chunk " + prefix[0][1])
    if not full:
        raise SystemExit("reply did not finish")
    if full[-1][1] != "Cookie, listening":
        raise SystemExit("after done " + full[-1][1])
    print("thinking then listening")


def cmd_talking(path: str, reduce: str) -> None:
    rows = load_samples(path)
    prefix = [item for item in rows if item and item[0] == "prefix"]
    if len(prefix) < 2:
        raise SystemExit("fewer than two samples during chunks")
    labels = [item[5] if len(item) > 5 else "" for item in prefix]
    menus = [item[1] if len(item) > 1 else "" for item in prefix]
    if any(label != "Cookie, talking" for label in labels):
        raise SystemExit("mascot " + ", ".join(labels) + " reduceMotion " + reduce)
    if any(label != "Cookie, thinking" for label in menus):
        raise SystemExit("menu " + ", ".join(menus))
    if len(set(labels)) != 1:
        raise SystemExit("mascot label changed during chunks")
    print("talking stable reduceMotion " + reduce)


def cmd_reply(path: str, full: str) -> None:
    rows = load_samples(path)
    prefix = [item for item in rows if item and item[0] == "prefix"]
    full_rows = [item for item in rows if item and item[0] == "full"]
    if not prefix or not full_rows:
        raise SystemExit("chunks were not observed")
    you_values = [item[3] for item in rows if len(item) > 4 and item[3]]
    you_labels = [item[4] for item in rows if len(item) > 4 and item[3]]
    if "hello from drive-mac" not in you_values:
        raise SystemExit("you value missing")
    if any(label != "you" for label in you_labels):
        raise SystemExit("you label " + ", ".join(you_labels))
    if not full.startswith(prefix[0][2]) or prefix[0][2] == full:
        raise SystemExit("prefix was not a growing chunk")
    if full_rows[-1][2] != full:
        raise SystemExit("final " + full_rows[-1][2])
    badges = [item[6] for item in rows if len(item) > 6 and item[0] in ("prefix", "full") and item[6]]
    if not badges or any(badge != "on-device" for badge in badges):
        raise SystemExit("badge " + ", ".join(badges))
    print("chunks you on-device")


def cmd_egress(path: str) -> None:
    bad: list[str] = []
    for line in pathlib.Path(path).read_text().splitlines():
        if not line.startswith("n"):
            continue
        name = line[1:]
        for part in name.replace("->", " ").split():
            host = part
            if host.startswith("["):
                end = host.find("]")
                host = host[: end + 1] if end >= 0 else host
            elif ":" in host:
                host = host.rsplit(":", 1)[0]
            if host in ("", "*", "127.0.0.1", "localhost", "::1", "[::1]"):
                continue
            bad.append(name)
            break
    if bad:
        raise SystemExit("non-loopback " + ", ".join(bad))
    print("sockets loopback")


def self_test() -> None:
    ax = "\n".join(
        [
            "meta\ttitle\tAsk Cookie…\tAXSystemDialog\t",
            "cookie.popup\tAXWindow\t\tAsk Cookie…\t",
            "cookie.popup.input\tAXTextArea\talpha\\n\tAsk Cookie…\ttrue",
            "cookie.popup.mascot\tAXGroup\t\tCookie, listening\t",
            "geom\tcookie.popup.mascot\t10 20 40 40",
            "geom\tcookie.popup.input\t56 18 400 44",
        ]
    )
    elems, geoms, meta = parse_ax(ax)
    assert meta["title"] == "Ask Cookie…"
    assert elems["cookie.popup.input"]["value"] == "alpha\n"
    assert geoms["cookie.popup.mascot"] == "10 20 40 40"
    try:
        parse_ax("cookie.popup.input\tA\t\t\t\ncookie.popup.input\tA\t\t\t")
    except SystemExit as error:
        assert "duplicate" in str(error)
    else:
        raise SystemExit("duplicate identifiers were accepted")
    frames = "window 100 40 560 64\nscreen 0 0 1200 800\n"
    # centre x = 380, screen mid = 600. That is NOT centred. Use a centred window.
    frames = "window 320 40 560 80\nscreen 0 0 1200 900\n"
    # cx = 600, cy = 80. band centre = 0 + 900/6 = 150. delta 70, would fail the 24 tolerance.
    frames = "window 320 110 560 80\nscreen 0 0 1200 900\n"
    # cy = 150. band = 150. cx = 600. mid = 600. width 560.
    path_frames = pathlib.Path("/tmp/cookie-assert-frames.txt")
    path_ax = pathlib.Path("/tmp/cookie-assert-ax.txt")
    path_frames.write_text(frames)
    path_ax.write_text(ax)
    cmd_layout(str(path_frames), str(path_ax))
    cmd_field_label(str(path_ax), "Ask Cookie…")
    cmd_panel(str(path_ax))
    mark = pathlib.Path("/tmp/cookie-assert-mark.txt")
    mark.write_text("id cookie.menu.local-only\nname Local-only mode\nmark ✓\nvalue 1\n")
    cmd_mark(str(mark))
    samples = pathlib.Path("/tmp/cookie-assert-samples.txt")
    full = "I'm here. This reply is from the fake core, with no model loaded."
    samples.write_text(
        "\n".join(
            [
                "prefix\tCookie, thinking\tI'm here. \thello from drive-mac\tyou\tCookie, talking\ton-device",
                "prefix\tCookie, thinking\tI'm here. This reply is from the fake core, \thello from drive-mac\tyou\tCookie, talking\ton-device",
                f"full\tCookie, listening\t{full}\thello from drive-mac\tyou\tCookie, listening\ton-device",
            ]
        )
        + "\n"
    )
    cmd_thinking(str(samples))
    cmd_talking(str(samples), "no")
    cmd_reply(str(samples), full)
    sockets = pathlib.Path("/tmp/cookie-assert-sockets.txt")
    sockets.write_text("pid 9\nn127.0.0.1:18080->127.0.0.1:54321\nn*:18080\n")
    cmd_egress(str(sockets))
    try:
        sockets.write_text("n1.2.3.4:443->1.2.3.4:9999\n")
        cmd_egress(str(sockets))
    except SystemExit as error:
        assert "non-loopback" in str(error)
    else:
        raise SystemExit("egress check accepted a public address")
    five = pathlib.Path("/tmp/cookie-assert-five.txt")
    capped = pathlib.Path("/tmp/cookie-assert-capped.txt")
    five.write_text("cookie.popup.input\tAXTextArea\talpha\\n\\n\\n\\n\tAsk Cookie…\ttrue\n")
    capped.write_text(five.read_text())
    cmd_line_cap(str(five), str(capped))
    loading = pathlib.Path("/tmp/cookie-assert-loading.txt")
    loading.write_text(
        "\n".join(
            [
                "cookie.popup.input\tAXTextArea\tstill drafting\tAsk Cookie…\ttrue",
                "cookie.popup.send\tAXButton\t\t⏎\tfalse",
                "cookie.popup.loading\tAXStaticText\tLoading the model…\tLoading the model…\t",
            ]
        )
        + "\n"
    )
    cmd_loading(str(loading), "Loading the model…", "still drafting")
    down = pathlib.Path("/tmp/cookie-assert-down.txt")
    down.write_text(
        "\n".join(
            [
                "cookie.popup.input\tAXTextArea\toffline draft\tAsk Cookie…\ttrue",
                "cookie.popup.refusal\tAXStaticText\tCookie's model isn't ready yet.\t\t",
            ]
        )
        + "\n"
    )
    cmd_down(str(down), "Cookie's model isn't ready yet.", "offline draft")
    cmd_input_equals(str(path_ax), "alpha\n", True)
    print("self-test ok")


def main(argv: list[str]) -> None:
    if len(argv) < 2:
        raise SystemExit("usage: assert-ax.py <command> ...")
    command = argv[1]
    if command == "self-test":
        self_test()
    elif command == "mark":
        cmd_mark(argv[2])
    elif command == "field-label":
        cmd_field_label(argv[2], argv[3])
    elif command == "panel":
        cmd_panel(argv[2])
    elif command == "layout":
        cmd_layout(argv[2], argv[3])
    elif command == "input-equals":
        cmd_input_equals(argv[2], argv[3].replace("\\n", "\n"), argv[4] == "forbid-you")
    elif command == "line-cap":
        cmd_line_cap(argv[2], argv[3])
    elif command == "you-turn":
        cmd_you_turn(argv[2], argv[3])
    elif command == "recall":
        cmd_recall(argv[2], argv[3])
    elif command == "loading":
        cmd_loading(argv[2], argv[3], argv[4])
    elif command == "down":
        cmd_down(argv[2], argv[3], argv[4])
    elif command == "offline":
        cmd_offline(argv[2], argv[3])
    elif command == "sample-line":
        cmd_sample_line(argv[2], argv[3], argv[4])
    elif command == "thinking":
        cmd_thinking(argv[2])
    elif command == "talking":
        cmd_talking(argv[2], argv[3] if len(argv) > 3 else "")
    elif command == "reply":
        cmd_reply(argv[2], argv[3])
    elif command == "egress":
        cmd_egress(argv[2])
    else:
        raise SystemExit("unknown command " + command)


if __name__ == "__main__":
    main(sys.argv)
