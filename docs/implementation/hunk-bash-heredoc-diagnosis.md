# Native Bash here-document diagnosis, 2026-10-12

The blocker is a synchronous pipe write in Nix Bash 5.3p9, exposed by the host's current 512-byte effective pipe capacity.
The apparent temporary-file `ENOSPC` occurs after timeout termination, not before the stall.
The original diagnosis was read-only; the subsequently authorized source/package repair below is complete without production activation, staging, commits, or transfer.
The leased checkout remains `hunk-turn-review13`, dotfiles slot 13, branch `feat/hunk-turn-review`.

## Reproduction and syscall evidence

The bounded red command is:

```sh
python3 /private/tmp/hunk-bash-diag-ve2am1db/repro.py red
```

It launches `/nix/store/72yw9glj9rk3xwymwwp965869gn6k3dz-bash-interactive-5.3p9/bin/bash -c` with a literal, quoted here-document feeding `/bin/cat`.
It asserts exact output, times out after two seconds, records child PID/PGID, and terminates only its own verified process group.
Repeated runs return exit 1, zero output, and an owned child timeout.

| Delivered bytes, including newline | Declared Bash result |
| ---------------------------------- | -------------------- |
| 65, 256, 511, 512                  | Exact output, exit 0 |
| 513, 8,193, 16,384, 16,385, 65,536 | Stall, zero output   |
| 65,537                             | Exact output, exit 0 |

Samples of both the minimal child and unchanged generated Herdr helper show `do_redirection_internal` blocked in the kernel `write()` call.
Their parent Bash waits for the child.
Three independent nonblocking OS pipe probes each accept only 512 bytes from a 16,384-byte write.
`PIPE_BUF=512` alone is an atomicity guarantee; the separate write probes establish the current effective capacity.

