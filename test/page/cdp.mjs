// a headless chromium stalls on the in-page gateway fetch, so this attaches to the headed one already running

const ENDPOINT = process.env.CDP || 'http://127.0.0.1:41951'

const openTab = async (url) => {
  const response = await fetch(ENDPOINT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })
  if (!response.ok) throw new Error('could not open a tab: HTTP ' + response.status)
  return response.json()
}

export const closeTab = (id) => fetch(ENDPOINT + '/json/close/' + id).catch(() => {})

export const connect = async (url) => {
  const target = await openTab(url)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
  })

  let nextId = 1
  const pending = new Map()
  const logs = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      logs.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (message.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (message.params.exceptionDetails.exception?.description ??
        message.params.exceptionDetails.text))
    }
  })

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error(method + ' timed out'))
    }, 60_000)
  })

  await send('Runtime.enable')
  await send('Page.enable')

  // deliberately setTimeout rather than requestAnimationFrame below: an unfocused tab throttles rAF so the promise never settles
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }

  const waitFor = async (expression, { timeoutMs = 120_000, everyMs = 500, label = expression } = {}) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await evaluate(expression).catch(() => undefined)
      if (value) return value
      if (Date.now() > deadline) throw new Error('timed out waiting for ' + label)
      await new Promise((resolve) => setTimeout(resolve, everyMs))
    }
  }

  return {
    id: target.id,
    evaluate,
    waitFor,
    logs,
    navigate: async (to) => {
      await send('Page.navigate', { url: to })
      await waitFor('document.readyState === "complete"', { label: 'load of ' + to })
    },
    close: async () => {
      socket.close()
      await closeTab(target.id)
    },
  }
}
