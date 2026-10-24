export function buildPlanningPrompt(userRequest: string): string {
  return `The user has requested: "${userRequest}"

Before implementing, produce a numbered plan:
1. List files you need to inspect first.
2. List files you will create or modify.
3. For each file, state the specific change needed.
4. List any commands you will need to run.
5. State any risks or things that require user approval.

Be specific. Do not say "I will update the file" — say which function/class/line you will change and why.`;
}
