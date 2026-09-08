/**
 * What a provider DECLARES about its own configuration, so an installation can draw a Settings
 * panel for it without a hand-written block (ADR-0027, issue #294; amendment E19 to ADR-0003).
 *
 * Types only, like the rest of the contract. Nothing here is the provider's `configSchema` — that
 * validates; this describes. The two are distinct on purpose: a zod schema carries no labels or
 * help, cannot be introspected without a dependency this package refuses to have, does not know
 * that a `token` box takes the NAME of an environment variable, and has no way to say that two of
 * its fields (`sshAllowedCidr` and `allowAllCidr`) are one control with a two-act guard. So a
 * provider says both, and the conformance suite checks they agree: every declared field's
 * `example` must parse through `configSchema`.
 *
 * WHAT IS DELIBERATELY NOT DECLARABLE. `enabled`, `package` and `sizes` are core's fields —
 * orchestration, where to load from, and the allowlist core applies to every catalogue — and an
 * installation adds them to every panel itself; a declaration naming one is refused. There is no
 * `kind` for an arbitrary object or a free-form list: the kinds below are exactly the controls a
 * settings page knows how to draw honestly, and a shape outside them is edited in the file.
 */

/**
 * The controls a declared field can ask for.
 *
 * - `string` / `number` / `boolean` — a box or a checkbox.
 * - `secret` — a credential. The box takes the NAME of an environment variable by default and the
 *   file gets `${VAR}`; the value is never displayed once set. `accepts: 'literal'` opts a field
 *   into taking the token itself, which an installation may refuse.
 * - `stringList` — a list of strings the page shows and does not edit (an allowlist, a set of
 *   zones); combine with `writable: false` and a `reason` saying where it is edited.
 * - `sshCidrList` — THE two-act SSH whitelist: the field named is a list of CIDRs, and the section
 *   also has a boolean `allowAllCidr` beside it that `0.0.0.0/0` requires (ADR-0021, `ssh-cidr.ts`).
 *   A provider declaring this MUST also declare `capabilities.managesSshAccess`, because the
 *   control's whole promise is that a save reaches the cloud; conformance constructs the provider
 *   to check. The page draws one control for both fields and never a bare checkbox.
 */
export type ProviderSettingKind = 'string' | 'number' | 'boolean' | 'secret' | 'stringList' | 'sshCidrList'

export interface ProviderSettingField {
  /** The key inside `providers.<id>`, exactly as `configSchema` expects it. */
  name: string
  kind: ProviderSettingKind
  /** The control's label, in operator language ("Console project id"). */
  label: string
  /** What the setting is for, as a sentence an operator can act on. Required, and checked. */
  help: string
  /** A footgun worth naming next to the control. */
  warning?: string
  /** Default `true`. `false` shows the value and refuses edits; `reason` is then required. */
  writable?: boolean
  /** Why the page will not write this field, and where the edit is made instead. */
  reason?: string
  /** Default `'save'`. `'restart'` fields carry `restartReason`, printed beside the control. */
  appliesAt?: 'save' | 'restart'
  restartReason?: string
  /** `secret` only. Default `'envVarName'`. */
  accepts?: 'envVarName' | 'literal'
  /**
   * A value the schema accepts, shown greyed in the box. For a `secret` with the default
   * `accepts`, the NAME of a variable (`HETZNER_TOKEN`); conformance substitutes a placeholder
   * before parsing. For an `sshCidrList`, one CIDR.
   */
  example?: string
  /**
   * THE SHAPE A TYPED VALUE HAS TO HAVE, so the page can say so before the save does.
   *
   * A `string` field only, and a source-form regular expression — `'^[a-z]{2}(-[a-z]+)+-\\d$'`,
   * anchored, matched against the whole box. It exists because of one thing a first-contact test
   * caught: a mis-click put `sandbox` in AWS's Region box and nothing said a word about it until
   * the save came back refused, several fields later, with the reader no longer looking at the
   * box that was wrong.
   *
   * IT IS A HINT ABOUT SHAPE, NEVER A VALIDATOR. `configSchema` remains the only thing that
   * accepts or refuses a value, unchanged and unweakened; this is the editor being able to point
   * at the right box a second after the typo instead of a minute later. So keep it LOOSE — a
   * pattern that refuses a region the cloud has since added is worse than no pattern at all,
   * because it stops a save the schema would have taken.
   *
   * DECLARING ONE REQUIRES `example`: the message the page prints is "that does not look like an
   * AWS region, for example us-east-1", and the second half of that sentence is this field's own
   * example. Conformance checks the example matches the pattern, so the page can never hold a
   * reader to a shape the provider's own example breaks.
   */
  pattern?: string
}

