"""Rendered tones waiting to be downloaded: the core's only state (docs/PLAN.md 5.5).

A result is one file under the scratch tmpfs, results/<id>/tone.m4a, where
<id> is 128 random bits. The index in memory is the authority: a directory on
disk that the index doesn't know is never served, and the tone's name lives
only in the index, never in a path or a file. Results expire after the TTL and
nothing is evicted early, so the tmpfs has a known upper bound
(MAX_RESULTS results at once). There is no database; a restart forgets all.
"""
from __future__ import annotations

import os
import re
import secrets
import shutil
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

# Exactly what secrets.token_hex(16) produces. Checked before any lookup, so a
# client-chosen string never gets near the index or the filesystem.
RESULT_ID_RE = re.compile(r"[0-9a-f]{32}")
TONE_FILE = "tone.m4a"


class StoreFull(Exception):
    """MAX_RESULTS results already exist; the render answers 503 until the sweep frees room."""


@dataclass(frozen=True)
class Result:
    result_id: str
    name: str
    path: Path
    created: float


class ResultStore:
    def __init__(
        self,
        directory: Path,
        ttl_seconds: int,
        max_results: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ttl_seconds < 1 or max_results < 1:
            raise ValueError("ttl_seconds and max_results must be at least 1")
        self.directory = directory
        self.ttl_seconds = ttl_seconds
        self.max_results = max_results
        self._clock = clock
        self._lock = threading.Lock()
        self._results: dict[str, Result] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        # Created here, inside a scratch directory the server has just checked
        # and emptied. Owner-only, like scratch itself.
        directory.mkdir(mode=0o700, exist_ok=True)

    def __len__(self) -> int:
        with self._lock:
            return len(self._results)

    def is_full(self) -> bool:
        """Whether put() would refuse now, after expiring what is due.

        The server asks before it takes a render slot, so a full store costs
        no upload and no render.
        """
        self.sweep()
        with self._lock:
            return len(self._results) >= self.max_results

    def put(self, source: Path, name: str) -> Result:
        """Move source into the store under a fresh random ID."""
        self.sweep()
        with self._lock:
            if len(self._results) >= self.max_results:
                raise StoreFull()
            result_id = secrets.token_hex(16)
            # 128 random bits never repeat in practice; checked anyway, because
            # overwriting someone else's result would hand them this tone.
            while result_id in self._results:
                result_id = secrets.token_hex(16)
            folder = self.directory / result_id
            # Not exist_ok: a directory already at this name was not made by us.
            folder.mkdir(mode=0o700)
            path = folder / TONE_FILE
            try:
                # A rename within the scratch tmpfs: no copy, and the job
                # directory no longer holds the file when it is removed.
                os.replace(source, path)
            except OSError:
                shutil.rmtree(folder, ignore_errors=True)
                raise
            result = Result(result_id=result_id, name=name, path=path, created=self._clock())
            self._results[result_id] = result
        return result

    def get(self, result_id: str) -> Result | None:
        """The live result with this ID, or None for a malformed, unknown or expired one."""
        if not isinstance(result_id, str) or not RESULT_ID_RE.fullmatch(result_id):
            return None
        with self._lock:
            result = self._results.get(result_id)
        if result is None or self._clock() - result.created >= self.ttl_seconds:
            return None
        return result

    def sweep(self) -> int:
        """Delete every result older than the TTL; return how many went."""
        now = self._clock()
        with self._lock:
            expired = [r for r in self._results.values() if now - r.created >= self.ttl_seconds]
            for result in expired:
                del self._results[result.result_id]
        # The files go after the index entries: from this point no request can
        # be handed these paths.
        for result in expired:
            shutil.rmtree(self.directory / result.result_id, ignore_errors=True)
        return len(expired)

    def clear(self) -> None:
        """Forget every result and leave the results directory existing and empty."""
        with self._lock:
            self._results.clear()
        # Recreated when missing: the server clears scratch, results directory
        # included, before it hands the store its first result.
        self.directory.mkdir(mode=0o700, exist_ok=True)
        for child in self.directory.iterdir():
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child, ignore_errors=True)
            else:
                try:
                    child.unlink()
                except OSError:
                    pass

    def start_sweeper(self, interval_seconds: float) -> None:
        """Sweep every interval_seconds on a daemon thread until stop()."""
        if self._thread is not None:
            raise RuntimeError("the sweeper is already running")
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be positive")
        self._stop.clear()

        def loop() -> None:
            # Event.wait doubles as the sleep and the stop signal, so stop()
            # never waits a whole interval.
            while not self._stop.wait(interval_seconds):
                try:
                    self.sweep()
                except Exception:
                    # A failed sweep is retried on the next tick; the thread
                    # must not die and leave results to pile up.
                    pass

        # A daemon: it must never keep the process alive after SIGTERM.
        self._thread = threading.Thread(target=loop, name="result-sweeper", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop the sweeper thread, if one runs, and wait for it."""
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join()
