// Unit checks for the parser, planner and emitter: they pin the shape so a regression shows up as a named failure rather than as a wrong image.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  planBuild, parseDockerfile, parseWord, parseEnv, wordText,
  chrootBuildScript, launchCommand, renderWord,
  planLaunch, isPresetWasmURL, PRESET_DOCKERFILES,
} from './fastpath.mjs'

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log('ok   ' + label)
  else {
    failures++
    console.error('FAIL ' + label + (detail === undefined ? '' : '\n     ' + detail))
  }
}

const ALPINE = {
  env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
  workdir: '/',
  cmd: ['/bin/sh'],
}

// each step's body is nested inside a single quoted `sh -c`, so matching the outer text proves nothing
const bodies = (text) => {
  const out = []
  const pattern = /\/bin\/sh -c '((?:[^']|'\\'')*)'/g
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    out.push(match[1].replace(/'\\''/g, "'"))
  }
  return out
}

const script = (text, opts = {}) => chrootBuildScript({
  plan: planBuild(text),
  layers: opts.layers ?? [{ key: 'k0', bytes: 100, ops: opts.ops }],
  imageDefaults: opts.imageDefaults ?? ALPINE,
  readyMarker: '__R__',
  failMarker: '__F__',
})

{
  const parsed = parseDockerfile('FROM a\nRUN echo one \\\n  two\n')
  check('continuation joins without inserting a newline',
    parsed.instructions[1].args === 'echo one   two', JSON.stringify(parsed.instructions[1]))
}
{
  const parsed = parseDockerfile('FROM a\nRUN echo one \\\n# a comment\n  two\n')
  check('a comment inside a continuation does not end it',
    parsed.instructions.length === 2 && parsed.instructions[1].args === 'echo one   two',
    JSON.stringify(parsed.instructions))
}
{
  const parsed = parseDockerfile('FROM a\nRUN echo # not a comment\n')
  check('a hash inside an instruction stays part of it',
    parsed.instructions[1].args === 'echo # not a comment')
}
check('escape directive falls back',
  planBuild('# escape=`\nFROM alpine\nRUN true\n').engine === 'buildah')
check('syntax directive falls back',
  planBuild('# syntax=docker/dockerfile:1\nFROM alpine\nRUN true\n').engine === 'buildah')
check('a plain leading comment does not fall back',
  planBuild('# just a note\nFROM alpine\nRUN true\n').engine === 'chroot')
check('RUN --mount falls back',
  planBuild('FROM alpine\nRUN --mount=type=cache,target=/c make\n').engine === 'buildah')
check('RUN heredoc falls back',
  planBuild('FROM alpine\nRUN <<EOF\ntrue\nEOF\n').engine === 'buildah')
check('FROM --platform falls back',
  planBuild('FROM --platform=linux/arm64 alpine\nRUN true\n').engine === 'buildah')

check('unquoted value expands',
  JSON.stringify(parseWord('/opt:$PATH')) ===
  JSON.stringify([{ kind: 'literal', value: '/opt:' }, { kind: 'variable', expression: 'PATH' }]))
check('single quotes suppress expansion',
  JSON.stringify(parseWord("'costs $5 $HOME'")) ===
  JSON.stringify([{ kind: 'literal', value: 'costs $5 $HOME' }]))
check('double quotes keep expansion',
  JSON.stringify(parseWord('"a $B c"')) ===
  JSON.stringify([{ kind: 'literal', value: 'a ' }, { kind: 'variable', expression: 'B' }, { kind: 'literal', value: ' c' }]))
check('a backslash makes the dollar literal',
  JSON.stringify(parseWord('"\\$HOME"')) === JSON.stringify([{ kind: 'literal', value: '$HOME' }]))
check('braced form with a default is passed through',
  JSON.stringify(parseWord('${PORT:-8080}')) ===
  JSON.stringify([{ kind: 'variable', expression: 'PORT:-8080' }]))
check('a lone dollar stays literal', wordText(parseWord('100$')) === '100$')
check('legacy ENV form', JSON.stringify(parseEnv('NAME some value').map(b => [b.key, wordText(b.value)])) ===
  JSON.stringify([['NAME', 'some value']]))
check('multiple ENV pairs', JSON.stringify(parseEnv('A=1 B="two words"').map(b => [b.key, wordText(b.value)])) ===
  JSON.stringify([['A', '1'], ['B', 'two words']]))

