# Security policy

## Reporting a vulnerability

Please report a security problem privately, not in a public issue, pull request or discussion.

Use GitHub's private reporting: open the **Security** tab of this repository and choose **Report a vulnerability**
(<https://github.com/stabrea/Branch-Agent/security/advisories/new>). Only the maintainers see the report.

Helpful things to include:

- what an attacker could do, and who the attacker is (someone on the same network, a web page Branch reads, a chat
  message, another program on the computer, a household profile, a short-lived key);
- the version (`branch version`, or Settings › Updates & about) and the operating system;
- the smallest steps that show it, and whether it needs a setting changed from how Branch ships.

Please don't include real passwords, keys or personal data in the report.

You should hear back within a week. Once a fix is released, the advisory is published with credit to you unless you ask
otherwise.

## What is in scope

- The Branch Agent engine (`src/`), its HTTP API and the app window (`public/`).
- The desktop app (`src/desktop/`), its gateway and its updater.
- The phone door, chat apps, pairing and short-lived keys, the MCP, A2A and ACP servers.
- The approval rules, Lockdown, the secrets locker, sign-in filling from a password manager, and the command sandbox.

Problems in a model provider, a chat service or a password manager themselves are theirs to fix. A way Branch passes
something to them that it should not is in scope.

## Supported versions

Security fixes go into the newest release. Branch updates itself, so please check the newest release still has the
problem before reporting.
