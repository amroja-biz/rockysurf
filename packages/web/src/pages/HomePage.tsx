import { Link } from 'react-router'
import { AppShell } from '../components/AppShell'
import { GITHUB_URL, SHOP_URL, repoDocUrl } from '../lib/links'

/**
 * What Rocky Surf is, the problem it solves, and why you would run it (issue #266).
 *
 * This used to be the README, copied sentence for sentence (issue #16). That made the front
 * door a second operator manual — install, backup, IAM, spend caps — and it drifted the
 * moment either copy moved. The README remains the operator document. Help remains the UI
 * manual. This page is the pitch: what the product is, who it is for, and the two stories
 * that explain it. If a sentence here promises a behaviour, that behaviour still has to be
 * true of the code; the install steps do not belong here a second time.
 *
 * `title=""` suppresses the shell's `<h1>`; the thesis line below the hero is this page's real
 * heading.
 */

export function HomePage() {
  return (
    <AppShell title="" className="home">
      <img
        className="home-hero"
        src="/images/logo.png"
        alt="Rocky Surf — a lighthouse on a moonlit rocky shore"
        width={800}
        height={600}
      />

      <h1>A Linux box for your coding agents, on a cloud you already own</h1>
      <p className="home-lede">
        Rocky Surf is an open-source personal productivity tool for software engineers. You run
        one process yourself. It creates a Linux box on your own cloud account, installs the
        coding agents you actually use, clones the GitHub repos you name, and hands you an SSH
        command. One admin password, no accounts, no telemetry, nothing hosted.
      </p>
      <p className="home-lede">
        Coding agents want a real machine, and a laptop is a bad one. Close the lid and the agent
        dies. Leave it running and it shares your files, your SSH keys, and the rest of the apps
        on that computer. Setting the same thing up by hand in a cloud console is a pile of IAM,
        images, keys, and install scripts. Hosted agent clouds take that work off your plate by
        taking the other side of the relationship: they run the boxes, they see the spend, and
        they sit on the path to your keys and code.
      </p>
      <p className="home-lede">
        Rocky Surf keeps the isolation without the middleman. The agents get a machine that is
        not the one you use for everything else. You keep the cloud account, the licenses, and
        the repos.
      </p>

      <section className="home-section">
        <h2>Bring your own cloud, keys and repos</h2>
        <ul className="home-claims">
          <li>
            <strong>BYOC — bring your own cloud.</strong> Your AWS account, your Hetzner project,
            Azure, GCP, or a machine you already own. Rocky Surf holds the credential and calls the
            API. The resources and the bill are yours.
          </li>
          <li>
            <strong>BYOK — bring your own keys.</strong> Your Claude Code subscription, your Codex
            login, your API keys. Rocky Surf installs the agents; you sign them in.
          </li>
          <li>
            <strong>BYOR — bring your own repos.</strong> Your GitHub repositories, cloned onto the
            box during setup using a token you supply.
          </li>
        </ul>
        <p>
          Rocky Surf resells nothing and sits in the middle of nothing. It won&rsquo;t proxy your
          cloud spend, pool your API keys, or hold your code, and features that would need it to
          get refused.
        </p>
      </section>

      <section className="home-section">
        <h2>Creating a server</h2>
        <p>
          You pick a cloud you already pay for — AWS, GCP, Azure, or Hetzner. You pick a{' '}
          <strong>Surge Pack</strong>, which is a YAML file that names the tools to install:
          Claude Code, Codex, Amp, OpenCode, or whichever harness you actually run. You paste the
          GitHub repo you want on the box, public or private. Create.
        </p>
        <p>
          Rocky Surf calls your cloud, boots the machine, runs the pack, clones the repo, and puts
          an SSH command on the screen. You do not open the cloud console for any of that.
        </p>
        <p>
          The dashboard is every box you have, across every cloud you configured, in one list.
          Create, stop, start, and terminate from there. Stop a box overnight and the disk stays:
          the repo, the branches, and the shell history are waiting in the morning. A stopped box
          costs storage, not compute.
        </p>
      </section>

      <section className="home-section">
        <h2>A pack of your own</h2>
        <p>
          When a new coding harness shows up — the one from this morning&rsquo;s Hacker News
          thread — you do not wait for Rocky Surf to ship it. A Surge Pack is one YAML file. The{' '}
          <a
            href={repoDocUrl('.claude/skills/create-surge-pack/SKILL.md')}
            target="_blank"
            rel="noreferrer"
          >
            create-surge-pack
          </a>{' '}
          skill in this repository writes that file with you: the tools, the install scripts, the
          sign-in guide. You try it on a box of your own. If it works and other people might want
          it, you send it to the{' '}
          <a href={SHOP_URL} target="_blank" rel="noreferrer">
            Rocky Surf Shop
          </a>
          .
        </p>
        <p>
          Official packs live in this project and ship with a release. A pack you wrote does not
          have to wait on one. A new cloud is the same idea in the other direction: a provider
          package against a frozen SDK, not a change to the control plane. You wire providers in
          a config file and compose packs in YAML. The contracts are in{' '}
          <a href={repoDocUrl('docs/writing-a-pack.md')} target="_blank" rel="noreferrer">
            writing a pack
          </a>{' '}
          and{' '}
          <a href={repoDocUrl('docs/writing-a-provider.md')} target="_blank" rel="noreferrer">
            writing a provider
          </a>
          .
        </p>
      </section>

      <section className="home-section">
        <h2>Room to work</h2>
        <p>
          Agentic engineering needs room. Room off the laptop, so an agent can keep working after
          you close the lid, and so it is not sitting in the same filesystem as your mail and
          your passwords. Room to change harnesses, because a pack is a file, not a platform you
          are locked into. Room for the agents to actually build, on a machine that is theirs.
          And room for you to try the next one without rebuilding your setup around it.
        </p>
        <p>
          Install, backup, spend caps, and the rest of the operator detail live on the{' '}
          <Link to="/help">Help page</Link> and in the README.
        </p>
      </section>

      <p className="home-links">
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        <Link to="/help">Help</Link>
        <Link to="/servers/new">Create a server</Link>
      </p>
    </AppShell>
  )
}
