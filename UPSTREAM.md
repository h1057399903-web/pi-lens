# Downstream maintenance policy

This repository is the Workbench-owned downstream of
[`apmantza/pi-lens`](https://github.com/apmantza/pi-lens). It provides a
reviewed, reversible release lane while keeping pi-lens close to its active
upstream.

## Provenance

| Item | Value |
| --- | --- |
| Upstream | `https://github.com/apmantza/pi-lens.git` |
| Upstream license | MIT (`LICENSE`) |
| Upstream default branch | `master` |
| Downstream owner | `h1057399903-web` |
| Downstream integration branch | `master` |
| Downstream release/default branch | `stable` |
| Bootstrap base | `ccf33b136d1fd46399ecddf9264531af03024d58` (`v4.1.3`) |
| Last synced upstream commit | `ccf33b136d1fd46399ecddf9264531af03024d58` (`v4.1.3`) |

## Intentional downstream changes

Downstream-only files stay separate from upstream implementation code:

- `UPSTREAM.md` records provenance, synchronization, release, and rollback
  policy. It is force-tracked: the upstream `.gitignore` lists this name, so
  adding it requires `git add -f`, and upstream changes to that entry never
  affect the tracked file.
- `.github/workflows/downstream-compat.yml` runs the upstream checks on Linux
  (Node.js 22.19.0, the runtime upstream CI itself tests — the package
  declares no `engines` field) and the manually dispatched disposable
  distribution test.
- `downstream/compatibility.json` declares the package entry point and the
  expected Pi tool and command surfaces for Workbench's shared exact-SHA gate.
- `downstream/verify-distribution.mjs` exercises fresh install, update,
  commit-pinned rollback, and return to the stable lane in an isolated Pi
  home. Compared with the pi-web-access verifier it only extends the
  per-command timeout, because pi-lens's upstream `prepare` lifecycle builds
  the bundled extension entry and downloads core tree-sitter grammars during
  every `pi install`.

Do not carry implementation patches without recording their purpose, upstream
issue or PR, and removal condition in this section.

## Inherited upstream workflows

The fork inherited eighteen upstream GitHub Actions workflows. They are
disabled through the repository's Actions settings (not deleted from the
tree) because they encode upstream-repo-specific process — merge-train
dispatch validation, per-PR changelog fragments and PR-title lint, greetings
and stale bots, nightly smokes — that cannot pass or is unwanted in this
downstream. Disabling them at the API level keeps the tree identical to
upstream, so synchronization merges never conflict on `.github/workflows`.
The lane's own `Downstream compatibility` workflow is the only active one.
Re-enable any of them only with a recorded reason, mirroring what upstream
CI covers that the lane workflow does not.

## Extension entry point

Unlike pi-web-access, whose entry point is repository source, pi-lens's
`pi.extensions` entry is the built artifact `dist/index.js`. The upstream
`build:dist` script produces a self-contained bundle whose bare-specifier
runtime dependencies are inlined exactly so hosts can load it from a plain
Git checkout. The Workbench gate therefore runs `npm run build:dist` after its
credential-checked, script-suppressed install, before asserting the joint
surface. `dist/` is generated, never committed.

## Diagnostics compatibility surface

pi-lens registers fourteen tools. Eight are always active:
`lens_diagnostics`, `lsp_diagnostics`, `symbol_search`, `project_report`,
`module_report`, `read_symbol`, `read_enclosing`, and the activation loader
`pi_lens_activate_tools`. Six situational tools (`ast_grep_search`,
`ast_grep_replace`, `ast_grep_outline`, `ast_grep_dump`, `lsp_navigation`,
`lens_diagnostic_mark`) are registered but deactivated on `session_start` by
upstream design and become visible only after `pi_lens_activate_tools`. The
compatibility manifest therefore requires only the deterministic
always-active tier, which includes the two diagnostics tools at the core of
this lane's compatibility review, plus all nine `lens-*` commands.

## Branch and consumer contract

- `master` receives reviewed upstream synchronization PRs.
- `stable` is the default branch and moves only to an exact reviewed `master`
  commit after all required checks and a compatibility review pass.
- Routine users install the unqualified owned source:

  ```sh
  pi install git:github.com/h1057399903-web/pi-lens
  ```

  With no ref, `pi update --extensions` follows the repository's default
  `stable` branch.
- A full commit ref is a hard pin used for rollback:

  ```sh
  pi install git:github.com/h1057399903-web/pi-lens@<reviewed-commit>
  ```

  Pi reconciles pinned refs but does not advance them during
  `pi update --extensions`. Reinstall the unqualified source to rejoin the
  moving stable lane.

## Synchronizing upstream

For each selected upstream release or commit:

1. Fetch upstream and identify the exact old and new upstream SHAs.
2. Create `sync/upstream-<version-or-sha>` from downstream `master`.
3. Merge the selected upstream commit without squashing, preserving ancestry.
4. Update **Last synced upstream commit** above.
5. Record the upstream range, release notes, conflicts, audit findings,
   compatibility result, and rollback SHA in the PR.
6. Run `npm ci`, `npm run build`, `npm test`, `npm run lint`,
   `npm audit --omit=dev --audit-level=high`, and `npm pack --dry-run` on
   Linux.
7. Run the private Workbench shared gate against the exact sync head.
8. Obtain review, merge into `master`, then promote that exact accepted
   commit to `stable` and rerun the stable/disposable workflow.

Example:

```sh
git fetch upstream master --tags
git fetch downstream master stable
git switch -c sync/upstream-vX.Y.Z downstream/master
git merge --no-ff <upstream-sha>
# update this file, run checks, push, and open a PR targeting master
```

## Compatibility baseline

The bootstrap baseline is:

- pi-lens `v4.1.3` / `ccf33b136d1fd46399ecddf9264531af03024d58`;
- Workbench `3a46553ed38b8f0bf04db6dabc9e5af459461065`;
- Pi `0.84.4`;
- CI runtime Node.js `22.19.0`.

Workbench's shared compatibility runner checks the exact downstream SHA, loads
both extension entry points in an isolated Pi process, requires pi-lens's
eight always-active tools and nine commands, and then verifies that Workbench
still starts without this optional package. `PI_OFFLINE=1` suppresses
Pi-managed network activity for this check, but it is not a network sandbox
and does not prevent extension code or child processes from opening network
connections; pi-lens's own `prepare` lifecycle legitimately downloads the
TypeScript compiler and core tree-sitter grammars during installation.

Linux CI is authoritative for the upstream suite. Upstream CI runs its suite
on Node.js 22 on Linux; this lane mirrors that runtime instead of inventing
an untested one, and environment-specific failures on other hosts are not
patched into upstream code.

## Rollback

Preferred rollback is non-destructive:

1. Identify the last known-good promoted commit.
2. Pin affected users immediately with the full-commit command above.
3. Revert the bad synchronization or downstream patch on `master` through a
   PR.
4. Promote the reviewed revert commit to `stable` after checks pass.
5. Reinstall the unqualified source and run `pi update --extensions` to
   return users to the moving lane.

If `stable` must move back before a revert PR lands, an owner may reset it to
the last known-good reviewed commit with `--force-with-lease`. Record the
incident and exact old/new SHAs in the tracking issue.
