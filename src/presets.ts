import httpDockerfileSource from './app/dockerfile-playground/presets/http.Dockerfile?raw'
import shellDockerfileSource from './app/dockerfile-playground/presets/shell.Dockerfile?raw'

export type PresetName = 'shell' | 'http'

export const PRESET_RUNTIME_TIMEOUT_MS = 5 * 60_000
export const PRESET_DOCKERFILES: Record<PresetName, string> = {
  shell: shellDockerfileSource,
  http: httpDockerfileSource,
}
export const PRESET_WASM_PATHS: Record<PresetName, string> = {
  shell: '/presets/shell.wasm',
  http: '/presets/http.wasm',
}

export const isPresetWasmURL = (value: string): boolean => {
  try {
    const path = new URL(value, 'https://preset.invalid').pathname
    return /(?:^|\/)presets\/(?:shell|http)(?:\.[0-9a-f]{64})?\.wasm(?:\.js)?$/.test(path)
  } catch {
    return false
  }
}

export const matchPreset = (dockerfile: string, servicePort: number | null): PresetName | null => {
  if (servicePort === null && dockerfile === PRESET_DOCKERFILES.shell) return 'shell'
  if (servicePort === 8080 && dockerfile === PRESET_DOCKERFILES.http) return 'http'
  return null
}
