# `.agents/skills/`

Agent Skills for working with Rocky Surf. Each directory here teaches a coding agent one of this
project's contracts — what a file must satisfy, how it is verified, and how it gets shipped — so it
can do the job correctly the first time instead of rediscovering the rules from the source.

They are written for **users of Rocky Surf**, not only for contributors to it. Extensibility is the
point of this project: a pack and a provider are both things an outsider is meant to be able to
add, and a skill is how their own agent learns to do it properly.

| Skill | Use it when |
|---|---|
| [`create-surge-pack`](create-surge-pack/) | You want a Rocky Surf box with your own tools on it, and need a Surge Pack that passes the smoke harness |
| [`register-a-tool`](register-a-tool/) | You want to register ONE tool — reusable across packs, exportable as a file you can send someone — rather than author a whole pack |
| [`adding-providers`](adding-providers/) | You want to switch on or configure a cloud, or add support for one Rocky Surf does not have yet |
| [`rockysurf-design`](rockysurf-design/) | You are changing the web UI, or making a mock, slide, or asset that should look like Rocky Surf — the tokens, the voice rules, every component's props contract, the specimen cards, a click-through of the app and the two etched screens (`ui_kits/`), and the etched skin's rollout order (`handoff/README.md`), and the designer's rendered guide to the applied system (`design-guide.html.txt`) |

## Using them

**In a checkout, there is nothing to install.** Any coding agent that supports the Agent Skills
format discovers `.agents/skills/<name>/SKILL.md` automatically, so if you cloned this repository
and started a session in it with such an agent, the skills are already live. Just describe what
you want — "make me a Rocky Surf pack with Rust, Neovim and Claude Code on it" — and the right one
loads itself. You never invoke a skill by name.

**Outside a checkout**, copy the one you want into your own skills directory:

```bash
cp -r .agents/skills/create-surge-pack ~/.agents/skills/        # just you, every project
cp -r .agents/skills/create-surge-pack <your-project>/.agents/skills/   # a team, checked in
```

Restart the session afterwards so it is picked up.

That second path is worth knowing about for `create-surge-pack` in particular, because of a
chicken-and-egg problem: the skill's first instruction is to get a checkout, and it cannot give you
that instruction if it only exists inside the checkout you do not have yet. If you expect to write
packs from your own projects, install it personally once.

## What they need to do their job

These skills verify their work with this repository's real harnesses rather than a weaker
substitute of their own, so they will ask for a checkout with `pnpm install && pnpm -r build` run
once. `create-surge-pack` and `register-a-tool` also need Docker, for the run-twice smoke test.
Any of them can write the file without those; none can honestly tell you it works, and all are
written to say so rather than guess.

## Adding a skill here

Keep the shape consistent so the set reads as one thing:

- `SKILL.md` with `name` + `description` frontmatter and nothing else. The description is the only
  triggering mechanism, so write it in trigger-phrase style: what it does, then the phrasings a
  real user would type.
- `SKILL.md` is a router plus the workflow. Depth goes in `references/*.md`, linked by relative
  path and loaded on demand, each with a stated "read this when".
- `assets/` for files the agent copies rather than reads — templates, skeletons.
- Label anything that only exists in a checkout as "in the checkout" or "(in tree)". Both skills
  serve people who have neither `docs/` nor `packages/` in front of them.
- Name the directory after the user's task. The directory name, the frontmatter `name` and the
  identity a user sees are all the same string.

Two rules that are the reason these are worth shipping at all:

- **Never fork a normative document.** A reference file summarises the real doc and says which one
  wins, or the two drift and the skill starts teaching a contract CI no longer enforces.
- **Drive the real verifier.** Whatever this repository's actual gate is —
  `scripts/pack-smoke.mjs`, the provider conformance suite — the skill runs *that*, with the real
  flags, and reads the real output. A skill that ships a gentler check of its own is worse than no
  skill.

And verify a new skill the way both of these were: give a fresh sub-agent the skill and *nothing
else*, deny it the rest of the repository, and have it build the real thing. Every serious defect
in both skills was found that way and none of them was visible by re-reading.
