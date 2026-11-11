"""Starting the lobby the way the README says (python online/server.py) serves its own files.

Run as a script, online/ is first on sys.path, so a module there named like a standard-library
module (it was online/queue.py) replaces it for all of Python: the thread pool then fails and
every static file came back empty, leaving the page on "Loading Game Center...".
"""
from __future__ import annotations

import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_no_online_module_shadows_the_standard_library():
    names = {path.stem for path in (ROOT / "online").glob("*.py")}
    assert not names & set(sys.stdlib_module_names), sorted(names & set(sys.stdlib_module_names))


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_script_start_serves_static_files(tmp_path):
    port = _free_port()
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "online" / "server.py"), "--data", str(tmp_path), "--port", str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    try:
        deadline = time.time() + 20
        while True:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/games", timeout=2).read()
                break
            except OSError:
                if time.time() > deadline or server.poll() is not None:
                    raise
                time.sleep(0.3)
        for path in ("/app.js", "/style.css"):
            body = urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5).read()
            assert len(body) > 0, path
    finally:
        server.terminate()
        server.wait(timeout=10)
