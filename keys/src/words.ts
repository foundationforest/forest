// Paper export: the seed as 24 English words (BIP39), and back. The words
// encode the 32 seed bytes plus an 8-bit checksum. BIP39's own "seed" step
// (PBKDF2 over the words) is not used; the entropy is the seed.

import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { SEED_LENGTH, assertBytes } from './hkdf.ts'

export const WORD_COUNT = 24

/** The seed as 24 words separated by single spaces. */
export function exportWords(seed: Uint8Array): string {
  assertBytes('seed', seed, SEED_LENGTH)
  return entropyToMnemonic(seed, wordlist)
}

/** The seed back from the words. Case and spacing are forgiven; a wrong word is not. */
export function importWords(text: string): Uint8Array {
  const words = text.trim().toLowerCase().split(/\s+/)
  if (words.length !== WORD_COUNT) throw new Error(`expected ${WORD_COUNT} words, got ${words.length}`)
  const mnemonic = words.join(' ')
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('these words are not a paper export: a word is wrong, or in the wrong place')
  }
  return mnemonicToEntropy(mnemonic, wordlist)
}
