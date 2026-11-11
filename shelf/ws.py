"""A tiny WebSocket client over a plain socket.

The lobby's live tables speak WebSocket (``docs/BOT-API.md``). The plugin must not
add a dependency to talk to them, and the module Hermes loads must keep working on
a machine that has nothing extra installed, so this is the client: the handshake,
client-side masking, one text message at a time, and ping answered with pong.

Only what the ladder and a live table need is here. It is not a general-purpose
library: binary frames are refused, and a message must fit in one frame or a
short run of continuation frames.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import socket
import ssl
import struct
from urllib.parse import urlsplit

log = logging.getLogger(__name__)

MAX_MESSAGE = 1 << 20          # 1 MiB: the server caps a message at 4 KiB anyway
_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_OP_CONT, _OP_TEXT, _OP_BINARY = 0x0, 0x1, 0x2
_OP_CLOSE, _OP_PING, _OP_PONG = 0x8, 0x9, 0xA


class SocketError(Exception):
    """The socket could not be opened, or the other end closed it."""


def socket_url(base: str, path: str) -> str:
    """``https://host`` + ``/ws/room`` -> ``wss://host/ws/room``."""
    parts = urlsplit(str(base or ""))
    scheme = "wss" if parts.scheme.lower() in {"https", "wss"} else "ws"
    host = parts.netloc or parts.path
    return f"{scheme}://{host}{path}"


class Socket:
    """One WebSocket, opened on construction and closed with :meth:`close`."""

    def __init__(self, url: str, *, timeout: float = 10.0, connect=None) -> None:
        parts = urlsplit(str(url or ""))
        if parts.scheme not in {"ws", "wss"}:
            raise SocketError("That is not a WebSocket address.")
        tls = parts.scheme == "wss"
        host = parts.hostname or ""
        if not host:
            raise SocketError("That WebSocket address has no host.")
        port = parts.port or (443 if tls else 80)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        opener = connect or socket.create_connection
        try:
            raw = opener((host, port), timeout)
            if tls:
                raw = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        except OSError as exc:
            raise SocketError(f"Could not connect: {exc}") from exc
        self.sock = raw
        self.sock.settimeout(timeout)
        self._buffer = b""
        self._pieces: list[bytes] = []
        self._opcode = None
        self._closed = False
        try:
            self._handshake(host, port, path, tls)
        except SocketError:
            self.close()
            raise

    # Handshake ---------------------------------------------------------------

    def _handshake(self, host: str, port: int, path: str, tls: bool) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        host_header = host if (port == (443 if tls else 80)) else f"{host}:{port}"
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {host_header}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
            "",
            "",
        ]
        self.sock.sendall("\r\n".join(lines).encode())
        while b"\r\n\r\n" not in self._buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise SocketError("The table closed the connection.")
            self._buffer += chunk
            if len(self._buffer) > 65536:
                raise SocketError("The table sent a strange answer.")
        head, self._buffer = self._buffer.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0].decode("latin-1")
        if " 101" not in status:
            raise SocketError(f"The table refused the connection ({status}).")
        wanted = base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()
        accept = ""
        for line in head.split(b"\r\n")[1:]:
            name, _, value = line.decode("latin-1").partition(":")
            if name.strip().lower() == "sec-websocket-accept":
                accept = value.strip()
        if accept and accept != wanted:
            raise SocketError("The table's answer did not match the request.")

    # Frames ------------------------------------------------------------------

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self._closed:
            raise SocketError("This connection is closed.")
        head = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            head.append(0x80 | length)
        elif length < (1 << 16):
            head.append(0x80 | 126)
            head += struct.pack("!H", length)
        else:
            head.append(0x80 | 127)
            head += struct.pack("!Q", length)
        mask = os.urandom(4)
        head += mask
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        try:
            self.sock.sendall(bytes(head) + masked)
        except OSError as exc:
            self._closed = True
            raise SocketError(f"The connection dropped: {exc}") from exc

    def _fill(self, count: int) -> None:
        """Buffer at least ``count`` bytes. Nothing is consumed, so a timeout keeps them."""
        while len(self._buffer) < count:
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                raise TimeoutError("No answer from the table.")
            except OSError as exc:
                self._closed = True
                raise SocketError(f"The connection dropped: {exc}") from exc
            if not chunk:
                self._closed = True
                raise SocketError("The table closed the connection.")
            self._buffer += chunk

    def _read_message(self) -> str | None:
        """One text message, or None for a control frame that needed no answer.

        The whole frame is buffered before it is taken out of the buffer, so a
        receive timeout between the header and the payload leaves the frame in
        place and the next call picks it up instead of mistaking payload bytes
        for a new header.
        """
        while True:
            self._fill(2)
            first, second = self._buffer[0], self._buffer[1]
            length = second & 0x7F
            offset = 2
            if length == 126:
                self._fill(4)
                length = struct.unpack("!H", self._buffer[2:4])[0]
                offset = 4
            elif length == 127:
                self._fill(10)
                length = struct.unpack("!Q", self._buffer[2:10])[0]
                offset = 10
            if length > MAX_MESSAGE:
                raise SocketError("The table sent a message that is too big.")
            masked = bool(second & 0x80)
            total = offset + (4 if masked else 0) + length
            self._fill(total)
            frame, self._buffer = self._buffer[:total], self._buffer[total:]
            payload = frame[offset + (4 if masked else 0):]
            if masked:
                mask = frame[offset:offset + 4]
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            fin = bool(first & 0x80)
            opcode = self._opcode if self._opcode is not None else (first & 0x0F)
            if first & 0x0F != _OP_CONT and self._pieces:
                raise SocketError("The table sent a broken message.")
            if opcode == _OP_PING:
                # Answer in place and keep reading: a ping can arrive in the
                # middle of a message, and the pieces already read still count.
                self._send_frame(_OP_PONG, payload)
                continue
            if opcode == _OP_PONG:
                return None
            if opcode == _OP_CLOSE:
                self._closed = True
                raise SocketError("The table closed the connection.")
            if opcode == _OP_BINARY:
                raise SocketError("The table sent a binary message.")
            if opcode not in {_OP_TEXT, _OP_CONT}:
                raise SocketError("The table sent something unexpected.")
            self._opcode = opcode
            self._pieces.append(payload)
            if fin:
                text = b"".join(self._pieces)
                self._pieces, self._opcode = [], None
                try:
                    return text.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise SocketError("The table sent text that is not UTF-8.") from exc

    # Public ------------------------------------------------------------------

    def send_json(self, message: dict) -> None:
        self._send_frame(_OP_TEXT, json.dumps(message, separators=(",", ":")).encode("utf-8"))

    def receive(self, timeout: float | None = 10.0) -> dict | None:
        """The next JSON object, or None when nothing arrived before ``timeout``."""
        if timeout is not None:
            self.sock.settimeout(timeout)
        try:
            while True:
                text = self._read_message()
                if text is None:
                    continue
                try:
                    loaded = json.loads(text)
                except ValueError as exc:
                    raise SocketError("The table sent something that is not JSON.") from exc
                return loaded if isinstance(loaded, dict) else None
        except TimeoutError:
            return None

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._send_frame(_OP_CLOSE, b"")
        except SocketError:
            log.debug("the close frame could not be sent", exc_info=True)
        try:
            self.sock.close()
        except OSError:
            log.debug("the socket did not close cleanly", exc_info=True)
