/**
 * The front door: what Rounds is, for somebody who has never seen it.
 *
 * Everything claimed here is checkable against the thing that does the work —
 * the rule counts come from chant's audit rules reference, and the tier split
 * is the one a round actually runs under. A landing page that oversells an
 * unattended tool is worse than one that undersells it: the whole product is
 * somebody deciding to trust it with commit access while they are not looking.
 *
 * It sells the outcome — pull requests you can merge — rather than the
 * machinery that produces them. Nobody buying Dependabot is told what it is
 * made of, and the word for what runs here is "Rounds".
 *
 * It is also half the length it used to be. Every claim survived the cut; what
 * went was the second and third sentence making each one again. A page about
 * a tool whose whole pitch is "it will not waste your attention" cannot spend
 * eight hundred words asking for it.
 *
 * The form itself is a page of its own (`SignIn`). Keeping it at the bottom of
 * this one meant the hero — the part everybody reads and most people only read
 * — had nothing to act on, and anybody who already knew what Rounds was had to
 * scroll the whole pitch to reach it. So the hero asks, and the foot asks
 * again for whoever needed the middle.
 */
import { SIGN_IN_ROUTE } from "./SignIn";

/** What chant audits, and how much of it. Counts from the audit rules reference. */
export const FAMILIES: Array<{ name: string; where: string; rules: number }> = [
  { name: "GitHub Actions", where: ".github/workflows/*.yml", rules: 45 },
  { name: "AWS CloudFormation", where: "*.template, *.yaml, *.json", rules: 50 },
  { name: "GitLab CI", where: ".gitlab-ci.yml", rules: 39 },
  { name: "Kubernetes", where: "manifests, Argo, Flux", rules: 31 },
  { name: "GCP Config Connector", where: "cnrm.cloud.google.com", rules: 26 },
  { name: "Azure ARM", where: "deployment templates", rules: 24 },
  { name: "Helm", where: "any chart directory", rules: 21 },
  { name: "Docker", where: "Dockerfile, compose", rules: 6 },
  { name: "Forgejo", where: ".forgejo/workflows", rules: 2 },
];

export const TOTAL = FAMILIES.reduce((n, f) => n + f.rules, 0);

/**
 * How those rules split by what Rounds will do with them.
 *
 * Kept as numbers rather than prose because they have to add up to TOTAL, and
 * a landing page whose arithmetic has quietly rotted is worse than one with no
 * numbers on it. A test pins the sum.
 */
export const TIERS = { mechanical: 6, judgment: 153, hygiene: 85 } as const;

export function Landing() {
  return (
    <div className="landing">
      <header className="lp-nav">
        <div className="wordmark">
          Rounds<span>.</span>
        </div>
        <nav className="lp-navlinks">
          <a href="#what">What it watches</a>
          <a href="#tiers">What it will open</a>
          <a href="https://github.com/managoat/rounds">Source</a>
        </nav>
      </header>

      <section className="lp-hero">
        <p className="lp-eyebrow">Unattended configuration maintenance</p>
        <h1>
          Dependabot watches your dependencies.<br />
          <b>Nothing watches your configuration.</b>
        </h1>
        <p className="lp-lede">
          Workflows, manifests, Dockerfiles, Helm charts and cloud templates drift the way dependencies do. Rounds
          audits them on a schedule, fixes what it can prove it fixed, and opens the pull request.
        </p>
        <div className="lp-herocta">
          <a className="buttonish" href={SIGN_IN_ROUTE}>
            Enroll a repository
          </a>
          <a className="linkish" href="#tiers">
            See what it opens
          </a>
        </div>
      </section>

      <section className="lp-section" id="what">
        <h2>What it watches</h2>
        <p className="lp-sub">
          {TOTAL} rules from OSSF Scorecard, GitHub's hardening guides and the cloud providers' security baselines.
        </p>
        <div className="lp-grid tight">
          {FAMILIES.map((f) => (
            <div className="lp-card" key={f.name}>
              <div className="lp-cardhead">
                <h3>{f.name}</h3>
                <span className="lp-count">{f.rules}</span>
              </div>
              <code className="lp-where">{f.where}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section" id="tiers">
        <h2>What it will actually open a pull request for</h2>
        <p className="lp-sub">We sort every finding into three tiers, and open pull requests for the ones that earn one.</p>

        <div className="lp-tiers">
          <div className="lp-tier">
            <div className="lp-tierhead">
              <span className="lp-pill ok">on by default</span>
              <span className="lp-tiern">{TIERS.mechanical} rules</span>
            </div>
            <h3>Mechanical</h3>
            <p>
              We produce the diff: pin an action to a SHA, an image to a digest, <code>write-all</code> to least
              privilege. The edit is known rather than judged, so it goes up exactly as generated.
            </p>
          </div>

          <div className="lp-tier">
            <div className="lp-tierhead">
              <span className="lp-pill ok">on by default</span>
              <span className="lp-tiern">{TIERS.judgment} rules</span>
            </div>
            <h3>Judgment calls</h3>
            <p>
              A container that may run as root. A <code>pull_request_target</code> checking out untrusted code. Hours
              of work each, <b>none of them yours</b>. You review the change instead of writing it.
            </p>
          </div>

          <div className="lp-tier off">
            <div className="lp-tierhead">
              <span className="lp-pill quiet">off unless you ask</span>
              <span className="lp-tiern">{TIERS.hygiene} rules</span>
            </div>
            <h3>Hygiene</h3>
            <p>
              Deprecations, style, missing timeouts: worth knowing, rarely worth interrupting you. They stay in the
              report unless a repository asks for them in its <code>.rounds.yml</code>.
            </p>
          </div>
        </div>
      </section>

      <section className="lp-section" id="policy">
        <h2>The repository sets its own terms</h2>
        <p className="lp-sub">
          A <code>.rounds.yml</code> in the root overrides all of it, read and enforced by the service.
        </p>
        <pre className="lp-code">
          <code>{`enabled: true              # false → nothing happens at all
tiers: [quick-win]         # quick-win, needs-review, report-only
ignore: [GHA021]           # rule ids never to propose
paths_ignore: ["examples/**"]
max_open_prs: 3`}</code>
        </pre>
      </section>

      <section className="lp-cta">
        <h2>Turn it on and forget it</h2>
        <p>Sign in, install the GitHub App where you want it, pick a cadence.</p>
        <a className="buttonish" href={SIGN_IN_ROUTE}>
          Enroll a repository
        </a>
      </section>

      <footer className="lp-foot">
        <p className="fineprint">
          The audit is <a href="https://intentius.io/chant/cli/audit/">chant</a>. The schedule and the computer are{" "}
          <a href="https://github.com/BinaryBourbon/fountain">Fountain</a>. The interactive version — point it at a
          repo, watch it work, take the patch — is <a href="https://github.com/managoat/mend">Mend</a>.{" "}
          <a href="https://github.com/managoat/rounds">Source</a>.
        </p>
      </footer>
    </div>
  );
}
