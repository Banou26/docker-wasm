// What the editor page hands the runtime.
//
// This is a pure function on purpose. It used to be an expression inline in the
// button handler, and it carried a bug that made every edited Dockerfile boot
// the full buildah guest: it pinned `/playground/playground.wasm` as the wasm
// URL, the runtime honours an explicit URL over its own plan, and
// `isPresetWasmURL` does not recognise that path as one to ignore. So the fast
// path, the smaller guest and the quicker boot were all unreachable from the
// page they were built for, while looking fine in every log.
//
// Nothing here needs a DOM, which is the point: the contract is checked in
// test/fast-path rather than by loading the page and reading a URL bar.

import { b64encodeUtf8, HASH_KEY_DOCKERFILE, QUERY_PARAMS, withWasmAssetVersion } from './shared'
import { matchPreset, PRESET_WASM_PATHS, type PresetName } from './presets'
import { planBuild } from './dockerfile'
import { DEFAULT_BUILDER_ARCH, GUESTS, sameImage, type Builder, type BuilderArch } from './builder'

export type LaunchMode = PresetName

export type LaunchPlan = {
  // Where to send the browser.
  url: string
  // The guest that will boot, so the page can start downloading it early.
  guest: Builder
  // One line describing what the build will do, for the editor.
  summary: string
  // Set only for a preset, whose artifact is the whole image and so overrides
  // the runtime's own choice.
  preset: PresetName | null
}

export const guestFor = (dockerfile: string, arch: BuilderArch = DEFAULT_BUILDER_ARCH): {
  guest: Builder
  summary: string
} => {
  const plan = planBuild(dockerfile)
  if (plan.engine === 'buildah') {
    return { guest: GUESTS.builder[arch], summary: 'Full builder: ' + plan.reason }
  }
  const guest = GUESTS.runner[arch]
  const inPlace = guest.baseImage !== undefined && sameImage(plan.base, guest.baseImage)
  const steps = plan.steps.length + ' step' + (plan.steps.length === 1 ? '' : 's')
  return {
    guest,
    summary: inPlace
      ? 'Fast path, no transfer: ' + plan.base + ' is the guest, ' + steps
      : 'Fast path: pull ' + plan.base + ', ' + steps,
  }
}

export const planLaunch = (options: {
  dockerfile: string
  mode: LaunchMode
  arch?: BuilderArch
}): LaunchPlan => {
  const { dockerfile, mode } = options
  const servicePort = mode === 'http' ? 8080 : null
  const preset = matchPreset(dockerfile, servicePort)

  const params = new URLSearchParams({ [QUERY_PARAMS.net]: 'webvpn' })
  // Only a preset pins its artifact, because a preset *is* the artifact. For
  // anything else the runtime picks the guest from the same plan this function
  // reads, and naming one here would override it.
  if (preset) params.set(QUERY_PARAMS.wasmUrl, withWasmAssetVersion(PRESET_WASM_PATHS[preset]))
  if (servicePort !== null) {
    params.set(QUERY_PARAMS.publish, 'tcp:' + servicePort)
    params.set(QUERY_PARAMS.run, 'default')
  }

  const chosen = preset
    ? { guest: GUESTS.runner[options.arch ?? DEFAULT_BUILDER_ARCH], summary: 'Prebuilt example, no build needed' }
    : guestFor(dockerfile, options.arch)

  return {
    url: '/playground/?' + params + '#' + HASH_KEY_DOCKERFILE + '=' + b64encodeUtf8(dockerfile),
    guest: chosen.guest,
    summary: chosen.summary,
    preset,
  }
}
