import { startCodexAdapter } from "./adapter.mjs";

// Only the native SessionStart hook supplies these values. No terminal/default endpoint inference.
const options = JSON.parse(process.argv[2]);
let adapter;
try {
  adapter = await startCodexAdapter(options);
  process.stdout.write("Original Codex review observer ready\n");
} catch (error) {
  process.stderr.write(`Hunk turn review observer unavailable: ${String(error)}\n`);
  process.exitCode = 1;
}
if (adapter) {
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await adapter.close();
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
}
