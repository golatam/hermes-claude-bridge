import { readFileSync } from 'node:fs';

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

  const topicToProject = new Map();
  for (const project of raw.projects) {
    if (topicToProject.has(project.topicId)) {
      throw new Error(`Duplicate topicId in config: ${project.topicId}`);
    }
    topicToProject.set(project.topicId, project);
  }

  return {
    ...raw,
    telegram: { ...raw.telegram, botToken },
    topicToProject,
  };
}