/** One field of a list entry. */
export interface ProviderSettingListItemField {
  name: string
  label: string
  kind: 'string' | 'number' | 'boolean' | 'secret'
  /**
   * What this box in the entry is for, when the list's own sentence does not cover it.
   *
   * Optional, and the default is the LIST's `help` for every item — which is the right answer
   * for a list whose entries are one idea (`mirrors`: a name and a URL). It is the wrong answer
   * for a list whose boxes are different ideas — an address, a login, a port and a fingerprint
   * each need their own sentence, and repeating the list's one line under all of them would say
   * nothing about any of them. A sentence when present, checked like every other.
   */
  help?: string
}

/**
 * A list of entries the page can add to and remove from — a repeated sub-object under the
 * provider's own config section. `add` is what the blank form asks for; without it the list
 * renders and offers no Add.
 *
 * NO SHIPPED PROVIDER DECLARES ONE (issue #446). The only one that ever did was the
 * bring-your-own-server provider's host list, which was removed before v0.1.0; the declaration
 * and its renderer are kept because a personal Provider whose configuration is genuinely a list
 * is an ordinary thing to write, and because the SDK's shapes are frozen for the packages
 * outside this repository that compile against them. `settings/inventory.ts` still builds the
 * page from it and `inventory.test.ts` still covers it end to end.
 */
export interface ProviderSettingList {
  name: string
  label: string
  help: string
  itemFields: readonly ProviderSettingListItemField[]
  add?: {
    /** The singular the buttons speak — "Add machine". */
    noun: string
    /** A complete entry the schema accepts, shown greyed; never written by itself. */
    example: Readonly<Record<string, string | number | boolean>>
    /** Item fields the form refuses to send empty. */
    required: readonly string[]
  }
  /** The item field that titles a card. Defaults to the first of `itemFields`. */
  labelField?: string
  /** Shown in place of the list when it is empty. */
  empty: string
}

/**
 * A sentence for the human, surfaced where the named page draws it (issue #294's second kind of
 * variability: what only the operator needs to know). Never something core computes with — that
 * is a capability. `settings` renders at the head of the provider's panel; `create` renders on
 * the New Server page when this provider is selected.
 */
export interface ProviderAdvisory {
  surface: 'settings' | 'create'
  text: string
}

export interface ProviderSettings {
  /** The panel's title — usually the cloud's name as the operator knows it. */
  title: string
  /** One or two sentences under the title: what this provider drives, and how it authenticates. */
  help: string
  /**
   * The provider's own fields, in the order the panel draws them. `enabled` is NOT declared here
   * — core adds it first, always — nor are `package` and `sizes`.
   */
  fields: readonly ProviderSettingField[]
  lists?: readonly ProviderSettingList[]
  /**
   * The vocabulary of this cloud's machine types, for the saved-type fields
   * (`preferences.tiers.<id>.small|medium|large`) an installation draws for every provider:
   * "the `server type` to use whenever you ask Hetzner for a small box — `cpx21`, for instance".
   */
  offering: {
    /** "instance type", "VM size", "server type", "host". */
    noun: string
    /** One real id of this cloud's — `t4g.medium`, `cpx21`. */
    example: string
    /**
     * How this provider is named INSIDE a sentence, when that is not its `title`.
     *
     * Default `title`, which reads correctly for a proper noun ("whenever you ask AWS for a
     * small box"). A provider whose panel title is a phrase rather than a name needs the other
     * one — a capitalised title read mid-sentence breaks the sentence.
     */
    label?: string
    /**
     * Whether core's `sizes` allowlist applies to this provider. Default `true`.
     *
     * `false` says the provider's catalogue is ALREADY the operator's own list, so a second
     * allowlist over it would be a control for a config key that does not exist — true of a
     * provider whose machine types are entries the operator wrote in their own config section.
     */
    allowlist?: boolean
  }
  advisories?: readonly ProviderAdvisory[]
}

/** The three keys core owns in every provider section; a declaration naming one is refused. */
export const RESERVED_PROVIDER_SETTING_NAMES = ['enabled', 'package', 'sizes'] as const

/** The boolean an `sshCidrList` field implies beside it, by name (ADR-0021's two-act guard). */
export const SSH_ALLOW_ALL_FIELD = 'allowAllCidr'
