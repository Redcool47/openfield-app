# Security

Openfield runs entirely on your machine. It makes no network requests at
runtime, has no accounts, no server component and no telemetry, so the attack
surface is the files it reads and writes.

## Reporting

Open a private report through GitHub's **Security → Report a vulnerability** on
this repository. Please do not open a public issue for something exploitable.

Useful in a report: the version, the platform, the command or file that
triggers it, and what an attacker gains. A reproduction on a throwaway
workspace is worth more than a long description.

## What is in scope

- The workspace on disk: path traversal through page titles or imports, a file
  written outside the workspace folder, symlink handling.
- Import parsers: Markdown, CSV and any HTML in imported content.
- The Electron shell: renderer/preload boundaries, `nodeIntegration`, context
  isolation, and anything the packaged app exposes to a page.
- The `ow` CLI parsing arguments or scripts.

## What is not

- Anything requiring a malicious local user who can already edit the workspace
  files directly — that person owns the data by definition.
- Denial of service by a deliberately enormous workspace.
- Reports from a scanner with no demonstrated impact.

## Supported versions

The latest release. This is an alpha: fixes land on `main` and ship in the next
release rather than being backported.
