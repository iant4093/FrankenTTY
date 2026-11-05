#!/usr/bin/env python3
"""Run a command in a PTY, inject input and signals on a schedule, print JSON.

Usage: pty_run.py '<json spec>'

Spec keys:
  cmd      list of strings, the argv (required)
  cwd      working directory (optional)
  env      extra environment variables (optional)
  cols     terminal columns (default 80)
  rows     terminal rows (default 24)
  timeout  seconds before the child is killed (default 10)
  events   list of {"at": seconds, "hex": "71"} (bytes to write to the PTY)
           or {"at": seconds, "signal": "SIGTERM"} (signal sent to the child)

Prints {"exitCode": int, "outputBase64": str, "timedOut": bool}.
exitCode is the exit status, or the negated signal number if the child was
killed by a signal.
"""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def read_available(fd, timeout):
    """Return (data, eof). data is b'' when nothing arrived within timeout."""
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return b"", False
    try:
        data = os.read(fd, 65536)
    except OSError:
        return b"", True
    if not data:
        return b"", True
    return data, False


def decode_status(status):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return -os.WTERMSIG(status)
    return -1


def main():
    spec = json.loads(sys.argv[1])
    cmd = spec["cmd"]
    cols = int(spec.get("cols", 80))
    rows = int(spec.get("rows", 24))
    timeout = float(spec.get("timeout", 10))
    events = sorted(spec.get("events", []), key=lambda e: e["at"])
    env = dict(os.environ)
    env.update(spec.get("env", {}))

    pid, fd = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            if spec.get("cwd"):
                os.chdir(spec["cwd"])
            os.execvpe(cmd[0], cmd, env)
        except BaseException as exc:  # noqa: BLE001 - child must never return
            os.write(2, ("pty_run: exec failed: %s\n" % exc).encode())
            os._exit(127)

    output = bytearray()
    start = time.monotonic()
    index = 0
    status = None
    timed_out = False

    while True:
        elapsed = time.monotonic() - start
        while index < len(events) and events[index]["at"] <= elapsed:
            event = events[index]
            index += 1
            if "hex" in event:
                os.write(fd, bytes.fromhex(event["hex"]))
            elif "signal" in event:
                os.kill(pid, getattr(signal, event["signal"]))

        data, _ = read_available(fd, 0.02)
        output += data

        finished, raw_status = os.waitpid(pid, os.WNOHANG)
        if finished != 0:
            status = raw_status
            break
        if elapsed > timeout:
            timed_out = True
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
            break

    # Drain whatever the child wrote before exiting.
    while True:
        data, eof = read_available(fd, 0.1)
        output += data
        if eof or not data:
            break
    os.close(fd)

    print(
        json.dumps(
            {
                "exitCode": decode_status(status),
                "outputBase64": base64.b64encode(bytes(output)).decode("ascii"),
                "timedOut": timed_out,
            }
        )
    )


if __name__ == "__main__":
    main()
