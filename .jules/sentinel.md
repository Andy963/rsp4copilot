## 2026-02-16 - [Information Leakage in Error Handling]
**Vulnerability:** The main error handler in `src/workers.ts` was returning raw exception messages to the client in 500 responses.
**Learning:** Cloudflare Workers' `fetch` handler needs explicit try-catch blocks that sanitize errors, as default behavior might expose internal state.
**Prevention:** Always catch unhandled exceptions at the top level and return a generic "Internal Server Error" message, while logging details server-side.
