// PreToolUse guard for Bash/PowerShell. Reads the hook JSON on stdin; exit 2 blocks the call.
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    const j = JSON.parse(raw);
    cmd = String(j.tool_input?.command ?? "");
  } catch {
    process.exit(0);
  }
  const rules = [
    [/git\s+push\b[^\n]*(--force\b|--force-with-lease|\s-f\b)/i, "force-push is blocked; ask the owner"],
    [/gh\s+pr\s+merge\b[^\n]*--admin/i, "admin-bypass merge needs the owner's explicit OK naming the PRs"],
    [/(Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|reg(\.exe)?\s+(add|delete))[^\n]*(HKCU|HKEY_CURRENT_USER)/i, "never write HKCU from the agent shell (registry virtualization trap)"],
    [/(Set-ItemProperty|New-ItemProperty|reg(\.exe)?\s+add)[^\n]*(\\Run\b)/i, "do not write Run keys; the owner runs the restore command"],
    [/git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f/i, "destructive git command; confirm with the user first"],
  ];
  for (const [re, why] of rules) {
    if (re.test(cmd)) {
      process.stderr.write(`Blocked by project guard: ${why}\n`);
      process.exit(2);
    }
  }
  process.exit(0);
});
