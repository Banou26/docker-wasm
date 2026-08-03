// End to end check of the chroot path: runs the real generated script against
// real layers, and diffs the rootfs against what `docker build` produced.

import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planBuild, chrootBuildScript, scanLayers } from './fastpath.mjs'

const BASE = 'fkn-layers:base'
const freePort = () => Number(spawnSync('python3', ['-c',
  "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()",
], { encoding: 'utf8' }).stdout.trim())

let failures = 0

const run = (file, args, opts = {}) => {
  const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts })
  if (result.error) throw result.error
  return { status: result.status, output: String(result.stdout ?? '') + String(result.stderr ?? '') }
}
const sh = (file, args, opts = {}) => {
  const { status, output } = run(file, args, opts)
  if (status !== 0) throw new Error(file + ' ' + args.join(' ') + ' exited ' + status + ':\n' + output.slice(-3000))
  return output
}

const check = (label, condition, detail) => {
  if (condition) console.log('ok   ' + label)
  else {
    failures++
    console.error('FAIL ' + label + (detail === undefined ? '' : '\n     ' + String(detail).split('\n').join('\n     ')))
  }
}

const work = mkdtempSync(join(tmpdir(), 'fkn-chroot-'))
const baseDir = join(work, 'base')
mkdirSync(baseDir)
writeFileSync(join(baseDir, 'Dockerfile'), [
  'FROM alpine:3.21',
  'RUN mkdir -p /d /opq && echo one > /d/a && echo two > /d/b && echo keep > /opq/keep',
  'RUN rm /d/a && rm -rf /opq && mkdir -p /opq && echo fresh > /opq/new',
  'RUN echo three > /d/a && rm -f /d/b && mkdir /d/b && echo inner > /d/b/inner',
  'ENV BASE_VAR=from-base',
  'WORKDIR /base-wd',
  '',
].join('\n'))
sh('docker', ['build', '-q', '--no-cache', '-t', BASE, baseDir])

const saveDir = join(work, 'save')
mkdirSync(saveDir)
sh('docker', ['save', BASE, '-o', join(work, 'img.tar')])
sh('tar', ['-xf', join(work, 'img.tar'), '-C', saveDir])
const manifest = JSON.parse(readFileSync(join(saveDir, 'manifest.json'), 'utf8'))[0]
const layerBytes = manifest.Layers.map((path) => new Uint8Array(readFileSync(join(saveDir, path))))
const config = JSON.parse(readFileSync(join(saveDir, manifest.Config), 'utf8')).config
const imageDefaults = {
  env: config.Env ?? undefined,
  workdir: config.WorkingDir ?? undefined,
  entrypoint: config.Entrypoint ?? undefined,
  cmd: config.Cmd ?? undefined,
}
const ops = await scanLayers(layerBytes)

check('the layer scan finds the recorded deletions',
  ops[2].removals.includes('d/a') && ops[2].markers.includes('d/.wh.a'), JSON.stringify(ops[2]))
check('the layer scan finds a path whose type changes',
  ops[3].removals.includes('d/b'), JSON.stringify(ops[3]))

// Out of process on purpose: everything else here is spawnSync, so an in-process server would never answer the guest's wget.
const serveDir = join(work, 'serve', 'img')
mkdirSync(serveDir, { recursive: true })
layerBytes.forEach((bytes, index) => {
  writeFileSync(join(serveDir, '__fkn_layer_' + index + '__'), Buffer.from(bytes))
})
const port = freePort()
const server = spawn('python3', [
  '-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', join(work, 'serve'),
], { stdio: 'ignore', detached: false })
const reachable = () => run('curl', ['-fsS', '-o', '/dev/null',
  'http://127.0.0.1:' + port + '/img/__fkn_layer_0__']).status === 0
for (let attempt = 0; attempt < 50 && !reachable(); attempt++) {
  spawnSync('sh', ['-c', 'sleep 0.1'])
}
check('the layer server is up', reachable())

