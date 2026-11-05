"""`python -m naulon <command>`. One command so far: `connect`, run beside the app."""

from __future__ import annotations

import sys

from naulon.local import connect_main

USAGE = "usage: python -m naulon connect --site <https://your-site> [--gate <url>] [--dir <path>]"


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0 if argv else 2
    if argv[0] == "connect":
        return connect_main(argv[1:])
    print(f"unknown command: {argv[0]}\n{USAGE}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
