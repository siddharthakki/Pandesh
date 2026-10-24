export function buildReviewPrompt(filePath: string, before: string, after: string): string {
  return `Review the following change to ${filePath}:

BEFORE:
\`\`\`
${before}
\`\`\`

AFTER:
\`\`\`
${after}
\`\`\`

Assess:
1. Correctness: Are there bugs introduced?
2. Completeness: Does this satisfy the original request?
3. Safety: Are there security issues?
4. Style: Does it match the surrounding code style?

Be concise.`;
}
