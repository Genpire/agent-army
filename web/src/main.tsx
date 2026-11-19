import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Astryx: the reset, then the theme. Component styles are compiled from Astryx's
// source by the StyleX plugin (web/vite.config.ts), so the prebuilt astryx.css is
// not imported. Figtree (the theme's font) is bundled here instead of loaded from
// Google Fonts, so the page calls no third party.
import "@astryxdesign/core/reset.css";
import "@astryxdesign/theme-neutral/theme.css";
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { App } from "./App";
import { AppStateProvider } from "./lib/state";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <Theme theme={neutralTheme} mode="system">
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </Theme>
  </StrictMode>,
);
