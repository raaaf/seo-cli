import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export async function complete({ system, prompt, model = 'claude-sonnet-4-6', maxTokens = 4096, json = false }) {
  const messages = [{ role: 'user', content: prompt }];

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
      });

      const text = res.content[0].text.trim();

      if (json) {
        const match = text.match(/```json\s*([\s\S]+?)\s*```/) || text.match(/(\{[\s\S]+\})/);
        if (!match) throw new Error(`Claude returned no JSON:\n${text.slice(0, 300)}`);
        try {
          return JSON.parse(match[1]);
        } catch (parseErr) {
          throw new Error(`Claude returned malformed JSON: ${parseErr.message}\n${match[1].slice(0, 300)}`);
        }
      }

      return text;
    } catch (e) {
      const retryable = e.status === 529 || e.status === 503 || e.status === 502;
      if (!retryable || attempt === 4) throw e;
      const wait = attempt * 15000;
      console.log(chalk.yellow(`  Claude ${e.status} (overloaded) — retrying in ${wait / 1000}s...`));
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
