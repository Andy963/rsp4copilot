export function encodeSse(event: string, dataObj: unknown): string {
  const data = typeof dataObj === "string" ? dataObj : JSON.stringify(dataObj);
  // OpenAI-style SSE: event type is encoded in the JSON `type` field, not the SSE `event:` line.
  void event;
  return `data: ${data}\n\n`;
}

export function parseSseLines(text: string): Array<{ event: string; data: string }> {
  const lines = String(text || "").split(/\r?\n/);
  const out: Array<{ event: string; data: string }> = [];
  let event = "";
  let dataLines: string[] = [];
  const flush = () => {
    if (!event && !dataLines.length) return;
    const data = dataLines.join("\n");
    out.push({ event: event || "message", data });
    event = "";
    dataLines = [];
  };
  for (const line of lines) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
  }
  flush();
  return out;
}

export type SseParsedEvent = { event: string; data: string };

export class SseTextStreamParser {
  private pendingLine = "";
  private event = "";
  private dataLines: string[] = [];

  push(text: string): SseParsedEvent[] {
    const chunk = typeof text === "string" ? text : String(text ?? "");
    this.pendingLine += chunk;

    const out: SseParsedEvent[] = [];
    const lines = this.pendingLine.split("\n");
    this.pendingLine = lines.pop() || "";

    for (let line of lines) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const evt = this.consumeLine(line);
      if (evt) out.push(evt);
    }

    return out;
  }

  finish(): SseParsedEvent[] {
    const out: SseParsedEvent[] = [];
    if (this.pendingLine) {
      const line = this.pendingLine.endsWith("\r") ? this.pendingLine.slice(0, -1) : this.pendingLine;
      this.pendingLine = "";
      const evt = this.consumeLine(line);
      if (evt) out.push(evt);
    }
    const evt = this.flush();
    if (evt) out.push(evt);
    return out;
  }

  private consumeLine(line: string): SseParsedEvent | null {
    if (line === "") {
      return this.flush();
    }
    if (line.startsWith(":")) return null;
    if (line.startsWith("event:")) {
      this.event = line.slice(6).trim();
      return null;
    }
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).trimStart());
      return null;
    }
    return null;
  }

  private flush(): SseParsedEvent | null {
    if (!this.event && !this.dataLines.length) return null;
    const data = this.dataLines.join("\n");
    const evt: SseParsedEvent = { event: this.event || "message", data };
    this.event = "";
    this.dataLines = [];
    return evt;
  }
}
