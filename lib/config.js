import { readFileSync } from 'node:fs';

const VALID_GIT_MODES = new Set(['pr', 'direct']);

export function loadConfig(configPath) {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));

  const botToken = process.env[raw.telegram.botTokenEnv];
  if (!botToken) {
    throw new Error(
      `Bot token env var "${raw.telegram.botTokenEnv}" is not set. ` +
        `Export it before running, e.g.: export ${raw.telegram.botTokenEnv}=123:abc`
    );
  }

  if (!Array.isArray(raw.projects) || raw.projects.length === 0) {
    throw new Error('config.projects must be a non-empty array');
  }

  if (raw.claude?.defaultGitMode && !VALID_GIT_MODES.has(raw.claude.defaultGitMode)) {
    throw new Error(`claude.defaultGitMode must be "pr" or "direct", got: ${raw.claude.defaultGitMode}`);
  }

  const topicToProject = new Map();
  for (const project of raw.projects) {
    if (topicToProject.has(project.topicId)) {
      throw new Error(`Duplicate topicId in config: ${project.topicId}`);
    }
    if (project.gitMode && !VALID_GIT_MODES.has(project.gitMode)) {
      throw new Error(`projects[topicId=${project.topicId}].gitMode must be "pr" or "direct", got: ${project.gitMode}`);
    }
    topicToProject.set(project.topicId, project);
  }

  return {
    ...raw,
    telegram: { ...raw.telegram, botToken },
    topicToProject,
  };
}
