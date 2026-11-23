"""Create and verify a standalone snapshot of the live WBC SQLite database."""

import argparse
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory


def backup_database(source: Path, directory: Path) -> Path:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".in-progress-", dir=directory) as work:
        snapshot = Path(work) / "wbc.sqlite"
        with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as live:
            with closing(sqlite3.connect(snapshot)) as backup:
                live.backup(backup, pages=256)
                # The published backup must be usable without WAL or shared-memory files.
                if backup.execute("PRAGMA journal_mode=DELETE").fetchone() != ("delete",):
                    raise RuntimeError("Could not finalize a standalone SQLite backup")

        with closing(sqlite3.connect(snapshot.as_uri() + "?mode=ro&immutable=1", uri=True)) as check:
            if check.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RuntimeError("SQLite backup integrity check failed")
            if check.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise RuntimeError("SQLite backup contains foreign key violations")
            for table in ("users", "children", "bookings", "ledger"):
                check.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone()

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        target = directory / f"wbc-{stamp}.sqlite"
        with snapshot.open("rb") as file:
            os.fsync(file.fileno())
        os.link(snapshot, target)
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    print(backup_database(args.source, args.directory.resolve()))
