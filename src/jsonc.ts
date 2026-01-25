export function stripJsonc(input: unknown): string {
  const text = typeof input === "string" ? input : input == null ? "" : String(input);
  if (!text.trim()) return "";

  // Remove BOM
  const s = text.replace(/^\uFEFF/, "");

  const isWs = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";

  const skipLineComment = (start: number) => {
    let i = start + 2;
    while (i < s.length && s[i] !== "\n") i++;
    return i;
  };

  const skipBlockComment = (start: number) => {
    let i = start + 2;
    while (i < s.length) {
      if (s[i] === "*" && s[i + 1] === "/") return i + 2;
      i++;
    }
    return s.length;
  };

  const peekNextSignificant = (start: number) => {
    let i = start;
    while (i < s.length) {
      const c = s[i];
      if (isWs(c)) {
        i++;
        continue;
      }
      if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) {
        i = s[i + 1] === "/" ? skipLineComment(i) : skipBlockComment(i);
        continue;
      }
      return c;
    }
    return "";
  };

  const out: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inString) {
      out.push(c);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === "\"") {
        inString = false;
      }
      continue;
    }

    if (c === "\"") {
      inString = true;
      out.push(c);
      continue;
    }

    // Strip comments (string-aware).
    if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) {
      const start = i;
      i = s[i + 1] === "/" ? skipLineComment(i) : skipBlockComment(i);
      i -= 1;

      // Preserve newlines for nicer JSON.parse error locations; otherwise keep a single space.
      const commentText = s.slice(start, i + 1);
      const newlines = commentText.match(/\n/g);
      if (newlines?.length) out.push(...newlines.map(() => "\n"));
      else out.push(" ");
      continue;
    }

    // Strip trailing commas: { "a": 1, } or [1,2,]
    if (c === ",") {
      const nextSig = peekNextSignificant(i + 1);
      if (nextSig === "}" || nextSig === "]") continue;
      out.push(c);
      continue;
    }

    out.push(c);
  }

  return out.join("").trim();
}

export function parseJsonc(input: unknown): { ok: true; value: unknown; error: string } | { ok: false; value: null; error: string } {
  const stripped = stripJsonc(input);
  if (!stripped) return { ok: false, value: null, error: "Empty JSONC" };
  try {
    return { ok: true, value: JSON.parse(stripped), error: "" };
  } catch (e: unknown) {
    const msg = e && typeof e === "object" && "message" in e ? String((e as { message?: unknown }).message) : "Invalid JSON";
    return { ok: false, value: null, error: msg };
  }
}
