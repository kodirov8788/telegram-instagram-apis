import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AIClassifierService } from '../ai-classifier';

describe('AIClassifierService (Fallback Rule Engine)', () => {
  const originalEnv = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.OPENAI_API_KEY = originalEnv;
    }
  });

  it('classifies price inquiry in Uzbek', async () => {
    const result = await AIClassifierService.classifyMessage('Mahsulot narxi qancha?');
    expect(result.language).toBe('uz');
    expect(result.intent).toBe('price_inquiry');
  });

  it('classifies availability in Russian', async () => {
    const result = await AIClassifierService.classifyMessage('Здравствуйте, есть в наличии?');
    expect(result.language).toBe('ru');
    expect(result.intent).toBe('availability_inquiry');
  });

  it('classifies human agent request in English', async () => {
    const result = await AIClassifierService.classifyMessage('Hello, I want to speak with a human operator');
    expect(result.language).toBe('en');
    expect(result.intent).toBe('human_agent_request');
  });

  it('classifies complaint and angry sentiment', async () => {
    const result = await AIClassifierService.classifyMessage('Xizmatdan judayam norozi man refund bering');
    expect(result.intent).toBe('complaint');
    expect(result.sentiment).toBe('angry');
  });
});
