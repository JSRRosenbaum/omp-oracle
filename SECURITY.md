# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability
reporting: [Report a vulnerability](https://github.com/alphastorm/omp-oracle/security/advisories/new).

Include:

- `omp-oracle` version or commit
- Host (Oh My Pi or `pi`) and its version
- Operating system and browser version
- Auth transport (isolated seed profile, existing-Chrome relay, or managed browser)
- Reproduction steps and redacted logs (`worker.log` or `oracle-auth.log`)

Never include cookies, tokens, browser profile directories (`oracle-auth-seed-profile`, runtime
profiles, or managed Chrome profiles), `job.json` secrets, or private provider conversation
contents.

## Scope

The security model, what leaves the machine, local trust boundaries, and out-of-scope threats are
documented in [`docs/SECURITY.md`](docs/SECURITY.md). Provider-side handling of uploaded archives
and prompts is governed by your ChatGPT or Grok account, not by this extension.

`pi-oracle` on npm is the upstream package; report issues in its code to
[`fitchmultz/pi-oracle`](https://github.com/fitchmultz/pi-oracle) unless they are specific to
this fork.

## Supported versions

The latest commit on `main` and the most recent published `omp-oracle` release receive fixes.
