#!/usr/bin/python3 -I
"""Owner-prepared portal helper. One WINDOW grant, restricted FD, non-reused serial; no screen fallback."""
import base64
import json
import os
import resource
import signal
import struct
import sys
import time
import uuid
import zlib
import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import Gio, GLib, Gst, GstVideo

resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024 * 1024, 1536 * 1024 * 1024))
Gst.init(None)
STOP = False

def stop(_sig, _frame):
    global STOP
    STOP = True

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGALRM, stop)
signal.alarm(120)

def pump():
    context = GLib.MainContext.default()
    while context.pending():
        context.iteration(False)
    if STOP:
        raise RuntimeError("Owner view stopped")

class Portal:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.owner = self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", GLib.Variant("(s)", ("org.freedesktop.portal.Desktop",)), GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
        self.path = "/org/freedesktop/portal/desktop"
        self.sender = self.bus.get_unique_name()[1:].replace(".", "_")
        self.session = None
        self.closed = False
        self.closed_subscription = None
        self.fd = None

    def call(self, interface, method, parameters, result=None, path=None):
        return self.bus.call_sync(self.owner, path or self.path, interface, method, parameters, result, Gio.DBusCallFlags.NONE, 5000, None)

    def request(self, method, args, signature):
        token = "branch_" + uuid.uuid4().hex
        options = args[-1]
        options["handle_token"] = GLib.Variant("s", token)
        path = "/org/freedesktop/portal/desktop/request/" + self.sender + "/" + token
        received = []
        sub = self.bus.signal_subscribe(self.owner, "org.freedesktop.portal.Request", "Response", path, None, Gio.DBusSignalFlags.NONE, lambda connection, sender, object_path, interface, name, parameters, *unused: received.append(parameters.unpack()))
        try:
            handle = self.call("org.freedesktop.portal.ScreenCast", method, GLib.Variant(signature, tuple(args)), GLib.VariantType("(o)")).unpack()[0]
            if handle != path:
                raise RuntimeError("Portal request addressing changed")
            deadline = time.monotonic() + 85
            while not received and time.monotonic() < deadline:
                pump()
                if self.closed:
                    raise RuntimeError("Portal session closed")
                time.sleep(.02)
            if not received or received[0][0] != 0:
                raise RuntimeError("Owner cancelled or portal refused window grant")
            return received[0][1]
        finally:
            self.bus.signal_unsubscribe(sub)
            try:
                self.call("org.freedesktop.portal.Request", "Close", None, path=path)
            except GLib.Error:
                pass

    def grant(self):
        props = self.call("org.freedesktop.DBus.Properties", "GetAll", GLib.Variant("(s)", ("org.freedesktop.portal.ScreenCast",)), GLib.VariantType("(a{sv})")).unpack()[0]
        if props.get("version", 0) < 6 or not props.get("AvailableSourceTypes", 0) & 2 or not props.get("AvailableCursorModes", 0) & 1:
            raise RuntimeError("Hold: portal v6 WINDOW/hidden-cursor support required")
        token = "branch_" + uuid.uuid4().hex
        result = self.request("CreateSession", [{"session_handle_token": GLib.Variant("s", token)}], "(a{sv})")
        self.session = result.get("session_handle")
        if self.session != "/org/freedesktop/portal/desktop/session/" + self.sender + "/" + token:
            raise RuntimeError("Portal session addressing changed")
        self.closed_subscription = self.bus.signal_subscribe(self.owner, "org.freedesktop.portal.Session", "Closed", self.session, None, Gio.DBusSignalFlags.NONE, lambda *event: setattr(self, "closed", True))
        self.request("SelectSources", [self.session, {"types": GLib.Variant("u", 2), "multiple": GLib.Variant("b", False), "cursor_mode": GLib.Variant("u", 1), "persist_mode": GLib.Variant("u", 0)}], "(oa{sv})")
        result = self.request("Start", [self.session, "", {}], "(osa{sv})")
        streams = result.get("streams", [])
        if len(streams) != 1 or streams[0][1].get("source_type") != 2:
            raise RuntimeError("Portal did not prove exactly one WINDOW source")
        node, metadata = streams[0]
        serial = metadata.get("pipewire-serial")
        if not isinstance(serial, int) or serial <= 0:
            raise RuntimeError("Non-reused PipeWire serial required; no node-ID fallback")
        result, descriptors = self.bus.call_with_unix_fd_list_sync(self.owner, self.path, "org.freedesktop.portal.ScreenCast", "OpenPipeWireRemote", GLib.Variant("(oa{sv})", (self.session, {})), GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE, 5000, None, None)
        self.fd = descriptors.get(result.unpack()[0])
        return {"session": self.session, "portalOwner": self.owner, "sourceType": 2, "serial": str(serial), "opaqueId": str(metadata.get("id", ""))[:256], "nodeId": node, "persistMode": 0}

    def close(self):
        if self.session:
            try:
                self.call("org.freedesktop.portal.Session", "Close", None, path=self.session)
            except GLib.Error:
                pass
        if self.closed_subscription:
            self.bus.signal_unsubscribe(self.closed_subscription)
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