{
  const plan = planBuild('FROM alpine\nENV V=1\nRUN echo $V\nENV V=2\nRUN echo $V\n')
  check('a RUN sees only the ENVs above it',
    plan.steps[0].env.length === 1 && wordText(plan.steps[0].env[0].value) === '1',
    JSON.stringify(plan.steps[0].env))
  check('a later RUN sees the re-assignment',
    plan.steps[1].env.length === 2 && wordText(plan.steps[1].env[1].value) === '2')
}
{
  const plan = planBuild('FROM alpine\nRUN one\nWORKDIR /x\nRUN two\n')
  check('a WORKDIR below a RUN does not reach it', plan.steps[0].workdirs.length === 0)
  check('a WORKDIR above a RUN does', plan.steps[1].workdirs.length === 1)
}
{
  const plan = planBuild('FROM alpine\nWORKDIR /usr\nWORKDIR local\nRUN pwd\n')
  check('a relative WORKDIR extends the chain',
    plan.steps[0].workdirs.map(wordText).join(',') === '/usr,local')
}
{
  const plan = planBuild('FROM alpine\nENV A=1\nENV B=$A\nENV A=2\nRUN true\n')
  check('a re-assignment is kept as its own entry, not folded into the first',
    plan.steps[0].env.map(b => b.key + '=' + wordText(b.value)).join(',') === 'A=1,B=$A,A=2')
}

