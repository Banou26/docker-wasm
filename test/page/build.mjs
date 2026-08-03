// Real builds in a real browser: the guest picked from the build plan, the artifact bridge, the emulated `wget`, the `chroot` and the emulated `tar` only exist here.

import { connect } from './cdp.mjs'

const ORIGIN = process.env.ORIGIN || 'http://localhost:1234'
let failures = 0

const check = (label, condition, detail) => {
  if (condition) console.log('  ok   ' + label + (detail ? '  ' + detail : ''))
  else {
    failures++
    console.error('  FAIL ' + label + (detail === undefined ? '' : '\n       ' + String(detail)))
  }
}

const PROBE = 'echo junk > /dev/null; ' +
  'echo "PROBE<$BANNER|$(pwd)|$(wc -c < /dev/null)|${PATH%%:*}>"'

const EXPECTED = 'PROBE<hello there/prod|/srv/app|0|/usr/local/sbin>'

const dockerfileFor = (base) => [
  'FROM ' + base,
  'ENV GREETING="hello there" MODE=prod',
  'ENV BANNER="$GREETING/$MODE"',
  'WORKDIR /srv',
  'WORKDIR app',
  'RUN ' + PROBE,
  'CMD ["/bin/sh"]',
  '',
].join('\n')

const runBuild = async (label, dockerfile, expectations) => {
  console.log('\n=== ' + label)
  const b64 = Buffer.from(dockerfile, 'utf8').toString('base64').replace(/=+$/, '')
  const page = await connect(ORIGIN + '/playground/?net=webvpn#dockerfile=' + b64)
  const started = Date.now()
  try {
    const state = await page.waitFor(
      `(() => {
         const text = document.getElementById('runtime-state')?.textContent ?? ''
         return /ready|Ready|failed|Failed/.test(text) ? text : null
       })()`,
      { timeoutMs: 420_000, everyMs: 1000, label: 'the build to settle' },
    )
    const wall = (Date.now() - started) / 1000
    check('the build finishes', !/fail/i.test(state), JSON.stringify(state) + ' in ' + wall.toFixed(1) + 's')

    const tail = String(await page.evaluate('window.dockerWasmConsole ? window.dockerWasmConsole() : ""'))
    // the guest echoes the command before running it, so the format string is in the tail either way
    const printed = (tail.replace(/\r?\n/g, '').match(/PROBE<[^>]*>/g) ?? [])
      .filter((line) => !line.includes('$'))
    check('the built image is what the Dockerfile describes',
      printed.includes(EXPECTED), JSON.stringify(printed))

    const phases = await page.evaluate('window.dockerWasmPhases ? window.dockerWasmPhases() : []')
    const labels = (phases ?? []).map((phase) => phase.label)
    for (const [what, pattern] of Object.entries(expectations)) {
      check(what, labels.some((line) => pattern.test(line)), JSON.stringify(labels))
    }
    for (const phase of phases ?? []) {
      console.log('       ' + (phase.sinceMs / 1000).toFixed(1).padStart(6) + 's  ' + phase.label)
    }
    return wall
  } catch (error) {
    failures++
    console.error('  FAIL ' + label + ': ' + error.message)
    const tail = await page.evaluate('window.dockerWasmConsole ? window.dockerWasmConsole() : ""').catch(() => '')
    console.error('       guest tail: ' + String(tail).split('\n').slice(-6).join(' / '))
    return 0
  } finally {
    await page.close()
  }
}

const inPlaceSeconds = await runBuild('in place, the guest is the base image', dockerfileFor('alpine:3.21'), {
  'skips the transfer entirely': /nothing to transfer/,
  'never mentions a layer': /^(?!.*layer).*$/,
})

const transferSeconds = await runBuild('with a transfer, built under chroot', dockerfileFor('alpine:3.19'), {
  'fetches the layer': /fetch layer 1\/1/,
  'extracts it': /extract layer 1\/1/,
})

if (inPlaceSeconds && transferSeconds) {
  check('skipping the transfer is the faster path',
    inPlaceSeconds < transferSeconds,
    inPlaceSeconds.toFixed(1) + 's against ' + transferSeconds.toFixed(1) + 's')
}

console.log(failures ? '\n' + failures + ' failing' : '\nall passing')
process.exitCode = failures ? 1 : 0
