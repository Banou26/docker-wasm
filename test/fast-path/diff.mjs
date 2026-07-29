// Differential check: the same Dockerfile through `docker build` and through the
// fast path, comparing what a RUN step actually sees.
//
// This is the only check that can settle the questions the fast path gets wrong
// in ways that produce a working build rather than a failing one. Asserting the
// generated text says nothing about whether the shell does with it what docker
// would; running both and diffing does.
//
// The fast path runs here in its in-place mode, which is the same script the
// guest runs when the base image is the guest, with the container standing in
// for the guest. chroot mode is covered by chroot.mjs.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planBuild, chrootBuildScript } from './fastpath.mjs'

const BASE = 'alpine:3.21'
let failures = 0
let ran = 0

// buildkit writes its build log to stderr, so both streams matter and the
// probes can land on either.
const run = (file, args, opts = {}) => {
  const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts })
  if (result.error) throw result.error
  return {
    status: result.status,
    output: String(result.stdout ?? '') + String(result.stderr ?? ''),
  }
}

const sh = (file, args, opts = {}) => {
  const { status, output } = run(file, args, opts)
  if (status !== 0) throw new Error(file + ' exited ' + status + ':\n' + output.slice(-2000))
  return output
}

// The base image config, exactly the fields pullRootfs hands the emitter.
const imageDefaults = (() => {
  const raw = sh('docker', ['inspect', '--format', '{{json .Config}}', BASE])
  const config = JSON.parse(raw)
  return {
    env: config.Env ?? undefined,
    workdir: config.WorkingDir ?? undefined,
    entrypoint: config.Entrypoint ?? undefined,
    cmd: config.Cmd ?? undefined,
  }
})()

// Both sides echo the command they are about to run, so the format string
// itself shows up as a match. Only what the command printed is evidence.
const probes = (text) =>
  (text.match(/PROBE\d*<[^>]*>/g) ?? []).filter((probe) => !probe.endsWith('<%s>'))

