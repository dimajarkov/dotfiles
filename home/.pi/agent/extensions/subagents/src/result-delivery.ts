export function createDeferredResultDelivery<T extends { readonly id: string }>() {
  const deferred = new Map<string, T>();

  return {
    defer(result: T) {
      deferred.set(result.id, result);
    },
    consume(ids: readonly string[]) {
      for (const id of ids) deferred.delete(id);
    },
    drain() {
      const results = [...deferred.values()];
      deferred.clear();
      return results;
    },
    clear() {
      deferred.clear();
    },
  };
}
