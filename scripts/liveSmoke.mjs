import { spawn } from 'node:child_process'

const port = process.env.API_PORT || '8787'
const base = `http://127.0.0.1:${port}`

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function request(path, options) {
  const response = await fetch(`${base}${path}`, options)
  const body = await response.json()
  return { ok: response.ok, status: response.status, body }
}

function keys(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key, item !== null && item !== undefined]))
}

async function waitForServer() {
  for (let i = 0; i < 25; i += 1) {
    try {
      const health = await request('/api/health')
      if (health.ok) return
    } catch {
      await sleep(250)
    }
  }
  throw new Error('Local API did not become healthy.')
}

async function main() {
  const server = spawn(process.execPath, ['server/qverisServer.mjs'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  try {
    await waitForServer()
    const market = await request('/api/market/NVDA')
    const options = await request('/api/options/NVDA')
    const events = await request('/api/events/NVDA')
    const volatility = await request('/api/volatility/NVDA')
    const assistant = await request('/api/assistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Summarize the available QVeris market context in two sentences.',
        marketContext: { ticker: 'NVDA', market: market.body },
      }),
    })

    const summary = {
      market: { ok: market.ok, status: market.status, fields: keys(market.body) },
      options: {
        ok: options.ok,
        status: options.status,
        contracts: options.body.contracts?.length ?? 0,
        sampleFields: keys(options.body.contracts?.[0]),
        dataGaps: options.body.dataGaps ?? [],
      },
      events: {
        ok: events.ok,
        status: events.status,
        earnings: events.body.earnings?.length ?? 0,
        filings: events.body.filings?.length ?? 0,
      },
      volatility: {
        ok: volatility.ok,
        status: volatility.status,
        tenors: volatility.body.tenors?.length ?? 0,
        moneyness: volatility.body.moneyness?.length ?? 0,
        ivRows: volatility.body.iv?.length ?? 0,
        dataGaps: volatility.body.dataGaps ?? [],
      },
      assistant: {
        ok: assistant.ok,
        status: assistant.status,
        model: assistant.body.model ?? null,
        hasText: Boolean(assistant.body.text),
      },
    }

    console.log(JSON.stringify(summary, null, 2))
    if (
      ![
        summary.market.ok,
        summary.options.ok,
        summary.events.ok,
        summary.volatility.ok,
        summary.assistant.ok,
      ].every(Boolean)
    ) {
      throw new Error('Live smoke failed; check .env.local and endpoint status.')
    }
  } finally {
    server.kill('SIGTERM')
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