{
  const body = bodies(script('FROM alpine\nWORKDIR /app\nRUN pwd\n'))[0]
  check('WORKDIR is created, not just entered',
    body.includes('mkdir -p "/app" && cd "/app" || exit 1'), body)
  check('a failed cd is no longer swallowed', !/cd .*\|\| true/.test(body), body)
}
{
  const body = bodies(script('FROM alpine\nRUN true\n'))[0]
  check('the base image environment is seeded',
    body.includes("export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'"), body)
  check('the base image working directory is entered', body.includes("cd '/' || exit 1"), body)
}
{
  const body = bodies(script('FROM alpine\nENV PATH=/opt/bin:$PATH\nRUN true\n'))[0]
  check('ENV expands against what came before', body.includes('export PATH="/opt/bin:${PATH}"'), body)
}
{
  const body = bodies(script("FROM alpine\nENV MSG='costs $5'\nRUN true\n"))[0]
  check('a single quoted ENV does not expand', body.includes('export MSG="costs \\$5"'), body)
}
{
  const text = script('FROM alpine\nRUN true\n')
  check('/dev/null is a device, not a file the build creates',
    text.includes('mknod -m 666 /rootfs/dev/null c 1 3'))
  check('/dev is bind mounted when the guest allows it',
    text.includes('mount -o bind /dev /rootfs/dev'))
  check('/proc is mounted', text.includes('mount -t proc none /rootfs/proc'))
}
{
  const text = chrootBuildScript({
    plan: planBuild('FROM alpine:3.21\nRUN true\n'),
    layers: [], imageDefaults: ALPINE, readyMarker: '__R__', failMarker: '__F__',
  })
  check('in-place skips the chroot', !text.includes('chroot '))
  check('in-place skips the device setup', !text.includes('mknod'))
  check('in-place still enters the image working directory',
    bodies(text)[0].includes("cd '/' || exit 1"), bodies(text)[0])
}
{
  const ops = {
    removals: ['d/a'], emptied: ['opq'], markers: ['d/.wh.a', 'opq/.wh..wh..opq'], compression: 'gzip',
  }
  const text = script('FROM alpine\nRUN true\n', { layers: [{ key: 'k', bytes: 1, ops }] })
  check('a recorded deletion runs before the extract',
    text.indexOf("rm -rf '/rootfs/d/a'") < text.indexOf('tar -xzf'))
  check('an opaque directory is cleared and recreated before the extract',
    text.includes("rm -rf '/rootfs/opq' && mkdir -p '/rootfs/opq'") &&
    text.indexOf("rm -rf '/rootfs/opq'") < text.indexOf('tar -xzf'))
  check('the markers are removed after the extract',
    text.indexOf('tar -xzf') < text.indexOf("rm -f '/rootfs/d/.wh.a'"))
}
{
  const text = script('FROM alpine\nRUN true\n', {
    layers: [{ key: 'k', bytes: 1, ops: { removals: [], emptied: [], markers: [], compression: 'none' } }],
  })
  check('an uncompressed layer is untarred without -z', text.includes('tar -xf /tmp/layer0.tar'))
}
{
  const text = script("FROM alpine\nRUN echo \"it's fine\"\n")
  check('an embedded apostrophe survives the quoting', text.includes("it'\\''s fine"))
}
check('never mentions buildah', !script('FROM alpine\nRUN true\n').includes('buildah'))
{
  const text = script('FROM alpine\nRUN a\nRUN b\n')
  check('one phase marker per RUN, with its source line',
    (text.match(/__phase 'RUN /g) || []).length === 2 && text.includes('(line 2)') && text.includes('(line 3)'))
  check('the ready marker precedes the launch', text.indexOf('__R__') < text.indexOf('starting container'))
}

const launch = (text, defaults) => launchCommand(planBuild('FROM a\n' + text), defaults)
check('image CMD applies when the Dockerfile sets none',
  launch('RUN x\n', { cmd: ['/bin/busybox', 'httpd'] }) === "'/bin/busybox' 'httpd'")
check('Dockerfile CMD wins over image CMD',
  launch('CMD ["x"]\n', { cmd: ['y'] }) === "'x'")
check('entrypoint and cmd concatenate', launch('ENTRYPOINT ["e"]\nCMD ["c"]\n', {}) === "'e' 'c'")
check('setting ENTRYPOINT clears the inherited CMD',
  launch('ENTRYPOINT ["e"]\n', { cmd: ['inherited'] }) === "'e'")
check('a shell form ENTRYPOINT ignores CMD',
  launch('ENTRYPOINT top level\nCMD ["ignored"]\n', {}) === 'top level')
check('a shell form ENTRYPOINT ignores an inherited CMD',
  launch('ENTRYPOINT top level\n', { cmd: ['inherited'] }) === 'top level')
check('a shell form CMD after an exec form ENTRYPOINT is passed as argv',
  launch('ENTRYPOINT ["e"]\nCMD run it\n', {}) === "'e' /bin/sh -c 'run it'")
check('a shell form CMD on its own is a line of shell',
  launch('CMD echo hi\n', {}) === 'echo hi')
check('an empty exec form ENTRYPOINT clears both',
  launch('ENTRYPOINT []\n', { entrypoint: ['i'], cmd: ['c'] }) === '/bin/sh')
check('falls back to a shell', launch('RUN x\n', {}) === '/bin/sh')
check('an inherited entrypoint applies',
  launch('CMD ["c"]\n', { entrypoint: ['i'] }) === "'i' 'c'")

{
  const launch = planLaunch({ dockerfile: 'FROM alpine:3.21\nRUN echo hi\n', mode: 'shell' })
  const url = new URL(launch.url, 'https://x.invalid')
  check('an edited Dockerfile pins no artifact, leaving the plan in charge',
    !url.searchParams.has('wasm-url'), launch.url)
  check('and never names the buildah guest', !launch.url.includes('playground.wasm'), launch.url)
  check('an edited Dockerfile boots the runner guest', launch.guest.kind === 'runner', launch.guest.kind)
  const builder = planLaunch({ dockerfile: 'FROM alpine\nCOPY . /app\n', mode: 'shell' }).guest
  check('the runner is the smaller download of the two',
    launch.guest.approximateDownloadBytes < builder.approximateDownloadBytes,
    launch.guest.approximateDownloadBytes + ' vs ' + builder.approximateDownloadBytes)
  check('the Dockerfile travels in the hash, not the query',
    url.hash.startsWith('#dockerfile=') && !url.search.includes('dockerfile'), launch.url)
}
{
  const launch = planLaunch({ dockerfile: 'FROM alpine\nCOPY . /app\n', mode: 'shell' })
  check('a Dockerfile the fast path declines boots the builder',
    launch.guest.kind === 'builder' && launch.summary.includes('COPY'), launch.summary)
  check('and still pins no artifact', !launch.url.includes('wasm-url'), launch.url)
}
{
  const launch = planLaunch({ dockerfile: PRESET_DOCKERFILES.shell, mode: 'shell' })
  const pinned = new URL(launch.url, 'https://x.invalid').searchParams.get('wasm-url')
  check('a preset does pin its own artifact', pinned !== null, launch.url)
  check('and the runtime recognises it as one', isPresetWasmURL(pinned ?? ''), pinned)
}
{
  const launch = planLaunch({ dockerfile: 'FROM alpine:3.21\nEXPOSE 8080\nCMD ["x"]\n', mode: 'http' })
  const params = new URL(launch.url, 'https://x.invalid').searchParams
  check('service mode publishes the port and runs the image command',
    params.get('publish') === 'tcp:8080' && params.get('run') === 'default', launch.url)
}
{
  const launch = planLaunch({ dockerfile: 'FROM alpine:3.21\nRUN echo hi\n', mode: 'shell' })
  check('the summary says the base needs no transfer when the guest is it',
    launch.summary.includes('no transfer'), launch.summary)
}
{
  const launch = planLaunch({ dockerfile: 'FROM debian:12\nRUN echo hi\n', mode: 'shell' })
  check('and says what it will pull when it is not',
    launch.summary.includes('pull debian:12'), launch.summary)
}

const dir = import.meta.dirname
for (const [label, text] of [
  ['chroot', script('FROM alpine\nENV A="x y" B=$A\nWORKDIR /srv\nWORKDIR sub\nRUN echo "it\'s $A" > /f\nCMD ["/bin/sh"]\n')],
  ['in place', chrootBuildScript({
    plan: planBuild('FROM alpine:3.21\nENV A=1\nWORKDIR /w\nRUN true\n'),
    layers: [], imageDefaults: ALPINE, readyMarker: '__R__', failMarker: '__F__',
  })],
]) {
  const path = dir + '/generated-' + label.replace(' ', '-') + '.sh'
  writeFileSync(path, text)
  try {
    execFileSync('sh', ['-n', path], { stdio: 'pipe' })
    console.log('ok   the generated ' + label + ' script parses under sh -n')
  } catch (error) {
    failures++
    console.error('FAIL the generated ' + label + ' script is not valid shell\n' +
      String(error.stderr || error))
  }
}

console.log(failures ? '\n' + failures + ' failing' : '\nall passing')
process.exitCode = failures ? 1 : 0
