import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { LiteratureUniverse } from "../app/universe/LiteratureUniverse";
import "../app/globals.css";

async function start() {
  // The development server has no native shell; a fictional stand-in keeps
  // every workflow usable in a browser. Production builds drop this import.
  const host = window as Window & { webkit?: unknown };
  if (import.meta.env.DEV && !host.webkit) await import("./dev-bridge");

  const root = document.getElementById("root");
  if (!root) throw new Error("Liteverse root element is missing.");
  const applicationRoot = createRoot(root);

  // WKWebView can defer React's initial concurrent commit while a local file is
  // still completing navigation. Commit the first frame synchronously so the
  // native window never remains an empty black surface.
  flushSync(() => {
    applicationRoot.render(
      <StrictMode>
        <LiteratureUniverse />
      </StrictMode>,
    );
  });
}

void start();
