import { describe, expect, it } from 'vitest'
import { decodeDataUri, loadShippedElf } from './shipped.ts'

describe('reading a shipped binary', () => {
  it('decodes the data URI a production build inlines', async () => {
    const bytes = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])
    const base64 = Buffer.from(bytes).toString('base64')
    const uri = `data:application/octet-stream;base64,${base64}`
    expect([...decodeDataUri(uri)]).toEqual([...bytes])
    expect([...(await loadShippedElf(uri))]).toEqual([...bytes])
  })

  it('refuses a data URI that is not base64 rather than mangling it', () => {
    // If the bundler ever stopped base64-encoding these, silently decoding
    // the text as bytes would produce an ELF-shaped mess.
    expect(() => decodeDataUri('data:application/octet-stream,7fELF')).toThrow(/not base64/)
    expect(() => decodeDataUri('data:nonsense')).toThrow(/malformed/)
  })
})
