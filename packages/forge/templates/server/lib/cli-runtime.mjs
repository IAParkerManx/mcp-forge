// CLI runtime for generated servers: turns tool arguments into an argv array
// and runs the command directly, never through a shell. Values that start with
// "-" are refused so an argument cannot smuggle in an extra option.
import { spawn } from "node:child_process";

const MAX_OUTPUT = 10 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

function checkValue(name, value) {
  if (typeof value === "string" && value.startsWith("-")) {
    throw new Error(`Argument "${name}" may not start with "-".`);
  }
  if (value !== null && typeof value === "object") throw new Error(`Argument "${name}" must be a plain value.`);
  return String(value);
}

export function buildArgv(binding, args) {
  if (binding.argv_template) {
    // An exact argv: literals stay as they are, {arg} placeholders take one value each.
    return binding.argv_template.map((token) => {
      const m = /^\{([a-z_][a-z0-9_]*)\}$/.exec(token);
      if (!m) return token;
      const value = args[m[1]];
      if (value === undefined || value === null) throw new Error(`Missing argument "${m[1]}".`);
      return checkValue(m[1], value);
    });
  }
  const argv = [...binding.subcommand, ...binding.fixed_args];
  const positionals = [];
  for (const spec of binding.options) {
    const value = args[spec.name];
    if (value === undefined || value === null || value === false) continue;
    const values = spec.repeatable ? (Array.isArray(value) ? value : [value]) : [value];
    if (spec.positional !== undefined) {
      positionals.push([spec.positional, values.map((v) => checkValue(spec.name, v))]);
    } else if (!spec.takes_value) {
      if (value === true) argv.push(spec.flag);
    } else {
      for (const v of values) argv.push(spec.flag, checkValue(spec.name, v));
    }
  }
  for (const [, values] of positionals.sort((a, b) => a[0] - b[0])) argv.push(...values);
  return argv;
}

export function createCliRuntime(manifest, env) {
  const { server } = manifest;
  const command = (server.command_env && env[server.command_env]) || server.default_command;
  if (!command) throw new Error(`Set ${server.command_env ?? "the command"} to the executable to run.`);
  const cwd = (server.cwd_env && env[server.cwd_env]) || process.cwd();

  return {
    invoke(op, args) {
      const argv = buildArgv(op.binding, args);
      // Node scripts run through Node itself, so they work without a shebang (Windows) or an exec bit.
      const script = /\.(m|c)?js$/i.test(command);
      return new Promise((resolve, reject) => {
        const child = spawn(script ? process.execPath : command, script ? [command, ...argv] : argv, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let size = 0;
        const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
        const take = (chunk, into) => {
          size += chunk.length;
          if (size > MAX_OUTPUT) child.kill("SIGTERM");
          return into + chunk.toString("utf8");
        };
        child.stdout.on("data", (c) => (stdout = take(c, stdout)));
        child.stderr.on("data", (c) => (stderr = take(c, stderr)));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(new Error(`Could not run ${command}: ${e.message}`));
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ exit_code: code ?? -1, signal, stdout, stderr });
        });
      });
    },
  };
}
