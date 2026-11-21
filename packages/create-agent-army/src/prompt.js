// Questions on the terminal (node:readline/promises). Not interactive: every answer is the default.
import { createInterface } from "node:readline/promises";

/** @typedef {import("./types.js").Prompter} Prompter */

/**
 * @param {{ input: NodeJS.ReadableStream & { isTTY?: boolean }, output: NodeJS.WritableStream, interactive: boolean }} options
 * @returns {Prompter}
 */
export function createPrompter({ input, output, interactive }) {
  /** @type {{ rl: import("node:readline/promises").Interface, lines: AsyncIterator<string> } | undefined} */
  let piped;

  /** @param {string} text */
  const question = async (text) => {
    if (!input.isTTY) {
      // Answers piped in: one reader for all of them, so none is lost between questions.
      if (!piped) {
        const rl = createInterface({ input, terminal: false });
        piped = { rl, lines: rl[Symbol.asyncIterator]() };
      }
      output.write(text);
      const next = await piped.lines.next();
      output.write("\n");
      return next.done ? "" : String(next.value).trim();
    }
    // A terminal: one readline per question, closed straight after, so the provider CLIs get the
    // terminal back (password prompts, browser logins) between questions.
    const rl = createInterface({ input, output, terminal: true });
    // Ctrl-C while asking: nothing has been created yet, so just stop.
    rl.on("SIGINT", () => {
      output.write("\n");
      process.exit(130);
    });
    try {
      return (await rl.question(text)).trim();
    } finally {
      rl.close();
    }
  };

  return {
    interactive,

    async ask(text, defaultValue = "") {
      if (!interactive) return defaultValue;
      const answer = await question(`${text}${defaultValue ? ` (${defaultValue})` : ""}: `);
      return answer || defaultValue;
    },

    async choose(text, choices, defaultIndex) {
      const fallback = choices[defaultIndex] ?? choices[0];
      if (!fallback) throw new Error("No choices");
      if (!interactive) return fallback.value;
      output.write(`${text}\n`);
      choices.forEach((choice, i) => {
        const mark = i === defaultIndex ? "*" : " ";
        output.write(`  ${mark} ${i + 1}) ${choice.label}${choice.hint ? `  - ${choice.hint}` : ""}\n`);
      });
      for (;;) {
        const answer = await question(`Choose 1-${choices.length} (${defaultIndex + 1}): `);
        if (!answer) return fallback.value;
        const picked = choices[Number(answer) - 1] ?? choices.find((c) => String(c.value) === answer.toLowerCase());
        if (picked) return picked.value;
        output.write(`Type a number from 1 to ${choices.length}.\n`);
      }
    },

    async confirm(text, defaultValue) {
      if (!interactive) return defaultValue;
      const answer = (await question(`${text} ${defaultValue ? "(Y/n)" : "(y/N)"} `)).toLowerCase();
      if (!answer) return defaultValue;
      return answer === "y" || answer === "yes";
    },

    close() {
      piped?.rl.close();
      piped = undefined;
    },
  };
}