The unchanged generated helper was replayed against an owned Unix socket using the captured synthetic SessionStart input and recorded synthetic PATH.
Its trace contains no `ENOSPC` before termination and no registration request.
Immediately after owned `SIGTERM`, it prints `cannot create temp file for here-document: No space left on device` and exits 1.
GNU Bash's inspected `redir.c` maps a short write with no errno to `ENOSPC`; its diagnostic also covers pipe failures.
The active path is a regular pipe, not POSIX shared memory.
Source: [GNU Bash 5.3 distribution](https://ftp.gnu.org/gnu/bash/bash-5.3.tar.gz), `redir.c`, functions `heredoc_write` and `here_document_to_fd`.

## Controls and ranked hypotheses

1. Dynamic kernel pipe capacity: confirmed as the immediate constraint by independent writes and sampled stacks.
2. Bash's compile-time capacity assumption: confirmed by the size boundary and successful regular-file controls.
3. Bad inherited TMPDIR/startup configuration: changing only TMPDIR or adding `--noprofile --norc` leaves the failure intact; an auth-free minimal environment also fails.
4. Disk, inode, descriptor, or process limits: ordinary temporary-file creation and a 65,537-byte write succeed; 34 GiB and approximately 353 million inodes are available, with roughly 23,000 descriptors against a 368,640 system limit.

With the same binary and input, this single-variable diagnostic control passes:

```sh
BASH_COMPAT=5.0 python3 /private/tmp/hunk-bash-diag-ve2am1db/repro.py red
```

The unchanged helper also succeeds with only that additional variable and reports the captured UUID to the private collector.
Compatibility mode and the earlier `/bin/bash` comparison are diagnostic controls only, not installation proposals or native acceptance.

Apple's [pipe implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/sys_pipe.c) conditions buffer growth on global pipe memory usage.
Global pipe pressure is therefore a supported explanation for the reduced capacity, not a verified attribution to one process.
This kernel does not expose the queried pipe memory/count sysctls.
Unprivileged inspection sees 4,004 pipe descriptors across 868 processes; this is not a unique pipe count or complete kernel inventory.
Old cache directories and watcher references do not establish cleanup ownership.
No conclusively task-owned live pressure source was identified, so no existing process, cache, semaphore, or shared-memory object was removed.

## Authorized source repair and ownership

The focused package maintenance authorization retains Nix ownership and upgrades only the declared Darwin Bash recipe from 5.3p9 to 5.3p16.
[nix/packages/bash-darwin-pipes.nix](../../nix/packages/bash-darwin-pipes.nix) shares the original locked recipe across interactive and noninteractive variants.
It retains the exact 5.3 tarball, GNU patches 001-009, downstream job-control patch, configure options, compiler flags, hardening, and output layout.
It inserts official GNU patches 010-016 between the original upstream series and downstream patches, with exact `fetchurl` hashes and matching `version`/`patch_suffix`.
The recipe refuses an unexpected upstream baseline rather than guessing its patch order.
No flake input or lockfile changed during this repair.

[GNU patch 016](https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-016) makes Darwin heredoc pipe writes nonblocking and falls back to private temporary files on `ENOSPC` or `EAGAIN`.
The maintainer's [July 2026 explanation](https://www.mail-archive.com/bug-bash%40gnu.org/msg36171.html) is supporting context; the build uses the hash-pinned official release patches, not the mailing-list attachment.
Fresh GNU downloads matched all seven independently recorded hashes before compilation.
Patches 010-015 cover inherited-job waiting, mapfile callback lifetime/correction, inherited EXIT traps, and read-buffer lifetime/bounds.

| GNU patch | SHA-256 SRI                                           |
| --------- | ----------------------------------------------------- |
| 010       | `sha256-z3bxzOLqMAwYv/nwAtIfKAzJMazRfChRgRC5P+bnJWk=` |
| 011       | `sha256-Apjfj16iox075D7X0mnFs8fDQt1bVwvqf2TWbcu+dTE=` |
| 012       | `sha256-1xN5s5vrrtrxI0FEFOd/tFigpDua0xFllMbffKZ1RXM=` |
| 013       | `sha256-BC+c2pZ+JL9CEZRGl0Qek9Bv9CtLmYYpqYobJJJ58gA=` |
| 014       | `sha256-vUNgtAHThQfjWHg9ythTapnGeJ8NOlvQz7jEo0FEaWw=` |
| 015       | `sha256-Vbec7uL8J/Z2fu1pfpOafrL+KijAFVa9dfGNWBAU9G4=` |
| 016       | `sha256-nqKbJmt9JMs00P8/HEYx5NUnv+LR7xXRfNuSS/Me92c=` |

The existing Nix Bash also stalls while running GNU configure's heredocs.
Only that POSIX configure step uses Dash from the same locked Nixpkgs set as a build tool.
The feature asset build's actual interpreter is the repaired noninteractive Bash, retaining its existing stdenv/compiler and build script.
The installed interactive shell and all eight feature Bash wrappers use 5.3p16.
Hunk/Pi/runtime source assets stay byte-identical; wrapper interpreter paths and the generated plugin's wrapper reference change through Nix packaging.
No generated Herdr helper was edited.

The feature profile contains `bin/bash`, so Home Manager omits its separate Bash package when consuming that profile.
Standalone Home Manager instead declares the same repaired interactive recipe.
Both branches are evaluated by `bash-home-wiring`, and `bash-darwin-source` asserts retained source, patch ordering, flags, hardening, and options for both variants.
No broad package-set overlay or nix-darwin rebuild is required for this focused profile build.

The repaired profile is `/nix/store/cqra6c74xz47xgdlcn8jlbfpzj65jnpr-hunk-turn-review-profile-1.0.0`.
Its retained root is `/private/tmp/hunk-bash-repair-hx0gli5g/roots/profile`.
Its `bin/bash` resolves to `/nix/store/42qfy5a6fhfa3fk2krvpx1ifzw5kb4wm-bash-interactive-5.3p16/bin/bash`.
Its wrapper interpreter is `/nix/store/wd2ys7yi9ns7fwvlrkq3mgimi2j69da4-bash-5.3p16/bin/bash`.
The one-bin audit with that profile first selects repaired Nix Bash and also reports the retained p9 user/per-user/system routes and `/bin/bash`.
Those duplicates are retained for rollback; the live global routes remain p9 because activation is outside this maintenance scope.

## Regression and native proof

[The public regression](../../nix/tests/bash-heredoc.py) first failed on the exact p9 binary with an owned timeout at 513 bytes.
Both repaired variants pass 512, 513, 4,096, 65,536, 65,537, and 131,073 byte payloads plus literal/Unicode/EOF checks in interactive and noninteractive modes.
A regular-file probe additionally checks exact contents, private permissions, zero links, and no leftover files in the dedicated TMPDIR.
No compatibility variable or lowered Bash language mode is used.
Fresh OS writes still accept only 512 bytes.

The ordinary rebuild measures `PIPESIZE=512` on this host.
To prove the algorithm rather than just that measurement, the `bash-heredoc-dynamic` check compiles the same patched source with the old `HEREDOC_PIPESIZE=65536` assumption and passes the same regression under the current 512-byte pipe limit.
That flag belongs only to the regression artifact and is absent from the installed variants.
The package records its real build configuration and exact source/patch provenance under `nix-support/bash-darwin-pipes`.

The unchanged generated SessionStart helper, SHA-256 `38a90a2a99872d06dcbc978e7613406cdd852dbb07503abd7a113f518d5951f3`, completes through the repaired profile and reports the correct captured UUID and pane to a private socket.
The public native fixture models the installer's PATH hook in its synthetic home because system zshenv otherwise resets hook subprocesses to the unactivated p9 route.
Its selected Codex wrapper invokes only the existing credential-free app-server branch.
Generated helper bytes, native trust, production configuration, and authentication files are untouched.
Current Codex/Pi direct/default results and source/package checks are recorded in [finalization evidence](hunk-turn-review-finalization.md).

## Private proof and preservation

New evidence is `/private/tmp/hunk-bash-diag-ve2am1db`: `minimal-native-red.json`, `minimal-compat50-control.json`, `kernel-probes.json`, `resources-and-owner.json`, `pipe-owner-counts.json`, `helper-replay.json`, `helper-replay-compat50-counterfactual.json`, source hashes, and owned-child samples.
The helper SHA-256 is `38a90a2a99872d06dcbc978e7613406cdd852dbb07503abd7a113f518d5951f3`.
Original evidence remains under `hunk-session-recovery-iete88yk/finalization._ltroqfj`, including `shell-counterfactual.json` and `heredoc-size-matrix.json`.
The original diagnosis added only this document; the later repair has its own bounded changed-file and preservation receipts.
All diagnostic groups were verified absent afterward.
Original servers, panes, agents, leases, source work, rooted profiles, and unrelated preservation backups were untouched.

Repair receipts, native fixture results, source comparisons, manager audit, rooted checks, and current primary preservation copies are retained under `/private/tmp/hunk-bash-repair-hx0gli5g`.
