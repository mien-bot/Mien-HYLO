#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const quick = args.has('--quick');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let failures = 0;
let warnings = 0;

function log(label, message) {
  console.log(`${label} ${message}`);
}

function pass(message) {
  log('[ok]', message);
}

function warn(message) {
  warnings += 1;
  log('[warn]', message);
}

function fail(message) {
  failures += 1;
  log('[fail]', message);
}

function quoteShellArg(value) {
  if (!/[ \t"&|<>^]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

function readJson(relativePath) {
  const path = join(root, relativePath);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${relativePath} is not readable JSON: ${error.message}`);
    return null;
  }
}

function requireFile(relativePath) {
  if (existsSync(join(root, relativePath))) {
    pass(`${relativePath} exists`);
  } else {
    fail(`${relativePath} is missing`);
  }
}

function requireScript(pkg, scriptName, packagePath) {
  if (pkg?.scripts?.[scriptName]) {
    pass(`${packagePath} defines script "${scriptName}"`);
  } else {
    fail(`${packagePath} is missing script "${scriptName}"`);
  }
}

function run(command, commandArgs, options = {}) {
  const useShell = process.platform === 'win32' && options.shell;
  const result = spawnSync(
    useShell ? [command, ...commandArgs].map(quoteShellArg).join(' ') : command,
    useShell ? [] : commandArgs,
    {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: useShell,
    },
  );

  if (result.error) {
    if (options.optionalStart) {
      warn(`${command} ${commandArgs.join(' ')} could not start: ${result.error.message}`);
      return null;
    }

    if (options.optional) {
      warn(`${command} ${commandArgs.join(' ')} could not start: ${result.error.message}`);
      return null;
    }

    fail(`${command} ${commandArgs.join(' ')} failed to start: ${result.error.message}`);
    return null;
  }

  if (result.status !== 0) {
    if (options.optional) {
      warn(`${command} ${commandArgs.join(' ')} exited with ${result.status}`);
      return null;
    }

    fail(`${command} ${commandArgs.join(' ')} exited with ${result.status}`);
    return null;
  }

  return result;
}

function checkPackageScripts() {
  const desktopPackage = readJson('package.json');
  const mobilePackage = readJson('mobile/package.json');
  const relayPackage = readJson('relay/package.json');

  for (const scriptName of ['dev', 'build', 'package', 'health', 'health:quick']) {
    requireScript(desktopPackage, scriptName, 'package.json');
  }

  for (const scriptName of ['start', 'ios', 'android', 'web']) {
    requireScript(mobilePackage, scriptName, 'mobile/package.json');
  }

  for (const scriptName of ['start', 'dev', 'tunnel']) {
    requireScript(relayPackage, scriptName, 'relay/package.json');
  }
}

function checkRequiredFiles() {
  const files = [
    'README.md',
    'SETUP.md',
    'CLAUDE.md',
    'AGENTS.md',
    'docs/ai-workflow.md',
    'DATA-SYNC.md',
    'HOW-IT-WORKS.md',
    'src/main/ipc/index.ts',
    'src/main/preload.ts',
    'src/main/db/database.ts',
    'src/main/lib/store.ts',
    'relay/server.js',
    'mobile/App.tsx',
  ];

  for (const file of files) {
    requireFile(file);
  }
}

function checkSecretTracking() {
  const secretPaths = [
    'relay/relay.key',
    'relay/strava-config.json',
    'relay/strava-tokens.json',
    'relay/strava-activity-details.json',
    'relay/strava-streams.json',
    'relay/.env',
    'relay/tunnel-url.txt',
    'mien.db',
  ];

  const result = run('git', ['ls-files', '--', ...secretPaths], { capture: true, optional: true });
  if (!result) {
    warn('Could not verify tracked secret/runtime files because git ls-files failed');
    return;
  }

  const tracked = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (tracked.length === 0) {
    pass('known secret/runtime files are not tracked');
  } else {
    fail(`secret/runtime files are tracked: ${tracked.join(', ')}`);
  }

  const trackedFilesResult = run('git', ['ls-files', '-z'], { capture: true, optional: true });
  if (!trackedFilesResult) {
    warn('Could not scan tracked files for credential patterns');
    return;
  }

  const trackedFiles = trackedFilesResult.stdout.split('\0').filter(Boolean);
  const suspiciousPaths = trackedFiles.filter((file) => {
    if (file === '.env.example' || file === 'mobile/.env') return false;
    return /(^|\/)(\.env($|\.)|[^/]+\.(?:db|sqlite3?|pem|p12|pfx|key))$/i.test(file);
  });
  if (suspiciousPaths.length > 0) {
    fail(`potential secret/runtime files are tracked: ${suspiciousPaths.join(', ')}`);
  } else {
    pass('no unexpected credential or database files are tracked');
  }

  const credentialPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bsk-ant-(?!your-|example|placeholder)[A-Za-z0-9_-]{16,}\b/i,
    /\bghp_[A-Za-z0-9]{20,}\b/,
    /\bntn_[A-Za-z0-9_-]{16,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}\b/,
    /C:\\Users\\(?!<you>|you\\|Public\\)[^\\\r\n]+/i,
    /\/Users\/(?!<you>|you\/)[^/\s]+/i,
    /\b[A-Z0-9._%+-]+@(?:gmail|icloud|outlook|protonmail)\.com\b/i,
    /https:\/\/(?![a-z0-9-]*(?:example|xxx|random|abc-xyz|shy-cloud))[a-z0-9-]+\.trycloudflare\.com\b/i,
  ];
  const matchedFiles = [];
  for (const file of trackedFiles) {
    try {
      const content = readFileSync(join(root, file), 'utf8');
      if (credentialPatterns.some((pattern) => pattern.test(content))) matchedFiles.push(file);
    } catch {
      // Binary and platform-specific files are covered by the path denylist.
    }
  }
  if (matchedFiles.length > 0) {
    fail(`tracked files contain credential or private-environment values: ${matchedFiles.join(', ')}`);
  } else {
    pass('tracked text files contain no high-confidence credential or private-environment patterns');
  }
}

function checkVersionConsistency() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  let versionFile = null;
  try {
    versionFile = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  } catch (error) {
    fail(`VERSION is not readable: ${error.message}`);
  }

  const versions = [pkg?.version, lock?.version, lock?.packages?.['']?.version, versionFile];
  if (versions.every((version) => version && version === versions[0])) {
    pass(`desktop version metadata is consistent (${versions[0]})`);
  } else {
    fail(`desktop version metadata differs: ${versions.map((value) => value || '<missing>').join(', ')}`);
  }
}

function checkWorktree() {
  const result = run('git', ['status', '--short'], { capture: true, optional: true });
  if (!result) {
    warn('Could not read git status');
    return;
  }

  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    pass('worktree is clean');
  } else {
    warn(`worktree has ${lines.length} changed file(s); keep commits scoped`);
  }
}

function runBuildGate() {
  if (quick) {
    pass('build gate skipped in --quick mode');
    return;
  }

  const failureCountBeforeBuild = failures;
  const result = run(npm, ['run', 'build'], { optionalStart: true, shell: true });
  if (!result && failures === failureCountBeforeBuild) {
    warn('Build gate could not run from the health script; run npm run build directly');
  }
}

console.log('Mien health check');
console.log(quick ? 'Mode: quick' : 'Mode: full');

checkPackageScripts();
checkRequiredFiles();
checkSecretTracking();
checkVersionConsistency();
checkWorktree();
runBuildGate();

if (failures > 0) {
  console.log(`\nHealth check failed: ${failures} failure(s), ${warnings} warning(s).`);
  process.exit(1);
}

console.log(`\nHealth check passed: ${warnings} warning(s).`);
