import { describe, expect, it } from "vitest";
import { SMTP_PRESETS, addressOf, portForTls, presetById, presetForHost } from "../../../web/src/pages/integrations/email/presets.js";

describe("SMTP presets in the Email pane", () => {
  it("covers the common services with their usual host, port and TLS", () => {
    expect(SMTP_PRESETS.map((p) => [p.id, p.host, p.port, p.secure])).toEqual([
      ["gmail", "smtp.gmail.com", 465, true],
      ["microsoft", "smtp.office365.com", 587, false],
      ["ses", "email-smtp.us-east-1.amazonaws.com", 587, false],
      ["mailgun", "smtp.mailgun.org", 587, false],
      ["sendgrid", "smtp.sendgrid.net", 587, false],
      ["zoho", "smtp.zoho.com", 465, true],
      ["custom", "", 587, false],
    ]);
    // Each preset's host maps back to it.
    for (const p of SMTP_PRESETS.filter((x) => x.host)) expect(presetForHost(p.host)).toBe(p.id);
    expect(presetById("ses").passLabel).toBe("SMTP password");
    // Only SendGrid always signs in with the same user name.
    expect(SMTP_PRESETS.filter((p) => p.user).map((p) => p.id)).toEqual(["sendgrid"]);
  });

  it("fills in SendGrid's SMTP relay: STARTTLS on 587, the user apikey and the API key as the password", () => {
    const sendgrid = presetById("sendgrid");
    expect(sendgrid).toMatchObject({ name: "SendGrid", host: "smtp.sendgrid.net", port: 587, secure: false, user: "apikey", passHint: "The password is your API key." });
    expect(sendgrid.tip).toMatch(/the password is your API key/);
    expect(sendgrid.tip).toMatch(/Mail Send/);
    expect(sendgrid.tip).toMatch(/Settings → Sender Authentication/);
    expect(presetForHost("SMTP.SendGrid.net")).toBe("sendgrid");
  });

  it("recognises a saved host, including other regions", () => {
    expect(presetForHost("")).toBeUndefined();
    expect(presetForHost("email-smtp.eu-west-1.amazonaws.com")).toBe("ses");
    expect(presetForHost("smtp.eu.mailgun.org")).toBe("mailgun");
    expect(presetForHost("smtp.zoho.eu")).toBe("zoho");
    expect(presetForHost("SMTP.Gmail.com")).toBe("gmail");
    expect(presetForHost("mail.example.com")).toBe("custom");
  });

  it("moves between the usual ports when TLS from the start is switched", () => {
    expect(portForTls(true, 587)).toBe(465);
    expect(portForTls(false, 465)).toBe(587);
    expect(portForTls(true, 2525)).toBe(2525);
  });

  it("reads the bare address from a From value", () => {
    expect(addressOf("Pointer <pointer@example.com>")).toBe("pointer@example.com");
    expect(addressOf(" reports@example.com ")).toBe("reports@example.com");
  });
});
