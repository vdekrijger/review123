// Token budget formula: budgetTokens = contextWindowTokens - maxOutputTokens - 2000 (prompt overhead)
// = 64_000 - 4_000 - 2_000 = 58_000
export const LLM_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  contextWindowTokens: 64_000,
  maxOutputTokens: 4_000,
}
