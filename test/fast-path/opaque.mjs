// Opaque directory markers (`.wh..wh..opq`), end to end. buildkit's differ prefers per-file
// whiteouts, so the layers here are assembled by hand rather than diffed out of a docker build.

import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planBuild, chrootBuildScript, scanLayers } from './fastpath.mjs'

const freePort = () => Number(spawnSync('python3', ['-c',
  "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()",
], { encoding: 'utf8' }).stdout.trim())

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log('ok   ' + label)
  else {
    failures++
    console.error('FAIL ' + label + (detail === undefined ? '' : '\n     ' + String(detail).split('\n').join('\n     ')))
  }
}

const run = (file, args, opts = {}) => {
  const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts })
  if (result.error) throw result.error
  return { status: result.status, output: String(result.stdout ?? '') + String(result.stderr ?? '') }
}
const sh = (file, args, opts = {}) => {
  const { status, output } = run(file, args, opts)
  if (status !== 0) throw new Error(file + ' exited ' + status + ':\n' + output.slice(-2000))
  return output
}

const work = mkdtempSync(join(tmpdir(), 'fkn-opaque-'))

sh('docker', ['save', 'alpine:3.21', '-o', join(work, 'alpine.tar')])
mkdirSync(join(work, 'alpine'))
sh('tar', ['-xf', join(work, 'alpine.tar'), '-C', join(work, 'alpine')])
const alpineManifest = JSON.parse(readFileSync(join(work, 'alpine', 'manifest.json'), 'utf8'))[0]
const alpineConfig = JSON.parse(
  readFileSync(join(work, 'alpine', alpineManifest.Config), 'utf8'),
).config

const makeLayer = (name, build) => {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  build(dir)
  const out = join(work, name + '.tar.gz')
  sh('tar', ['-czf', out, '-C', dir, '.'])
  return new Uint8Array(readFileSync(out))
}

const lower = makeLayer('lower', (dir) => {
  mkdirSync(join(dir, 'opqdir', 'sub'), { recursive: true })
  writeFileSync(join(dir, 'opqdir', 'lower-a'), 'a\n')
  writeFileSync(join(dir, 'opqdir', 'lower-b'), 'b\n')
  writeFileSync(join(dir, 'opqdir', 'sub', 'deep'), 'deep\n')
  writeFileSync(join(dir, 'opqdir', '.hidden-lower'), 'hidden\n')
  writeFileSync(join(dir, 'untouched'), 'still here\n')
})

const upper = makeLayer('upper', (dir) => {
  mkdirSync(join(dir, 'opqdir'), { recursive: true })
  writeFileSync(join(dir, 'opqdir', '.wh..wh..opq'), '')
  writeFileSync(join(dir, 'opqdir', 'upper-only'), 'mine\n')
})

const layerBytes = [
  new Uint8Array(readFileSync(join(work, 'alpine', alpineManifest.Layers[0]))),
  lower,
  upper,
]
const ops = await scanLayers(layerBytes)

check('the opaque marker is recognised',
  ops[2].emptied.includes('opqdir'), JSON.stringify(ops[2]))
check('the marker itself is not treated as content',
  ops[2].markers.includes('opqdir/.wh..wh..opq'), JSON.stringify(ops[2]))
check('the opaque directory is cleared, not the whole rootfs',
  ops[2].emptied.length === 1 && ops[2].removals.length === 0, JSON.stringify(ops[2]))

const serveDir = join(work, 'serve', 'img')
mkdirSync(serveDir, { recursive: true })
layerBytes.forEach((bytes, index) => {
  writeFileSync(join(serveDir, '__fkn_layer_' + index + '__'), Buffer.from(bytes))
})
const port = freePort()
const server = spawn('python3', [
  '-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', join(work, 'serve'),
], { stdio: 'ignore' })
const reachable = () => run('curl', ['-fsS', '-o', '/dev/null',
  'http://127.0.0.1:' + port + '/img/__fkn_layer_0__']).status === 0
for (let attempt = 0; attempt < 50 && !reachable(); attempt++) spawnSync('sh', ['-c', 'sleep 0.1'])
check('the layer server is up', reachable())

const dockerfile = 'FROM synthetic:opaque\n' +
  'RUN find /opqdir /untouched | sort | sed "s/^/TREE|/"\n'

const plan = planBuild(dockerfile)
let script = chrootBuildScript({
  plan,
  layers: layerBytes.map((bytes, index) => ({
    key: '__fkn_layer_' + index + '__', bytes: bytes.length, ops: ops[index],
  })),
  imageDefaults: {
    env: alpineConfig.Env ?? undefined,
    workdir: alpineConfig.WorkingDir ?? undefined,
    cmd: alpineConfig.Cmd ?? undefined,
  },
  readyMarker: '__FKN_OK__',
  failMarker: '__FKN_FAILED__',
})
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
  guest.status === 0 && guest.output.includes('__FKN_OK__') && !guest.output.includes('__FKN_FAILED__'),
  guest.output.slice(-2000))

// the phase marker echoes the command, which contains the probe's own `TREE|` prefix, so only well formed paths count
const tree = (guest.output.match(/TREE\|[^\n\r]*/g) ?? [])
  .map((line) => line.trim())
  .filter((line) => /^TREE\|(\/[\w.-]+)+$/.test(line))
  .sort()

const expected = ['TREE|/opqdir', 'TREE|/opqdir/upper-only', 'TREE|/untouched'].sort()
check('the opaque directory keeps only its own layer\'s contents',
  JSON.stringify(tree) === JSON.stringify(expected),
  'expected: ' + JSON.stringify(expected) + '\nactual:   ' + JSON.stringify(tree))

if (failures) console.error('\nartefacts kept at ' + work)
else rmSync(work, { recursive: true, force: true })

console.log(failures ? '\n' + failures + ' failing' : '\nall passing')
process.exitCode = failures ? 1 : 0
