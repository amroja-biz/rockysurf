import { ProviderError } from '@rockysurf/provider-sdk'

/**
 * `ProvisionSpec.tags` is `Record<string, string>`. DigitalOcean tags are FLAT STRINGS.
 *
 * The API's tag model gives the charset as a pattern — `^[a-zA-Z0-9_\-\:]+$` — with a limit of
 * 255 characters, described as "Tags may contain letters, numbers, colons, dashes, and
 * underscores." There is no `=`, so **`managed-by=rockysurf` is not expressible on this cloud**,
 * and the encoding is the provider's to choose.
 *
 * THE ENCODING IS `key:value`, AND IT IS INJECTIVE FOR THE KEYS ROCKY SURF USES. A colon is in
 * the charset and neither a key nor a value may contain one (it is the separator and the charset
 * bans nothing else that matters), so splitting at the FIRST colon recovers exactly the pair that
 * was written: `managed-by:rockysurf`, `server-id:dev-box`. Round-tripping is not decoration —
 * `listManaged()` filters on `managed-by:<prefix>` and attributes rows by `server-id:<id>`, and a
 * tag that does not decode back to what was written is a resource this provider can create and
 * never find again.
 *
 * WHICH IS WHY A VALUE CONTAINING A COLON IS REFUSED RATHER THAN MANGLED (contract.md, trap 3).
 * Rewriting `a:b` to `a-b` would make two different tags collide, and the failure is committed at
 * create time and discovered by a bill. The refusal happens in `validateSpec()`, before anything
 * exists.
 */

/** Every character DigitalOcean allows in a tag. */
export const DO_TAG_PATTERN = /^[A-Za-z0-9_:-]+$/

/** "There is a limit of 255 characters per tag." */
export const DO_TAG_MAX_LENGTH = 255

/** The one character that means "the key ends here", and therefore the one banned in both halves. */
export const TAG_SEPARATOR = ':'

/**
 * `key:value`, or a refusal naming the pair that could not be expressed.
 *
 * The message is written for the operator who will read it in the boot log or on the New Server
 * page, so it says what the cloud allows rather than quoting a regular expression at them.
 */
export function encodeTag(key: string, value: string): string {
  const refuse = (why: string): never => {
    throw new ProviderError(
      'invalid_spec',
      `tag ${key}=${value} cannot be written to DigitalOcean: ${why}. DigitalOcean tags are flat ` +
        'strings of letters, digits, colons, dashes and underscores, up to 255 characters, so this ' +
        `provider writes them as "key${TAG_SEPARATOR}value" — a colon in either half would not survive ` +
        'the round trip that listManaged() depends on.',
    )
  }

  if (key.length === 0) refuse('the key is empty')
  if (value.length === 0) refuse('the value is empty')
  if (key.includes(TAG_SEPARATOR)) refuse(`the key contains "${TAG_SEPARATOR}", which separates the two halves`)
  if (value.includes(TAG_SEPARATOR)) refuse(`the value contains "${TAG_SEPARATOR}", which separates the two halves`)

  const encoded = `${key}${TAG_SEPARATOR}${value}`
  if (!DO_TAG_PATTERN.test(encoded)) refuse('it contains a character DigitalOcean does not allow in a tag')
  if (encoded.length > DO_TAG_MAX_LENGTH) {
    refuse(`it is ${encoded.length} characters, over DigitalOcean's ${DO_TAG_MAX_LENGTH}-character limit`)
  }
  return encoded
}

/** The pair a tag was encoded from, or `undefined` for a tag this provider did not write. */
export function decodeTag(tag: string): { key: string; value: string } | undefined {
  const at = tag.indexOf(TAG_SEPARATOR)
  if (at <= 0 || at === tag.length - 1) return undefined
  return { key: tag.slice(0, at), value: tag.slice(at + 1) }
}

/** Every `key:value` in a droplet's tag array, as the record `ProvisionSpec.tags` would have been. */
export function decodeTags(tags: readonly string[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const tag of tags ?? []) {
    const pair = decodeTag(tag)
    if (pair) out[pair.key] = pair.value
  }
  return out
}

/** The whole tag array for a spec, refusing the first pair that cannot be round-tripped. */
export function encodeTags(tags: Record<string, string>): string[] {
  return Object.entries(tags).map(([key, value]) => encodeTag(key, value))
}
