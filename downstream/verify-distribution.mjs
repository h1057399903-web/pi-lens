import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const downstreamRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(downstreamRoot, "downstream", "compatibility.json"), "utf8"),
);
const source = "git:github.com/h1057399903-web/pi-lens";
const bootstrapSha = "ccf33b136d1fd46399ecddf9264531af03024d58";
const expectedStableSha = process.env.PI_EXPECTED_STABLE_SHA;
const piInstallRoot = resolve(
  process.env.PI_INSTALL_ROOT ?? join(process.cwd(), "..", "pi-plugin-workbench"),
);
const piCli = join(
  piInstallRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
const agentDir = mkdtempSync(join(tmpdir(), "pi-lens-distribution-"));
const cloneDir = join(
  agentDir,
  "git",
  "github.com",
  "h1057399903-web",
  "pi-lens",
);
const requiredCommands = manifest.requiredCommands;
const requiredTools = manifest.requiredTools;

if (!expectedStableSha) {
  throw new Error("PI_EXPECTED_STABLE_SHA must be the reviewed stable commit");
}

// pi-lens installs are heavier than the first downstream package's: the
// upstream `prepare` lifecycle builds the bundled extension entry
// (`dist/index.js`), downloads core tree-sitter grammars, and warms the
// loader cache, so every spawned `pi install` needs a longer budget than the
// 180 s the pi-web-access verifier uses.
const runTimeoutMs = 600_000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    },
    encoding: "utf8",
    timeout: runTimeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function pi(...args) {
  return run(process.execPath, [piCli, ...args]);
}

function head() {
  return run("git", ["-C", cloneDir, "rev-parse", "HEAD"]);
}

function assertIncludes(actual, requiredValues, label) {
  const missing = requiredValues.filter((value) => !actual.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label} missing: ${missing.join(", ")}`);
  }
}

async function assertInstalledSurface(id) {
  const output = run(
    process.execPath,
    [
      piCli,
      "--mode",
      "rpc",
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    ],
    { input: `${JSON.stringify({ type: "get_commands", id })}\n` },
  );
  const events = output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const response = events.find((event) => event.id === id);
  if (!response?.success) {
    throw new Error(`Installed package did not start successfully: ${output}`);
  }
  const commands = (response.data?.commands ?? response.data ?? []).map(
    (command) => (typeof command === "string" ? command : command.name),
  );
  assertIncludes(commands, requiredCommands, "Installed RPC commands");

  const sdk = await import(
    pathToFileURL(
      join(
        piInstallRoot,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "index.js",
      ),
    ).href
  );
  const settingsManager = sdk.SettingsManager.inMemory({});
  const loader = new sdk.DefaultResourceLoader({
    cwd: cloneDir,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [join(cloneDir, manifest.extension)],
  });
  await loader.reload();
  const result = await sdk.createAgentSession({
    cwd: cloneDir,
    agentDir,
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(cloneDir),
    settingsManager,
    noTools: "builtin",
  });
  try {
    if (result.extensionsResult.errors.length > 0) {
      throw new Error(
        `Installed extension load errors: ${JSON.stringify(result.extensionsResult.errors)}`,
      );
    }
    const tools = result.session.getAllTools().map((tool) => tool.name);
    const sdkCommands = result.extensionsResult.runtime
      .getCommands()
      .map((command) => command.name);
    assertIncludes(tools, requiredTools, "Installed SDK tools");
    assertIncludes(sdkCommands, requiredCommands, "Installed SDK commands");
  } finally {
    result.session.dispose();
  }
}

try {
  pi("install", source);
  if (head() !== expectedStableSha) {
    throw new Error(`Fresh install did not resolve stable: ${head()}`);
  }
  await assertInstalledSurface("fresh-stable");

  pi("update", "--extensions");
  if (head() !== expectedStableSha) {
    throw new Error(`Routine update moved away from stable: ${head()}`);
  }

  pi("install", `${source}@${bootstrapSha}`);
  if (head() !== bootstrapSha) {
    throw new Error(`Pinned rollback did not resolve bootstrap: ${head()}`);
  }

  pi("install", source);
  pi("update", "--extensions");
  if (head() !== expectedStableSha) {
    throw new Error(`Return to the moving stable lane failed: ${head()}`);
  }
  await assertInstalledSurface("returned-stable");

  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  const packages = settings.packages ?? [];
  const configuredSources = packages.map((entry) =>
    typeof entry === "string" ? entry : entry.source,
  );
  if (!configuredSources.includes(source)) {
    throw new Error(`Unqualified stable source not persisted: ${JSON.stringify(packages)}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      source,
      stable: expectedStableSha,
      rollback: bootstrapSha,
      tools: requiredTools,
      commands: requiredCommands,
      isolatedAgentDir: agentDir,
    }),
  );
} finally {
  if (process.env.PI_KEEP_DISPOSABLE_HOME !== "1") {
    rmSync(agentDir, { recursive: true, force: true });
  }
}
