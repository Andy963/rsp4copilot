## 2025-03-08 - [Insecure Randomness Fallback in Request IDs]
**Vulnerability:** A fallback in `src/worker/handler.ts` used `Math.random()` to generate request IDs when `crypto.randomUUID()` failed. `Math.random()` is predictable, posing an insecure randomness risk.
**Learning:** Even when used only as fallbacks or for identifiers not directly representing secrets, predictable randomness (`Math.random()`) can be exploited in certain contexts.
**Prevention:** Always use Web Crypto API (`crypto.getRandomValues()` or `crypto.randomUUID()`) when random values are generated, regardless of whether it is a primary path or a fallback path.
