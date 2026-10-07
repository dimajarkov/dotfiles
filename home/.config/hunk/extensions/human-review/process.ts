import { execFile } from "node:child_process";

export type Runner = (
  binary: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

/** Arguments remain separate through execFile; neither code nor comments enter a shell. */
export const run: Runner = (binary, args, cwd, env) =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      { cwd, env, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // Never display the command: Node errors can include the complete human prompt.
          let code = "command_failed";
          try {
            code = JSON.parse(stderr).error?.code ?? code;
          } catch {
            /* Non-JSON failures stay generic. */
          }
          reject(
            new Error(
              `${binary.split("/").pop()}: ${code}; delivery may be uncertain if input began`,
            ),
          );
        } else resolve(stdout);
      },
    );
  });

export function digest(value: unknown): string {
  return new Bun.CryptoHasher("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}
