import { Buffer } from 'buffer'
import process from 'process/browser'
globalThis.Buffer = globalThis.Buffer || Buffer
globalThis.process = globalThis.process || process
