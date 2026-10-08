# Changelog

## [0.1.2] - 2026-10-08

- **The local server warms up before it reports ready.** A fresh server's first request no longer runs past the routing deadline or stalls a compaction.
- **Correct first-start download size.** The README now says about 2 GB: Python packages with PyTorch plus the ~650 MB model.
- **Documented Claude Code's model warning.** The README explains the `unrecognized_model` notice and the estimated cost report, and that only one router should run per session.

## [0.1.1] - 2026-10-08

- **Routing works with hooks that add output.** Turns followed by hook output or the environment block are routed again instead of staying on the default model. [#58](https://github.com/gargpratyush/jev-router/issues/58), [#48](https://github.com/gargpratyush/jev-router/issues/48), [#28](https://github.com/gargpratyush/jev-router/issues/28), [#18](https://github.com/gargpratyush/jev-router/issues/18)
- **The first turn can start on a cheaper model.** A large opening message no longer blocks the downgrade on the first turn, when there is no cache to lose yet. [#59](https://github.com/gargpratyush/jev-router/issues/59)
- **Images no longer count as huge conversations.** A pasted image counts as its real cost, not as its encoded size, and the context metric no longer stops at 200K. [#41](https://github.com/gargpratyush/jev-router/issues/41)
- **No more routing to a model that is too small.** A model whose window cannot hold the whole request is no longer offered, so the API does not reject the turn. [#42](https://github.com/gargpratyush/jev-router/issues/42)
- **Codex picks a cheaper model again.** Laya sees one Codex model per tier, preferring the configured one, so trivial turns can be downgraded. [#49](https://github.com/gargpratyush/jev-router/issues/49)
- **Codex replies keep accented text and emoji intact.** Characters split between two network chunks are no longer corrupted. [#54](https://github.com/gargpratyush/jev-router/issues/54)
- **laya-codex exits when Codex exits.** Closing the proxy now also closes its open connections. [#31](https://github.com/gargpratyush/jev-router/issues/31)
- **Windows: laya-codex prefers codex.cmd.** The PowerShell shim, which could hang, is now the last choice. [#30](https://github.com/gargpratyush/jev-router/issues/30)
- **The proxy accepts only local requests.** Requests with a foreign host or origin get 403, so a web page cannot use the proxy. [PR #63](https://github.com/gargpratyush/jev-router/pull/63)
- **Safer settings files.** The status-line settings file is readable only by you, and your Claude Code settings are restored atomically, also on SIGTERM and SIGHUP. [PR #57](https://github.com/gargpratyush/jev-router/pull/57)
- **Override phrases must be the whole prompt.** Only a turn that is exactly `use opus` (or similar) switches model; the phrase inside other text does nothing. [PR #65](https://github.com/gargpratyush/jev-router/pull/65)
- **Stable status tests.** Tests no longer reuse status files from earlier runs. [#43](https://github.com/gargpratyush/jev-router/issues/43)
- **Tests run on Node 20.** `npm test` no longer depends on Node 22 glob support. [PR #32](https://github.com/gargpratyush/jev-router/pull/32)

## [0.1.0] - 2026-10-08

- **First release as laya-router.** Port of jev-router: each turn's model is chosen by Laya, on a laya-serve server (`LAYA_URL`) or on a shared local server with the multilingual model. Includes tuning sheets.
