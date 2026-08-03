/// <reference types="node" />

import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import {
  buildContainerImage,
  pruneCache,
  type BuiltImage,
  type ImageSpec,
  type TargetArch,
} from './build-image'

const PREFIX = '\0fkn-container:'
const DEV_BASE = '/@fkn-container/'
// Emitted at the output root so its scope covers the whole site.
const WORKER_FILE = 'fkn-container-coi.js'
const WORKER_SOURCE = 'coi-serviceworker.js'

export const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

export type ContainersOptions = {
  // default target arch; `riscv64` roughly halves the artifact but the image needs a riscv64 variant and binfmt handlers for its RUN steps
  arch?: TargetArch
  // guest RAM in MiB
  memoryMB?: number
  // where converted images are cached, defaults to node_modules/.cache
  cacheDir?: string
  // container CLI, defaults to "docker"
  builder?: string
  // path to an existing container2wasm binary, built in a container otherwise
  c2wPath?: string
  // how the page becomes cross-origin isolated, which the runtime requires; `service-worker` emits a worker that sends the headers itself for hosts that cannot
  crossOriginIsolation?: boolean | 'headers' | 'service-worker'
  // Safari and Firefox for Android ignore `credentialless`, so on those browsers the page is simply not isolated and the runtime cannot start at all.
  coep?: 'credentialless' | 'require-corp'
  // named images built even when nothing imports them, for warming the cache in CI
  images?: Record<string, ImageSpec>
}

type Query = { arch?: TargetArch; memoryMB?: number; target?: string }

const parseQuery = (search: string): Query | null => {
  const params = new URLSearchParams(search)
  if (!params.has('container')) return null
  const query: Query = {}
  const arch = params.get('arch')
  if (arch === 'amd64' || arch === 'riscv64') query.arch = arch
  else if (arch) throw new Error('unsupported container arch: ' + arch)
  const memory = params.get('memory')
  if (memory) {
    const value = Number(memory)
    if (!Number.isInteger(value) || value < 32 || value > 4096) {
      throw new Error('container memory must be an integer between 32 and 4096 MiB, got ' + memory)
    }
    query.memoryMB = value
  }
  const target = params.get('target')
  if (target) query.target = target
  return query
}

const formatBytes = (bytes: number): string => (bytes / 1e6).toFixed(1) + ' MB'

const isolationMode = (options: ContainersOptions): 'headers' | 'service-worker' | false => {
  const value = options.crossOriginIsolation
  if (value === false) return false
  if (value === 'service-worker') return 'service-worker'
  return 'headers'
}

const readIsolationWorker = async (coep: string): Promise<string> => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, 'assets', WORKER_SOURCE), 'utf8')
  return source.replace('__FKN_CONTAINER_COEP__', coep)
}

