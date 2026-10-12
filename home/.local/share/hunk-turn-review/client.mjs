import { StringDecoder } from "node:string_decoder";
import { connect } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** Native instruction identity excludes renderer/reconciliation and explicit disposition. */
export function nativeNoteRevision(note, provenance) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        note.id,
        note.parentId,
        note.summary,
        note.rationale,
        note.markup,
        note.title,
        note.author,
        note.createdAt,
        note.updatedAt,
        note.tags,
        note.confidence,
        note.anchor.oldRange,
        note.anchor.newRange,
        note.anchor.preferred,
        provenance,
      ]),
    )
    .digest("hex");
}

export function canonicalCheckout(path) {
  return realpathSync(
    execFileSync("git", ["-C", realpathSync(path), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
  );
}

/** The same client runs in Node, Pi, Codex hooks, and Hunk. */
export function createClient({ socket, timeoutMs = 30000 }) {
  return {
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const connection = connect(socket);
        let data = "";
        const decoder = new StringDecoder("utf8");
        const fail = (error) => {
          connection.destroy();
          reject(error);
        };
        connection.setTimeout(timeoutMs, () => fail(new Error("Turn-review runtime timed out")));
        connection.on("error", fail);
        connection.on("connect", () =>
          connection.write(JSON.stringify({ version: 1, id, method, params }) + "\n"),
        );
        connection.on("data", (chunk) => {
          data += decoder.write(chunk);
          if (Buffer.byteLength(data) > 256 * 1024 * 1024)
            return fail(new Error("Oversized runtime response"));
          if (!data.includes("\n")) return;
          try {
            const response = JSON.parse(data.slice(0, data.indexOf("\n")));
            if (response.version !== 1 || response.id !== id)
              throw new Error("Incompatible runtime response");
            connection.end();
            if (response.error) {
              reject(
                Object.assign(new Error(response.error.message), { code: response.error.code }),
              );
            } else resolve(response.result);
          } catch (error) {
            fail(error);
          }
        });
        connection.on("end", () => {
          if (!data.includes("\n")) fail(new Error("Runtime closed without receipt"));
        });
      });
    },
  };
}
