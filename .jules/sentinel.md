## 2026-02-17 - Error Handling Information Leak
**Vulnerability:** The global error handler in `src/workers.ts` was returning raw exception messages to the client, potentially exposing sensitive internal details (e.g., database connection strings, upstream API errors).
**Learning:** The codebase lacked a centralized error sanitization mechanism and defaulted to exposing full error details, likely for easier debugging during development.
**Prevention:** Always use a generic error message for client responses in production environments (e.g., "Internal Server Error") and log the detailed error only on the server side. Include a request ID for correlation.
