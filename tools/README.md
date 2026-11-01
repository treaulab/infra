# tools

Operator helpers invoked by the root `Justfile`. They are implementation
details, not a second interface: use `just ...`.

- `deploy-public.sh` — compatibility wrapper for `just deploy-public` (Ansible).
- `bump-spoke.sh` — pin a tailnet-runner spoke to a hub SHA.
- `gh-shell.sh` — dispatch a tailnet runner and SSH in.
