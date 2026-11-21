// A Linux server over ssh: runs the repo's deploy/install.sh there (Docker, the app and Caddy for
// automatic HTTPS). install.sh takes its options as environment variables, not flags.
import { INSTALL_SH_URL } from "../constants.js";
import { CommandError, shellQuote } from "../exec.js";
import { isValidHost, normalizeDomain } from "../args.js";

/** @typedef {import("../types.js").Provider} Provider */

/**
 * The script `sh -s` runs on the server, sent on ssh's stdin, so the keys are never on a command
 * line (here or there) and any login shell works. install.sh reads its options, MASTER_KEY and
 * SETUP_TOKEN from the environment. Downloading it first makes a failed download fail the run.
 * @param {{ domain: string, image: string, masterKey: string, setupToken: string }} options
 *   The domain and image are validated (no quotes or spaces); the keys are base64 and hex.
 */
export function remoteScript({ domain, image, masterKey, setupToken }) {
  return [
    "set -e",
    `MASTER_KEY=${shellQuote(masterKey)}`,
    `SETUP_TOKEN=${shellQuote(setupToken)}`,
    "export MASTER_KEY SETUP_TOKEN",
    `installer="$(curl -fsSL ${INSTALL_SH_URL})"`,
    `printf '%s\\n' "$installer" | DOMAIN=${domain} AGENT_ARMY_IMAGE=${image} NONINTERACTIVE=1 sh`,
    "",
  ].join("\n");
}

/** @type {Provider} */
export const vm = {
  id: "vm",
  label: "Linux server over SSH",
  installUrl: "https://www.openssh.com/",
  loginCommand: "ssh-copy-id <user>@<server>  (or add your key when creating the server)",
  requiresCli: () => true,

  async prepare(ctx) {
    let host = ctx.options.host;
    if (!host && ctx.prompt.interactive) {
      ctx.out.line("The server: Ubuntu or Debian, 8 GB RAM or more, ports 80 and 443 open, and you can ssh in as root");
      ctx.out.line("or as a user with passwordless sudo.");
      host = await ctx.prompt.ask("SSH target (e.g. root@203.0.113.7)", "");
    }
    if (!host && ctx.run.dryRun) {
      // A dry run without the answers shows the commands with placeholders.
      ctx.answers.host = "root@<server>";
      ctx.answers.domain = ctx.options.domain ?? "<domain>";
      return;
    }
    if (!host) throw new CommandError("The server's ssh target is missing.", { hint: "Pass --host, e.g. --host root@203.0.113.7" });
    if (!isValidHost(host)) throw new CommandError(`"${host}" is not an ssh target (e.g. root@203.0.113.7).`);

    let domain = ctx.options.domain;
    if (!domain && ctx.prompt.interactive) {
      const answer = await ctx.prompt.ask("Domain for Agent Army (its DNS A record must point at the server)", "");
      domain = answer ? normalizeDomain(answer) : undefined;
      if (answer && !domain) throw new CommandError(`"${answer}" is not a domain name (e.g. army.example.com).`);
    }
    if (!domain) {
      throw new CommandError("A domain is needed for HTTPS.", {
        hint:
          "Pass --domain army.example.com (an A record pointing at the server). Without a domain, run install.sh on " +
          `the server itself: it can use the server's IP address (experimental): curl -fsSL ${INSTALL_SH_URL} | sh`,
      });
    }
    ctx.answers.host = host;
    ctx.answers.domain = domain;
  },

  plan: ({ options, answers }) =>
    `Docker, Agent Army and Caddy (automatic HTTPS) in /opt/agent-army on ${answers.host}, at https://${answers.domain}.`,

  async deploy(ctx) {
    const host = /** @type {string} */ (ctx.answers.host);
    const domain = /** @type {string} */ (ctx.answers.domain);
    const url = `https://${domain}`;
    const ssh = (/** @type {string} */ command) => `ssh ${host} ${shellQuote(command)}`;

    ctx.saveKeys({ AGENT_ARMY_URL: url, AGENT_ARMY_HOST: host });

    ctx.out.step(`Running deploy/install.sh on ${host} (installs Docker if needed; a few minutes)`);
    ctx.created.push({
      what: `Agent Army in /opt/agent-army on ${host} (if install.sh got that far)`,
      remove: ssh("cd /opt/agent-army && sudo docker compose down --volumes && sudo rm -rf /opt/agent-army"),
    });
    const image = ctx.options.image;
    try {
      await ctx.run.run("ssh", ["-o", "ConnectTimeout=20", host, "sh", "-s"], {
        input: remoteScript({ domain, image, masterKey: ctx.secrets.masterKey, setupToken: ctx.secrets.setupToken }),
        inputLabel: "this script on stdin:",
        showInput: true,
      });
    } catch (err) {
      if (err instanceof CommandError) {
        err.hint = [
          "If sudo asked for a password: connect as root, or give this user passwordless sudo.",
          `If Agent Army is already on that server, its keys are in /opt/agent-army/.env: update it with ${ssh(`curl -fsSL ${INSTALL_SH_URL} | sh`)}`,
        ].join("\n");
      }
      throw err;
    }

    return {
      url,
      waitForHealth: true,
      notes: [
        `The keys are also on the server, in /opt/agent-army/.env (mode 600).`,
        `Update: ${ssh(`curl -fsSL ${INSTALL_SH_URL} | NONINTERACTIVE=1 sh`)}`,
        `Logs:   ${ssh("sudo docker compose -f /opt/agent-army/compose.yaml logs -f agent-army")}`,
      ],
      notHealthyHint:
        `Check that ${domain} points at the server and that ports 80 and 443 are open (cloud firewall), then: ` +
        ssh("sudo docker compose -f /opt/agent-army/compose.yaml logs caddy"),
    };
  },
};
