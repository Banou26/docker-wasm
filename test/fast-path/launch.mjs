// differential check: an inherited CMD survives a child CMD but not a child ENTRYPOINT, and a shell form ENTRYPOINT swallows CMD whole

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planBuild, chrootBuildScript } from './fastpath.mjs'

const BASE = 'fkn-launch:base'
let failures = 0

const run = (file, args) => {
  const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 1 << 24 })
  if (result.error) throw result.error
  return { status: result.status, out: String(result.stdout ?? ''), err: String(result.stderr ?? '') }
}
const sh = (file, args) => {
  const { status, out, err } = run(file, args)
  if (status !== 0) throw new Error(file + ' exited ' + status + ':\n' + out + err)
  return out
}

const build = (tag, dockerfile) => {
  const dir = mkdtempSync(join(tmpdir(), 'fkn-launch-'))
  try {
    writeFileSync(join(dir, 'Dockerfile'), dockerfile)
    sh('docker', ['build', '-q', '-t', tag, dir])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

build(BASE, [
  'FROM alpine:3.21',
  'ENTRYPOINT ["/bin/echo", "base-ep"]',
  'CMD ["base-cmd"]',
  '',
].join('\n'))

const config = JSON.parse(sh('docker', ['inspect', '--format', '{{json .Config}}', BASE]))
const imageDefaults = {
  env: config.Env ?? undefined,
  workdir: config.WorkingDir ?? undefined,
  entrypoint: config.Entrypoint ?? undefined,
  cmd: config.Cmd ?? undefined,
}

const fastLaunch = (instructions) => {
  const plan = planBuild('FROM ' + BASE + '\n' + instructions)
  if (plan.engine !== 'chroot') throw new Error('planner declined: ' + plan.reason)
  const script = chrootBuildScript({
    plan, layers: [], imageDefaults, readyMarker: '__R__', failMarker: '__F__',
  })
  // the last `sh -c` in the script is the launch, and its body spans several lines
  const pattern = /\/bin\/sh -c '((?:[^']|'\\'')*)'/g
  let body = null
  for (let match = pattern.exec(script); match; match = pattern.exec(script)) body = match[1]
  if (body === null) throw new Error('could not read the launch line from:\n' + script)
  return body.replace(/'\\''/g, "'")
}

const compare = (label, body) => {
  let expected
  let actual
  try {
    build('fkn-launch:case', 'FROM ' + BASE + '\n' + body)
    expected = run('docker', ['run', '--rm', 'fkn-launch:case']).out.trim()
    actual = run('docker', [
      'run', '--rm', '--entrypoint', '/bin/sh', BASE, '-c', fastLaunch(body),
    ]).out.trim()
  } catch (error) {
    failures++
    console.error('FAIL ' + label + '\n     ' + String(error.message).split('\n').join('\n     '))
    return
  }
  if (expected === actual) {
    console.log('ok   ' + label + '  -> ' + JSON.stringify(expected))
    return
  }
  failures++
  console.error('FAIL ' + label +
    '\n     docker:    ' + JSON.stringify(expected) +
    '\n     fast path: ' + JSON.stringify(actual))
}

compare('nothing overridden', 'RUN true\n')
compare('a child CMD replaces the inherited one', 'CMD ["child-cmd"]\n')
compare('a child ENTRYPOINT clears the inherited CMD',
  'ENTRYPOINT ["/bin/echo", "child-ep"]\n')
compare('a child ENTRYPOINT with its own CMD',
  'ENTRYPOINT ["/bin/echo", "child-ep"]\nCMD ["child-cmd"]\n')
compare('a shell form ENTRYPOINT ignores the inherited CMD',
  'ENTRYPOINT /bin/echo shell-ep\n')
compare('a shell form ENTRYPOINT ignores its own CMD',
  'ENTRYPOINT /bin/echo shell-ep\nCMD ["ignored"]\n')
compare('a shell form CMD under an inherited exec form ENTRYPOINT',
  'CMD echo shell-cmd\n')
compare('an ENV the launched process should see',
  'ENV EXTRA=visible\nCMD ["sh", "-c", "echo $EXTRA"]\n')
compare('the working directory the launched process starts in',
  'WORKDIR /srv/here\nCMD ["sh", "-c", "pwd"]\n')

console.log(failures ? '\n' + failures + ' failing' : '\nall passing')
process.exitCode = failures ? 1 : 0
