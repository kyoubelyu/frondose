# Frondose Web

The public marketing and download site for the Frondose desktop agent. This is a
standalone static project: a single self-contained `index.html` (fonts and
styles embedded, zero network dependencies) plus a focused landing test.

The site does not own or proxy App updates. Download links target HTTPS GitHub
Release assets:

- macOS: `Frondose-universal.dmg`
- Windows: `Frondose-windows-x86_64-setup.exe`

## Project layout

```text
index.html          landing/download page (standalone)
README.md           this file
LICENSE             PolyForm Noncommercial 1.0.0
SECURITY.md         security policy
tests/              focused landing/download-link tests
```

## Development

Open `index.html` in a browser, or serve it statically:

```sh
python3 -m http.server 8080
```

## Test

```sh
npm test
```

No Node server, Tauri code, App source, update metadata, installer binary,
fleet console, credentials, private host, or issue board lives in this project.
