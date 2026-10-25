#!/usr/bin/env python3
"""Insert the drive-process handler after leading comments and use lines."""

import pathlib
import sys


def prepend(handler: str, text: str) -> str:
    lines = text.splitlines(keepends=True)
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        if stripped == "" or stripped.startswith("--") or stripped.startswith("use "):
            index += 1
            continue
        break
    if handler and not handler.endswith("\n"):
        handler += "\n"
    return "".join(lines[:index]) + handler + "".join(lines[index:])


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit("usage: prepend-drive-library.py LIBRARY SOURCE DEST")
    library, source, dest = (pathlib.Path(arg) for arg in sys.argv[1:])
    handler = library.read_text()
    if handler.lstrip().startswith("use "):
        sys.exit("drive-process library must not start with a use statement")
    dest.write_text(prepend(handler, source.read_text()))


if __name__ == "__main__":
    main()
