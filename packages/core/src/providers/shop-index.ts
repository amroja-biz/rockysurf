import { isHostnameSafeId } from '@rockysurf/provider-sdk'
import { z } from 'zod'

/**
 * `providers.json` — what a registry publishes about PROVIDERS, and what core reads (ADR-0028).
 *
 * A registry has published `index.json` since ADR-0006: a listing of Surge Packs plus the paths
 * of the pack files it describes. A provider is a different kind of thing — an npm package that
 * runs INSIDE this process rather than a YAML file that describes shell run on a box — and it
 * gets its own document at `<url>/providers.json` rather than a second array inside the pack
 * index. Two reasons, and the second is the one that decided it:
 *
 * FIRST, THE TWO LISTINGS ARE FETCHED AT DIFFERENT TIMES. Opening the pack shelves should not
 * cost a fetch of a provider catalogue nobody asked to see, and the reverse.
 *
 * SECOND, `registryIndexSchema` IS STRICT. Adding a `providers` array to it would make every
 * shop that published one unreadable by every Rocky Surf already installed — the pack shelf
 * would go from "here are the packs" to "this is not a pack registry index" on an installation
 * that changed nothing. A separate file is invisible to a client that never asks for it, so a
 * shop can start listing providers without breaking anybody.
 *
 * THERE IS NO TRUST FIELD HERE, AND THE SCHEMA REFUSES ONE. This is ADR-0006's rule applied to a
 * heavier payload rather than a new decision: a trust label inside a registry's own document is a
 * claim about trustworthiness written by the party being trusted. The sentence every listing
 * carries — "a provider runs with Rocky Surf's full access — install ones you trust" — is Rocky
 * Surf's own constant (`PERSONAL_PROVIDER_TRUST_SENTENCE`), rendered by the client on every
 * entry. No registry can write it, soften it, or leave it out.
 *
 * WHAT THE sha256 IS AND IS NOT, again. It pins the tarball to the entry that describes it, so an
 * artifact swapped without regenerating the listing fails closed. It is not a signature: whoever
 * can write the listing can write both halves, and the honest statement of the chain is "the
 * operator trusts this repository's main branch and its host's account controls". ADR-0006 says
 * exactly that about packs and ADR-0028 repeats it rather than implying more.
 */

/** Bumped when the document shape changes. Core refuses a version it does not know. */
export const PROVIDER_INDEX_VERSION = 1

/** The file a directory source publishes its providers in, beside `index.json`. */
export const PROVIDER_INDEX_FILE = 'providers.json'

/**
 * The provider id, which is also the key of a `providers:` section in the operator's config file.
 * The rule `personal-providers.ts` enforces on that key, applied here so a listing cannot offer
 * an entry that could never be installed.
 */
const PROVIDER_ID = z
  .string()
  .min(1)
  .refine((id) => id === id.toLowerCase() && isHostnameSafeId(id), {
    error: 'must be lowercase letters, digits and hyphens, starting with a letter',
  })

/** An npm package name, scoped or not. What `providers.<id>.package` will be set to. */
const PACKAGE_NAME = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, { error: 'must be an npm package name' })

/**
 * `https` ONLY, refused at the schema rather than at the socket.
 *
 * A provider tarball is code that will run with everything this process can reach, so plain http
 * — where anything on the path may rewrite both the artifact and, arriving over the same
 * connection, the digest meant to catch that — is not a thing an operator can opt into. The same
 * rule `registry.sources[].url` took in ADR-0006's #88 amendment, for a heavier payload.
 */
const HTTPS_URL = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === 'https:'
      } catch {
        return false
      }
    },
    { error: 'must be an https URL' },
  )

/**
 * One row of the panel the provider will get in Settings, as the listing shows it BEFORE install.
 *
 * A summary, deliberately not the provider's whole `ProviderSettings` declaration: the listing's
 * job is to answer "what will this ask me for", and the authoritative declaration arrives with
 * the package and drives the real panel (ADR-0027). Kinds are the SDK's, so a listing cannot
 * promise a control the page has no way to draw.
 */
export const providerSettingSummarySchema = z.strictObject({
  name: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['string', 'number', 'boolean', 'secret', 'stringList', 'sshCidrList']),
})

/**
 * The capability answers, as the provider declares them — the questions the research protocol in
 * `.agents/skills/add-provider` makes an author answer, shown before anybody installs.
 *
 * Present in the listing rather than discovered after install because they are the facts that
 * decide whether this provider is usable at all on this installation: whether a machine can be
 * stopped, whether stopping it stops the bill (ADR-0025), whether the provider will manage the
 * SSH whitelist. A listing that hid them would be asking for consent to something unreadable.
 *
 * The four required ones are ADR-0003's required capabilities; the optional ones default to
 * absent exactly as they do in the SDK, and absent means false.
 */
export const providerCapabilityAnswersSchema = z.strictObject({
  stop: z.boolean(),
  ipStableAcrossStop: z.boolean(),
  canInjectHostKeys: z.boolean(),
  generatesUserData: z.boolean(),
  userDataMaxBytes: z.number().int().nonnegative(),
  managesSshAccess: z.boolean().optional(),
  billsWhileStopped: z.boolean().optional(),
  simulatedInstances: z.boolean().optional(),
})

export const providerRegistryEntrySchema = z.strictObject({
  /** The config section key this installs as, and the id the package's factory must declare. */
  providerId: PROVIDER_ID,
  /** What the provider calls itself. The package's `displayName` is the one that finally shows. */
  name: z.string().min(1),
  description: z.string().min(1),
  /** The artifact's version, shown before install and compared with what is on disk after. */
  version: z.string().min(1).max(64),
  /** The npm package name inside the tarball, which the installer checks the manifest against. */
  package: PACKAGE_NAME,
  /** Where the packed tarball is. https only; fetched through the SSRF guard; size-capped. */
  tarball: HTTPS_URL,
  /** Lowercase hex, 64 chars, over the tarball's bytes. Verified after fetch; refused on a miss. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, { error: 'must be a lowercase hex sha256' }),
  settings: z.array(providerSettingSummarySchema),
  capabilities: providerCapabilityAnswersSchema,
})

export const providerRegistryIndexSchema = z.strictObject({
  version: z.literal(PROVIDER_INDEX_VERSION),
  /** When the listing was written, ISO-8601. Displayed rather than enforced, as `index.json` is. */
  generatedAt: z.iso.datetime(),
  providers: z.array(providerRegistryEntrySchema),
})

export type ProviderSettingSummary = z.infer<typeof providerSettingSummarySchema>
export type ProviderCapabilityAnswers = z.infer<typeof providerCapabilityAnswersSchema>
export type ProviderRegistryEntry = z.infer<typeof providerRegistryEntrySchema>
export type ProviderRegistryIndex = z.infer<typeof providerRegistryIndexSchema>
