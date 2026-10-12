import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fixture } from "./runtime.test.js";
import { randomUUID } from "node:crypto";
import { createClient } from "../client.mjs";

const killOwnedGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

// The real installed Pi process loads both adapters. No external provider is contacted.
test("original running Pi captures interactive requests and admits exact-session feedback natively", async () => {
  const f = await fixture();
  const nativeId = randomUUID();
  const sessionDir = join(f.dir, "pi-sessions");
  await mkdir(sessionDir);
  const driver = join(f.dir, "driver.ts");
  const eventsPath = join(f.dir, "request-events.jsonl");
  const adapter = join(
    import.meta.dir,
    "../../../../.pi/agent/extensions/hunk-turn-review/index.ts",
  );
  await writeFile(
    driver,
    `import {writeFileSync,appendFileSync} from "node:fs";
    import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
    export default function(pi) {
      pi.registerProvider("htr-fixture",{baseUrl:"http://127.0.0.1:1",apiKey:"local-fixture",api:"htr-fixture",models:[{id:"local",name:"Local test",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1000}],streamSimple(model){
        const stream=createAssistantMessageEventStream();
        const message={role:"assistant",content:[{type:"text",text:"native fixture response"}],api:"htr-fixture",provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()};
        setTimeout(()=>{stream.push({type:"start",partial:message});stream.push({type:"done",reason:"stop",message});stream.end();},500);return stream;
      }});
      let continued=false;
      for(const event of ["user_request_start","user_request_end"]) pi.on(event,e=>appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify(e)+"\\n"));
      pi.on("session_start",(_e,ctx)=>{ctx.ui.setStatus("htr-driver","native-test-ready");});
      pi.on("before_agent_start",()=>{writeFileSync("tracked.txt","native Pi change\\n");});
      pi.on("agent_before_settle",()=>{if(!continued){continued=true;writeFileSync("tracked.txt","native Pi continuation\\n");return {entries:[{type:"custom_message",customType:"fixture-continuation",content:"Continue this response",display:false}],continue:true};}});
    }`,
  );
  const argv = [
    process.env.PI_TEST_BIN ?? "pi",
    "-ne",
    "-ns",
    "--no-mcp",
    "--offline",
    "--no-approve",
    "--provider",
    "htr-fixture",
    "--model",
    "local",
    "--thinking",
    "off",
    "--session-dir",
    sessionDir,
    "--session-id",
    nativeId,
    "-e",
    adapter,
    "-e",
    driver,
  ];
  const bridge = `import os,pty,sys,json,select,signal,fcntl,termios,struct,time
pid,fd=pty.fork()
if pid==0:
 a=json.loads(sys.argv[1]);os.execvpe(a[0],a,os.environ)
print("HTR_NATIVE_PID="+str(pid),file=sys.stderr,flush=True)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",40,140,0,0))
def stop(*args):
 raise SystemExit
signal.signal(signal.SIGTERM,stop)
try:
 while True:
  ready,_,_=select.select([0,fd],[],[])
  for source in ready:
   try: data=os.read(source,65536)
   except OSError: raise SystemExit
   if not data: raise SystemExit
   os.write(fd if source==0 else 1,data)
finally:
 try: os.killpg(pid,signal.SIGTERM)
 except ProcessLookupError: pass
 for attempt in range(100):
  if os.waitpid(pid,os.WNOHANG)[0]: break
  time.sleep(0.02)
 else:
  try: os.killpg(pid,signal.SIGKILL)
  except ProcessLookupError: pass
  os.waitpid(pid,0)
`;
  const child = spawn("python3", ["-u", "-c", bridge, JSON.stringify(argv)], {
    cwd: f.checkout,
    env: {
      ...process.env,
      HERDR_ENV: "1",
      HUNK_TURN_REVIEW_SOCKET: f.socket,
      HUNK_TURN_REVIEW_STATE: join(f.dir, "state"),
      HUNK_TURN_REVIEW_CLIENT: join(import.meta.dir, "../client.mjs"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));
  const wait = async (get: () => Promise<any>) => {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      try {
        const value = await get();
        if (value) return value;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Pi native fixture did not reach expected state: " + output.slice(-3000));
  };
  // Observe the real public lifecycle from the isolated native process, never infer identity from text.
  const requests = async () =>
    (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const completedFeedback = async (
    batchId: string,
    call: (method: string, params?: object) => Promise<any>,
  ) => {
    const start = (await requests()).find(
      (e) => e.type === "user_request_start" && e.request.correlationId === batchId,
    );
    if (!start) return;
    const latest = await call("review.get", { selection: "latest" });
    return latest.requestId === start.request.id && latest.outcome === "completed"
      ? latest
      : undefined;
  };
  try {
    await wait(async () => output.includes("native-test-ready"));
    child.stdin.write("fixture user request\r");
    const attached = await wait(async () => {
      const status = await f.client.request("session.find", {
        kind: "pi",
        nativeId,
        checkout: f.checkout,
      });
      return status.latest ? status : undefined;
    });
    const call = (method: string, params = {}) =>
      f.client.request(method, { sessionId: attached.sessionId, ...params });
    const review = await call("review.get");
    expect(Buffer.from(review.changes[0].before.content, "base64").toString()).toBe(
      "pre-existing edit\n",
    );
    expect(Buffer.from(review.changes[0].after.content, "base64").toString()).toBe(
      "native Pi continuation\n",
    );
    const note = await call("note.save", {
      reviewId: review.id,
      note: { text: "Explain this change without editing" },
    });
    const batch = await call("batch.create", { noteIds: [note.id] });
    expect((await call("batch.submit", { batchId: batch.id })).state).toBe("queued");
    expect((await call("batch.reconcile", { batchId: batch.id })).state).toBe("queued");
    expect((await call("review.status")).notes[0].state).toBe("submitted");
    const corrected = await wait(() => completedFeedback(batch.id, call));
    expect(corrected.requestId).not.toBe(batch.id);
    child.stdin.write("first busy request\r");
    const busy = await wait(async () => {
      const s = await call("review.status");
      return s.active && s.active.requestId !== corrected.requestId ? s.active : undefined;
    });
    const busyNote = await call("note.save", {
        reviewId: review.id,
        note: { text: "Explain the older snapshot after this request settles" },
      }),
      busyBatch = await call("batch.create", { noteIds: [busyNote.id] });
    expect((await call("batch.submit", { batchId: busyBatch.id })).state).toBe("pending");
    child.stdin.write("distinct external request while busy\r");
    const interrupted = await wait(async () => {
      const s = await call("review.status");
      for (const id of s.reviews) {
        const r = await call("review.get", { reviewId: id });
        if (r.requestId === busy.requestId) return r;
      }
    });
    expect(interrupted.label).toBe("changes observed during this response");
    expect(interrupted.outcome).toBe("interrupted");
    const busyCorrected = await wait(() => completedFeedback(busyBatch.id, call));
    expect(busyCorrected.requestId).not.toBe(busyBatch.id);
    expect((await call("batch.reconcile", { batchId: busyBatch.id })).state).toBe("queued");
    const receiver = createClient({ socket: attached.receiver.socket });
    const wrong = await receiver.request("admission.enqueue", {
      identity: { ...attached.identity, nativeId: randomUUID() },
      epoch: attached.epoch,
      batchId: randomUUID(),
      batch: { id: "untrusted" },
      prompt: "Must never be admitted",
    });
    expect(wrong.state).toBe("blocked");
    const pendingNote = await call("note.save", {
      reviewId: review.id,
      note: { text: "Original session only" },
    });
    const pending = await call("batch.create", { noteIds: [pendingNote.id] });
    child.stdin.write("/new\r");
    await wait(async () => {
      const s = await call("review.status");
      return !s.receiver ? s : undefined;
    });
    expect((await call("batch.submit", { batchId: pending.id })).state).toBe("blocked");
  } finally {
    // pty.fork gives this fixture's Pi its own process group. Terminate only the
    // process group reported by this bridge, then reap the test-owned bridge.
    const pid = /HTR_NATIVE_PID=(\d+)/.exec(output)?.[1];
    if (pid && child.exitCode === null && child.signalCode === null) killOwnedGroup(Number(pid));
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGKILL");
      await exited;
    }
    await f.close();
  }
}, 20000);
