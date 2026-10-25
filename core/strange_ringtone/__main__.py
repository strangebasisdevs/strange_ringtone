"""Run the core server: python -m strange_ringtone [--bind HOST].

Settings come from the environment (docs/PLAN.md 5.7). The port is fixed by the
deployment contract; only the bind address can change, and only on the command
line, so a local run can stay on loopback while the image passes nothing.
"""
from __future__ import annotations

import argparse
import os
import signal
import sys
from types import FrameType

from strange_ringtone.config import ConfigError, Settings
from strange_ringtone.server import RingtoneServer

PORT = 8080


def _stop(signum: int, frame: FrameType | None) -> None:
    # Raising unwinds serve_forever on the main thread. Calling
    # server.shutdown() here would deadlock: it waits for the very loop this
    # handler interrupted.
    raise SystemExit(0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m strange_ringtone", description="Serve strange_ringtone's core on port 8080."
    )
    parser.add_argument(
        "--bind",
        default="0.0.0.0",
        metavar="HOST",
        help="address to listen on (default 0.0.0.0, for the container; use 127.0.0.1 locally)",
    )
    args = parser.parse_args(argv)
    try:
        settings = Settings.from_env(os.environ)
    except ConfigError as error:
        # Fail closed: never a server with a setting the operator didn't choose.
        print(f"strange_ringtone: configuration error: {error}", file=sys.stderr)
        return 2
    try:
        server = RingtoneServer((args.bind, PORT), settings)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"strange_ringtone: cannot start: {error}", file=sys.stderr)
        return 1
    signal.signal(signal.SIGTERM, _stop)
    print(f"strange_ringtone {settings.version} listening on {args.bind}:{PORT}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
