import { spawn } from 'child_process';
import { accessSync, constants, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { MODELS } from './models.js';

// Subscription backend: one `claude -p` child process per call, authenticated
// by CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`). complete() in claude.js
// falls back to the API on every ClaudeCodeError.

export const CLAUDE_TIMEOUT_MS = 8 * 60 * 1000;

// kind: 'limit' | 'auth' | 'timeout' | 'error'. `family` ('opus' | 'sonnet')
// is set for a limit that only covers one model family.
export class ClaudeCodeError extends Error {
  constructor(message, { kind = 'error', family = null } = {}) {
    super(message);
    this.name = 'ClaudeCodeError';
    this.kind = kind;
    this.family = family;
  }
}

// A message that hit the max_tokens cap is not usable output, whether or not
// it happened to contain a text block: on 2026-09-23 adaptive thinking spent
// most or all of an 8000-token budget, leaving generate.js and improve.js
// truncated markdown or none at all. Fail loudly here instead of letting
// runBatch log "succeeded" or validate.js discover it downstream.
export function assertNotTruncated(res, maxTokens) {
  if (res.stop_reason === 'max_tokens') {
    throw new Error(`Claude hit stop_reason: max_tokens (limit ${maxTokens}, used ${res.usage?.output_tokens} output tokens)`);
  }
}

// A classifier decline is a normal HTTP 200 with stop_reason: "refusal", not
// an exception — surface it as one so callers don't treat empty/partial
// content as a successful generation.
export function assertNotRefused(res) {
  if (res.stop_reason === 'refusal') {
    const category = res.stop_details?.category ?? 'unknown';
    throw new Error(`Claude declined the request (stop_reason: refusal, category: ${category})`);
  }
}

export function claudeOnPath() {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => {
    try { accessSync(join(dir, 'claude'), constants.X_OK); return true; } catch { return false; }
  });
}

// Claude Code reports failures as text in `result`, with no structured codes.
function classify(text) {
  const family = text.match(/You've hit your (Opus|Sonnet) limit/i)?.[1]?.toLowerCase() ?? null;
  if (family) return { kind: 'limit', family };
  if (/You've hit your (session|weekly) limit|spend limit/i.test(text)) return { kind: 'limit', family: null };
  if (/OAuth|authenticat|Not logged in|Login expired|Invalid API key/i.test(text)) return { kind: 'auth', family: null };
  return { kind: 'error', family: null };
}

function buildArgs({ system, model, schema, webSearch, maxSearches }) {
  return [
    '-p', '--output-format', 'json', '--model', model, '--system-prompt', system,
    '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '',
    ...(webSearch
      ? ['--tools', 'WebSearch', '--allowedTools', 'WebSearch', '--max-turns', String(maxSearches + 2)]
      : ['--tools', '', '--max-turns', '2']),
    ...(model === MODELS.generate ? ['--effort', 'high'] : []),
    ...(schema ? ['--json-schema', JSON.stringify(schema)] : []),
  ];
}

function run(args, { prompt, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // Decode as a stream: a multi-byte character can be split across chunks.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ClaudeCodeError(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s`, { kind: 'timeout' }));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ClaudeCodeError(`claude -p could not start: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => { /* a dead child surfaces through close */ });
    child.stdin.end(prompt);
  });
}

export async function completeViaClaudeCode({
  system, prompt, model, maxTokens, schema = null, webSearch = false, maxSearches = 6, timeoutMs = CLAUDE_TIMEOUT_MS,
}) {
  const workDir = mkdtempSync(join(tmpdir(), 'seo-claude-'));
  try {
    // Allowlist, nothing inherited: ANTHROPIC_API_KEY would override the OAuth
    // token in -p mode, and the repo secrets have no business in the child.
    const env = {
      PATH: process.env.PATH,
      HOME: workDir,
      CLAUDE_CONFIG_DIR: workDir,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_AUTOUPDATER: '1',
    };
    const { code, stdout, stderr } = await run(
      buildArgs({ system, model, schema, webSearch, maxSearches }),
      { prompt, cwd: workDir, env, timeoutMs },
    );

    let out;
    try { out = JSON.parse(stdout); } catch { out = null; }

    if (!out || out.is_error || code !== 0) {
      const detail = (typeof out?.result === 'string' ? out.result : '') || stderr.trim() || stdout.slice(0, 300);
      const { kind, family } = classify(detail);
      const why = out?.subtype && out.subtype !== 'success' ? `${out.subtype}: ` : '';
      throw new ClaudeCodeError(`claude -p failed (exit ${code}): ${why}${detail.slice(0, 300)}`, { kind, family });
    }
    // Plain Errors, not ClaudeCodeError: the paid API would fail the same way,
    // so complete() must not fall back.
    assertNotTruncated(out, maxTokens);
    assertNotRefused(out);
    if (schema && out.structured_output == null) {
      throw new ClaudeCodeError('claude -p returned no structured_output for the schema');
    }
    return {
      text: (out.result ?? '').trim(),
      structured: out.structured_output ?? null,
      costUsd: out.total_cost_usd ?? 0,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
