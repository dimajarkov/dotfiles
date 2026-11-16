# Good and Bad Tests

## Good Tests

**Integration-style**: Test through real interfaces, not mocks of internal parts.

```typescript
// GOOD: Tests observable behavior
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

Characteristics:

- Tests behavior users/callers care about
- Uses public API only
- Survives internal refactors
- Describes WHAT, not HOW
- One logical assertion per test

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

```typescript
// BAD: Tests implementation details
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Red flags:

- Mocking internal collaborators
- Testing private methods
- Asserting incidental call counts/order without an observable obligation or explicit resource budget
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Treating private storage layout as the public contract when only retrievability is required

```typescript
// COUPLED when the contract is only that the created user is retrievable
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: Verifies through interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

## Durable Effects and Performance Budgets

Invoke the public operation, then corroborate the effect the contract actually requires.
When acceptance requires durable commit, deletion or external settlement, independent database, Storage or provider readback is useful evidence, not an implementation-detail anti-pattern.
An API response or subsequent cached read alone cannot establish those effects.
Use authorized isolated targets, assert the invariant rather than incidental table layout, and preserve tenant, identity and resource scope.
A fake proves behavior only at its seam; it does not prove actual persistence or remote completion.

For an explicit scalability contract, assert bounded expensive operations as the inventory grows while retaining functional success checks and any race-refusal checks required by the agreed contract.
Prefer deterministic operation-count budgets to timing-only assertions in ordinary tests; measure the real public command separately.
A fixed count that merely copies today's implementation is not an independent budget.

## Independent Expectations

**Tautological tests**: Expected value restates the implementation, so the test passes by construction.

```typescript
// BAD: Expected value is recomputed the way the code computes it
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// GOOD: Expected value is an independent, known literal
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```
