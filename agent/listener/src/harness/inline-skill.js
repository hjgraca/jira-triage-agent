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

// Cache SKILL.md per skillPath so we read it once, not per webhook.
const rubricCache = new Map();

function loadRubric(skillPath) {
  if (rubricCache.has(skillPath)) return rubricCache.get(skillPath);
  let rubric;
  try {
    rubric = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8');
  } catch {
    rubric = ''; // fail soft: the prompt still names the scripts to run
  }
  rubricCache.set(skillPath, rubric);
  return rubric;
}

/**
 * Build a self-contained prompt for a skill-less harness: the rubric text, the
 * scripts to use for all Jira/GitLab access, and the base triage prompt naming
 * the one issue to act on.
 */
function composeInlineSkillPrompt(skillPath, basePrompt) {
  const rubric = loadRubric(skillPath);
  const scripts = path.join(skillPath, 'scripts');
  return [
    'You are running the jira-triage skill headlessly. Follow the rubric below',
    'exactly. Use ONLY these bundled scripts for all Jira/GitLab access (run them',
    `via the shell): ${scripts}/jira.sh and ${scripts}/gitlab.sh. Do not call the`,
    'Jira or GitLab APIs directly — the scripts enforce auth and allowed-value',
    'bounds. When finished, stop.',
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
