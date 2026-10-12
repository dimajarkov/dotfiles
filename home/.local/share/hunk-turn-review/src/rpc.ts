import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

/** A native host transport, with no terminal input or endpoint inference. */
export function socketRequest(socket: string, method: string, params: object) {
  return new Promise<any>((resolve, reject) => {
    const id = randomUUID(),
      c = connect(socket),
      decoder = new StringDecoder("utf8");
    let data = "";
    const fail = (e: Error) => {
      c.destroy();
      reject(e);
    };
    c.setTimeout(5000, () => fail(new Error("Native host timed out")));
    c.on("error", fail);
    c.on("connect", () => c.write(JSON.stringify({ id, method, params }) + "\n"));
    c.on("data", (chunk) => {
      data += decoder.write(chunk);
      if (Buffer.byteLength(data) > 16 * 1024 * 1024)
        return fail(new Error("Oversized native host response"));
      while (data.includes("\n")) {
        const i = data.indexOf("\n"),
          line = data.slice(0, i);
        data = data.slice(i + 1);
        try {
          const r = JSON.parse(line);
          if (r.id !== id) continue;
          c.end();
          if (r.error) reject(new Error(r.error.message));
          else resolve(r.result);
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
    c.on("end", () => reject(new Error("Native host closed without a receipt")));
  });
}
