import process from 'process'

Object.assign(globalThis, { process })
void import('./main')