def png(sample):
    info = GstVideo.VideoInfo.new_from_caps(sample.get_caps())
    if info.width != 1280 or info.height != 720:
        raise RuntimeError("Bounded frame negotiation changed")
    buffer = sample.get_buffer()
    ok, mapped = buffer.map(Gst.MapFlags.READ)
    if not ok:
        raise RuntimeError("Portal frame unreadable")
    try:
        pixels = bytes(mapped.data)
        if info.stride[0] < info.width * 3 or len(pixels) > 8_000_000:
            raise RuntimeError("Portal frame memory bound exceeded")
        rows = bytearray()
        for y in range(info.height):
            start = info.offset[0] + y * info.stride[0]
            row = pixels[start:start + info.width * 3]
            if len(row) != info.width * 3:
                raise RuntimeError("Truncated portal frame")
            rows.extend(b"\0" + row)
        def chunk(name, data):
            return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data) & 0xffffffff)
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", info.width, info.height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 3)) + chunk(b"IEND", b"")
    finally:
        buffer.unmap(mapped)

def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)

def watch(portal, grant, frames, interval):
    pipeline = Gst.parse_launch("pipewiresrc name=source ! videoconvert ! videoscale add-borders=true ! video/x-raw,format=RGB,width=1280,height=720,pixel-aspect-ratio=1/1 ! appsink name=sink max-buffers=1 drop=true sync=false")
    source, sink = pipeline.get_by_name("source"), pipeline.get_by_name("sink")
    if not source.find_property("target-object") or not source.find_property("on-disconnect"):
        raise RuntimeError("Prepared PipeWire plugin needs serial targeting and disconnect errors")
    stream_fd = os.dup(portal.fd)
    source.set_property("fd", stream_fd)
    source.set_property("target-object", grant["serial"])
    source.set_property("on-disconnect", 2)
    emit({"kind": "grant", "grant": grant})
    try:
        if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError("Portal stream refused")
        bus = pipeline.get_bus()
        deadline, captured, next_frame = time.monotonic() + 30, 0, 0
        while captured < frames and time.monotonic() < deadline:
            pump()
            if portal.closed or bus.pop_filtered(Gst.MessageType.ERROR | Gst.MessageType.EOS):
                raise RuntimeError("Granted window stream closed; choose again explicitly")
            sample = sink.emit("try-pull-sample", 100_000_000)
            if sample is None or time.monotonic() < next_frame:
                continue
            data = png(sample)
            if len(data) > 3_000_000:
                raise RuntimeError("Portal PNG bound exceeded")
            emit({"kind": "frame", "grant": grant, "width": 1280, "height": 720, "png": base64.b64encode(data).decode("ascii")})
            captured += 1
            next_frame = time.monotonic() + interval / 1000
        if captured != frames:
            raise RuntimeError("Portal watch frame deadline exceeded")
        emit({"kind": "end"})
    finally:
        pipeline.set_state(Gst.State.NULL)
        try:
            os.close(stream_fd)
        except OSError:
            pass

def main():
    if len(sys.argv) != 2 or len(sys.argv[1]) > 1000:
        raise RuntimeError("Bounded owner-view request required")
    terms = json.loads(sys.argv[1])
    if set(terms) != {"frames", "intervalMs"} or type(terms["frames"]) is not int or not 1 <= terms["frames"] <= 20 or type(terms["intervalMs"]) is not int or not 200 <= terms["intervalMs"] <= 2000:
        raise RuntimeError("Invalid portal watch terms")
    portal = Portal()
    try:
        watch(portal, portal.grant(), terms["frames"], terms["intervalMs"])
    finally:
        portal.close()

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Portal capture refused: " + str(error)[:800], file=sys.stderr)
        sys.exit(1)