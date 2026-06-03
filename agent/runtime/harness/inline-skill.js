'use strict';

// Shared helper for harnesses that CANNOT load a skill directory by path (no
// `--skill` flag) — currently kiro-cli and opencode. They get the rubric inlined
// into the prompt instead, plus an instruction to run the bundled bash scripts
// as shell tools. pi does not use this (it loads the skill natively).
//
// Extracted so the inlining logic lives in one place: a third harness with the
// same constraint reuses it rather than copy-pasting the prompt assembly.

const fs = require('fs');
const path = require('path');
const { splitFrontmatter } = require('../lib/agent-def');

// Cache the rubric BODY per skillPath so we read it once, not per webhook. The
// body is SKILL.md with its YAML frontmatter stripped — the frontmatter is the
// machine-readable agent definition (name/prompt/...), not rubric prose, so we
// don't inline it into the model prompt.
const rubricCache = new Map();

function loadRubric(skillPath) {
  if (rubricCache.has(skillPath)) return rubricCache.get(skillPath);
  let rubric;
  try {
    const text = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8');
    rubric = splitFrontmatter(text).body;
  } catch {
    rubric = ''; // fail soft: the prompt still names the scripts to run
  }
  rubricCache.set(skillPath, rubric);
  return rubric;
}

// List the agent's bundled tool scripts (scripts/*.sh), if any. Agnostic: we
// don't know or care what they do — we just point the model at them.
function listScripts(skillPath) {
  const dir = path.join(skillPath, 'scripts');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sh'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Build a self-contained prompt for a skill-less harness (no `--skill` flag):
 * its rubric body, a generic instruction to use whatever bundled scripts the
 * skill ships as its tools, and the agent's own base prompt. Nothing here names
 * Jira/triage/pi — the rubric and scripts are the agent's, discovered from disk.
 */
function composeInlineSkillPrompt(skillPath, basePrompt) {
  const rubric = loadRubric(skillPath);
  const scripts = listScripts(skillPath);
  const toolLine = scripts.length
    ? `Use ONLY these bundled scripts as your tools (run them via the shell): ${scripts.join(', ')}. Prefer them over calling any API directly — they enforce the skill's auth and allowed-value bounds.`
    : 'Use the tools available to you as directed by the rubric.';
  return [
    'You are running a skill headlessly. Follow the rubric below exactly.',
    toolLine,
    'When finished, stop.',
    '',
    '----- BEGIN SKILL RUBRIC (SKILL.md) -----',
    rubric,
    '----- END SKILL RUBRIC -----',
    '',
    basePrompt,
  ].join('\n');
}

// Test seam: drop the cache so a test can swap SKILL.md between runs.
function _resetCache() {
  rubricCache.clear();
}

module.exports = { composeInlineSkillPrompt, _resetCache };
