## 2024-05-23 - Config Parsing Bottleneck
**Learning:** Parsing large JSONC configurations (~380KB) on every request consumes significant CPU time (~6ms) in Cloudflare Workers.
**Action:** Always cache static configuration objects in module-level variables to leverage the Worker's global scope persistence across requests.
