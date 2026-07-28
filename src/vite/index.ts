/// <reference types="node" />
// Vite plugin: point an import at a Dockerfile, get a URL to a browser-runnable
// container.
//
//   import { containers } from '@fkn/container/vite'
//   export default defineConfig({ plugins: [containers()] })
//
//   import image from './api/Dockerfile?container'
//   const api = createContainer({ image, ports: [8080] })
//
// The conversion happens on the developer's machine, once per image change, so
// the browser downloads a finished artifact instead of building one. The plugin
// also sets the cross-origin isolation headers the runtime needs, because a
// missing header is otherwise the first thing everyone hits.

import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
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

export const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

export type ContainersOptions = {
  // Default target architecture for every image.
  //
  // `amd64` runs any image and needs no extra host setup. `riscv64` produces an
  // artifact around half the size on a faster emulator, but the image must have
  // a riscv64 variant and its RUN steps need the matching binfmt handlers.
  arch?: TargetArch
  // Guest RAM in MiB. The default suits a small service.
  memoryMB?: number
  // Where converted images are cached. Defaults to node_modules/.cache.
  cacheDir?: string
  // Container CLI. Defaults to "docker".
  builder?: string
  // Path to an existing container2wasm binary. Built in a container otherwise.
  c2wPath?: string
  // Set the COOP/COEP headers on the dev and preview servers. On by default:
  // without them SharedArrayBuffer is unavailable and nothing runs.
  crossOriginIsolation?: boolean
  // Named images built regardless of whether anything imports them. Useful for
  // warming the cache in CI.
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

export const containers = (options: ContainersOptions = {}): Plugin => {
  const builder = options.builder ?? 'docker'
  let config: ResolvedConfig
  let cacheDir: string
  let server: ViteDevServer | null = null
  let isBuild = false

  const built = new Map<string, BuiltImage>()          // resolved id -> artifact
  const watched = new Map<string, Set<string>>()       // watched file -> resolved ids
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
      // The FKN transport is published against the Node built-ins. Map them to
      // their browser implementations here so a consumer does not have to
      // rediscover the list.
      resolve: {
        // Exact matches only. A bare string alias also rewrites subpaths, so a
        // `process` entry would turn `process/browser.js` into
        // `process/browser/browser.js`.
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
      // The runtime spawns module workers; keep that format in dev too so the
      // served and built pages behave the same.
      worker: { format: 'es' as const },
      ...(options.crossOriginIsolation === false ? {} : {
        server: { headers: { ...CROSS_ORIGIN_ISOLATION_HEADERS } },
        preview: { headers: { ...CROSS_ORIGIN_ISOLATION_HEADERS } },
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
      if (options.crossOriginIsolation !== false) {
        devServer.middlewares.use((_request, response, next) => {
          for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
            response.setHeader(name, value)
          }
          next()
        })
      }
      devServer.middlewares.use(DEV_BASE, (request, response, next) => {
        const name = decodeURIComponent((request.url || '').split('?')[0]!.replace(/^\//, ''))
        if (!/^[\w.-]+\.wasm$/.test(name)) return next()
        const path = join(cacheDir, name)
        response.setHeader('Content-Type', 'application/wasm')
        // The file name carries the image digest, so it is safe to pin.
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        createReadStream(path)
          .on('error', () => {
            response.statusCode = 404
            response.end('container image not built: ' + name)
          })
          .pipe(response)
      })
    },

    async buildStart () {
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
