// What the editor page hands the runtime. Kept DOM-free so test/fast-path can check the contract.

import { b64encodeUtf8, HASH_KEY_DOCKERFILE, QUERY_PARAMS, withWasmAssetVersion } from './shared'
import { matchPreset, PRESET_WASM_PATHS, type PresetName } from './presets'
import { planBuild } from './dockerfile'
import { DEFAULT_BUILDER_ARCH, GUESTS, sameImage, type Builder, type BuilderArch } from './builder'

export type LaunchMode = PresetName

export type LaunchPlan = {
  url: string
  guest: Builder
  summary: string
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
  // Only a preset pins its artifact: the runtime honours an explicit wasm URL over its own plan, so naming one for anything else disables the fast path.
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
