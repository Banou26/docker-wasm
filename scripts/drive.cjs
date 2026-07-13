// drive.cjs - boot alpine+curl in headless chrome via @webvpn, run curl,
// capture proof. Reads xterm's buffer directly via window.xterm.
const puppeteer = require('puppeteer-core')

const url = process.env.URL || 'http://127.0.0.1:8080/playground/?net=webvpn'
const chromePath = process.env.CHROME || '/etc/profiles/per-user/banou/bin/google-chrome'

const readTerminal = () => {
    try {
        const buf = window.xterm.buffer.active
        const out = []
        for (let y = 0; y < buf.length; y++) {
            const line = buf.getLine(y)
            if (line) out.push(line.translateToString(true))
        }
        return out.join('\n').replace(/[ \t]+$/gm, '')
    } catch (e) { return '' }
}

;(async () => {
    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })

    const proxyLogs = []
    page.on('console', m => {
        const t = m.text()
        if (t.startsWith('[proxy]') || t.startsWith('[webvpn]') || /webvpn_/i.test(t)) {
            proxyLogs.push(t)
        }
    })
    page.on('pageerror', e => console.log('[pageerror]', e.message))

    // capture all network requests / failures for diagnostics
    const reqs = []
    page.on('request', r => reqs.push({ method: r.method(), url: r.url() }))
    page.on('requestfailed', r => reqs.push({ failed: true, url: r.url(), err: r.failure()?.errorText }))
    // capture iframe console too - the WebTransport happens there
    browser.on('targetcreated', async (t) => {
        try {
            const f = await t.page()
            if (!f) return
            f.on('console', m => console.log('[iframe console]', m.type(), m.text()))
            f.on('pageerror', e => console.log('[iframe pageerror]', e.message))
            f.on('requestfailed', r => console.log('[iframe reqfail]', r.url(), r.failure()?.errorText))
        } catch (e) {}
    })

    console.log('navigating to', url)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    console.log('crossOriginIsolated =', await page.evaluate(() => crossOriginIsolated))
    // Give @fkn/lib a moment to inject its iframe
    await new Promise(r => setTimeout(r, 3000))
    const ifrs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, credentialless: f.credentialless }))
    )
    console.log('iframes:', JSON.stringify(ifrs))
    const iframeFrames = page.frames().filter(f => f !== page.mainFrame())
    console.log('frames count:', page.frames().length, 'iframes:', iframeFrames.length)
    console.log('iframe-related requests:')
    reqs.filter(r => /127\.0\.0\.1:1234|fkn/i.test(r.url)).forEach(r => console.log('  ', JSON.stringify(r)))
    await page.waitForSelector('#terminal', { timeout: 30000 })
    await page.waitForFunction('typeof window.xterm === "object"', { timeout: 30000 })

    // Wait for a shell prompt by polling the xterm buffer.
    console.log('waiting for boot prompt (up to 15 min)...')
    const deadline = Date.now() + 15 * 60 * 1000
    let booted = false
    let lastSnap = 0
    while (Date.now() < deadline) {
        const txt = await page.evaluate(readTerminal)
        if (/(\/ #|~ #|\$ )\s*$/m.test(txt) || /localhost:.*#\s*$/m.test(txt)) {
            booted = true
            console.log('--- terminal (tail) at boot ---\n' + txt.split('\n').filter(Boolean).slice(-20).join('\n'))
            break
        }
        // periodic screenshot for visual progress
        if (Date.now() - lastSnap > 30000) {
            lastSnap = Date.now()
            const elapsed = Math.round((Date.now() - (deadline - 15*60*1000)) / 1000)
            await page.screenshot({ path: `/tmp/c2w-webvpn-boot-${elapsed}s.png`, fullPage: false })
            const lines = txt.split('\n').filter(l => l.trim())
            console.log(`[${elapsed}s] term lines: ${lines.length}; last: ${lines.slice(-1)[0] || '(empty)'}`)
        }
        await new Promise(r => setTimeout(r, 4000))
    }

    if (!booted) {
        console.log('TIMEOUT waiting for prompt')
        const txt = await page.evaluate(readTerminal)
        console.log('--- last terminal ---\n' + txt.split('\n').filter(Boolean).slice(-40).join('\n'))
        await page.screenshot({ path: '/tmp/c2w-webvpn-noboot.png', fullPage: false })
        console.log('proxy logs (last 20):'); proxyLogs.slice(-20).forEach(l => console.log('  ' + l.slice(0, 200)))
        await browser.close()
        process.exit(2)
    }

    // Phase A: test TCP via @webvpn by curling a direct IP (no DNS).
    // 1.1.1.1 is Cloudflare's DNS frontend, also serves HTTPS at /.
    await page.click('#terminal')
    await new Promise(r => setTimeout(r, 500))
    await page.keyboard.type('curl -ksS --connect-timeout 30 https://1.1.1.1/ -o /tmp/x ; echo CURL_EXIT=$? ; head -3 /tmp/x\n', { delay: 25 })

    // Wait for curl output. 1.1.1.1's HTTPS root returns a small HTML or 301.
    const cdl = Date.now() + 90 * 1000
    let success = false
    while (Date.now() < cdl) {
        const txt = await page.evaluate(readTerminal)
        if (/CURL_EXIT=0/.test(txt)) { success = true; break }
        if (/CURL_EXIT=[1-9]/.test(txt)) break
        await new Promise(r => setTimeout(r, 1500))
    }
    const finalTxt = await page.evaluate(readTerminal)
    await page.screenshot({ path: '/tmp/c2w-webvpn-curl.png', fullPage: false })
    console.log('--- terminal after curl ---\n' + finalTxt.split('\n').filter(Boolean).slice(-30).join('\n'))
    console.log('--- ALL captured [proxy]/[webvpn] messages (' + proxyLogs.length + ') ---')
    proxyLogs.forEach(l => console.log('  ' + l.slice(0, 280)))
    await browser.close()
    if (!success) { console.log('curl FAILED'); process.exit(3) }
    console.log('SUCCESS: real HTTPS response from 1.1.1.1 via @webvpn through our netstack')
})().catch(e => { console.error('driver error:', e); process.exit(1) })
