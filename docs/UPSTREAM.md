# Upstream

**OMP Oracle** (`omp-oracle`) is the Oh My Pi ("OMP") fork of
[`fitchmultz/pi-oracle`](https://github.com/fitchmultz/pi-oracle), the `pi` extension that sends
long-running work to ChatGPT or Grok through the web app. This page records what the fork
preserves, what it changes, and how it tracks upstream.

Companion docs: [Documentation](README.md) · [Architecture](ARCHITECTURE.md) ·
[Compatibility](COMPATIBILITY.md) · [Release](RELEASE.md) · [Changelog](../CHANGELOG.md)

## What is preserved

- **Git history.** The fork branched from upstream `main` at the `upstream-compat-20260918` merge
  and retains every upstream commit.
- **User and agent contracts.** `/oracle`, `/oracle-followup`, `/oracle-auth`, `/oracle-read`,
  `/oracle-status`, `/oracle-cancel`, and `/oracle-clean`; `oracle_preflight`, `oracle_auth`,
  `oracle_submit`, `oracle_read`, and `oracle_cancel`; and the `/oracle` and `/oracle-followup`
  prompt templates.
- **Runtime and state identifiers.** The job layout under
  `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`, the `PI_ORACLE_*` environment variables,
  `/tmp/pi-oracle-state`, `/tmp/pi-oracle-auth-*`, and the `omp.pi-oracle.programmatic.v1` bridge
  symbol, so existing configurations, saved jobs, and host integrations keep working.
- **Validation harness.** `npm run verify:oracle`, the sanity harness, the Crabbox platform smoke
  lanes, and the ChatGPT preset proof.
- **License and authorship.** MIT license; Mitch Fultz is credited as a contributor in
  `package.json` and `README.md`.

## What the fork changes

- **Package identity.** Published on npm as `omp-oracle` from `alphastorm/omp-oracle`. Upstream's
  `pi-oracle` package does not carry fork commits and must be uninstalled before installing
  `omp-oracle`.
- **Opt-in shared-Chrome transports for ChatGPT.** Alongside the default isolated seed profile,
  the fork adds the [existing-Chrome relay](ARCHITECTURE.md#existing-chrome-relay-transport)
  (`browser.chatGptRelayEndpoint`) and the
  [managed browser](ARCHITECTURE.md#managed-browser-transport)
  (`browser.chatGptManagedProfileDir`), plus CDP frame capture and download-event native Markdown
  export for Deep Research. Upstream replaced unpinned real-Chrome automation with isolated
  seed-profile clones because tab-switching commands called `Page.bringToFront` and stole focus in
  the user's browser; the fork keeps the isolated seed profile as the default and adds the opt-in
  relay and managed-browser transports by pinning every command to a single job-owned tab without
  activating tabs or scraping `chrome://downloads` (see
  [Design lineage](ARCHITECTURE.md#design-lineage)).
- **Oh My Pi host compatibility.** Node worker launch, project-trust handling on hosts without
  Pi's trust exports, transient ChatGPT 403 classification, and the
  `omp.pi-oracle.programmatic.v1` programmatic bridge.
- **ChatGPT UI and collection hardening.** Shared UI control vocabulary across ChatGPT shell
  revisions (`chatgpt-ui-helpers.mjs`), composer-tool configuration, bound-turn capture
  (`response-capture.mjs`), and non-sending recollection (`oracle_read` with
  `action: "recollect"`).
- **Documentation.** Organized by reader role across `README.md` and `docs/`.

Per-release changes are recorded in [Changelog](../CHANGELOG.md).

## Tracking upstream

- **Merge, never rebase.** Upstream commits land as explicit merge commits so shared history stays
  intact. The latest recorded sync is upstream `4d96ffc` (2026-09-22), after
  `upstream-compat-20260918`: it imports cancellation-race and protected-profile test improvements
  plus a native Pi status smoke adapted to the fork's Pi `0.80.9` lockfile, while keeping runtime
  code, package identity, CI/Dependabot, and release gates fork-owned (upstream's shared
  compatibility fleet, Renovate policy, and Pi `0.86.1` dependency update are not adopted, and
  that test-only sync does not expand provider or platform qualification claims).
- **Release tags and version numbering.** Upstream's `v0.1.0`–`v0.7.20` tags remain in
  `fitchmultz/pi-oracle`. The fork's `v*` tags and npm versions restarted at `0.1.0` (based on
  upstream `0.7.20`), and [Changelog](../CHANGELOG.md) records the upstream base above the
  preserved upstream history divider.
- **Post-merge verification.** Every upstream merge must pass `npm run verify:oracle`; merges that
  touch archive packing, process cleanup, runtime or browser profile handling, package metadata,
  or the Crabbox harness also require the platform runs in
  [`docs/PLATFORM_SMOKE.md`](PLATFORM_SMOKE.md).
- **Upstream contributions.** Fixes that are not specific to Oh My Pi are candidates for upstream
  pull requests; the relay transport, managed browser, and OMP programmatic bridge remain
  fork-owned unless upstream requests them.

Community project; not affiliated with or endorsed by the Oh My Pi maintainers, the `pi-oracle`
maintainer, OpenAI, or xAI.
