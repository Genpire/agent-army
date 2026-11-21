// The deployment's keys, made on this computer, and the redaction that keeps them off the screen.
import { randomBytes } from "node:crypto";

/** @typedef {import("./types.js").Secrets} Secrets */

/** @returns {Secrets} */
export function generateSecrets() {
  return {
    // Encrypts everything the deployment stores. Same format as `openssl rand -base64 32`.
    masterKey: randomBytes(32).toString("base64"),
    // The one-time token that creates the admin account. Same as `openssl rand -hex 18`.
    setupToken: randomBytes(18).toString("hex"),
  };
}

/**
 * Replaces secret values with placeholders. Every line this tool prints goes through one.
 */
export class Redactor {
  constructor() {
    /** @type {Map<string, string>} */
    this.values = new Map();
  }

  /**
   * @param {string} value
   * @param {string} placeholder
   */
  add(value, placeholder) {
    if (value.length >= 8) this.values.set(value, placeholder);
  }

  /** The longest secret, so a stream can keep enough of a partial line back. */
  get longest() {
    let max = 0;
    for (const value of this.values.keys()) max = Math.max(max, value.length);
    return max;
  }

  /** @param {string} text */
  redact(text) {
    let result = text;
    for (const [value, placeholder] of this.values) {
      if (result.includes(value)) result = result.split(value).join(placeholder);
    }
    return result;
  }
}
