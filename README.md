# Local Log

## Overview

This project consists of a server that accepts post requests and socket events for logging purposes. Logs are emitted to the UI which is served at the root path (localhost:3000).

## Quick Start

1. Clone this project
2. `npm install`
3. `npm start`
4. Open [localhost:3000](http://localhost:3000)

## Developer Usage

The easiest way to report messages to this server is by using the REST endpoint. Paste the code below (make sure to replace the private IP) and open [localhost:3000](http://localhost:3000).

```javascript
// Sends logs to server using console.log params
const log = async (...messages: string[]) => {
  let content = ''
  if (messages?.length && messages.length > 1) {
    content = JSON.stringify(messages)
  } else {
    content = messages[0]
  }

  // You can use this command to get your private IP on a mac: `ipconfig getifaddr en0`
  // <<<< REPLACE >>>>
  const url = 'http://<private IP>:3000/message'
  // <<<< REPLACE >>>>

  const response = await fetch(url, {
    method: 'POST',
    mode: 'cors',
    cache: 'no-cache',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
    body: JSON.stringify({ message: content }),
  })
  return response.json()
}

// In a browser, redirect the console to the function above
window.console.info = log
window.console.log = log
window.console.warn = log
window.console.error = log
```

For API documentation, run `npm run swagger`. Swagger is hosted at [localhost:8080](http://localhost:8080) by default.

## Reading Logs From an AI Agent (MCP)

The logger doubles as an [MCP](https://modelcontextprotocol.io) server, so a coding
agent can read your app's console output directly instead of asking you to copy and
paste it. This is the point of `mcp.js`: Claude Code cannot see your phone's or your
browser's console, but it can see this buffer.

The repo ships a `.mcp.json`, so from this directory the server is picked up
automatically. To use it from another project, add:

```json
{
  "mcpServers": {
    "local-log": {
      "command": "node",
      "args": ["/absolute/path/to/local-log/mcp.js"],
      "env": { "LOCAL_LOG_URL": "http://localhost:3000" }
    }
  }
}
```

`npm start` must be running — the MCP server is a thin client over the HTTP API.

| Tool         | Arguments                              | Purpose                                                                    |
| ------------ | -------------------------------------- | -------------------------------------------------------------------------- |
| `read_logs`  | `after`, `level`, `grep`, `limit`      | Read buffered entries. Returns a `cursor` to pass back as `after`.         |
| `await_logs` | `after`, `level`, `grep`, `timeout_ms` | Block until a matching entry arrives. Use while the user reproduces a bug. |
| `clear_logs` | —                                      | Discard the buffer so the next read only covers the run you care about.    |

A typical loop: `clear_logs` → ask the user to tap the button → `await_logs` with
`level: "error"` → read the stack trace → fix.

### HTTP API

The same surface is available over HTTP if you would rather use `curl`:

```bash
curl 'localhost:3000/logs?after=42&level=error&grep=timeout&limit=50'
curl 'localhost:3000/logs?after=42&wait=30000'   # long-poll, returns as soon as a log lands
curl -X DELETE localhost:3000/logs
```

Entries carry a monotonic `seq`, a server-side `ts`, a `level`, and the reporting
`identity` when `/log` supplied a session. `seq` keeps counting across a
`clear_logs`, so a stale cursor never re-reads a recycled number.

### Configuration

| Variable          | Default                 | Meaning                                              |
| ----------------- | ----------------------- | ---------------------------------------------------- |
| `LOG_BUFFER_SIZE` | `5000`                  | Entries kept in memory before the oldest are dropped |
| `LOG_MAX_WAIT_MS` | `60000`                 | Ceiling on how long `wait` may hold a request open   |
| `LOCAL_LOG_URL`   | `http://localhost:3000` | Where `mcp.js` looks for the server                  |
