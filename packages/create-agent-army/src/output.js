// Everything shown on the screen goes through here, and through the redactor first.

/** @typedef {import("./types.js").Output} Output */
/** @typedef {import("./secrets.js").Redactor} Redactor */
/** @typedef {{ write(text: string): unknown, isTTY?: boolean }} Writable */

/**
 * @param {{ stdout: Writable, stderr: Writable, redactor: Redactor, color?: boolean }} options
 * @returns {Output}
 */
export function createOutput({ stdout, stderr, redactor, color = false }) {
  /** @param {string} code @param {string} text */
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  /** @param {Writable} to @param {string} text */
  const write = (to, text) => void to.write(redactor.redact(text));

  /** Child output not yet shown: kept until its line ends, so a secret is never cut in two. */
  const pending = { stdout: "", stderr: "" };

  /** @param {"stdout" | "stderr"} which @param {boolean} all */
  const drain = (which, all) => {
    const text = pending[which];
    if (!text) return;
    let cut = all ? text.length : Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
    // A very long line without an end: show all but a tail that could hold part of a secret.
    if (!all && cut === 0 && text.length > 65536) cut = text.length - redactor.longest;
    if (cut <= 0) return;
    pending[which] = text.slice(cut);
    write(which === "stdout" ? stdout : stderr, text.slice(0, cut));
  };

  return {
    line: (text = "") => write(stdout, `${text}\n`),
    step: (text) => write(stdout, `\n${paint("1;36", "==>")} ${paint("1", text)}\n`),
    command: (text) => write(stdout, `${paint("2", "$")} ${text}\n`),
    warn: (text) => write(stderr, `${paint("33", "Warning:")} ${text}\n`),
    error: (text) => write(stderr, `${paint("1;31", "Error:")} ${text}\n`),
    stream: (text, which) => {
      pending[which] += text;
      drain(which, false);
    },
    flush: () => {
      drain("stdout", true);
      drain("stderr", true);
    },
    bold: (text) => paint("1", text),
    dim: (text) => paint("2", text),
  };
}
