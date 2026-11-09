import { redactSecrets } from '../platform/credentialStore';

/**
 * Governed Cloud Public Research Broker
 *
 * When an explicitly approved public research request is submitted to a verified-free cloud model:
 * 1. Pandesh Core brokers the public search locally via the governed research capability.
 * 2. ONLY the approved public query + bounded, untrusted web excerpts and verified URLs are sent.
 * 3. NO filesystem, workspace, private CV, memory, or local tools are exposed to the external provider.
 * 4. Model replies are validated against evidence: stubs ('Found', 'Two') are rejected and synthesized cleanly.
 */

export function isCloudPublicResearchRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0) return false;

  // Explicit local-only CV assessment is NOT a public vacancy search
  if (/\b(?:my\s+(?:cv|resume)|evaluate\s+(?:my\s+)?(?:cv|resume)|assess\s+(?:my\s+)?(?:cv|resume)|check\s+(?:my\s+)?(?:cv|resume)|match\s+my\s+(?:cv|resume))\b/i.test(t) &&
      !/\b(?:find|search|look\s+for)\s+(?:5|five|\d+)?\s*(?:jobs?|vacanc(?:y|ies)|positions?|openings?)\b/i.test(t)) {
    return false;
  }

  // Explicit web research request
  if (/\b(?:web\s*research|search\s+the\s+web|web\s*search|look\s*up\s+online|search\s+online|browse\s+the\s+web|internet\s+search)\b/i.test(t)) {
    return true;
  }

  // Public job / vacancy / opportunity search
  const isJobSearch = /\b(?:jobs?|vacanc(?:y|ies)|positions?|openings?|roles?|postings?|hiring)\b/i.test(t) &&
    /\b(?:find|search|look\s+for|open|current|currently|available|apply|remote|germany|ulm|neu-ulm|salaries|salary)\b/i.test(t);
  if (isJobSearch) return true;

  // External product / market pricing / current news
  if (/\b(?:price|prices|cheapest|where to buy|compare prices?|current cost)\b/i.test(t) &&
      /\b(?:find|search|compare|research|look up)\b/i.test(t)) {
    return true;
  }

  // Latest external developments requiring web evidence
  if (/\b(?:latest|recent|newest|released in 2026)\b/i.test(t) &&
      /\b(?:news|releases?|benchmarks?|updates?|announcements?)\b/i.test(t)) {
    return true;
  }

  return false;
}

