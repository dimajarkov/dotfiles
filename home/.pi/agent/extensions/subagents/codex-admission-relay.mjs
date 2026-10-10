import fs from "node:fs";
import path from "node:path";

const ASYNC_QUESTION_TOOLS = new Set([
  "request_user_input_async",
  "send_user_message_async",
]);

const NATIVE_READ_METHODS = new Set([
  "thread/read",
  "thread/subscribe",
  "thread/unsubscribe",
]);

const THREAD_SCOPED_METHODS = new Set([
  ...NATIVE_READ_METHODS,
  "thread/resume",
  "thread/queue/add",
  "turn/start",
]);

export function filterManagedModelCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new TypeError("model catalog must contain a models array");
  }

  return {
    ...catalog,
    models: catalog.models.map((model) => {
      if (!model || typeof model !== "object" || typeof model.slug !== "string") {
        throw new TypeError("each catalog model must have a slug");
      }
      const markers = model.experimental_supported_tools;
      if (markers === undefined) return { ...model };
      if (!Array.isArray(markers) || markers.some((marker) => typeof marker !== "string")) {
        throw new TypeError(`invalid experimental tool markers for ${model.slug}`);
      }
      return {
        ...model,
        experimental_supported_tools: markers.filter(
          (marker) => !ASYNC_QUESTION_TOOLS.has(marker),
        ),
      };
    }),
  };
}

export class AdmissionAuthority {
  #capacity;
  #available;
  #leases = new Map();
  #tail = Promise.resolve();
  #journalPath;

  constructor({ capacity = 4, available = true, existing = [], journalPath: journal } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError("capacity must be a positive integer");
    }
    this.#capacity = capacity;
    this.#available = available;
    this.#journalPath = journal;

