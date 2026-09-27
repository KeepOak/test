"""A local port forward over SSH for the nightly evals: 127.0.0.1:<local port> on this computer reaches
<remote host>:<remote port> as seen from the SSH server (e.g. an Ollama that listens only on a GPU box's localhost).

    python evals/lib/ssh-forward.py <ssh host> <ssh user> <bitwarden item id> <local port> [remote host] [remote port]

The SSH password is read from the Bitwarden vault through the owner's helper (EVAL_BW_HELPER, default
C:/Users/bishi/AppData/Local/Codex/bitwarden/Invoke-Bitwarden.ps1) into memory only: it is never printed, logged,
put on a command line or in the environment, and it is dropped once the connection is made. The server's host key is
pinned on first contact in EVAL_SSH_KNOWN_HOSTS (default: .nightly-known-hosts next to the runner's evals/ folder) and
must match on every later run. Nothing is run on the server; only direct-tcpip channels are opened.

It prints "ready <local port>" once listening (loopback only) and runs until its standard input closes, which happens
when the process that started it exits, so a crashed nightly run never leaves the tunnel open.
"""
import os
import select
import socket
import subprocess
import sys
import threading

import paramiko

HELPER = os.environ.get("EVAL_BW_HELPER", "C:/Users/bishi/AppData/Local/Codex/bitwarden/Invoke-Bitwarden.ps1")
HERE = os.path.dirname(os.path.abspath(__file__))
KNOWN = os.environ.get("EVAL_SSH_KNOWN_HOSTS", os.path.join(HERE, "..", "..", ".nightly-known-hosts"))


def fail(words):
    print(f"ssh-forward: {words}", flush=True)
    sys.exit(1)


def password(item):
    run = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", f"& '{HELPER}' get password {item}"],
                         capture_output=True, text=True, timeout=120)
    secret = run.stdout.strip()
    if run.returncode != 0 or not secret:
        fail(f"the vault helper gave no password (exit {run.returncode})")  # its output may hold secrets: never shown
    return secret


def connect(host, user, item):
    client = paramiko.SSHClient()
    if os.path.exists(KNOWN):
        client.load_host_keys(KNOWN)
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
    else:
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())  # first contact: pin it below
    try:
        client.connect(host, username=user, password=password(item), timeout=20, allow_agent=False, look_for_keys=False)
    except paramiko.BadHostKeyException:
        fail(f"{host}'s host key does not match the one pinned in {KNOWN}; refusing")
    except Exception as error:  # the message names the failure, never the password
        fail(f"could not connect to {host}: {type(error).__name__}: {error}")
    if not os.path.exists(KNOWN):
        client.save_host_keys(KNOWN)
    client.get_transport().set_keepalive(30)
    return client


def pump(local, channel):
    try:
        while True:
            ready, _, _ = select.select([local, channel], [], [], 60)
            if local in ready:
                data = local.recv(65536)
                if not data:
                    break
                channel.sendall(data)
            if channel in ready:
                data = channel.recv(65536)
                if not data:
                    break
                local.sendall(data)
    except Exception:  # either side closed mid-read (the tunnel is closing, or the client went away)
        pass
    finally:
        channel.close()
        local.close()


def serve(client, listener, remote_host, remote_port):
    transport = client.get_transport()
    while transport.is_active():
        local, peer = listener.accept()
        try:
            channel = transport.open_channel("direct-tcpip", (remote_host, remote_port), peer)
        except Exception as error:
            print(f"ssh-forward: the server refused a channel: {error}", flush=True)
            local.close()
            continue
        threading.Thread(target=pump, args=(local, channel), daemon=True).start()


def main():
    if len(sys.argv) < 5:
        fail("usage: ssh-forward.py <ssh host> <ssh user> <bitwarden item id> <local port> [remote host] [remote port]")
    host, user, item, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    remote_host = sys.argv[5] if len(sys.argv) > 5 else "127.0.0.1"
    remote_port = int(sys.argv[6]) if len(sys.argv) > 6 else 11434
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind(("127.0.0.1", port))  # loopback only; a port in use (another tunnel) is refused, not shared
    except OSError as error:
        fail(f"127.0.0.1:{port} is not free: {error}")
    listener.listen(16)
    client = connect(host, user, item)
    threading.Thread(target=serve, args=(client, listener, remote_host, remote_port), daemon=True).start()
    print(f"ready {port}", flush=True)
    sys.stdin.read()  # until the parent goes away
    client.close()


if __name__ == "__main__":
    main()
