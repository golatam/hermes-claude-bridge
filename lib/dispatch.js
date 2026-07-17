import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const STATUS_LINE = /^STATUS:\s*(done|question|error)\s*$/im;
const SUMMARY_BLOCK = /^SUMMARY:\s*([\s\S]*)$/im;

const GIT_WORKFLOW_INSTRUCTIONS = {
  pr: (baseBranch) =>
    `Git workflow: create a new branch off "${baseBranch}" for this work. Never commit, push, or merge directly to "${baseBranch}". When the change is ready, push the new branch and open a pull request with "gh pr create" targeting "${baseBranch}"; do not merge it yourself.`,
  direct: (baseBranch) =>
    `Git workflow: commit directly to "${baseBranch}" and push. No branch, no pull request — this project is configured for direct-push mode. Still use good commit hygiene (small, reviewed-by-you-before-pushing commits, clear messages).`,
};

// Wraps the raw task text with a strict end-of-turn protocol so the poll
// script can tell "finished" apart from "blocked on a question" without
// any structured-output support from the CLI itself. Also pins the git
// workflow: the tool allowlist (e.g. "Bash(git *)") permits pushing to any
// branch, so which branch is/isn't safe to push to has to be stated here
// explicitly, not assumed from the allowlist.
export function buildTaskPrompt(rawTaskText, baseBranch = 'main', attachmentPath = null, gitMode = 'pr') {
  const gitInstruction = (GIT_WORKFLOW_INSTRUCTIONS[gitMode] ?? GIT_WORKFLOW_INSTRUCTIONS.pr)(baseBranch);
  return [
    rawTaskText.trim(),
    '',
    ...(attachmentPath
      ? [`Attached file, read it first: ${attachmentPath}`, '']
      : []),
    '---',
    gitInstruction,
    '',
    'When you finish this turn (task complete, blocking question, or error), end your final message with exactly these two lines:',
    'STATUS: done|question|error',
    'SUMMARY: <one paragraph, plain text, no markdown>',
    'Use STATUS: question only if you cannot proceed without the user answering something specific — put that exact question in SUMMARY.',
  ].join('\n');
}

export function parseStatus(resultText = '') {
  const statusMatch = resultText.match(STATUS_LINE);
  const summaryMatch = resultText.match(SUMMARY_BLOCK);
  return {
    status: statusMatch ? statusMatch[1].toLowerCase() : 'done',
    summary: summaryMatch ? summaryMatch[1].trim() : resultText.trim(),
  };
}

export function newSessionId() {
  return randomUUID();
}

export function runClaudeTask({
  repoPath,
  prompt,
  sessionId,
  resume,
  claudeConfig,
  addDir = null,
  timeoutMs = 20 * 60 * 1000,
}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json'];

    if (resume) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    args.push('--permission-mode', claudeConfig.permissionMode);
    if (claudeConfig.allowedTools?.length) {
      args.push('--allowed-tools', ...claudeConfig.allowedTools);
    }
    if (claudeConfig.maxBudgetUsd) {
      args.push('--max-budget-usd', String(claudeConfig.maxBudgetUsd));
    }
    if (addDir) {
      args.push('--add-dir', addDir);
    }

    const proc = spawn('claude', args, {
      cwd: repoPath,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', reject);

    proc.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      let payload;
      try {
        const lastLine = stdout.trim().split('\n').pop();
        payload = JSON.parse(lastLine);
      } catch (err) {
        reject(
          new Error(
            `Failed to parse claude JSON output: ${err.message}\nRaw tail: ${stdout.slice(-2000)}`
          )
        );
        return;
      }

      const { status, summary } = parseStatus(payload.result ?? '');
      resolve({
        sessionId: payload.session_id ?? sessionId,
        status,
        summary,
        isError: Boolean(payload.is_error),
        costUsd: payload.total_cost_usd ?? null,
      });
    });
  });
}
