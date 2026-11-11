# Security policy

## Reporting a vulnerability

Please use GitHub's private security-advisory flow for this repository. Do not open a
public issue containing credentials, unpublished exploit details, or customer data.

Include the affected version, a minimal reproduction, impact, and any suggested
mitigation. Rotate any credential that may have been exposed during testing.

## Deployment assumptions

- Drive9 workspace and evidence credentials are distinct and path-scoped.
- Evidence storage is not mounted into the agent execution world.
- In the default profile, the Drive9 mount and Harness subprocess runtime share one host, container, or VM.
- Optional Runtime exec requires a separate authenticated evidence tenant, not just a different token or unmounted directory. Runtime commands can address the whole workspace drive.
- Runtime exec accepts only explicitly approved `danger-full-access`; it does not claim host-wide read-only or subtree confinement. The local and remote workspace paths must match.
- TLS and Drive9 authentication terminate at a trusted endpoint.
- Session seeding is trusted same-process Harness composition code.

Locators are unguessable capabilities, but possession alone is not authorization.
Retrieval also requires an integration-issued receipt and matching immutable manifest
and Harness event provenance.

See [docs/design-lock.md](docs/design-lock.md) for the full threat boundary.
