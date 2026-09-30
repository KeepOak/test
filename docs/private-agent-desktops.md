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

Watch returns the existing localhost VNC connection to the owner; an installed
VNC viewer is required. This does not yet embed a desktop in the Trunk pane.
Cloud providers and native Windows private desktops are outside this local Linux
path. Resource limits bound each container, not aggregate Docker disk usage.
Orphaned images after daemon failure may require manual Docker cleanup; Branch
does not perform a global image sweep. A deleted Trunk's snapshots are retained
but cannot currently be restored through this dialog.

Implementation was reviewed from source only. No Docker, application, tests or
desktop lifecycle operation was executed during delivery.
