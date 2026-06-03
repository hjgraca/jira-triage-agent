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

/**
 * Build a self-contained prompt for a skill-less harness: the rubric text, a
 * pointer to whatever scripts the skill bundles (agent-agnostic — discovered,
 * not hardcoded), and the base prompt naming the work to do.
 */
function composeInlineSkillPrompt(skillPath, basePrompt) {
  const rubric = loadRubric(skillPath);
  const scriptsDir = path.join(skillPath, 'scripts');
  let scriptLine = '';
  try {
    const scripts = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.sh')).sort();
    if (scripts.length) {
      scriptLine =
        `Use ONLY the bundled scripts in ${scriptsDir} for any external access ` +
        `(run them via the shell): ${scripts.join(', ')}. Do not call external ` +
        `APIs directly — the scripts enforce auth and allowed-value bounds.`;
    }
  } catch {
    /* no scripts dir — the rubric stands on its own */
  }
  return [
    'Follow the rubric below exactly. When finished, stop.',
    ...(scriptLine ? [scriptLine] : []),
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
