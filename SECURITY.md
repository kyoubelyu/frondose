# Security Policy

## Supported versions

Only the latest published release of Frondose receives security updates.

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's private
vulnerability reporting:

**https://github.com/kyoubelyu/frondose/security/advisories/new**

Do not post exploit details in public issues. Include:

- the affected version and platform;
- a minimal reproduction;
- the security impact you observed.

## Security posture

- The agent tool layer performs **no shell execution** and no arbitrary file
  I/O; external capabilities are explicitly allowlisted.
- Browser automation is scoped to a dedicated Chrome profile; credentials live
  in the user's own secret store, never in the repository or build output.
- Releases are signed, checksummed, and accompanied by SBOM and provenance
  material; update metadata is validated before installation.
- The public source repositories contain no credentials, private hosts, or
  operator machine state.
