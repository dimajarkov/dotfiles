import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, canonicalCheckout } from "../client.mjs";
import { assertPrivateSocket } from "./feedback.js";

const usage = `Usage: hunk-turn-review-control <status|tab|reopen> --session-id <review-session-id> [--socket <owner-private-socket>]

Commands:
  status  Show the original session binding and current review placement
  tab     Open the same review in a full-width Herdr tab without focusing it
  reopen  Explicitly reopen the review beside its original native session

Options:
  --session-id  Exact review service session ID from the Hunk integration warning
  --socket      Runtime socket (defaults to HUNK_TURN_REVIEW_SOCKET or the installed HOME socket)
  -h, --help    Show this help
`;

interface ControlArgs {
  action: "status" | "tab" | "reopen";
  sessionId: string;
  socket?: string;
}

export function parseControlArgs(args: string[]): ControlArgs | { help: true } {
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) return { help: true };
  if (!args.length) throw new Error("A control action is required; use --help for usage");
  const [action, ...options] = args;
  if (action !== "status" && action !== "tab" && action !== "reopen")
    throw new Error(`Unknown action: ${action}`);
  let sessionId: string | undefined;
  let socket: string | undefined;
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (option !== "--session-id" && option !== "--socket")
      throw new Error(`Unknown option: ${option}`);
    if (i + 1 >= options.length || options[i + 1].startsWith("--"))
      throw new Error(`Missing value for ${option}`);
    const value = options[++i];
    if (!value) throw new Error(`Missing value for ${option}`);
    if (option === "--session-id") {
      if (sessionId !== undefined) throw new Error("Duplicate --session-id option");
      sessionId = value;
    } else {
      if (socket !== undefined) throw new Error("Duplicate --socket option");
      socket = value;
    }
  }
  if (!sessionId) throw new Error("Exact --session-id is required; use --help for usage");
  if (!/^[a-f0-9]{64}$/.test(sessionId))
    throw new Error("--session-id must be the exact review service session ID");
  return { action, sessionId, ...(socket ? { socket } : {}) };
}

function verifyIdentity(sessionId: string, status: any) {
  const identity = status?.identity;
  if (
    !identity ||
    !["pi", "codex"].includes(identity.kind) ||
    typeof identity.nativeId !== "string" ||
    !identity.nativeId ||
    typeof identity.checkout !== "string" ||
    (identity.sessionPath !== undefined && typeof identity.sessionPath !== "string")
  )
    throw new Error("Runtime did not return a valid original native-session identity");
  const checkout = canonicalCheckout(identity.checkout);
  if (checkout !== identity.checkout)
    throw new Error("Runtime session checkout is not canonical; refusing layout control");
  const boundSessionId = createHash("sha256")
    .update(
      JSON.stringify([identity.kind, identity.nativeId, identity.sessionPath ?? null, checkout]),
    )
    .digest("hex");
  if (boundSessionId !== sessionId)
    throw new Error("Review service session ID does not match its original native identity");
  return { ...identity, checkout };
}

export async function runControl(args = process.argv.slice(2), environment = process.env) {
  const parsed = parseControlArgs(args);
  if ("help" in parsed) {
    process.stdout.write(usage);
    return;
  }
  const socket =
    parsed.socket ||
    environment.HUNK_TURN_REVIEW_SOCKET ||
    join(environment.HOME || homedir(), ".local/state/hunk-turn-review/data/runtime.sock");
  assertPrivateSocket(socket);
  const client = createClient({ socket });
  const status = await client.request("review.status", { sessionId: parsed.sessionId });
  const identity = verifyIdentity(parsed.sessionId, status);
  const receipt =
    parsed.action === "status"
      ? {
          latest: status.latest,
          selection: status.selection,
          layoutState: status.layoutState,
          warnings: status.warnings,
        }
      : await client.request(parsed.action === "tab" ? "layout.tab" : "layout.reopen", {
          sessionId: parsed.sessionId,
        });
  process.stdout.write(
    JSON.stringify(
      {
        sessionId: parsed.sessionId,
        action: parsed.action,
        identity,
        receipt,
      },
      null,
      2,
    ) + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runControl().catch((error: unknown) => {
    process.stderr.write(`Hunk turn-review control refused: ${String(error)}\n`);
    process.exitCode = 1;
  });