export const containers = (options: ContainersOptions = {}): Plugin => {
  const builder = options.builder ?? 'docker'
  const isolation = isolationMode(options)
  const coep = options.coep ?? 'credentialless'
  const isolationHeaders = { ...CROSS_ORIGIN_ISOLATION_HEADERS, 'Cross-Origin-Embedder-Policy': coep }
  let config: ResolvedConfig
  let cacheDir: string
  let server: ViteDevServer | null = null
  let isBuild = false

  const built = new Map<string, BuiltImage>()
  const watched = new Map<string, Set<string>>()
  const inFlight = new Map<string, Promise<BuiltImage>>()

  const log = (message: string): void => {
    config?.logger.info('[36m[container][0m ' + message, { timestamp: true })
  }

  const build = async (id: string): Promise<BuiltImage> => {
    const existing = inFlight.get(id)
    if (existing) return existing
    const [path, search = ''] = id.slice(PREFIX.length).split('?', 2)
    const query = parseQuery(search) ?? {}
    const task = buildContainerImage({
      dockerfile: path!,
      arch: query.arch ?? options.arch,
      memoryMB: query.memoryMB ?? options.memoryMB,
      target: query.target,
    }, {
      cacheDir,
      builder,
      c2wPath: options.c2wPath,
      log,
    }).then((artifact) => {
      built.set(id, artifact)
      for (const file of artifact.watchFiles) {
        const ids = watched.get(file) ?? new Set<string>()
        ids.add(id)
        watched.set(file, ids)
      }
      log(
        (artifact.fromCache ? 'reused ' : 'built ') + artifact.fileName +
        ' (' + formatBytes(artifact.bytes) + ', linux/' + artifact.arch + ')' +
        (artifact.fromCache ? '' : ' in ' + Math.round(artifact.durationMs / 1000) + 's'),
      )
      return artifact
    }).finally(() => { inFlight.delete(id) })
    inFlight.set(id, task)
    return task
  }

  return {
    name: 'fkn-container',
    enforce: 'pre',

    config: () => ({
      resolve: {
        // Exact matches only: a bare string alias also rewrites subpaths, turning `process/browser.js` into `process/browser/browser.js`.
        alias: [
          { find: /^node:buffer$/, replacement: 'buffer' },
          { find: /^node:events$/, replacement: 'events' },
          { find: /^node:util$/, replacement: 'util/' },
          { find: /^node:stream$/, replacement: 'stream-browserify' },
          { find: /^node:process$/, replacement: 'process/browser.js' },
          { find: /^process$/, replacement: 'process/browser.js' },
          { find: /^stream$/, replacement: 'stream-browserify' },
          { find: /^util$/, replacement: 'util/' },
        ],
      },
      define: { global: 'globalThis' },
      worker: { format: 'es' as const },
      ...(isolation === false ? {} : {
        server: { headers: { ...isolationHeaders } },
        preview: { headers: { ...isolationHeaders } },
      }),
    }),

    configResolved (resolved) {
      config = resolved
      isBuild = resolved.command === 'build'
      cacheDir = options.cacheDir
        ? resolvePath(resolved.root, options.cacheDir)
        : join(resolved.root, 'node_modules', '.cache', 'fkn-container')
    },

    configureServer (devServer) {
      server = devServer
      if (isolation !== false) {
        devServer.middlewares.use((_request, response, next) => {
          for (const [name, value] of Object.entries(isolationHeaders)) {
            response.setHeader(name, value)
          }
          next()
        })
      }
      if (isolation === 'service-worker') {
        devServer.middlewares.use('/' + WORKER_FILE, (_request, response) => {
          void readIsolationWorker(coep).then((source) => {
            response.setHeader('Content-Type', 'text/javascript')
            response.setHeader('Service-Worker-Allowed', '/')
            response.end(source)
          })
        })
      }
      devServer.middlewares.use(DEV_BASE, (request, response, next) => {
        const name = decodeURIComponent((request.url || '').split('?')[0]!.replace(/^\//, ''))
        if (!/^[\w.-]+\.wasm$/.test(name)) return next()
        const path = join(cacheDir, name)
        response.setHeader('Content-Type', 'application/wasm')
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        createReadStream(path)
          .on('error', () => {
            response.statusCode = 404
            response.end('container image not built: ' + name)
          })
          .pipe(response)
      })
    },

    transformIndexHtml: {
      order: 'pre',
      handler: () => (isolation !== 'service-worker' ? [] : [{
        tag: 'script',
        attrs: { src: '/' + WORKER_FILE },
        injectTo: 'head-prepend',
      }]),
    },

    async buildStart () {
      if (isolation === 'service-worker' && isBuild) {
        this.emitFile({
          type: 'asset',
          fileName: WORKER_FILE,
          source: await readIsolationWorker(coep),
        })
      }

      for (const [name, spec] of Object.entries(options.images ?? {})) {
        const artifact = await buildContainerImage({
          ...spec,
          arch: spec.arch ?? options.arch,
          memoryMB: spec.memoryMB ?? options.memoryMB,
        }, { cacheDir, builder, c2wPath: options.c2wPath, log })
        log('image "' + name + '" ready: ' + artifact.fileName)
      }
    },

    resolveId (source, importer) {
      if (source.startsWith(PREFIX)) return source
      const [path, search] = source.split('?', 2)
      if (!search || !new URLSearchParams(search).has('container')) return null
      if (!path) return null
      const absolute = isAbsolute(path)
        ? path
        : resolvePath(importer ? dirname(importer) : config.root, path)
      return PREFIX + absolute + '?' + search
    },

    async load (id) {
      if (!id.startsWith(PREFIX)) return null
      const artifact = await build(id)
      for (const file of artifact.watchFiles) this.addWatchFile(file)

      if (!isBuild) {
        return 'export default ' + JSON.stringify(DEV_BASE + artifact.fileName) + '\n'
      }

      const reference = this.emitFile({
        type: 'asset',
        fileName: (config.build.assetsDir || 'assets') + '/' + artifact.fileName,
        source: await readFile(artifact.path),
      })
      return 'export default import.meta.ROLLUP_FILE_URL_' + reference + '\n'
    },

    async handleHotUpdate (context) {
      const ids = watched.get(context.file)
      if (!ids || ids.size === 0) return
      for (const id of ids) {
        built.delete(id)
        try {
          await build(id)
        } catch (error) {
          config.logger.error('[container] ' + String(error), { timestamp: true })
          return []
        }
      }
      server?.ws.send({ type: 'full-reload' })
      return []
    },

    async closeBundle () {
      await pruneCache(cacheDir, new Set(Array.from(built.values(), (artifact) => artifact.fileName)))
    },
  }
}

export default containers
export type { ImageSpec, TargetArch }
