import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { MODELS } from './models.js';

const MAX_RETRIES = 4;
const BASE_RETRY_MS = 5000;
const MAX_RETRY_MS = 60000;

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// Server-side web search. Runs on Anthropic's side, so a single request returns
// the searched-and-answered result: no client tool loop, only pause_turn resumes.
const WEB_SEARCH_TOOL = Object.freeze({ type: 'web_search_20260209', name: 'web_search' });
const MAX_PAUSE_RESUMES = 3;

export async function complete({
  system, prompt, model = MODELS.default, maxTokens = 4096, json = false,
  webSearch = false, maxSearches = 6,
}) {
  const messages = [{ role: 'user', content: prompt }];
  const tools = webSearch ? [{ ...WEB_SEARCH_TOOL, max_uses: maxSearches }] : undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let res = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
        ...(tools ? { tools } : {}),
      });

      // The server-side search loop caps out at 10 iterations and returns
      // stop_reason "pause_turn"; resending the assistant turn resumes it.
      for (let resume = 0; res.stop_reason === 'pause_turn' && resume < MAX_PAUSE_RESUMES; resume++) {
        res = await getClient().messages.create({
          model,
          max_tokens: maxTokens,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: [...messages, { role: 'assistant', content: res.content }],
          ...(tools ? { tools } : {}),
        });
      }

      // With web search the answer is the LAST text block: earlier ones narrate
      // the searches. Without tools there is only one.
      const textBlocks = res.content.filter((b) => b.type === 'text');
      const textBlock = textBlocks[textBlocks.length - 1];
      if (!textBlock) throw new Error(`Claude returned no text block (stop_reason: ${res.stop_reason})`);
      const text = textBlock.text.trim();

      if (json) {
        const match = text.match(/```json\s*([\s\S]+?)\s*```/) || text.match(/(\{[\s\S]+\})/);
        if (!match) throw new Error(`Claude returned no JSON:\n${text.slice(0, 300)}`);
        try {
          return JSON.parse(match[1]);
        } catch (parseErr) {
          throw new Error(`Claude returned malformed JSON: ${parseErr.message}\n${match[1].slice(0, 300)}`, { cause: parseErr });
        }
      }

      return text;
    } catch (e) {
      const retryable = e.status === 529 || e.status === 503 || e.status === 502;
      if (!retryable || attempt === MAX_RETRIES) throw e;
      const exp = Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
      const jitter = Math.floor(Math.random() * 1000);
      const wait = exp + jitter;
      console.log(chalk.yellow(`  Claude ${e.status} (overloaded) — retrying in ${(wait / 1000).toFixed(1)}s...`));
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