const viaDocker = (dockerfile) => {
  const dir = mkdtempSync(join(tmpdir(), 'fkn-diff-'))
  try {
    writeFileSync(join(dir, 'Dockerfile'), dockerfile)
    return probes(sh('docker', [
      'build', '--no-cache', '--progress=plain', '-t', 'fkn-diff:latest', dir,
    ], { env: { ...process.env, DOCKER_BUILDKIT: '1' } }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const viaFastPath = (dockerfile) => {
  const plan = planBuild(dockerfile)
  if (plan.engine !== 'chroot') throw new Error('planner declined: ' + plan.reason)
  const script = chrootBuildScript({
    plan,
    layers: [],
    imageDefaults,
    readyMarker: '__FKN_OK__',
    failMarker: '__FKN_FAILED__',
  })
  const dir = mkdtempSync(join(tmpdir(), 'fkn-fast-'))
  try {
    writeFileSync(join(dir, 'fkn.sh'), script)
    const { status, output } = run('docker', [
      'run', '--rm', '-v', dir + ':/fkn:ro', BASE, 'sh', '/fkn/fkn.sh',
    ])
    if (status !== 0 || output.includes('__FKN_FAILED__')) {
      throw new Error('fast path build failed (exit ' + status + '):\n' + output.slice(-2000) +
        '\n--- script ---\n' + script)
    }
    return probes(output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const compare = (label, body) => {
  ran++
  const dockerfile = 'FROM ' + BASE + '\n' + body
  let expected
  let actual
  try {
    expected = viaDocker(dockerfile)
    actual = viaFastPath(dockerfile)
  } catch (error) {
    failures++
    console.error('FAIL ' + label + '\n     ' + String(error.message).split('\n').join('\n     '))
    return
  }
  if (expected.length === 0) {
    failures++
    console.error('FAIL ' + label + '\n     the reference build produced no probe output')
    return
  }
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    console.log('ok   ' + label + '  ' + expected.join(' '))
    return
  }
  failures++
  console.error('FAIL ' + label +
    '\n     docker:    ' + JSON.stringify(expected) +
    '\n     fast path: ' + JSON.stringify(actual))
}

const P = (n, value) => "printf 'PROBE" + n + "<%s>\\n' " + value

// --- ordering --------------------------------------------------------------

compare('ENV is positional', [
  'ENV V=1',
  'RUN ' + P(1, '"$V"'),
  'ENV V=2',
  'RUN ' + P(2, '"$V"'),
  '',
].join('\n'))

compare('a re-assignment does not reach back through an earlier reference', [
  'ENV A=1',
  'ENV B=$A',
  'ENV A=2',
  'RUN ' + P(1, '"$A"') + '; ' + P(2, '"$B"'),
  '',
].join('\n'))

compare('WORKDIR is positional', [
  'RUN ' + P(1, '"$(pwd)"'),
  'WORKDIR /srv',
  'RUN ' + P(2, '"$(pwd)"'),
  '',
].join('\n'))

// --- working directory -----------------------------------------------------

compare('WORKDIR creates a directory the base image does not have', [
  'WORKDIR /app/nested',
  'RUN ' + P(1, '"$(pwd)"') + '; ' + P(2, '"$(ls -d /app)"'),
  '',
].join('\n'))

compare('a relative WORKDIR resolves against the previous one', [
  'WORKDIR /usr',
  'WORKDIR local',
  'WORKDIR share',
  'RUN ' + P(1, '"$(pwd)"'),
  '',
].join('\n'))

compare('an absolute WORKDIR after a relative one replaces it', [
  'WORKDIR /usr',
  'WORKDIR local',
  'WORKDIR /etc',
  'RUN ' + P(1, '"$(pwd)"'),
  '',
].join('\n'))

compare('a WORKDIR built from a variable', [
  'ENV ROOT=/opt/thing',
  'WORKDIR $ROOT/sub',
  'RUN ' + P(1, '"$(pwd)"'),
  '',
].join('\n'))

// --- environment -----------------------------------------------------------

compare('the base image PATH is in effect', ['RUN ' + P(1, '"$PATH"'), ''].join('\n'))

compare('ENV expands against the environment so far', [
  'ENV PATH=/opt/bin:$PATH',
  'RUN ' + P(1, '"$PATH"'),
  '',
].join('\n'))

compare('a single quoted ENV value does not expand', [
  "ENV MSG='costs $5 not $HOME'",
  'RUN ' + P(1, '"$MSG"'),
  '',
].join('\n'))

compare('a double quoted ENV value does expand', [
  'ENV WHO=world',
  'ENV MSG="hello $WHO"',
  'RUN ' + P(1, '"$MSG"'),
  '',
].join('\n'))

compare('an escaped dollar stays literal', [
  'ENV MSG=\\$HOME',
  'RUN ' + P(1, '"$MSG"'),
  '',
].join('\n'))

compare('several assignments on one ENV line', [
  'ENV A=1 B="two words" C=three',
  'RUN ' + P(1, '"$A|$B|$C"'),
  '',
].join('\n'))

compare('the legacy ENV form', [
  'ENV GREETING hello there',
  'RUN ' + P(1, '"$GREETING"'),
  '',
].join('\n'))

compare('a default value in a braced reference', [
  'ENV PORT=',
  'ENV BIND=0.0.0.0:${PORT:-8080}',
  'RUN ' + P(1, '"$BIND"'),
  '',
].join('\n'))

compare('an ENV set after a RUN still applies to the launched process', [
  'ENV V=early',
  'RUN true',
  'ENV V=late',
  'RUN ' + P(1, '"$V"'),
  '',
].join('\n'))

// --- filesystem ------------------------------------------------------------

compare('a RUN writes where the following RUN reads', [
  'RUN echo written > /built.txt',
  'RUN ' + P(1, '"$(cat /built.txt)"'),
  '',
].join('\n'))

compare('/dev/null discards rather than accumulating', [
  'RUN echo junk > /dev/null && ' + P(1, '"$(wc -c < /dev/null)"'),
  '',
].join('\n'))

// --- parsing ---------------------------------------------------------------

compare('a continued RUN is one command', [
  'RUN X=$(echo a \\',
  '  b) && ' + P(1, '"$X"'),
  '',
].join('\n'))

compare('a comment inside a continued RUN is stripped, not fatal', [
  'RUN X=$(echo a \\',
  '# an explanation',
  '  b) && ' + P(1, '"$X"'),
  '',
].join('\n'))

compare('exec form RUN does not expand', [
  'ENV V=expanded',
  'RUN ["/bin/sh", "-c", "printf \'PROBE1<%s>\\\\n\' \'$V\'"]',
  '',
].join('\n'))

compare('a quote inside a RUN survives', [
  'RUN ' + P(1, '"$(echo "it\'s fine")"'),
  '',
].join('\n'))

console.log('\n' + ran + ' compared, ' + (failures || 'none') + ' failing')
process.exitCode = failures ? 1 : 0
