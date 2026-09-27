"""The Branch Agent client for Python.

Nothing here is installed from anywhere: it uses only the standard library (urllib and json) to
talk to the copy of Branch Agent already running on this computer, with the same address and the
same local session key the app itself uses. It mirrors the JavaScript client in packages/sdk.

Everything is one request, except watching a task as it happens: ``runs.stream`` reads the events
over a long-lived reply and hands them back one at a time, so a caller writes
``for event in branch.runs.stream(run_id)``.
"""

from __future__ import annotations

import ipaddress
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterator, List, Optional

DEFAULT_PORT = 3210
_LOCAL_NAMES = {"localhost"}


class BranchError(Exception):
    """A request Branch Agent refused, carrying the app's own plain-language message."""

    def __init__(self, status: int, message: str, path: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.path = path


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is never followed, so the session key can never be carried somewhere else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


def _opener() -> urllib.request.OpenerDirector:
    # No proxy either: a proxy set in the environment would otherwise see the key.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def _is_local(host: str) -> bool:
    if host.lower() in _LOCAL_NAMES:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _check_url(url: str) -> str:
    """Only http on this computer, or https anywhere: the key is never sent in the clear."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Give the web address Branch Agent is listening on, starting with http:// or https://")
    if parsed.scheme == "http" and not _is_local(parsed.hostname):
        raise ValueError("Plain http is only used for a Branch Agent on this computer; use https for any other address")
    return url.rstrip("/")


def _segment(value: str) -> str:
    """One id written into an address, so it can never reach a different route."""
    return urllib.parse.quote(str(value), safe="")


def _query(filters: Optional[Dict[str, Any]]) -> str:
    kept = {name: _plain(value) for name, value in (filters or {}).items() if value is not None}
    return f"?{urllib.parse.urlencode(kept)}" if kept else ""


def _plain(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _read_json(text: str) -> Any:
    try:
        return json.loads(text) if text else {}
    except ValueError:
        return {"error": text[:300]}


def from_data_dir(data_dir: str, port: int = DEFAULT_PORT, **options: Any) -> "BranchClient":
    """Reads the key the app wrote for this install, so a script needs no configuration."""
    with open(os.path.join(data_dir, "session-token"), encoding="utf-8") as handle:
        token = handle.read().strip()
    return BranchClient(f"http://127.0.0.1:{port}", token, **options)


class BranchClient:
    """One connection to Branch Agent, grouped the same way as the JavaScript client."""

    def __init__(self, url: str, token: str, timeout: float = 120.0) -> None:
        if not url or not token:
            raise ValueError("Give the address Branch Agent is listening on and its session key")
        self.url = _check_url(str(url))
        self._token = str(token)
        self.timeout = timeout
        self._open = _opener().open
        self.runs = Runs(self)
        self.sessions = Sessions(self)
        self.memory = Memory(self)
        self.documents = Documents(self)
        self.schedules = Schedules(self)
        self.policy = Policy(self)
        self.flows = Flows(self)

    def __repr__(self) -> str:
        return f"BranchClient(url={self.url!r})"

    def _headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        return {"authorization": f"Bearer {self._token}", **(extra or {})}

    def request(self, method: str, path: str, body: Any = None, timeout: Optional[float] = None) -> Any:
        """One request. A reply that is not a success is turned into a BranchError."""
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = self._headers({} if body is None else {"content-type": "application/json"})
        req = urllib.request.Request(f"{self.url}{path}", data=data, headers=headers, method=method)
        try:
            with self._open(req, timeout=timeout or self.timeout) as response:
                return _read_json(response.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as error:
            with error:
                value = _read_json(error.read().decode("utf-8", "replace"))
            message = value.get("error") if isinstance(value, dict) else None
            raise BranchError(error.code, message or f"Branch Agent answered {error.code}", path) from None
        except urllib.error.URLError as error:
            raise BranchError(0, f"Branch Agent could not be reached: {error.reason}", path) from None

    def get(self, path: str, **options: Any) -> Any:
        return self.request("GET", path, None, **options)

    def post(self, path: str, body: Any = None, **options: Any) -> Any:
        return self.request("POST", path, {} if body is None else body, **options)

    def state(self) -> Any:
        """Everything the app knows about itself right now: settings, tools, tasks, connections."""
        return self.get("/api/state")

    def tools(self) -> Any:
        """Every tool this copy can run, with the permission each one needs."""
        return self.get("/api/tools")

    def audit(self, **filters: Any) -> Any:
        """The record of what the assistant was allowed to do."""
        return self.get(f"/api/audit{_query(filters)}")

    def action(self, tool: str, args: Optional[Dict[str, Any]] = None) -> Any:
        """Runs one tool directly, without a task around it."""
        return self.post("/api/action", {"tool": tool, "args": args or {}})

    def ask_first(self, prompt: str, ask_first: Optional[bool] = None) -> Any:
        """Up to five questions to put to the person before a task starts."""
        body: Dict[str, Any] = {"prompt": prompt}
        if ask_first is not None:
            body["askFirst"] = ask_first
        return self.post("/api/ask-first", body)

    def with_answers(self, prompt: str, answers: List[Dict[str, str]]) -> Any:
        """The request with the answers written underneath it, ready to start."""
        return self.post("/api/ask-first/answers", {"prompt": prompt, "answers": answers})

    def search(self, query: str) -> Any:
        """Documents and saved notes together, best answer first."""
        return self.post("/api/retrieval/search", {"query": query})

    def issue_context(self, url: str) -> Any:
        """What an issue says, pulled in from its web address as a passage with a citation."""
        return self.post("/api/issues/context", {"url": url})


def _read_frames(response: Any) -> Iterator[Dict[str, Any]]:
    """Server-sent frames turned back into the events they carried."""
    name, data = "", []
    for raw in response:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if line == "":
            event = _frame(name, data)
            name, data = "", []
            if event is not None:
                yield event
        elif line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].strip())
    event = _frame(name, data)
    if event is not None:
        yield event


def _frame(name: str, data: List[str]) -> Optional[Dict[str, Any]]:
    """The last frame of a task is named "end" and carries only the status, so the name is kept."""
    if not data:
        return None
    try:
        value = json.loads("\n".join(data))
    except ValueError:
        return None
    return {"kind": name, **value} if isinstance(value, dict) else None


class Runs:
    def __init__(self, client: BranchClient) -> None:
        self._client = client

    def start(self, prompt: str, **options: Any) -> Any:
        """Starts a task. Takes the same fields as the app (sessionId, temporary, plan, ...)."""
        return self._client.post("/api/run", {"prompt": prompt, **options})

    def get(self, run_id: str) -> Any:
        """One task with its events, its messages and what it has used so far."""
        return self._client.get(f"/api/runs/{_segment(run_id)}")

    def steer(self, run_id: str, text: str) -> Any:
        """Says something to a task while it is working."""
        return self._client.post(f"/api/runs/{_segment(run_id)}/steer", {"text": text})

    def cancel(self, run_id: str) -> Any:
        return self._client.post(f"/api/runs/{_segment(run_id)}/cancel")

    def resume(self, run_id: str) -> Any:
        """Picks a task up again after it was interrupted."""
        return self._client.post(f"/api/runs/{_segment(run_id)}/resume")

    def approve(self, session_id: str, decision: str, remember: str = "session", fingerprint: Optional[str] = None) -> Any:
        """Answers the question a paused task stopped on: allow or deny; never, session or always.
        Pass the question's fingerprint (policy.get()["waiting"]): an answer without it is refused when the question has one."""
        return self._client.policy.approve(session_id, decision, remember, fingerprint)

    def receipts(self, run_id: str) -> Any:
        """Every tool result of a task with whether its receipt is genuine."""
        return self._client.get(f"/api/runs/{_segment(run_id)}/receipts")

    def activity(self) -> Any:
        """Tasks in progress, with what each one is doing right now."""
        return self._client.get("/api/activity")

    def stream(self, run_id: str, after: int = 0, timeout: float = 300.0) -> Iterator[Dict[str, Any]]:
        """The events of a task as they happen. Start from ``after`` to pick up where a read stopped."""
        client = self._client
        path = f"/api/runs/{_segment(run_id)}/stream"
        req = urllib.request.Request(
            f"{client.url}{path}?after={int(after)}",
            headers=client._headers({"accept": "text/event-stream"}),
        )
        try:
            response = client._open(req, timeout=timeout)
        except urllib.error.HTTPError as error:
            error.close()
            raise BranchError(error.code, "That task's events could not be read", path) from None
        except urllib.error.URLError as error:
            raise BranchError(0, f"Branch Agent could not be reached: {error.reason}", path) from None
        with response:
            yield from _read_frames(response)


class Sessions:
    def __init__(self, client: BranchClient) -> None:
        self._client = client

    def get(self, session_id: str) -> Any:
        return self._client.get(f"/api/sessions/{_segment(session_id)}")

    def search(self, query: str, **options: Any) -> Any:
        return self._client.post("/api/sessions/search", {"query": query, **options})

    def summary(self, session_id: str) -> Any:
        return self._client.get(f"/api/sessions/{_segment(session_id)}/summary")

    def export(self, session_id: str) -> Any:
        return self._client.get(f"/api/sessions/{_segment(session_id)}/export")

    def follow_up(self, session_id: str, prompt: str) -> Any:
        return self._client.post(f"/api/sessions/{_segment(session_id)}/followups", {"prompt": prompt})


class Memory:
    def __init__(self, client: BranchClient) -> None:
        self._client = client

    def search(self, query: str, limit: Optional[int] = None) -> Any:
        body: Dict[str, Any] = {"query": query}
        if limit is not None:
            body["limit"] = limit
        return self._client.post("/api/memory/search", body)

    def export(self) -> Any:
        return self._client.get("/api/memory/export")

    def index(self) -> Any:
        """Brings the index in line with the saved facts and compares them by meaning where it can."""
        return self._client.post("/api/memory/index")

    def settings(self) -> Any:
        return self._client.get("/api/memory/retrieval")

    def configure(self, **settings: Any) -> Any:
        return self._client.post("/api/memory/retrieval", settings)


class Documents:
    def __init__(self, client: BranchClient) -> None:
        self._client = client

    def list(self) -> Any:
        return self._client.get("/api/documents")

    def add(self, name: str, text: str, **options: Any) -> Any:
        return self._client.post("/api/documents", {"name": name, "text": text, **options})

    def search(self, query: str, limit: Optional[int] = None) -> Any:
        body: Dict[str, Any] = {"query": query}
        if limit is not None:
            body["limit"] = limit
        return self._client.post("/api/documents/search", body)

    def remove(self, document_id: str) -> Any:
        return self._client.request("DELETE", f"/api/documents/{_segment(document_id)}")

    def settings(self) -> Any:
        return self._client.get("/api/documents/settings")


class Schedules:
    def __init__(self, client: BranchClient) -> None:
        self._client = client

    def get(self, schedule_id: str) -> Any:
        return self._client.get(f"/api/schedules/{_segment(schedule_id)}")

    def trigger(self, schedule_id: str) -> Any:
        return self._client.post(f"/api/schedules/{_segment(schedule_id)}/trigger")


class Policy:
    def __init__(self, client: BranchClient) -> None:
        self._client = client

    def get(self) -> Any:
        """The saved approval settings, the presets on offer, and anything waiting on an answer."""
        return self._client.get("/api/policy")

    def save(self, **settings: Any) -> Any:
        return self._client.post("/api/policy", settings)

    def approve(self, session_id: str, decision: str, remember: str = "session", fingerprint: Optional[str] = None) -> Any:
        body = {"sessionId": session_id, "decision": decision, "remember": remember}
        if fingerprint:
            body["fingerprint"] = fingerprint
        return self._client.post("/api/policy/approve", body)

    def categories(self) -> Any:
        """Approvals decided a kind of thing at a time rather than a tool at a time."""
        return self._client.get("/api/approvals/categories")

    def set_categories(self, decisions: Dict[str, str]) -> Any:
        return self._client.post("/api/approvals/categories", decisions)


class Flows:
    """Saved flows, and the same flows written out and read back as YAML.

    ``export_yaml`` and ``import_yaml`` need "Building on Branch" switched on in the app's Settings.
    """

    def __init__(self, client: BranchClient) -> None:
        self._client = client

    def list(self) -> Any:
        return self._client.get("/api/flows")

    def get(self, flow_id: str) -> Any:
        return self._client.get(f"/api/flows/{_segment(flow_id)}")

    def save(self, flow: Dict[str, Any]) -> Any:
        return self._client.post("/api/flows", flow)

    def run(self, flow_id: str, **inputs: Any) -> Any:
        return self._client.post(f"/api/flows/{_segment(flow_id)}/run", inputs)

    def export_yaml(self, flow_id: str) -> str:
        """One saved flow as YAML text."""
        return self._client.get(f"/api/flows/{_segment(flow_id)}/yaml")["yaml"]

    def import_yaml(self, text: str) -> Any:
        """Saves a flow written as YAML, always as a new flow."""
        return self._client.post("/api/flows/yaml", {"yaml": text})
