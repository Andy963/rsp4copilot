## 2025-05-18 - [Config Re-parsing]
**Learning:** Parsing large JSONC configuration on every request is a significant bottleneck (0.45ms per request).
**Action:** Always cache static or infrequently changing configuration in a module-level variable to avoid re-parsing on every invocation.
