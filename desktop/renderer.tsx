import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { LiteratureUniverse } from "../app/universe/LiteratureUniverse";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) throw new Error("Liteverse root element is missing.");

const applicationRoot = createRoot(root);

// WKWebView can defer React's initial concurrent commit while a local file is
// still completing navigation. Commit the first frame before boot finishes so
// the native window never remains an empty black surface.
flushSync(() => {
  applicationRoot.render(
    <StrictMode>
      <LiteratureUniverse />
    </StrictMode>,
  );
});
