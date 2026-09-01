import { app } from 'electron';
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ManagedSkillManifest = {
  version: 1;
  displayName: string;
  sourcePath: string;
  importedAt: string;
};
export const managedSkillsRoot = (): string => join(app.getPath('userData'), 'skills');
export const managedManifestName = '.seecoder-skill.json';

export async function readManagedManifest(directory: string): Promise<ManagedSkillManifest | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, managedManifestName), 'utf8')) as ManagedSkillManifest;
    return value.version === 1 && typeof value.displayName === 'string' && typeof value.sourcePath === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function validateSkillSource(inputPath: string): Promise<{ directory: string; skillPath: string; displayName: string }> {
  const skillPath = await realpath(inputPath);
  if (basename(skillPath).toLowerCase() !== 'skill.md' || !(await stat(skillPath)).isFile()) throw new Error('请选择名为 SKILL.md 的文件');
  const directory = dirname(skillPath);
  let files = 0;
  let bytes = 0;
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = join(current, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error('Skill 目录包含符号链接，无法安全导入');
      if (info.isDirectory()) {
        await visit(target);
        continue;
      }
      files += 1;
      bytes += info.size;
      if (files > 200 || bytes > 5 * 1024 * 1024) throw new Error('Skill 目录超过 200 个文件或 5 MiB 限制');
      if (/^(\.env|credentials?|secrets?)$/i.test(entry.name) || /\.(pem|key|p12)$/i.test(entry.name)) throw new Error(`Skill 目录包含敏感文件：${entry.name}`);
    }
  };
  await visit(directory);
  const content = await readFile(skillPath, 'utf8');
  if (!content.trim() || content.length > 100_000) throw new Error('SKILL.md 为空或超过 100,000 字符');
  return { directory, skillPath, displayName: basename(directory) };
}

export async function copyManagedSkill(source: { directory: string; displayName: string }, manifest?: ManagedSkillManifest): Promise<string> {
  const root = managedSkillsRoot();
  await mkdir(root, { recursive: true });
  const slug =
    source.displayName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'skill';
  const target = join(root, `${slug}-${randomUUID().slice(0, 8)}`);
  const temporary = `${target}.importing`;
  await cp(source.directory, temporary, { recursive: true, errorOnExist: true });
  await writeFile(
    join(temporary, managedManifestName),
    JSON.stringify(
      manifest ?? {
        version: 1,
        displayName: source.displayName,
        sourcePath: source.directory,
        importedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  await rename(temporary, target);
  return target;
}
