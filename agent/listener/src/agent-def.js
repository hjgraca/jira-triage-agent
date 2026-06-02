'use strict';

// The AGENT DEFINITION is the skill itself: a SKILL.md with a YAML frontmatter
// header describing the agent, followed by the rubric body. This is what makes
// the listener generic — the skill (not the code) decides what the agent is and
// what prompt it runs. Swapping the skill dir (AGENT_PATH) yields a different
// agent with no code change.
//
// Frontmatter fields (all optional except name + prompt):
//   name           identifier, for logs
//   prompt         prompt template; {{var}} placeholders filled from trigger vars
//   loopMarker     sentinel the agent writes; the loop guard drops echoes of it
//   authorizedActors  comma list or YAML list of actor ids allowed to trigger
//   trustTools     harness tool-grant hint (e.g. "read,execute_bash")
//   model          override the model id for this agent
//
// We ship a DELIBERATELY MINIMAL YAML parser (zero deps, to keep the listener
// dependency-free): scalars, `|` block scalars, and simple inline `[a, b]` or
// `- item` lists. That's all an agent definition needs. It is NOT a general YAML
// engine — anything fancier should be added consciously, not assumed to work.

const fs = require('fs');
const path = require('path');

const cache = new Map(); // skillPath -> parsed definition

/**
 * Split a SKILL.md into { frontmatter (raw yaml string|null), body }.
 * Frontmatter is a leading `---\n ... \n---` block.
 */
function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { yaml: null, body: text };
  // Find the closing fence on its own line.
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { yaml: null, body: text };
  return { yaml: m[1], body: m[2] };
}

/**
 * Minimal YAML-frontmatter parser. Handles top-level `key: value`, `key: |`
 * block scalars, inline flow lists `[a, b]`, and block lists (`- item`). Returns
 * a flat object. Intentionally small — see the module note.
 */
function parseFrontmatter(yaml) {
  const out = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      i += 1;
      continue;
    }
    const key = kv[1];
    let rest = kv[2];

    // Block scalar: `key: |` (literal) — gather more-indented following lines.
    if (rest === '|' || rest === '|-' || rest === '>') {
      const block = [];
      i += 1;
      // Determine indent from the first non-empty block line.
      let indent = null;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          block.push('');
          i += 1;
          continue;
        }
        const lead = l.match(/^(\s+)/);
        if (!lead) break; // dedented to column 0 → block ended
        if (indent === null) indent = lead[1].length;
        if (l.length - l.trimStart().length < indent) break;
        block.push(l.slice(indent));
        i += 1;
      }
      // Trim a single trailing empty line (common with `|`).
      while (block.length && block[block.length - 1] === '') block.pop();
      out[key] = block.join(rest === '>' ? ' ' : '\n');
      continue;
    }

    // Block list: `key:` then following `- item` lines.
    if (rest === '') {
      const peek = lines[i + 1] || '';
      if (/^\s*-\s+/.test(peek)) {
        const list = [];
        i += 1;
        while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
          list.push(stripQuotes(lines[i].replace(/^\s*-\s+/, '').trim()));
          i += 1;
        }
        out[key] = list;
        continue;
      }
      out[key] = '';
      i += 1;
      continue;
    }

    // Inline flow list: `key: [a, b, c]`
    if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = rest
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length);
      i += 1;
      continue;
    }

    out[key] = stripQuotes(rest);
    i += 1;
  }
  return out;
}

function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Load + parse the agent definition from <skillPath>/SKILL.md. Cached per path.
 * Returns { name, prompt, loopMarker, authorizedActors:Set, trustTools, model,
 *           body }. Throws if SKILL.md is missing or has no prompt — a generic
 * runner with no prompt is a misconfiguration we want to fail fast on.
 */
function loadAgentDef(skillPath) {
  if (cache.has(skillPath)) return cache.get(skillPath);
  const file = path.join(skillPath, 'SKILL.md');
  const text = fs.readFileSync(file, 'utf8');
  const { yaml, body } = splitFrontmatter(text);
  const fm = yaml ? parseFrontmatter(yaml) : {};

  if (!fm.prompt) {
    throw new Error(
      `agent definition at ${file} has no \`prompt\` in its frontmatter. ` +
        `The skill must declare the prompt that drives the agent.`
    );
  }

  const actors = Array.isArray(fm.authorizedActors)
    ? fm.authorizedActors
    : String(fm.authorizedActors || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

  const def = {
    name: fm.name || path.basename(skillPath),
    prompt: fm.prompt,
    loopMarker: fm.loopMarker || '',
    authorizedActors: new Set(actors),
    trustTools: fm.trustTools || '',
    model: fm.model || '',
    body, // rubric prose after the frontmatter (inlined by skill-less harnesses)
  };
  cache.set(skillPath, def);
  return def;
}

/**
 * Render a prompt template, substituting {{var}} from `vars`. Unknown
 * placeholders are left intact (so a typo is visible, not silently blanked).
 */
function renderPrompt(template, vars) {
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
  );
}

function _resetCache() {
  cache.clear();
}

module.exports = { loadAgentDef, renderPrompt, splitFrontmatter, parseFrontmatter, _resetCache };
