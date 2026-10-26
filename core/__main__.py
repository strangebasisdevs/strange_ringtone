"""Entry point for running the checkout's core directory: python -I core [--bind HOST].

-I (which implies -P) keeps the current directory and the script's directory
off sys.path, so `python -I -m strange_ringtone` finds the package only once it
is installed. Python always puts a directory that it runs as a program on
sys.path, even under -I, so passing this directory makes the package next to it
importable with the environment and the user site still ignored.
"""
from __future__ import annotations

import sys

from strange_ringtone.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
