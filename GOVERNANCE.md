# Governance

## Maintainer

Frondose is a single-maintainer project. The maintainer owns:

- the product contract (tool inventory, system-prompt structure, persistence
  schema);
- release decisions, including versioning and publication;
- security-sensitive changes and the operator-validation gates between major
  versions.

## Contributions

Contributions are welcome under `CONTRIBUTING.md`. The maintainer reviews all
changes before they land. Behavior-changing contributions must include tests;
contract changes (tool names, schemas, on-disk paths) require explicit
approval and a version bump.

## Releases

Releases are cut from `main` on tags, built and verified on both supported
platforms, and published through the release workflow. No release ships
without passing the project's verification gates.