    if (journal) {
      this.#loadJournal(journal);
    } else {
      for (const reservation of existing) {
        if (typeof reservation !== "string" || !reservation) {
          throw new TypeError("existing reservations must be non-empty strings");
        }
        this.#leases.set(reservation, { kind: "external" });
      }
    }
    if (this.#leases.size > this.#capacity) {
      throw new Error("existing reservations exceed capacity");
    }
  }

  #loadJournal(journal) {
    const absolute = path.resolve(journal);
    this.#journalPath = absolute;
    if (!fs.existsSync(absolute)) return;
    const metadata = fs.lstatSync(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new Error("admission journal must be a private regular file");
    }
    const contents = fs.readFileSync(absolute, "utf8");
    if (contents && !contents.endsWith("\n")) {
      throw new Error("admission journal ends with an incomplete record");
    }
    for (const line of contents.split("\n").filter(Boolean)) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error("admission journal contains an invalid record");
      }
      if (typeof record.id !== "string" || !record.id || !["reserve", "release"].includes(record.event)) {
        throw new Error("admission journal contains an unknown record");
      }
      if (record.event === "reserve") {
        if (this.#leases.has(record.id)) throw new Error("admission journal repeats an active reservation");
        const kind = record.kind ?? "managed";
        if (typeof kind !== "string" || !kind) throw new Error("admission journal contains an invalid lease kind");
        this.#leases.set(record.id, { kind });
      } else {
        if (!this.#leases.has(record.id)) throw new Error("admission journal releases an unknown reservation");
        this.#leases.delete(record.id);
      }
    }
  }

  #appendRecord(record) {
    if (!this.#journalPath) return;
    fs.mkdirSync(path.dirname(this.#journalPath), { recursive: true, mode: 0o700 });
    const existed = fs.existsSync(this.#journalPath);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW;
    const descriptor = fs.openSync(this.#journalPath, flags, 0o600);
    try {
      const metadata = fs.fstatSync(descriptor);
      if (!metadata.isFile()) throw new Error("admission journal is not a regular file");
      fs.fchmodSync(descriptor, 0o600);
      const line = Buffer.from(`${JSON.stringify(record)}\n`);
      let offset = 0;
      while (offset < line.length) {
        const written = fs.writeSync(descriptor, line, offset);
        if (written <= 0) throw new Error("admission journal write made no progress");
        offset += written;
      }
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (!existed) {
      const directory = fs.openSync(path.dirname(this.#journalPath), fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  }

  async #exclusive(action) {
    const previous = this.#tail;
    let unlock;
    this.#tail = new Promise((resolve) => (unlock = resolve));
    await previous;
    try {
      return await action();
    } finally {
      unlock();
    }
  }

  setAvailable(available) {
    this.#available = Boolean(available);
  }

  async reserve(id, kind = "managed") {
    if (typeof id !== "string" || !id) throw new TypeError("lease id is required");
    return this.#exclusive(() => {
      if (!this.#available) return { admitted: false, reason: "authority-unavailable" };
      if (this.#leases.has(id)) return { admitted: false, reason: "already-reserved" };
      if (this.#leases.size >= this.#capacity) return { admitted: false, reason: "capacity" };
      try {
        this.#appendRecord({ event: "reserve", id, kind });
      } catch {
        this.#available = false;
        return { admitted: false, reason: "journal-unavailable" };
      }
      this.#leases.set(id, { kind });
      return { admitted: true, reason: "reserved" };
    });
  }

  async release(id) {
    return this.#exclusive(() => {
      if (!this.#leases.has(id)) return false;
      try {
        this.#appendRecord({ event: "release", id });
      } catch {
        this.#available = false;
        return false;
      }
      return this.#leases.delete(id);
    });
  }

  async reacquire(id) {
    return this.#exclusive(() => {
      if (!this.#available || !this.#leases.has(id)) return false;
      return true;
    });
  }

  snapshot() {
    return Object.freeze({
      available: this.#available,
      capacity: this.#capacity,
      active: this.#leases.size,
      leases: Object.freeze(
        [...this.#leases.entries()].map(([id, value]) => ({ id, ...value })),
      ),
    });
  }
}

export class ManagerOwnedQueue {
  #threadId;
  #items = [];

  constructor(threadId) {
    if (typeof threadId !== "string" || !threadId) throw new TypeError("threadId is required");
    this.#threadId = threadId;
  }

  enqueue(request) {
    const params = request?.params ?? {};
    if (params.threadId !== this.#threadId || !Array.isArray(params.input)) {
      return { error: { code: "FOREIGN_THREAD_OR_INVALID_QUEUE_ITEM" } };
    }
    const submission = {
      id: `manager-queue-${this.#items.length + 1}`,
      clientUserMessageId: params.clientUserMessageId ?? `client-${this.#items.length + 1}`,
      input: params.input,
    };
    this.#items.push(submission);
    return { result: { queuedSubmission: structuredClone(submission) } };
  }

  take() {
    return this.#items.shift();
  }

  get size() {
    return this.#items.length;
  }
}

export class NativeRequestPolicy {
  #authority;
  #threadId;
  #queue;
  #activeRuns = new Set();

  constructor({ authority, threadId, queue = new ManagerOwnedQueue(threadId) }) {
    if (!(authority instanceof AdmissionAuthority)) {
      throw new TypeError("authority must be an AdmissionAuthority");
    }
    if (typeof threadId !== "string" || !threadId) {
      throw new TypeError("threadId is required");
    }
    this.#authority = authority;
    this.#threadId = threadId;
    this.#queue = queue;
  }

  async admitStart(runId, forward) {
    const existingLease = this.#authority.snapshot().leases.some(
      (lease) => lease.id === this.#threadId,
    );
    if (existingLease || this.#activeRuns.size > 0) {
      return { admitted: false, error: { code: "THREAD_BUSY_OR_LEASE_HELD" } };
    }
    const reservation = await this.#authority.reserve(this.#threadId);
    if (!reservation.admitted) {
      return {
        admitted: false,
        error: {
          code: reservation.reason === "authority-unavailable"
            ? "ADMISSION_UNAVAILABLE"
            : "ADMISSION_DENIED",
        },
      };
    }
    this.#activeRuns.add(runId);
    try {
      return { admitted: true, result: await forward() };
    } catch (error) {
      // A failed downstream write has an ambiguous outcome. Keep the lease until
      // the owner proves the host is quiescent and explicitly releases it.
      throw error;
    }
  }

  async handleNativeRequest(request, forward) {
    if (!request || typeof request.method !== "string") {
      return { error: { code: "UNCLASSIFIED_ROUTE" } };
    }
    const params = request.params ?? {};
    if (THREAD_SCOPED_METHODS.has(request.method) && params.threadId !== this.#threadId) {
      return { error: { code: "FOREIGN_THREAD" } };
    }
    if (request.method === "thread/queue/add") {
      return this.#queue.enqueue(request);
    }
    if (request.method === "turn/start") {
      if (
        (typeof request.id !== "string" || request.id.length === 0) &&
        (typeof request.id !== "number" || !Number.isFinite(request.id))
      ) {
        return { error: { code: "UNCLASSIFIED_ROUTE" } };
      }
      const decision = await this.admitStart(String(request.id), () => forward(request));
      return decision.admitted
        ? { result: decision.result }
        : { error: decision.error };
    }
    if (NATIVE_READ_METHODS.has(request.method) || request.method === "thread/resume") {
      return { result: await forward(request) };
    }
    return { error: { code: "UNCLASSIFIED_ROUTE" } };
  }

  async settle(runId, { goalStatus = "none", turnActive = false, pauseBarrierObserved = false } = {}) {
    this.#activeRuns.delete(runId);
    if (turnActive || goalStatus === "active" || !pauseBarrierObserved) return false;
    return this.#authority.release(this.#threadId);
  }

  queueSize() {
    return this.#queue.size;
  }
}

export class SinglePolicyResponder {
  #token;
  #owner;
  #pending = new Map();

  constructor(token) {
    if (typeof token !== "string" || token.length < 32) {
      throw new TypeError("management token must contain at least 32 characters");
    }
    this.#token = token;
  }

  connect(owner, token) {
    if (token !== this.#token) return { accepted: false, reason: "unauthorized" };
    if (this.#owner !== undefined) return { accepted: false, reason: "owner-already-connected" };
    this.#owner = owner;
    return { accepted: true };
  }

  disconnect(owner) {
    if (this.#owner !== owner) return false;
    this.#owner = undefined;
    return true;
  }

  offer(requestId, request) {
    if (this.#owner === undefined) return undefined;
    const pending = this.#pending.get(requestId);
    if (pending) {
      if (pending.owner !== this.#owner) return undefined;
      return Object.freeze({ owner: this.#owner, requestId, request: pending.request, replay: true });
    }
    this.#pending.set(requestId, { owner: this.#owner, request });
    return Object.freeze({ owner: this.#owner, requestId, request, replay: false });
  }

  respond(owner, requestId, result) {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.owner !== owner || this.#owner !== owner) return false;
    this.#pending.delete(requestId);
    return { requestId, result };
  }
}
