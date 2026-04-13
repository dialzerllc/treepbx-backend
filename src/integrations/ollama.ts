import { logger } from '../lib/logger';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

export async function chat(model: string, messages: { role: string; content: string }[], options?: { temperature?: number }) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { temperature: options?.temperature ?? 0.7 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${await response.text()}`);
  }

  const result = await response.json() as { message: { content: string } };
  return result.message.content;
}

export async function summarize(transcript: string, model = 'llama3') {
  return chat(model, [
    { role: 'system', content: 'Summarize this call transcript in 2-3 sentences. Focus on the outcome and key points.' },
    { role: 'user', content: transcript },
  ], { temperature: 0.3 });
}

export async function generateEmbedding(text: string, model = 'nomic-embed-text') {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });

  if (!response.ok) throw new Error(`Ollama embed error: ${response.status}`);
  const result = await response.json() as { embeddings: number[][] };
  return result.embeddings[0];
}
