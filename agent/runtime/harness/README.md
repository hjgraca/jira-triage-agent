# Harness adapters

The listener is **harness-agnostic**: it gates the webhook, then spawns a
one-shot headless coding-agent run to do the triage. Which agent it spawns —
[pi.dev](https://github.com/earendil-works/pi), [kiro-cli](https://kiro.dev),
or your own — is chosen at runtime by the **`HARNESS`** env var and implemented
by a small adapter in this directory.

```
index.js         registry: HARNESS env -> adapter (default "pi")
pi.js            pi.dev: streaming JSON, --skill, Bedrock via IRSA
kiro-cli.js      kiro-cli: --no-interactive, rubric inlined, KIRO_API_KEY backend
opencode.js      opencode: `opencode run --format json`, rubric inlined, provider creds
inline-skill.js  shared helper: inline SKILL.md into the prompt (kiro + opencode)
```

Everything else — the gate, dedupe, rate/spend limits, the watchdog, the
dedupe-evict-on-spawn-failure — lives in the listener and is identical across
harnesses. An adapter only answers "**how do I invoke this CLI, and how do I
read its result?**"

## The contract

Each adapter is a module exporting:

```js
module.exports = {
  // REQUIRED. Return how to spawn the harness for one issue.
  // ctx = { key, skillPath, model, prompt }
  buildCommand(ctx) {
    return { bin: 'my-agent', args: [/* ... */], env: { /* optional extra env */ } };
  },

  // OPTIONAL. Only for harnesses that stream parseable output (e.g. JSON
  // events). Called per stdout line; mutate `state` to accumulate signals.
  // Omit it entirely for harnesses that just print a final response.
  interpret(line, state) {
    /* e.g. if (JSON.parse(line).type === 'tool_error') state.toolError = true; */
  },

  // REQUIRED. Classify the finished run from its exit code + accumulated state.
  finalize(code, state) {
    return { toolError: code !== 0 };
  },
};
```

| Field | Meaning |
|---|---|
| `ctx.key` | the Jira issue key (e.g. `KAN-5`) |
| `ctx.skillPath` | absolute path to the baked skill dir (contains `SKILL.md` + `scripts/`) |
| `ctx.model` | the configured model id (`TRIAGE_MODEL`) — use it or ignore it |
| `ctx.prompt` | the base triage prompt (one ticket, then stop) |
| `cmd.env` | merged **onto** the inherited process env (which already has IRSA vars, `KIRO_API_KEY`, etc.) — return only additions |

### Two shapes of harness

- **Streaming** (pi): emits machine-readable events as it works. Implement
  `interpret()` to catch tool errors / terminal events mid-run; `finalize()`
  then trusts that accumulated state.
- **Non-streaming** (kiro-cli): prints only a final response. Omit `interpret()`
  and classify in `finalize()` from the **exit code** alone.

### Skill loading

- If your harness can load a skill/rules directory by path (pi's `--skill`),
  point it at `ctx.skillPath`.
- If it can't (kiro-cli, opencode), **inline the rubric** with the shared
  `inline-skill.js` helper: `composeInlineSkillPrompt(skillPath, basePrompt)`
  reads `SKILL.md` (cached), names the `scripts/jira.sh` / `scripts/gitlab.sh`
  tools, and appends the base prompt. Don't re-implement this per adapter.

### Boundary: this contract is subprocess-shaped

The contract assumes a harness you **spawn per ticket and that exits** — argv in,
stdout/exit-code out. That fits "CLI run" modes: `pi`, `kiro-cli`,
`opencode run`. It does **not** fit a harness that is *only* a long-lived HTTP
server (e.g. `opencode serve`, where you'd `POST /session` then
`POST /session/:id/message` against a daemon). A server-only harness has no
per-ticket process and no exit code, and a persistent daemon fights the
one-ephemeral-run-per-webhook security model (limiter slot, watchdog, egress
fence are all per-spawn).

If you must integrate a server-only harness, prefer its CLI "run" mode if it has
one (opencode does — `opencode run`, optionally `--attach`-ed to a warm `serve`
daemon, which keeps *this* contract intact). A true server client would be a
second adapter *kind* — a deliberate extension, not a drop-in — and should be
added as such rather than bent into `buildCommand`.

## Add your own harness

1. Create `my-harness.js` here implementing the contract above.
2. Register it in `index.js`:
   ```js
   const myHarness = require('./my-harness');
   const ADAPTERS = { pi, 'kiro-cli': kiroCli, 'my-harness': myHarness };
   ```
3. Add `agent/deploy/docker/my-harness.Dockerfile` that builds `FROM ${BASE}` and
   installs your CLI (copy `kiro.Dockerfile` as a template — install as root,
   relocate onto `/usr/local/bin`, drop back to `USER triage`).
4. Set `HARNESS=my-harness` in `agent/deploy/k8s/triage-listener.yaml`, plus any secret
   it needs (wire it as an env, `optional: true` if other harnesses don't use it).
5. Add unit tests in `agent/runtime/test/harness.test.js` (argv shape +
   `finalize` on representative exit codes).

The registry **throws on an unknown `HARNESS`**, so a typo fails fast at startup
rather than silently spawning nothing per webhook.

## Security note

`buildCommand` decides the trust posture of the spawned agent. Prefer
**least-privilege** tool grants over "trust everything" — e.g. kiro-cli uses
`--trust-tools=read,execute_bash`, not `--trust-all-tools`. The agent runs an
LLM over untrusted ticket text; don't hand it more tools than triage needs.
