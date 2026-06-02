'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getAdapter } = require('../harness');
const pi = require('../harness/pi');
const kiro = require('../harness/kiro-cli');
const opencode = require('../harness/opencode');
const { composeInlineSkillPrompt, _resetCache } = require('../harness/inline-skill');

const CTX = {
  key: 'KAN-9',
  skillPath: '/agents/jira-triage',
  model: 'us.anthropic.claude-sonnet-4-6',
  prompt: 'Triage Jira issue KAN-9 using the jira-triage skill. Act on exactly this one ticket, then stop.',
};

// --- registry ----------------------------------------------------------------
test('registry resolves known harnesses', () => {
  assert.strictEqual(getAdapter('pi').adapter, pi);
  assert.strictEqual(getAdapter('kiro-cli').adapter, kiro);
});

test('registry defaults to pi when unset', () => {
  assert.strictEqual(getAdapter(undefined).name, 'pi');
  assert.strictEqual(getAdapter('').name, 'pi');
});

test('registry throws loudly on an unknown harness', () => {
  assert.throws(() => getAdapter('does-not-exist'), /unknown HARNESS/);
});

// --- pi adapter --------------------------------------------------------------
test('pi.buildCommand emits the streaming-JSON + skill argv', () => {
  const cmd = pi.buildCommand(CTX);
  assert.strictEqual(cmd.bin, 'pi');
  assert.deepStrictEqual(cmd.args, [
    '--mode', 'json',
    '--provider', 'amazon-bedrock',
    '--model', 'us.anthropic.claude-sonnet-4-6',
    '--skill', '/agents/jira-triage',
    CTX.prompt,
  ]);
  assert.ok(cmd.env === undefined, 'pi adds no env (IRSA supplies creds)');
});

test('pi.interpret flags a tool error and the terminal event', () => {
  const state = {};
  pi.interpret(JSON.stringify({ type: 'tool_execution_end', isError: true }), state);
  pi.interpret(JSON.stringify({ type: 'agent_end' }), state);
  assert.strictEqual(state.toolError, true);
  assert.strictEqual(state.agentEnded, true);
});

test('pi.interpret ignores partial/non-JSON lines without throwing', () => {
  const state = {};
  pi.interpret('{partial', state);
  pi.interpret('', state);
  assert.deepStrictEqual(state, {});
});

test('pi.finalize: clean stream + exit 0 is not an error; in-stream error sticks', () => {
  assert.deepStrictEqual(pi.finalize(0, {}), { toolError: false });
  assert.deepStrictEqual(pi.finalize(0, { toolError: true }), { toolError: true });
  assert.deepStrictEqual(pi.finalize(1, {}), { toolError: true });
});

// --- kiro-cli adapter --------------------------------------------------------
test('kiro.buildCommand emits headless + least-privilege trust + inlined prompt', () => {
  const cmd = kiro.buildCommand(CTX);
  assert.strictEqual(cmd.bin, 'kiro-cli');
  assert.strictEqual(cmd.args[0], 'chat');
  assert.ok(cmd.args.includes('--no-interactive'));
  assert.ok(cmd.args.some((a) => a.startsWith('--trust-tools=')), 'uses --trust-tools, not --trust-all-tools');
  assert.ok(!cmd.args.includes('--trust-all-tools'));
  // Last arg is the composed prompt (rubric inlined + scripts named + base prompt).
  const composed = cmd.args[cmd.args.length - 1];
  assert.match(composed, /jira\.sh/);
  assert.match(composed, /gitlab\.sh/);
  assert.match(composed, /KAN-9/);
});

test('kiro.finalize classifies purely on exit code', () => {
  assert.deepStrictEqual(kiro.finalize(0), { toolError: false });
  assert.deepStrictEqual(kiro.finalize(1), { toolError: true }); // generic failure
  assert.deepStrictEqual(kiro.finalize(3), { toolError: true }); // MCP startup failure
});

test('kiro exposes no interpret() (non-streaming harness)', () => {
  assert.strictEqual(typeof kiro.interpret, 'undefined');
});

// --- shared inline-skill helper (kiro + opencode) ----------------------------
test('inline-skill prompt inlines SKILL.md when present', () => {
  _resetCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# RUBRIC SENTINEL 12345');
  try {
    const p = composeInlineSkillPrompt(dir, 'BASE PROMPT SENTINEL');
    assert.match(p, /RUBRIC SENTINEL 12345/);
    assert.match(p, /BASE PROMPT SENTINEL/);
    assert.match(p, /jira\.sh/);
    assert.match(p, /gitlab\.sh/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    _resetCache();
  }
});

test('inline-skill prompt is still usable when SKILL.md is missing (fail soft)', () => {
  _resetCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-empty-'));
  try {
    const p = composeInlineSkillPrompt(dir, 'BASE');
    assert.match(p, /jira\.sh/);
    assert.match(p, /BASE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    _resetCache();
  }
});

// --- opencode adapter --------------------------------------------------------
test('opencode.buildCommand emits `run` + json format + inlined prompt', () => {
  const cmd = opencode.buildCommand(CTX);
  assert.strictEqual(cmd.bin, 'opencode');
  assert.strictEqual(cmd.args[0], 'run');
  const fmtIdx = cmd.args.indexOf('--format');
  assert.ok(fmtIdx !== -1, 'requests a format');
  assert.strictEqual(cmd.args[fmtIdx + 1], 'json');
  assert.ok(cmd.args.includes('--dangerously-skip-permissions'));
  // Last arg is the inlined-skill prompt.
  const composed = cmd.args[cmd.args.length - 1];
  assert.match(composed, /jira\.sh/);
  assert.match(composed, /KAN-9/);
});

test('opencode passes --model only for a provider/model id; omits it for a bare id', () => {
  // Bare model id (the pi/Bedrock default shape) → no --model (opencode needs a
  // provider prefix; let it fall through to its configured default).
  const bare = opencode.buildCommand({ ...CTX, model: 'us.anthropic.claude-sonnet-4-6' });
  assert.ok(!bare.args.includes('--model'));
  // provider/model shape → passed through.
  const qualified = opencode.buildCommand({ ...CTX, model: 'anthropic/claude-sonnet-4-6' });
  const i = qualified.args.indexOf('--model');
  assert.ok(i !== -1);
  assert.strictEqual(qualified.args[i + 1], 'anthropic/claude-sonnet-4-6');
});

test('opencode.interpret flags a tool error from json events without throwing', () => {
  const state = {};
  // Unknown/partial lines are ignored.
  opencode.interpret('not json', state);
  opencode.interpret('', state);
  assert.deepStrictEqual(state, {});
  // A tool-error-shaped event sets toolError (best-effort across event shapes).
  opencode.interpret(JSON.stringify({ type: 'tool', state: { status: 'error' } }), state);
  assert.strictEqual(state.toolError, true);
});

test('opencode.finalize treats non-zero exit as error, with in-stream error sticky', () => {
  assert.deepStrictEqual(opencode.finalize(0, {}), { toolError: false });
  assert.deepStrictEqual(opencode.finalize(0, { toolError: true }), { toolError: true });
  assert.deepStrictEqual(opencode.finalize(1, {}), { toolError: true });
});
