// tiny-log-mcp browser drop-in. Load it from the listener so it knows where to send:
//   <script src="http://127.0.0.1:7710/client.js" data-source="web"></script>
// Forwards console.*, window "error" and "unhandledrejection" events to /ingest in
// batches. Console output still reaches the real console. Silently no-ops when
// the listener is down, so leaving the tag in during development costs nothing.
(() => {
  const script = document.currentScript;
  const base = script?.src ? new URL(script.src).origin : location.origin;
  const source = script?.dataset.source || "web";
  const endpoint = `${base}/ingest`;
  const FLUSH_MS = 250;
  let batch = [];
  let timer = null;

  const flush = () => {
    timer = null;
    if (batch.length === 0) return;
    const body = JSON.stringify({ source, entries: batch });
    batch = [];
    try {
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {
      // fetch unavailable or blocked: drop silently
    }
  };

  const send = (level, message, meta) => {
    batch.push({ level, message, ts: new Date().toISOString(), meta });
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };

  const describe = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    const seen = new WeakSet();
    try {
      return JSON.stringify(value, (_key, item) => {
        if (typeof item === "bigint") return item.toString();
        if (item instanceof Error) return item.stack || String(item);
        if (item && typeof item === "object") {
          if (seen.has(item)) return "[Circular]";
          seen.add(item);
        }
        return item;
      });
    } catch {
      return String(value);
    }
  };

  for (const level of ["log", "info", "debug", "warn", "error", "trace"]) {
    const original = console[level];
    console[level] = (...args) => {
      send(level, args.map(describe).join(" "));
      if (typeof original === "function") original.apply(console, args);
    };
  }

  window.addEventListener("error", (event) => {
    const detail = event.error ? describe(event.error) : event.message;
    send("error", `Uncaught ${detail}`, {
      file: event.filename,
      line: event.lineno,
      col: event.colno,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    send("error", `Unhandled promise rejection: ${describe(event.reason)}`);
  });
  addEventListener("pagehide", flush);
})();
