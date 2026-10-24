const PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: 'aws_key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '[AWS_KEY_REDACTED]',
  },
  {
    name: 'aws_secret',
    pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
    replacement: '[AWS_SECRET_REDACTED]',
  },
  {
    name: 'github_token',
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    replacement: '[GITHUB_TOKEN_REDACTED]',
  },
  {
    name: 'private_key_block',
    pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    replacement: '[PRIVATE_KEY_REDACTED]',
  },
  {
    name: 'env_secret',
    pattern: /(?:SECRET|TOKEN|PASSWORD|API_KEY|APIKEY|AUTH_KEY|ACCESS_KEY)\s*=\s*["']?[^\s"']{8,}["']?/gi,
    replacement: '[SECRET_ENV_REDACTED]',
  },
];

export class SecretScanner {
  static redact(text: string): { text: string; found: string[] } {
    const found: string[] = [];
    let result = text;
    for (const { name, pattern, replacement } of PATTERNS) {
      const before = result;
      result = result.replace(pattern, replacement);
      if (result !== before) {
        found.push(name);
      }
    }
    return { text: result, found };
  }

  static hasSecrets(text: string): boolean {
    return PATTERNS.some(({ pattern }) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    });
  }
}
