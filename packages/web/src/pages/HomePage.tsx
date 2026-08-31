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

      <h1>It's time for coding agents to move off your laptop</h1>
      <p className="home-lede">
        Coding agents want a computer, and your laptop ain't it. Your agents have
        no business being on the same machine as your email, your poorly secured 
        API keys, and your banking app. Not to mention all the times you killed
        your agent by closing the lid. No, your agents need a place to call home.
      </p>        
      <p className="home-lede">        
        Zillion dollar companies want to lock you into their platforms by making
        it easy to run things in their cloud. But that traps you in their platform,
        and you can't try all of the other amazing tools out there.
      </p>
      <p className="home-lede">        
        You could set up servers in your own cloud, but that's a pain. There's config, permissions, 
        key management, IaC, and other details that have nothing to do with the software
        you're trying to build. And what if you want to take advantage of cheaper rates on a different cloud?
        You'd have to tear everything down and start over. 
      </p>
      <p className="home-lede">        
        No thanks.
      </p>      
      <p className="home-lede">
        Rocky Surf is an open-source personal productivity tool for software engineers. 
        It gives you a lightweight management plane for Linux VMs running on your own cloud accounts, 
        pre-installed with coding tools and GitHub repos of your choice. Rocky Surf runs on your 
        computer and stores all data locally. No accounts, no telemetry, no SaaS. The only costs 
        are the ones from your cloud and coding agents.
      </p>

      <section className="home-section">
        <h2>Bring your own cloud, keys and repos</h2>
        <ul className="home-claims">
          <li>
            <strong>BYOC — bring your own cloud.</strong> Your AWS account, your Hetzner project,
            Azure, or GCP. Once logged in to your clouds, Rocky Surf calls their APIs on your behalf.
            Credentials don't leave your computer.
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
          Pick a cloud you already have an account with — AWS, GCP, Azure, or Hetzner. You pick a{' '}
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
