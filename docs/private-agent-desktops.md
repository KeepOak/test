# Private Trunk desktops

The owner's Add a computer → Private computer dialog can configure a named Trunk's
local Linux desktop. The Docker daemon and an image with Xvfb, x11vnc and xdotool
must already exist (see `examples/linux-desktop/Dockerfile`). No image is pulled.
This reuses the shared desktop confinement: no network, host mounts or additional
capabilities; one CPU, 1 GiB memory and 256 processes per running desktop.

Each owner/Trunk pair has a separate settings key and hashed Docker label. Stale
container cleanup filters exactly that label, preserving other private desktops
and the existing shared desktop. Agent tools derive the Trunk from their trusted
tool context; they cannot name another desktop. Owner setup is required, and
desktop.control permission still gates start, actions and stop. Taking over
blocks agent actions and its stop command until hand-back.

Create/start, stop, snapshot, restore and remove-snapshot are real local Docker
operations available only through the owner's unlocked window. Lockdown stops
running desktops. Owner stop cancels pending starts and restoration before they
can re-enable the desktop. There are at most 16 configured desktops and three
recorded snapshots per desktop. Failed creation is shown as stopped rather than
reported as a running computer.

Snapshots use [Docker commit](https://docs.docker.com/reference/cli/docker/container/commit/)
with pausing and a scoped snapshot label. They contain filesystem changes,
including private files and browser sign-ins; they remain in the local Docker
daemon. Process memory is not captured. The transient VNC password file is removed
before committing. Snapshot leaves control with the owner. Restore checks both
the recorded identifier and the image's owner/Trunk label before replacing a
desktop. Image removal never uses force and cannot delete an image used by a
running container. Stopping discards unsnapshotted changes; snapshots survive
Branch shutdown and are removed only through the explicit owner action.

The Trunk conversation's **Private desktop** side-panel tab embeds its desktop.
Open read-only view creates a one-use, five-minute grant bound to the owner,
profile, actual conversation-to-Trunk mapping and desktop revision. Four grants
at most exist at once. The local window key and same-origin checks gate the
WebSocket; its opaque grant goes in the protocol header, never the URL. Paired
devices and doors cannot obtain a grant or operate this lifecycle API.

The server authenticates VNC itself and forwards only bounded rectangles. The
real VNC password never goes to the embedded viewer, transcript, event log or
URL. Take over first uses the existing exact-target takeover path, then asks for
a separate control grant. The server independently refuses keyboard/pointer
packets from read-only grants and rechecks the owner, lock, target and held
control before every accepted input and outgoing rectangle. Merely watching
never pauses a Trunk. Profile switching, reassignment, Lockdown, app lock,
stop, snapshot, restore and hand-back revoke the view. Closing the pane clears
its canvas and disconnects; it does not silently hand back an existing takeover.

This original implementation uses [RFB 3.8 / RFC 6143](https://www.rfc-editor.org/rfc/rfc6143.html)
with VNC challenge authentication and Raw true-color encoding. It uses Node's
existing crypto API (equal-key Triple DES implements the DES challenge) rather
than copying noVNC or adding dependencies. The noVNC 1.6 authentication/DES source
and its license were inspected as protocol reference; no upstream code was
copied ([upstream DES reference](https://github.com/novnc/noVNC/blob/v1.6.0/core/crypto/des.js),
[upstream license](https://github.com/novnc/noVNC/blob/v1.6.0/LICENSE.txt)).
Rendering is at most 1280×800 with a single request outstanding and a
500 ms interval after each response. Pending RFB and WebSocket output are capped
at 5 MiB; inbound WebSocket buffering and input output at 64 KiB. There are at
most 2048 rectangles per update, bounded total pixels, 120 input packets/second
and 32 held keys. Stream teardown releases only that connection's held keys and
buttons, removes its Docker tunnel, and bounds final socket cleanup to 300 ms.
Clipboard, file transfer, protocol extensions, wheel events, dynamic desktop
resizing and compressed encodings are intentionally unsupported. An unsupported
RFB/security/cipher configuration disconnects; no weaker fallback is attempted.
Watching with a separately installed localhost VNC viewer remains available as
an optional existing owner flow.
Cloud providers and native Windows private desktops are outside this local Linux
path. Resource limits bound each container, not aggregate Docker disk usage.
Orphaned images after daemon failure may require manual Docker cleanup; Branch
does not perform a global image sweep. A deleted Trunk's snapshots are retained
but cannot currently be restored through this dialog.

Implementation was reviewed from source only. No Docker, application, tests or
desktop lifecycle operation was executed during delivery.
