import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";

test("deferred results can be consumed, drained once, and cleared", () => {
  const delivery = createDeferredResultDelivery<{ id: string; answer: string }>();
  delivery.defer({ id: "first", answer: "one" });
  delivery.defer({ id: "second", answer: "two" });
  delivery.consume(["first"]);

  assert.deepEqual(delivery.drain(), [{ id: "second", answer: "two" }]);
  assert.deepEqual(delivery.drain(), []);

  delivery.defer({ id: "third", answer: "three" });
  delivery.clear();
  assert.deepEqual(delivery.drain(), []);
});