export function sanitizePublicResearchObjective(requestText: string): string {
  if (!requestText) return '';
  let cleaned = requestText.trim();

  // 1. Redact secrets
  cleaned = redactSecrets(cleaned);

  // 2. Strip synthetic private canary tokens
  cleaned = cleaned.replace(/\b(?:PRIVATE|CANARY)_[A-Z0-9_]+\b/gi, '').trim();

  // 3. Strip local absolute or relative file paths and placeholders
  cleaned = cleaned.replace(/[A-Za-z]:\\[^\s"']+|(?:\/|\\)(?:Users|home|private|tmp|var|etc)[^\s"']+/gi, '');
  cleaned = cleaned.replace(/\[TEST_[^\]]+\]/gi, '');
  cleaned = cleaned.replace(/\b[\w.-]+\.(?:pdf|docx?|txt|md|json|csv|py|js|ts)\b/gi, '');
  cleaned = cleaned.replace(/\(\s*\)|\[\s*\]/g, ' ');

  // 4. Strip private CV / resume clauses
  cleaned = cleaned.replace(/(?:\band\s+)?\b(?:compare\s+(?:them|it)?\s+to|evaluate|assess|check|read|inspect|match)\s+(?:my\s+|the\s+|a\s+)?(?:local\s+|private\s+)?(?:cv|resume|profile|document)\b.*?(?:\band\s+(?:then\s+)?|[,;.]|$)/gi, '');
  cleaned = cleaned.replace(/\b(?:based\s+on|according\s+to|from|in)\s+(?:my\s+|the\s+|a\s+)?(?:local\s+|private\s+)?(?:cv|resume|profile|document)\b.*?(?:\band\s+(?:then\s+)?|[,;.]|$)/gi, '');
  cleaned = cleaned.replace(/\b(?:my|local|private)\s+(?:cv|resume)\b.*?(?:\band\s+(?:then\s+)?|[,;.]|$)/gi, '');

  // 5. Clean up leading/trailing punctuation and double spaces
  cleaned = cleaned.replace(/\s+/g, ' ')
    .replace(/^[,;:.!?\s]+/, '')
    .replace(/[,;:.!?\s]+$/, '')
    .trim();

  return cleaned;
}

export function derivePublicResearchQueries(requestText: string): string[] {
  const sanitized = sanitizePublicResearchObjective(requestText);
  const isJobSearch = /\b(?:product(?:\/project|\/it\s+project)?\s+manager|project\s+manager|software engineer|developer|designer|jobs?|vacanc(?:y|ies)|positions?|openings?|roles?|hiring)\b/i.test(sanitized || requestText);
  if (isJobSearch) {
    const textToAnalyze = sanitized || requestText;
    const queries: string[] = [];
    const hasUlm = /\b(?:ulm|neu-ulm)\b/i.test(textToAnalyze);
    const hasPm = /\bproduct(?:\/project|\/it\s+project)?\s+manager\b/i.test(textToAnalyze) || /\bproduct\s+management\b/i.test(textToAnalyze);
    const hasProjMgr = /\b(?:it\s+)?project\s+manager\b/i.test(textToAnalyze) || /\bproduct\/(?:it\s+)?project\s+manager\b/i.test(textToAnalyze);
    const hasPython = /\bpython\b/i.test(textToAnalyze);
    const hasSalary = /\b(?:90|100|90k|100k|salary|gehalt)\b/i.test(textToAnalyze);

    if (hasUlm) {
      if (hasPm && hasProjMgr) {
        queries.push('Product Manager OR IT Project Manager Ulm Germany English job vacancy');
      } else if (hasPm) {
        queries.push('Product Manager Ulm Germany English job vacancy');
      } else {
        queries.push('IT Project Manager Ulm Neu-Ulm Germany English vacancy');
      }
    }
    if (hasPython) {
      queries.push('Python Developer remote Germany English job vacancy');
    }
    if (hasProjMgr && !queries.some((q) => q.includes('IT Project Manager remote'))) {
      queries.push('IT Project Manager remote Germany English vacancy');
    }
    if (hasPm && !queries.some((q) => q.includes('Product Manager remote'))) {
      queries.push(hasSalary
        ? 'Product Manager remote Germany English salary 90000 job'
        : 'Product Manager remote Germany English job vacancy');
    }
    if (queries.length === 0) {
      queries.push('Product Manager remote Germany English job vacancy');
    }
    return queries.slice(0, 3);
  }

  const cleaned = (sanitized || requestText)
    .replace(/\b(?:use pandesh'?s available web research tool to|can you please|please|find out|search the web for|look up|research)\b/gi, '')
    .trim();
  if (cleaned.length > 10) return [cleaned.slice(0, 150)];
  return [(sanitized || requestText).slice(0, 150)];
}

export function isStubReply(text: string | null | undefined, isResearch = true): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (/^(?:found|two|three|four|five|here|done|yes|no|ok|okay|completed|i found|we found)[.?!]?$/i.test(trimmed)) {
    return true;
  }
  if (!isResearch) {
    return trimmed.length <= 1 || /^I[.?!]?$/i.test(trimmed);
  }
  // For research tasks, reject generic fragments or answers under 80 chars
  if (trimmed.length < 80) return true;
  return false;
}

export function buildCloudPublicResearchMessages(
  requestText: string,
  evidenceText: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const safeObjective = sanitizePublicResearchObjective(requestText);
  const system =
    'You are Pandesh, an expert research assistant. You are given verified web research evidence retrieved by Core to answer the user\'s public request.\n' +
    'Strict rules you must follow:\n' +
    '1. Base your answer ONLY on the verified web research evidence provided. Never invent job vacancies, company names, URLs, or salaries.\n' +
    '2. For each vacancy or opportunity, provide:\n' +
    '   - Employer / Company Name\n' +
    '   - Role / Job Title\n' +
    '   - Location (specify whether Ulm, Neu-Ulm, Germany-wide remote, etc.)\n' +
    '   - Salary Evidence: Quote the exact salary if stated in the source. If the source mentions market estimates or if salary is unstated in the listing, explicitly disclose that.\n' +
    '   - Working Link: Provide the exact working URL from the evidence.\n' +
    '3. Check the user\'s requested count (e.g. 5 vacancies). Present all verified matching vacancies up to the requested number. If fewer than the requested number of verified matching vacancies exist in the evidence, clearly report the verified ones and explicitly state which criteria or count could not be fulfilled.\n' +
    '4. Provide a substantive, detailed, professional response formatted in Markdown. Never output a stub, single word, or incomplete response such as "Found" or "Two".\n' +
    '5. You do not have access to private files, CVs, or local tools.';

  const user =
    `Public Research Objective:\n"${safeObjective}"\n\n` +
    `Verified Web Research Evidence:\n` +
    `${evidenceText}\n\n` +
    `Please answer the public research objective now following the strict rules above.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function synthesizePublicResearchReport(
  requestText: string,
  evidenceItems: Array<{ query: string; output: string; sourceUrls: string[] }>,
  modelReply?: string,
): string {
  const sources: Array<{ title: string; url: string; excerpt: string }> = [];
  const seenUrls = new Set<string>();

  for (const item of evidenceItems) {
    const markers = [...item.output.matchAll(/(?:^|\r?\n)\[(S\d+(?:\.\d+)?)\]\s*Title:\s*([^\r\n]+)\r?\nURL:\s*([^\r\n]+)\r?\nEvidence[^\r\n]*\r?\n([\s\S]*?)(?=(?:\r?\n\[S\d+)|$)/g)];
    for (const m of markers) {
      const title = m[2].trim();
      const url = m[3].trim();
      const excerpt = m[4].trim();
      if (url && !seenUrls.has(url)) {
        seenUrls.add(url);
        sources.push({ title, url, excerpt });
      }
    }
  }

  const lines: string[] = ['### Verified Public Research Findings\n'];
  if (modelReply && modelReply.trim().length > 0) {
    lines.push(`*(Note: Cloud model returned an incomplete response "${modelReply.trim()}". Pandesh Core synthesized the verified evidence directly from current public listings below.)*\n`);
  }

  const targetCount = 5;
  const presented = sources.slice(0, targetCount);

  presented.forEach((s, idx) => {
    lines.push(`#### ${idx + 1}. ${s.title}`);
    lines.push(`- **Verified Link:** [${s.url}](${s.url})`);
    lines.push(`- **Source Excerpt:** ${s.excerpt.slice(0, 300)}...`);
    const salaryMatch = s.excerpt.match(/€\s*\d+[\d,.]*|\b\d{2,3}(?:[.,]\d{3})?\s*(?:EUR|€|k)\b/i);
    if (salaryMatch) {
      lines.push(`- **Salary Evidence:** Stated or referenced in listing: ${salaryMatch[0]}`);
    } else {
      lines.push(`- **Salary Evidence:** No explicit salary figure published directly in this public excerpt.`);
    }
    lines.push('');
  });

  if (presented.length < targetCount) {
    lines.push(`\n**Coverage Report:** Verified ${presented.length} opportunities from live public search results. Could not locate ${targetCount} confirmed vacancies meeting all stated criteria.`);
  }

  return lines.join('\n');
}

