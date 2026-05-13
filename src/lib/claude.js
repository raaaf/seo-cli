import Anthropic from '@anthropic-ai/sdk';

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export async function complete({ system, prompt, model = 'claude-sonnet-4-6', maxTokens = 4096, json = false }) {
  const messages = [{ role: 'user', content: prompt }];

  const res = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    system: [
      {
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages,
  });

  const text = res.content[0].text.trim();

  if (json) {
    const match = text.match(/```json\s*([\s\S]+?)\s*```/) || text.match(/(\{[\s\S]+\})/);
    if (!match) throw new Error(`Claude returned no JSON:\n${text.slice(0, 300)}`);
    return JSON.parse(match[1]);
  }

  return text;
}
