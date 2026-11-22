# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Usogakie/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Usogakie/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. Applies a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON text-editor tool calls to a tree of text files, all or nothing. Node 22, standard library only, deterministic.

## Run it

```sh
node main.ts [PATCH]
```

Options: `--format=unified|search-replace|v4a|json|auto` (default auto), `--check` (dry run, writes nothing), `--strict` (exact line matching only). With no PATCH, or PATCH `-`, the patch is read from standard input. `runner.ts` hands a trial over to the kit's runner when `MAKEFUN_ENV_URL` is set.

---

<sub>Entered on [make.fun](https://make.fun/?ref=skbtbry2&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
