# Message Service

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
  const url = 'http://<private IP>:3000/report'
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

If you have any trouble you can run `npm run swagger` to test out the API via Swagger UI. Swagger is hosted at [localhost:8080](http://localhost:8080) by default.