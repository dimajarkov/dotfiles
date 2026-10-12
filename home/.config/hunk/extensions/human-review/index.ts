import { realpathSync } from "node:fs";
import type {
  ExtensionChangeset,
  ExtensionReviewSnapshot,
  ExtensionReviewSnapshotNote,
  ExtensionReviewControls,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import { digest, run, runHunk } from "./process";
import { rememberOrigin, stateDirectory, writeBatch } from "./storage";
import type { Origin } from "./storage";
import { bindingFromEnvironment, registerTurnReview } from "./turn-review";

export function unchanged(
  captured: ExtensionReviewSnapshot,
  current: ExtensionReviewSnapshot | null,
): boolean {
  return (
    current !== null &&
    current.generation === captured.generation &&
    current.stateRevision === captured.stateRevision
  );
}

export function requireUnchanged(
  captured: ExtensionReviewSnapshot,
  ctx: { review: Pick<ExtensionReviewControls, "snapshot"> },
): void {
  if (!unchanged(captured, ctx.review.snapshot()))
    throw new Error("Review changed while preparing feedback; reopen review actions");
}

export function fence(text: string, language = ""): string {
  const ticks = "`".repeat(
    Math.max(3, ...(text.match(/`+/g) ?? []).map((match) => match.length + 1)),
  );
  return `${ticks}${language}\n${text}\n${ticks}\n`;
}

export default function humanReview(hunk: HunkExtensionAPI): void {
  if (![28, 29].includes(Number(hunk.apiVersion)))
    throw new Error("Human review requires the verified Hunk v0.23.0 / API 28 or patched API 29");
  const binding = bindingFromEnvironment();
  if (binding) {
    registerTurnReview(hunk, binding);
    return;
  }
  let changeset: ExtensionChangeset | undefined;
  let busy = false;
  const origins = new Map<string, Origin>();
  const uiFiles = new Map<string, { path: string; previousPath?: string; patch: string }>();
  const originEpochs = new Map<string, number>();
  let epoch = 0;
  let reloaded = false;
  const launchArgs = process.argv.slice(1);
  let lastSession:
    | {
        sessionId: string;
        pid: number;
        repoRoot: string;
        cwd: string;
        title: string;
        sourceLabel: string;
        inputKind: string | null;
        review?: unknown;
        launchedAt: string;
      }
    | undefined;

  function originFor(note: ExtensionReviewSnapshotNote): Origin {
    // fileKey is opaque and event contexts cannot read authoritative snapshots.
    // Retain the entire original inventory without inventing a fileKey mapping.
    return {
      note,
      file: uiFiles.has(note.id)
        ? { path: uiFiles.get(note.id)!.path, previousPath: uiFiles.get(note.id)!.previousPath }
        : null,
      patch: uiFiles.get(note.id)?.patch ?? null,
      inventory:
        (note.resolution === "active" && !uiFiles.has(note.id) ? changeset?.files : undefined)?.map(
          ({ id, path, previousPath, patch }) => ({
            id,
            path,
            previousPath,
            patch,
          }),
        ) ?? [],
      scope: changeset
        ? { id: changeset.id, title: changeset.title, sourceLabel: changeset.sourceLabel }
        : null,
      capturedAt: new Date().toISOString(),
    };
  }

  hunk.on("changeset_loaded", async ({ changeset: loaded }) => {
    changeset = loaded;
    epoch++;
    const capturedEpoch = epoch;
    // Attest the host identity before notes can become missing-file records.
    // Registration is asynchronous at startup; never retain another process or source.
    for (let attempt = 0; attempt < 5 && capturedEpoch === epoch; attempt++) {
      try {
        const sessions = JSON.parse(await runHunk(["session", "list", "--json"])).sessions;
        const own = sessions.filter((session: { pid: number }) => session.pid === process.pid);
        if (
          capturedEpoch === epoch &&
          own.length === 1 &&
          own[0].repoRoot &&
          own[0].sourceLabel === loaded.sourceLabel &&
          own[0].title === loaded.title
        ) {
          lastSession = own[0];
          return;
        }
      } catch {
        /* Command handlers report unavailable identity if startup never attests it. */
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });
  hunk.on("session_reload", () => {
    reloaded = true;
  });
  hunk.on("note_changed", ({ note, kind }) => {
    if (kind !== "removed" && note.source === "user" && !origins.has(note.id)) {
      // Save exact original anchors before a reload can reconcile them.
      // fileKey is opaque; resolve via the host event's file inventory below.
      origins.set(note.id, originFor(note));
      originEpochs.set(note.id, epoch);
    }
  });
  hunk.on("note_created", ({ note }) => {
    if (note.draft) return;
    const file = changeset?.files.find((candidate) => candidate.id === note.fileId);
    if (file)
      uiFiles.set(note.id, { path: file.path, previousPath: file.previousPath, patch: file.patch });
    const original = origins.get(note.id);
    if (original && file && original.patch === null) {
      origins.set(note.id, {
        ...original,
        file: { path: file.path, previousPath: file.previousPath },
        patch: file.patch,
        inventory: [],
      });
    }
  });

  hunk.registerCommand(
    { id: "actions", title: "Human review actions...", key: "ctrl+g" },
    async (ctx) => {
      if (busy) {
        ctx.notify("Review actions already running", "warning");
        return;
      }
      busy = true;
      try {
        const action = await ctx.dialogs.select({
          title: "Human review actions",
          options: [
            "Export saved human feedback",
            "Send saved human feedback to agent",
            "Refresh / re-review",
          ],
        });
        if (action === null) return;
        if (action === "Refresh / re-review") {
          if (!ctx.commands.execute("hunk.app.refresh"))
            ctx.notify("This review cannot be refreshed", "warning");
          return;
        }
        const captured = ctx.review.snapshot();
        if (!captured) throw new Error("Review is unavailable");
        const human = captured.notes.filter((note) => note.source === "user");
        if (human.length === 0) {
          ctx.notify("No saved human feedback; save drafts with Ctrl-S first", "warning");
          return;
        }

        // The public CLI resolves this exact process, even with several windows
        // reviewing the same checkout. It owns local session authentication.
        const sessions = JSON.parse(await runHunk(["session", "list", "--json"])).sessions;
        const matches = sessions.filter((session: { pid: number }) => session.pid === process.pid);
        if (matches.length > 1) throw new Error("Ambiguous Hunk process identity");
        const registrationCurrent = matches.length === 1 && !!matches[0].repoRoot;
        if (registrationCurrent) lastSession = matches[0];
        // v0.23.0 can reject its own broker registration when a file with saved
        // notes leaves the review. The in-process snapshot remains authoritative.
        // Keep exports available using a previously attested checkout, only while
        // the source and host directory still match; do not guess new identities.
        if (
          !lastSession ||
          (!registrationCurrent &&
            (changeset?.sourceLabel !== lastSession.sourceLabel ||
              realpathSync(ctx.cwd) !== realpathSync(lastSession.cwd)))
        )
          throw new Error(
            "Hunk session identity is unavailable; no attested checkout for this review",
          );
        const session = registrationCurrent
          ? lastSession
          : {
              ...lastSession,
              title: changeset?.title ?? lastSession.title,
              inputKind: null,
              review: null,
            };
        const checkout = realpathSync(session.repoRoot);
        const root = stateDirectory(checkout);
        requireUnchanged(captured, ctx);
        const observedAt = new Date().toISOString();
        const commonDir = realpathSync(
          (
            await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], checkout)
          ).trim(),
        );
        let head: string | null = null;
        try {
          head = (await run("git", ["rev-parse", "--verify", "HEAD"], checkout)).trim();
        } catch {
          /* Unborn HEAD. */
        }
        const scope = {
          changesetId: changeset?.id,
          title: session.title,
          sourceLabel: session.sourceLabel,
          inputKind: session.inputKind,
          review: session.review ?? null,
          launchArgs,
          launchArgsAreCurrent: !reloaded,
        };

        const notes = human.map((note) => {
          const file = captured.files.find((candidate) => candidate.fileKey === note.fileKey);
          const rendered = changeset?.files.find((candidate) => candidate.id === file?.runtimeId);
          let original = origins.get(note.id) ?? originFor(note);
          // Fill missing file context only before any reload; never substitute new
          // code for lost original context after the host calls a note stale/orphaned.
          if (
            original.patch === null &&
            note.resolution === "active" &&
            (originEpochs.get(note.id) === epoch || !origins.has(note.id))
          )
            original = {
              ...original,
              file: file ?? null,
              patch: rendered?.patch ?? null,
              inventory: rendered ? [] : original.inventory,
            };
          original = rememberOrigin(root, checkout, note.id, original);
          origins.set(note.id, original);
          return {
            ...note,
            file: file ?? null,
            currentPatch: rendered?.patch ?? null,
            original,
            originalContextAvailable: original.patch !== null || original.inventory.length > 0,
            originalFileAssociationAvailable: original.file !== null,
            filePresentInReview: file !== undefined,
            patchChangedSinceOriginal:
              original.patch !== null && rendered?.patch !== original.patch,
          };
        });
        const files = captured.files.map((file) => ({
          ...file,
          patch:
            changeset?.files.find((candidate) => candidate.id === file.runtimeId)?.patch ?? null,
        }));
        const actionableIds = notes.map((note) => note.id);
        const payload = {
          repository: {
            checkout,
            commonDir,
            observedAt,
            observedHead: head,
            headIsExportObservation: true,
          },
          session: {
            id: session.sessionId,
            pid: process.pid,
            launchedAt: session.launchedAt,
            registrationCurrent,
          },
          scope,
          review: {
            generation: captured.generation,
            stateRevision: captured.stateRevision,
            contentIdentity: digest(captured.files.map((f) => [f.fileKey, f.contentIdentity])),
          },
          files,
          actionableIds,
          notes,
          contextOnlyNotes: captured.notes.filter((note) => note.source !== "user"),
          originalContextPolicy:
            "Original is first observed saved-note context; missing context stays explicit. No guessed relocation.",
        };
        const fingerprint = digest({
          checkout,
          commonDir,
          scope: {
            title: scope.title,
            sourceLabel: scope.sourceLabel,
            inputKind: scope.inputKind,
            review: scope.review,
          },
          files: files.map(({ runtimeId: _runtimeId, ...file }) => file),
          notes,
        });
        const markdown =
          `Checkout: ${JSON.stringify(checkout)}\n\nScope: ${JSON.stringify(scope)}\n\nGeneration: ${captured.generation}; state revision: ${captured.stateRevision}; broker registration current: ${registrationCurrent}.\n\n` +
          notes
            .map(
              (note) =>
                `## ${note.id} (${note.resolution}${note.filePresentInReview ? "" : "; file missing from current review"})\n\nFile and exact old/new anchor:\n\n${fence(JSON.stringify({ file: note.file, anchor: note.anchor, parentId: note.parentId, original: note.original, originalContextAvailable: note.originalContextAvailable, originalFileAssociationAvailable: note.originalFileAssociationAvailable, filePresentInReview: note.filePresentInReview, patchChangedSinceOriginal: note.patchChangedSinceOriginal }, null, 2), "json")}\nExact comment:\n\n${fence(note.summary)}${note.rationale !== undefined ? `\nExact rationale:\n\n${fence(note.rationale)}` : ""}`,
            )
            .join("\n");
        requireUnchanged(captured, ctx);
        const batch = writeBatch(root, payload, fingerprint, markdown);
        ctx.notify(`Exported ${notes.length} human notes: ${batch.json}`);
        if (action === "Export saved human feedback") return;
        throw new Error(
          "Safe Send review requires the original native session binding. Export retained; open its owned turn-review viewer to submit.",
        );
      } catch (error) {
        ctx.notify(error instanceof Error ? error.message : "Review action failed", "error");
      } finally {
        busy = false;
      }
    },
  );
}