const PROBE = [
  'find /d /opq | sort | while read -r p; do' +
    ' if [ -d "$p" ]; then echo "TREE|D $p";' +
    ' else echo "TREE|F $p $(cat "$p" 2>/dev/null | tr -d \'\\n\')"; fi; done',
  // Volatile paths are excluded rather than compared: the build writes a resolv.conf and the reference build mounts one instead.
  "printf 'PROBE1<%s>\\n' \"$(find / -xdev | grep -vE '^/(proc|sys|dev)($|/)'" +
    " | grep -vE '^/(etc/resolv.conf|etc/hosts|etc/hostname|.dockerenv)$' | sort | md5sum | cut -c1-32)\"",
  "printf 'PROBE2<%s|%s>\\n' \"$(pwd)\" \"$BASE_VAR\"",
].join(' && ')

const dockerfile = 'FROM ' + BASE + '\n' +
  'ENV OWN_VAR=from-child\n' +
  'WORKDIR /child-wd\n' +
  'RUN echo built > /child.txt\n' +
  'RUN ' + PROBE + '\n'

const extract = (text) => ({
  // Both sides echo the command before running it, so the probe's own source shows up as a match.
  tree: (text.match(/TREE\|[^\n\r]*/g) ?? [])
    .map((line) => line.trim())
    .filter((line) => !line.includes('$p'))
    .sort(),
  probes: (text.match(/PROBE\d<[^>]*>/g) ?? []).filter((probe) => !probe.includes('%s')),
})

const refDir = join(work, 'ref')
mkdirSync(refDir)
writeFileSync(join(refDir, 'Dockerfile'), dockerfile)
const reference = extract(sh('docker', [
  'build', '--no-cache', '--progress=plain', '-t', 'fkn-chroot-ref:latest', refDir,
]))

const plan = planBuild(dockerfile)
check('the planner accepts it', plan.engine === 'chroot', plan.reason)

let script = chrootBuildScript({
  plan,
  layers: layerBytes.map((bytes, index) => ({
    key: '__fkn_layer_' + index + '__', bytes: bytes.length, ops: ops[index],
  })),
  imageDefaults,
  readyMarker: '__FKN_OK__',
  failMarker: '__FKN_FAILED__',
})
// The bridge lives at a fixed address inside the guest; here it is this file's own server.
script = script.split('192.168.127.1:9090').join('127.0.0.1:' + port).split('192.168.127.1').join('127.0.0.1')

const scriptDir = join(work, 'script')
mkdirSync(scriptDir)
writeFileSync(join(scriptDir, 'fkn.sh'), script)
const guest = run('docker', [
  'run', '--rm', '--privileged', '--network', 'host', '-v', scriptDir + ':/fkn:ro',
  'alpine:3.21', 'timeout', '300', 'sh', '/fkn/fkn.sh',
])
server.kill()

check('the generated script completes',
  guest.status === 0 && !guest.output.includes('__FKN_FAILED__') && guest.output.includes('__FKN_OK__'),
  guest.output.slice(-3000))

const fast = extract(guest.output)

check('the rootfs under test matches, file for file and byte for byte',
  reference.tree.length > 0 && JSON.stringify(reference.tree) === JSON.stringify(fast.tree),
  'docker:\n' + reference.tree.join('\n') + '\nfast path:\n' + fast.tree.join('\n'))

const hashOf = (probes) => (probes.find((probe) => probe.startsWith('PROBE1')) ?? '').slice(7, -1)
check('the whole rootfs hashes the same',
  hashOf(reference.probes) !== '' && hashOf(reference.probes) === hashOf(fast.probes),
  'docker: ' + hashOf(reference.probes) + '  fast path: ' + hashOf(fast.probes))

const stateOf = (probes) => probes.find((probe) => probe.startsWith('PROBE2')) ?? ''
check('the working directory and inherited environment match',
  stateOf(reference.probes) !== '' && stateOf(reference.probes) === stateOf(fast.probes),
  'docker: ' + stateOf(reference.probes) + '  fast path: ' + stateOf(fast.probes))

if (failures) {
  writeFileSync(join(work, 'script.sh'), script)
  console.error('\nartefacts kept at ' + work)
} else {
  rmSync(work, { recursive: true, force: true })
}

console.log(failures ? '\n' + failures + ' failing' : '\nall passing')
process.exitCode = failures ? 1 : 0
