import { Link } from 'react-router'
import { AppShell } from '../components/AppShell'
import { GITHUB_URL } from '../lib/links'

/**
 * What Rocky Surf is and who it is for (rockysurf-n0zr.2, issue #16).
 *
 * One narrow column, read top to bottom: the illustration, the thesis, five claims, who it is
 * for, two links. Every sentence is a condensation of the README — which stays the normative
 * statement of all of it — and nothing here promises what the product does not do. The
 * non-goals sentence is on purpose: saying what this is NOT is the fastest way to tell a
 * stranger whether they are in the right place.
 *
 * `title=""` suppresses the shell's `<h1>`; the thesis line below the hero is this page's
 * real heading.
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
      <h1>Persistent dev boxes for coding agents.</h1>
      <p className="home-lede">
        Rocky Surf creates a real Linux server on your own cloud account, installs your agents&rsquo;
        tools before you first log in, and hands you an SSH command. Stop the box when you are done;
        start it tomorrow with everything still there. The control plane is one process you run
        yourself, with a SQLite file next to it.
      </p>

      <ul className="home-claims">
        <li>
          <strong>Persistent.</strong> Stop a box and its disk survives — your repo, your branches
          and your shell history are where you left them. Stopped boxes cost storage, not compute.
        </li>
        <li>
          <strong>Yours.</strong> Single admin, no accounts, no tenant, no telemetry, no hosted
          anything.
        </li>
        <li>
          <strong>Your cloud.</strong> Your AWS account, your Hetzner project, Azure, GCP, or a
          machine you already own. Rocky Surf holds the credential and calls the API; the resources
          and the bill are yours.
        </li>
        <li>
          <strong>Agents preloaded.</strong> A box is created from a Surge Pack, so Claude Code and
          friends are installed and ready before you first log in.
        </li>
        <li>
          <strong>Budget-capped.</strong> Server count, creates per hour and estimated monthly spend
          are enforced server-side — which is what makes it safe to hand an agent the MCP tools and
          let it create its own box.
        </li>
      </ul>

      <section className="home-audience">
        <h2>Who it&rsquo;s for</h2>
        <p>
          People who run coding agents and want them on a machine that outlives the session — not a
          container that dies with the tab, and not your laptop. It is deliberately small: one
          admin, no teams, no ephemeral sandboxes. If you want per-task throwaway compute that boots
          in a second, this is the wrong shape. If you want a box that lives for weeks on your own
          bill, it is exactly the shape.
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
